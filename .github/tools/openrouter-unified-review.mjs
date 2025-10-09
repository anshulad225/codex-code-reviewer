/**
 * openrouter-unified-review.mjs
 *
 * Unified reviewer (PR diffs OR full-repo) using OpenRouter.
 * - If PR_NUMBER is present -> reviews PR diff (batched) and posts a PR comment
 * - Otherwise -> scans entire repo and writes artifacts (json + md) and Summary
 *
 * Required env:
 *   OPENROUTER_API_KEY (secret)
 * Optional env:
 *   OPENROUTER_MODEL (repo variable) — defaults to "openrouter/auto"
 *   OR_PROJECT_NAME, OR_SITE_URL (optional metadata headers)
 * Inputs from workflow:
 *   GITHUB_TOKEN, REPO, PR_NUMBER (when running on PR)
 */

import fs from "fs";
import path from "path";

const OR_KEY   = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_MODEL || "openrouter/auto";
const OR_BASE  = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO || "";
const PR_NUMBER = process.env.PR_NUMBER || "";
const IS_PR = Boolean(PR_NUMBER);

if (!OR_KEY) {
  console.error("❌ Missing OPENROUTER_API_KEY env variable.");
  process.exit(1);
}

const [OWNER, REPO_NAME] = REPO.split("/");

// -------------------- Utilities --------------------
function extractJsonFromText(s) {
  if (!s || typeof s !== "string") {
    console.error("❌ Empty or non-string response from OpenRouter");
    return null;
  }
  // Try direct JSON
  try {
    return JSON.parse(s);
  } catch (e) {
    console.error(`❌ Direct JSON parse failed: ${e.message}`);
  }
  // Try fenced ```json ... ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) {
    const inner = fence[1].trim();
    try {
      return JSON.parse(inner);
    } catch (e) {
      console.error(`❌ Fenced JSON parse failed: ${e.message}`);
    }
  }
  // Try largest {...}
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = s.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      console.error(`❌ Largest {...} JSON parse failed: ${e.message}`);
    }
  }
  console.error(`❌ No valid JSON found in response: ${s.slice(0, 200)}...`);
  return null;
}

function renderMarkdown(finalOut, title = "OpenRouter Review") {
  const findings = Array.isArray(finalOut.findings) ? finalOut.findings : [];
  const summary = finalOut.summary || "Review completed.";
  const rows = findings.map(f =>
    `| ${String((f.severity || "info")).toUpperCase()} | \`${f.file||"-"}\` | ${f.line ?? "-"} | ${(f.comment||"").replace(/\n/g," ")} |`
  ).join("\n");
  const suggestions = findings.filter(f => f.suggestion)
    .map((f,i)=>`**Suggestion ${i+1} — ${f.file||""}:${f.line ?? ""}**\n\`\`\`\n${f.suggestion}\n\`\`\``)
    .join("\n\n");
  const table = findings.length
    ? `| Severity | File | Line | Comment |\n|---|---|---|---|\n${rows}\n\n${suggestions ? `---\n${suggestions}\n` : ""}`
    : "_No actionable findings._";
  return `### 🤖 ${title}\n**Summary:** ${summary}\n\n${table}`;
}

function mergeFindings(all) {
  const seen = new Set();
  const merged = [];
  for (const f of all) {
    const key = `${f.file}|${f.line}|${f.severity}|${(f.comment || "").slice(0,80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }
  return merged;
}

// -------------------- OpenRouter call --------------------
async function callOpenRouter(prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`🔎 Attempt ${attempt}/${retries} calling OpenRouter model: ${OR_MODEL}`);
    const body = {
      model: OR_MODEL,
      temperature: 0,
      max_tokens: 1000,
      // Honored by many models; harmless if ignored
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a careful, structured code reviewer that MUST return valid JSON only (one JSON object). No extra prose, no markdown, no code fences." },
        { role: "user", content: prompt }
      ]
    };

    try {
      const res = await fetch(`${OR_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OR_KEY}`,
          ...(process.env.OR_SITE_URL ? { "HTTP-Referer": process.env.OR_SITE_URL } : {}),
          ...(process.env.OR_PROJECT_NAME ? { "X-Title": process.env.OR_PROJECT_NAME } : {})
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        if (res.status === 429) {
          console.error("⚠️ Rate limit hit, consider waiting or reducing batch size");
        }
        throw new Error(`OpenRouter API ${res.status}: ${txt}`);
      }
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content ?? "";
      console.log(`📜 Raw OpenRouter response: ${text.slice(0, 200)}...`);
      return text;
    } catch (e) {
      console.error(`❌ Attempt ${attempt} failed: ${e.message}`);
      if (attempt === retries) throw e;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
    }
  }
}

// -------------------- Prompt --------------------
function promptForBatch(batch) {
  return `
You are a senior code reviewer. Your response MUST be a single, valid JSON object. Do NOT include markdown, prose, code fences, or any non-JSON content. Any deviation will break the parser.

OUTPUT FORMAT (MANDATORY):
{
  "findings": [
    { "file": "path/relative", "line": 123, "severity": "high|medium|low|info", "comment": "what & why", "suggestion"?: "small patch/snippet" }
  ],
  "summary": "1-2 sentence summary for this batch"
}

If you cannot analyze the input, return:
{"findings": [], "summary": "Unable to analyze this batch."}

If you are unsure, return:
{"findings": [], "summary": "No major issues identified in this batch."}

Focus on SECURITY, CORRECTNESS, PERFORMANCE, TEST COVERAGE, and MAINTAINABILITY.
Be concise and actionable.

--- BEGIN INPUT ---
${batch}
--- END INPUT ---
`;
}

// -------------------- GitHub helpers (PR mode) --------------------
async function githubPaginate(url, token) {
  const out = [];
  let next = url;
  while (next) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "openrouter-unified-review" }
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${next}`);
    const page = await res.json();
    out.push(...page);
    const link = res.headers.get("link") || "";
    const m = /<([^>]+)>; rel="next"/.exec(link);
    next = m ? m[1] : null;
  }
  return out;
}

async function postPRComment(owner, repo, prNumber, body) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "openrouter-unified-review", "Content-Type": "application/json" },
    body: JSON.stringify({ body })
  });
  if (!res.ok) {
    const err = await res.text().catch(()=>"");
    throw new Error(`Failed to post PR comment: ${res.status} ${err}`);
  }
}

// -------------------- PR batching helpers --------------------
const PR_MAX_BATCH_CHARS = 50_000; // Reduced from 80,000
function makeUnifiedChunk(filename, patch) {
  return `--- a/${filename}\n+++ b/${filename}\n${patch}\n\n`;
}
function batchPRFiles(files) {
  const batches = [];
  let buf = "";
  for (const f of files) {
    if (!f.patch) continue; // skip binary/non-text changes
    const chunk = makeUnifiedChunk(f.filename, f.patch);
    if ((buf.length + chunk.length) > PR_MAX_BATCH_CHARS) {
      if (buf) batches.push(buf);
      buf = chunk;
    } else {
      buf += chunk;
    }
  }
  if (buf) batches.push(buf);
  return batches;
}

// -------------------- PR review path (batched) --------------------
async function runPRReview() {
  if (!OWNER || !REPO_NAME || !GITHUB_TOKEN) {
    console.error("❌ Missing PR context or GITHUB_TOKEN for PR review."); process.exit(1);
  }
  const prNum = Number(PR_NUMBER);
  console.log(`🧩 Running PR review for ${OWNER}/${REPO_NAME} #${prNum}`);

  // 1) Fetch PR changed files (with unified patches)
  const files = await githubPaginate(
    `https://api.github.com/repos/${OWNER}/${REPO_NAME}/pulls/${prNum}/files?per_page=100`,
    GITHUB_TOKEN
  );

  // 2) Build batches of unified diff hunks
  const batches = batchPRFiles(files);
  if (!batches.length) {
    await postPRComment(OWNER, REPO_NAME, prNum, "No textual diff to review (binary or empty changes).");
    return;
  }

  const allFindings = [];
  const summaries = [];

  // 3) Review each batch with strict JSON prompt
  for (let i = 0; i < batches.length; i++) {
    console.log(`📦 PR batch ${i+1}/${batches.length} (len=${batches[i].length})`);
    const prompt = promptForBatch(batches[i]);
    let raw;
    try {
      raw = await callOpenRouter(prompt);
    } catch (e) {
      const msg = String(e.message || e);
      console.error(`❌ OpenRouter call failed on PR batch ${i+1}:`, msg);
      if (msg.includes("401")) {
        await postPRComment(OWNER, REPO_NAME, prNum, "❌ OpenRouter returned 401 Unauthorized. Check the OPENROUTER_API_KEY secret.");
        process.exit(1);
      }
      // Continue other batches but note the failure
      continue;
    }

    const parsed = extractJsonFromText(raw);
    const out = parsed && typeof parsed === "object"
      ? parsed
      : { findings: [], summary: "Model did not return valid JSON for this batch." };

    if (Array.isArray(out.findings)) allFindings.push(...out.findings);
    if (out.summary) summaries.push(String(out.summary));
  }

  // 4) Merge and post a single summary comment
  const merged = mergeFindings(allFindings);
  const finalSummary = summaries.length
    ? `Batches: ${batches.length}. ${summaries.slice(0, 3).join(" ")}`
    : `Reviewed ${batches.length} batch(es).`;

  const body = renderMarkdown({ summary: finalSummary, findings: merged }, "OpenRouter PR Review");
  await postPRComment(OWNER, REPO_NAME, prNum, body);
  console.log(`✅ PR review posted. Findings: ${merged.length}`);
}

// -------------------- Full repo path --------------------
const INCLUDE_EXTS = [".js",".ts",".jsx",".tsx",".py",".java",".go",".rb",".php",".cs",".cpp",".c",".rs",".kt",".m",".swift",".sql",".sh",".yml",".yaml",".json"];
const EXCLUDE_DIRS = [".git","node_modules","dist","build","out",".next",".venv","venv","coverage"];
const MAX_BATCH_CHARS = 60_000; // Reduced from 100,000
const MAX_FILE_CHARS = 20_000; // Reduced from 40,000
const MAX_FILES = 600;

const isExcludedDir = (p) => EXCLUDE_DIRS.some(d => p.split(path.sep).includes(d));
const hasGoodExt = (file) => INCLUDE_EXTS.some(ext => file.toLowerCase().endsWith(ext));

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isExcludedDir(full)) out.push(...walk(full));
    } else if (hasGoodExt(full)) {
      out.push(full);
    }
  }
  return out;
}

function sliceFileContent(p) {
  try {
    const stats = fs.statSync(p);
    if (stats.size > MAX_FILE_CHARS) {
      console.warn(`⚠️ File ${p} exceeds ${MAX_FILE_CHARS} bytes, truncating`);
    }
    let src = fs.readFileSync(p, "utf8");
    if (!src.trim()) return null;
    if (src.length > MAX_FILE_CHARS) src = src.slice(0, MAX_FILE_CHARS) + "\n... [truncated]";
    return `\n// ===== FILE: ${path.relative(process.cwd(), p)} =====\n${src}`;
  } catch (e) {
    console.error(`❌ Failed to read file ${p}: ${e.message}`);
    return null;
  }
}

function batchesFromFiles(files) {
  const batches = [];
  let buf = "";
  for (const f of files) {
    const part = sliceFileContent(f);
    if (!part) continue;
    if ((buf.length + part.length) > MAX_BATCH_CHARS) {
      if (buf) batches.push(buf);
      buf = part;
    } else {
      buf += part;
    }
  }
  if (buf) batches.push(buf);
  return batches;
}

async function runFullRepo() {
  const allFiles = walk(process.cwd()).slice(0, MAX_FILES);
  if (!allFiles.length) {
    console.log("No source files matched INCLUDE_EXTS."); return;
  }
  const batches = batchesFromFiles(allFiles);
  const allFindings = [];
  const summaries = [];

  for (let i = 0; i < batches.length; i++) {
    console.log(`📦 Reviewing batch ${i+1}/${batches.length} with model: ${OR_MODEL} ...`);
    const prompt = promptForBatch(batches[i]);
    let raw;
    try {
      raw = await callOpenRouter(prompt);
    } catch (e) {
      const msg = String(e.message || e);
      console.error(`❌ Batch ${i+1} failed: ${msg}`);
      if (msg.includes("401")) { console.error("❌ 401 Unauthorized from OpenRouter. Check OPENROUTER_API_KEY."); process.exit(1); }
      continue;
    }
    const parsed = extractJsonFromText(raw);
    const out = parsed && typeof parsed === "object" ? parsed : { findings: [], summary: "Model did not return valid JSON." };
    const f = Array.isArray(out.findings) ? out.findings : [];
    allFindings.push(...f);
    if (out.summary) summaries.push(out.summary);
  }

  const finalSummary = summaries.length ? `Batches: ${batches.length}. ${summaries.slice(0,3).join(" ")}` : `Reviewed ${allFiles.length} file(s) across ${batches.length} batch(es).`;
  const finalOut = { summary: finalSummary, findings: allFindings };

  fs.writeFileSync("codex_full_review.json", JSON.stringify(finalOut, null, 2), "utf8");
  const md = renderMarkdown(finalOut, "OpenRouter Full Repo Review");
  fs.writeFileSync("codex_full_review.md", md, "utf8");

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n", "utf8");
  }
  console.log(`✅ Full repo review complete. Files: ${allFiles.length}, Batches: ${batches.length}, Findings: ${allFindings.length}`);
}

// -------------------- Entrypoint --------------------
(async () => {
  try {
    if (IS_PR) await runPRReview();
    else await runFullRepo();
  } catch (e) {
    console.error("Unexpected failure:", e);
    process.exit(1);
  }
})();
