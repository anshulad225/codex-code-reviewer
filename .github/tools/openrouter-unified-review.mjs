/**
 * openrouter-unified-review.mjs
 *
 * Unified reviewer (PR diffs OR full-repo) using OpenRouter.
 * - PR mode → batched diff review + summary PR comment + INLINE COMMENTS
 * - Full repo mode → scans repo and writes artifacts (json + md) + job Summary
 *
 * Security extras:
 * - Loads team React guidelines from .github/REVIEW_RULES/REACT_GUIDELINES.md
 * - Redacts likely secrets before sending to the model (fixed safe regexes)
 * - Skips sensitive paths & allows model allowlist via env
 *
 * Required env:
 *   OPENROUTER_API_KEY (secret)
 * Optional env:
 *   OPENROUTER_MODEL (repo variable) — defaults to "openrouter/auto"
 *   MODEL_ALLOWLIST (repo variable) — comma-separated list; if set, model must be in it
 *   OR_PROJECT_NAME, OR_SITE_URL (optional metadata headers)
 * Inputs from workflow:
 *   GITHUB_TOKEN, REPO (owner/repo), PR_NUMBER (only in PR runs)
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

// -------------------- Load React Guidelines --------------------
let ORG_RULES_TEXT = "";
try {
  const p = path.join(process.cwd(), ".github", "REVIEW_RULES", "REACT_GUIDELINES.md");
  ORG_RULES_TEXT = fs.readFileSync(p, "utf8").trim();
  console.log("📏 Loaded React Guidelines from .github/REVIEW_RULES/REACT_GUIDELINES.md");
} catch {
  console.warn("⚠️ React Guidelines not found (continuing without team rules context).");
  ORG_RULES_TEXT = "";
}

// -------------------- Model allowlist (optional) --------------------
const ALLOW = (process.env.MODEL_ALLOWLIST || "")
  .split(",").map(s=>s.trim()).filter(Boolean);

if (ALLOW.length && !ALLOW.includes(OR_MODEL)) {
  console.error(`❌ Model "${OR_MODEL}" not in allowlist: ${ALLOW.join(", ")}`);
  process.exit(1);
}

// -------------------- Secret Redaction (safe regexes) --------------------
const SECRET_PATTERNS = [
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,

  // Generic assignments: key/secret/token/password/authorization
  // (no backticks; safe char classes across Node versions)
  /(?:api[_\-\s]*key|secret|token|password|passwd|authorization)\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}["']?/gi,

  // Google-style tokens
  /\b(AIza|ya29\.)[A-Za-z0-9_-]{20,}\b/g,

  // GitHub Personal Access Tokens
  /\bghp_[A-Za-z0-9]{20,}\b/g,

  // AWS keys
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\b\s*[:=]\s*["']?[A-Za-z0-9/+]{30,}["']?/gi,

  // Generic sk- style secrets
  /\bsk-[A-Za-z0-9]{20,}\b/g
];

function redact(s) {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, "[REDACTED]"), s);
}

// -------------------- Utilities --------------------
function extractJsonFromText(s) {
  if (!s || typeof s !== "string") return null;
  try { return JSON.parse(s); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const first = s.indexOf("{"), last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch {}
  }
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
  const rulesNote = ORG_RULES_TEXT ? "\n\n> ℹ️ Team React Guidelines were applied in this review." : "";
  return `### 🤖 ${title}\n**Summary:** ${summary}\n\n${table}${rulesNote}`;
}

function mergeFindings(all) {
  const seen = new Set();
  const merged = [];
  for (const f of all) {
    const key = `${f.file}|${f.line}|${f.severity}|${(f.comment || "").slice(0,100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }
  return merged;
}

// -------------------- OpenRouter call --------------------
async function callOpenRouter(prompt) {
  console.log(`🔎 Calling OpenRouter model: ${OR_MODEL}`);
  const body = {
    model: OR_MODEL,
    temperature: 0,
    max_tokens: 1000,
    response_format: { type: "json_object" }, // honored by many models
    messages: [
      { role: "system", content:
        "You are a careful, structured React code reviewer that MUST return valid JSON only (one JSON object). " +
        "No extra prose, no markdown, no code fences."
      },
      { role: "user", content: prompt }
    ]
  };

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
    const txt = await res.text().catch(()=> "");
    throw new Error(`OpenRouter API ${res.status}: ${txt}`);
  }
  const j = await res.json();
  return j?.choices?.[0]?.message?.content ?? "";
}

// -------------------- Prompt --------------------
function promptForBatch(batch) {
  const RULES = ORG_RULES_TEXT ? ORG_RULES_TEXT.slice(0, 18000) : "(no extra rules provided)";
  return `
You are a senior code reviewer for a React codebase.

TEAM REACT GUIDELINES (MANDATORY TO ENFORCE):
${RULES}

OUTPUT FORMAT (MANDATORY):
Return exactly ONE JSON object only. No prose, no markdown, no code fences. Valid JSON.

Schema:
{
  "findings": [
    { "file": "path/relative", "line": 123, "severity": "high|medium|low|info", "comment": "what & why; cite violated guideline if applicable", "suggestion"?: "small patch/snippet" }
  ],
  "summary": "1–2 sentence summary for this batch"
}

If unsure, return:
{"findings": [], "summary": "No major issues identified in this batch."}

Focus order:
1) Violations of TEAM REACT GUIDELINES (naming, structure, hooks, accessibility, state mgmt, JSX readability),
2) Security (XSS from dangerouslySetInnerHTML / user HTML, command execution, secrets),
3) Correctness,
4) Performance (avoid inline handlers in JSX causing rerenders, sync I/O in Node),
5) Test coverage,
6) Maintainability.

--- BEGIN INPUT (sanitized) ---
${batch}
--- END INPUT ---
`;
}

// -------------------- GitHub helpers --------------------
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
    const err = await res.text().catch(()=> "");
    throw new Error(`Failed to post PR comment: ${res.status} ${err}`);
  }
}

async function getPRHeadSha(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "openrouter-unified-review" }
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} getting PR`);
  const pr = await res.json();
  return pr?.head?.sha;
}

// Inline comment
async function postInlineComment(owner, repo, prNumber, { commit_id, path, position, body }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "openrouter-unified-review", "Content-Type": "application/json" },
    body: JSON.stringify({ commit_id, path, position, body })
  });
  if (!res.ok) {
    const err = await res.text().catch(()=> "");
    throw new Error(`Failed to post inline comment: ${res.status} ${err}`);
  }
}

// -------------------- PR batching + diff mapping --------------------
const PR_MAX_BATCH_CHARS = 80_000;
function makeUnifiedChunk(filename, patch) {
  return `--- a/${filename}\n+++ b/${filename}\n${patch}\n\n`;
}
function batchPRFiles(files) {
  const batches = [];
  let buf = "";
  for (const f of files) {
    if (!f.patch) continue;
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

/** map new-file line to diff "position" for inline comments */
function diffPositionForLine(unifiedPatch, targetNewLine) {
  const lines = unifiedPatch.split("\n");
  let position = 0;
  let newLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    position += 1;

    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(L);
    if (m) { newLine = parseInt(m[1], 10) || 0; continue; }

    if (L.startsWith("+")) {
      if (newLine === Number(targetNewLine)) return position;
      newLine += 1;
    } else if (L.startsWith("-")) {
      // removed line: doesn't advance newLine
    } else {
      if (newLine === Number(targetNewLine)) return position;
      newLine += 1;
    }
  }
  return null;
}

// -------------------- Static checks (cheap heuristics) --------------------
const STATIC_RULES = [
  { id: "react-inline-handler", re: /=\s*\{?\s*\(\s*\)\s*=>/ , severity: "low",    msg: "Inline arrow function in JSX may cause rerenders (extract handler)" },
  { id: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML/, severity: "high", msg: "dangerouslySetInnerHTML can introduce XSS; sanitize/escape content" },
  { id: "no-eval", re: /\beval\s*\(/, severity: "high", msg: "Avoid eval()" },
  { id: "weak-crypto", re: /\b(md5|sha1)\b/i, severity: "medium", msg: "Weak cryptography detected" },
  { id: "sync-io", re: /\bfs\.(readFileSync|writeFileSync|readdirSync|statSync)\b/, severity: "medium", msg: "Sync I/O in JS (prefer async)" },
];
function runStaticChecksOnPatch(filename, patch) {
  const findings = [];
  const lines = patch.split("\n");
  let newLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(L);
    if (h) { newLine = parseInt(h[1],10) || 0; continue; }
    if (L.startsWith("+")) {
      const code = L.slice(1);
      for (const r of STATIC_RULES) {
        if (r.re.test(code)) {
          findings.push({
            file: filename,
            line: newLine,
            severity: r.severity,
            comment: `${r.msg} (rule: ${r.id})`
          });
        }
      }
      newLine += 1;
    } else if (!L.startsWith("-")) {
      newLine += 1;
    }
  }
  return findings;
}

// -------------------- PR review path (batched + inline) --------------------
async function runPRReview() {
  if (!OWNER || !REPO_NAME || !GITHUB_TOKEN) {
    console.error("❌ Missing PR context or GITHUB_TOKEN for PR review."); process.exit(1);
  }
  const prNum = Number(PR_NUMBER);
  console.log(`🧩 Running PR review for ${OWNER}/${REPO_NAME} #${prNum}`);

  const headSha = await getPRHeadSha(OWNER, REPO_NAME, prNum);
  const files = await githubPaginate(
    `https://api.github.com/repos/${OWNER}/${REPO_NAME}/pulls/${prNum}/files?per_page=100`,
    GITHUB_TOKEN
  );

  // Static checks on patches (cheap & local)
  const staticFindings = [];
  for (const f of files) {
    if (!f.patch) continue;
    staticFindings.push(...runStaticChecksOnPatch(f.filename, f.patch));
  }

  // Build sanitized batches
  const rawBatches = batchPRFiles(files);
  const batches = rawBatches.map(b => redact(b));
  if (!batches.length) {
    await postPRComment(OWNER, REPO_NAME, prNum, "No textual diff to review (binary or empty changes).");
    return;
  }

  const allFindings = [];
  const summaries = [];

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
      continue;
    }

    const parsed = extractJsonFromText(raw);
    const out = parsed && typeof parsed === "object"
      ? parsed
      : { findings: [], summary: "Model did not return valid JSON for this batch." };

    if (Array.isArray(out.findings)) allFindings.push(...out.findings);
    if (out.summary) summaries.push(String(out.summary));
  }

  // Merge static + LLM findings
  const merged = mergeFindings([...allFindings, ...staticFindings]);
  const finalSummary = summaries.length
    ? `Batches: ${batches.length}. ${summaries.slice(0, 3).join(" ")}`
    : `Reviewed ${batches.length} batch(es).`;

  const body = renderMarkdown({ summary: finalSummary, findings: merged }, "OpenRouter PR Review");
  await postPRComment(OWNER, REPO_NAME, prNum, body);
  console.log(`✅ Summary PR comment posted. Findings: ${merged.length}`);

  // Inline comments (limit)
  const MAX_INLINE = 20;
  const patchMap = new Map(files.filter(f=>f.patch).map(f => [f.filename, f.patch]));
  let posted = 0;

  for (const f of merged) {
    if (posted >= MAX_INLINE) break;
    if (!f || !f.file) continue;
    // Prioritize high & medium for inline
    if (f.severity !== "high" && f.severity !== "medium") continue;

    const patch = patchMap.get(f.file);
    if (!patch) continue;

    const pos = diffPositionForLine(patch, f.line ?? 0);
    if (!pos) continue;

    const commentBody =
      `**${String(f.severity||"info").toUpperCase()}** — ${f.comment || "Issue"}`
      + (f.suggestion ? `\n\n**Suggestion**:\n\`\`\`\n${f.suggestion}\n\`\`\`` : "");

    try {
      await postInlineComment(OWNER, REPO_NAME, prNum, {
        commit_id: headSha,
        path: f.file,
        position: pos,
        body: commentBody
      });
      posted += 1;
    } catch (e) {
      console.warn(`⚠️ Inline comment failed for ${f.file}:${f.line} — ${String(e.message||e)}`);
    }
  }
  console.log(`✅ Inline comments posted: ${posted}`);
}

// -------------------- Full repo path --------------------
const INCLUDE_EXTS = [".js",".ts",".jsx",".tsx",".py",".java",".go",".rb",".php",".cs",".cpp",".c",".rs",".kt",".m",".swift",".sql",".sh",".yml",".yaml",".json"];
const EXCLUDE_DIRS = [".git","node_modules","dist","build","out",".next",".venv","venv","coverage","certs","keys","secrets",".secrets","credentials",".github/private"];
const EXCLUDE_FILES = [".env",".env.local","id_rsa","id_ed25519","service-account.json"];
const SENSITIVE_GLOBS = [/\.pem$/i, /\.p12$/i, /\.key$/i, /credentials?\./i];

const MAX_BATCH_CHARS = 100_000;
const MAX_FILE_CHARS = 40_000;
const MAX_FILES = 600;

const isExcludedDir = (p) => EXCLUDE_DIRS.some(d => p.split(path.sep).includes(d));
const hasGoodExt = (file) => INCLUDE_EXTS.some(ext => file.toLowerCase().endsWith(ext));
function isSensitivePath(p) {
  if (EXCLUDE_FILES.includes(path.basename(p))) return true;
  if (SENSITIVE_GLOBS.some(re => re.test(p))) return true;
  return false;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isExcludedDir(full)) out.push(...walk(full));
    } else if (hasGoodExt(full) && !isSensitivePath(full)) {
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
  if (!allFiles.length) { console.log("No source files matched INCLUDE_EXTS."); return; }

  const batches = batchesFromFiles(allFiles).map(b => redact(b));
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

  const finalSummary = summaries.length
    ? `Batches: ${batches.length}. ${summaries.slice(0,3).join(" ")}`
    : `Reviewed ${allFiles.length} file(s) across ${batches.length} batch(es).`;
  const finalOut = { summary: finalSummary, findings: mergeFindings(allFindings) };

  fs.writeFileSync("codex_full_review.json", JSON.stringify(finalOut, null, 2), "utf8");
  const md = renderMarkdown(finalOut, "OpenRouter Full Repo Review");
  fs.writeFileSync("codex_full_review.md", md, "utf8");

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n", "utf8");
  }
  console.log(`✅ Full repo review complete. Files: ${allFiles.length}, Batches: ${batches.length}, Findings: ${finalOut.findings.length}`);
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
