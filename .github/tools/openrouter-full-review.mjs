/**
 * Unified Reviewer (PR + Full Repo) via OpenRouter
 * - If PR_NUMBER is present → fetch PR diff and post a PR comment
 * - Else → scan full repo, create artifacts, write Summary
 *
 * Requires:
 *   OPENROUTER_API_KEY  (secret)
 *   OPENROUTER_MODEL    (repo variable or default "openrouter/auto")
 * Uses:
 *   GITHUB_TOKEN, REPO, PR_NUMBER when running on PR
 */

import fs from "fs";
import path from "path";

const OR_KEY   = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_MODEL || "openrouter/auto";
const OR_BASE  = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");

if (!OR_KEY) {
  console.error("❌ Missing OPENROUTER_API_KEY"); process.exit(1);
}

const IS_PR = !!process.env.PR_NUMBER;
const [owner, repo] = (process.env.REPO || "").split("/");

// ---------- Shared helpers ----------
function extractJsonFromText(s) {
  try { return JSON.parse(s); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) { const inner = fence[1].trim(); try { return JSON.parse(inner); } catch {} }
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = s.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function promptForBatch(batch) {
  return `
You are a senior code reviewer.

OUTPUT REQUIREMENT:
Return ONE JSON object only. No prose. No code fences. Valid JSON.

Schema:
{
  "findings": [
    { "file": "path/relative", "line": 123, "severity": "high|medium|low|info", "comment": "what & why", "suggestion"?: "minimal patch/snippet" }
  ],
  "summary": "1–2 sentences for this batch"
}

If unsure:
{"findings": [], "summary": "No major issues identified in this batch."}

Review for SECURITY, CORRECTNESS, PERFORMANCE, TEST COVERAGE, MAINTAINABILITY.

--- BEGIN INPUT ---
${batch}
--- END INPUT ---
`;
}

async function callOpenRouter(prompt) {
  console.log(`🔎 Using OpenRouter model: ${OR_MODEL}`);
  const body = {
    model: OR_MODEL,
    temperature: 0,
    max_tokens: 900,
    response_format: { type: "json_object" }, // honored by many models; ignored by others
    messages: [
      { role: "system", content: "You are a careful, structured code reviewer that ALWAYS returns strict JSON for the specified schema. Never add code fences." },
      { role: "user", content: prompt }
    ]
  };

  const resp = await fetch(`${OR_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OR_KEY}`,
      ...(process.env.OR_SITE_URL ? { "HTTP-Referer": process.env.OR_SITE_URL } : {}),
      ...(process.env.OR_PROJECT_NAME ? { "X-Title": process.env.OR_PROJECT_NAME } : {}),
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(()=> "");
    throw new Error(`OpenRouter API ${resp.status}: ${errTxt}`);
  }
  const j = await resp.json();
  const text = j?.choices?.[0]?.message?.content ?? "";
  return text;
}

function renderMarkdown(finalOut, title = "OpenRouter Review") {
  const findings = finalOut.findings || [];
  const summary = finalOut.summary || "Review completed.";

  const rows = findings.map(f =>
    `| ${String(f.severity||"info").toUpperCase()} | \`${f.file||"-"}\` | ${f.line ?? "-"} | ${(f.comment||"").replace(/\n/g," ")} |`
  ).join("\n");

  const suggestions = findings
    .filter(f => f.suggestion)
    .map((f,i)=>`**Suggestion ${i+1} — ${f.file||""}:${f.line ?? ""}**\n\`\`\`\n${f.suggestion}\n\`\`\``)
    .join("\n\n");

  const table = findings.length
    ? `| Severity | File | Line | Comment |\n|---|---|---|---|\n${rows}\n\n${suggestions ? `---\n${suggestions}\n` : ""}`
    : "_No actionable findings._";

  return `### 🤖 ${title}
**Summary:** ${summary}

${table}`;
}

// ---------- PR mode (diff review) ----------
async function runPRReview() {
  if (!owner || !repo || !process.env.GITHUB_TOKEN) {
    console.error("❌ Missing repo context or GITHUB_TOKEN for PR mode."); process.exit(1);
  }
  const prNumber = Number(process.env.PR_NUMBER);
  console.log(`🧩 PR review for ${owner}/${repo} #${prNumber}`);

  // Collect unified diff from PR files
  const files = await githubPaginate(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    process.env.GITHUB_TOKEN
  );

  let unified = "";
  for (const f of files) {
    if (!f.patch) continue;
    unified += `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n\n`;
  }

  if (!unified.trim()) {
    await postPRComment(owner, repo, prNumber, "No textual diff to review.");
    return;
  }

  const prompt = promptForBatch(unified);
  let out;
  try {
    const raw = await callOpenRouter(prompt);
    out = extractJsonFromText(raw) || { findings: [], summary: "Model did not return valid JSON." };
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("401")) {
      await postPRComment(owner, repo, prNumber, "❌ 401 from OpenRouter. Check `OPENROUTER_API_KEY`.");
      process.exit(1);
    }
    await postPRComment(owner, repo, prNumber, `OpenRouter PR review failed: \`${msg}\``);
    throw e;
  }

  const body = renderMarkdown(out, "OpenRouter PR Review");
  await postPRComment(owner, repo, prNumber, body);
  console.log("✅ Posted PR review comment.");
}

async function githubPaginate(url, token) {
  const out = [];
  let next = url;
  while (next) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "openrouter-unified-review" } });
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
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "openrouter-unified-review" , "Content-Type": "application/json" },
    body: JSON.stringify({ body })
  });
  if (!res.ok) {
    const err = await res.text().catch(()=> "");
    throw new Error(`Failed to post PR comment: ${res.status} ${err}`);
  }
}

// ---------- Full repo mode ----------
const INCLUDE_EXTS = [".js",".ts",".jsx",".tsx",".py",".java",".go",".rb",".php",".cs",".cpp",".c",".rs",".kt",".m",".swift",".sql",".sh",".yml",".yaml",".json"];
const EXCLUDE_DIRS = [".git","node_modules","dist","build","out",".next",".venv","venv","coverage"];
const MAX_BATCH_CHARS = 100_000;
const MAX_FILE_CHARS  = 40_000;
const MAX_FILES       = 600;

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
  let src = "";
  try { src = fs.readFileSync(p, "utf8"); } catch { return null; }
  if (!src.trim()) return null;
  if (src.length > MAX_FILE_CHARS) src = src.slice(0, MAX_FILE_CHARS) + "\n... [truncated]";
  return `\n// ===== FILE: ${path.relative(process.cwd(), p)} =====\n${src}`;
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
  if (!allFiles.length) { console.log("No source files matched."); return; }
  const batches = batchesFromFiles(allFiles);

  const allFindings = [];
  const summaries = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`📦 Reviewing batch ${i+1}/${batches.length} with model: ${OR_MODEL} ...`);
    const prompt = promptForBatch(batches[i]);

    try {
      const raw = await callOpenRouter(prompt);
      const out = extractJsonFromText(raw) || { findings: [], summary: "Model did not return valid JSON." };
      const f = Array.isArray(out.findings) ? out.findings : [];
      allFindings.push(...f);
      if (out.summary) summaries.push(String(out.summary));
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("401")) { console.error("❌ 401 from OpenRouter. Check key."); process.exit(1); }
      console.error(`❌ Batch ${i+1} failed: ${msg}`);
    }
  }

  const finalSummary = summaries.length
    ? `Batches: ${batches.length}. ${summaries.slice(0,3).join(" ")}`
    : `Reviewed ${allFiles.length} file(s) across ${batches.length} batch(es).`;

  const finalOut = { summary: finalSummary, findings: allFindings };

  // Write artifacts
  fs.writeFileSync("codex_full_review.json", JSON.stringify(finalOut, null, 2), "utf8");
  const md = renderMarkdown(finalOut, "OpenRouter Full Repo Review");
  fs.writeFileSync("codex_full_review.md", md, "utf8");

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n", "utf8");
  }
  console.log(`✅ Full repo review complete. Files: ${allFiles.length}, Batches: ${batches.length}, Findings: ${allFindings.length}`);
}

// ---------- Entry ----------
(async () => {
  try {
    if (IS_PR) await runPRReview();
    else await runFullRepo();
  } catch (e) {
    console.error("Unexpected failure:", e);
    process.exit(1);
  }
})();
