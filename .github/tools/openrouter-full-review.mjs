/**
 * OpenRouter Full-Repo Reviewer
 * - Scans repo files, batches content, calls OpenRouter chat completions
 * - Produces codex_full_review.json + codex_full_review.md + Summary output
 *
 * Required env:
 *   OPENROUTER_API_KEY   → your OpenRouter key
 * Optional env:
 *   OPENROUTER_MODEL     → model id (defaults to "openrouter/auto")
 *   OPENROUTER_BASE_URL  → override endpoint (default "https://openrouter.ai/api/v1")
 *   OR_PROJECT_NAME      → appears in OpenRouter logs X-Title (optional)
 *   OR_SITE_URL          → appears in OpenRouter logs HTTP-Referer (optional)
 */

import fs from "fs";
import path from "path";

// ---------- CONFIG (tweak as needed) ----------
const INCLUDE_EXTS = [
  ".js", ".ts", ".jsx", ".tsx", ".py", ".java",
  ".go", ".rb", ".php", ".cs", ".cpp", ".c", ".rs",
  ".kt", ".m", ".swift", ".sql", ".sh", ".yml", ".yaml", ".json"
];
const EXCLUDE_DIRS = [
  ".git", "node_modules", "dist", "build", "out",
  ".next", ".venv", "venv", "coverage"
];
const MAX_BATCH_CHARS = 100_000;    // per model call
const MAX_FILE_CHARS  = 40_000;     // per file slice
const MAX_FILES       = 600;        // overall cap to control cost
// ---------------------------------------------

const OR_KEY   = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_MODEL || "openrouter/auto"; // router picks a suitable model
const OR_BASE  = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");

if (!OR_KEY) {
  console.error("❌ Missing OPENROUTER_API_KEY env variable.");
  process.exit(1);
}

// Helpers
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

function promptFor(batch) {
  return `
You are a senior staff engineer performing a repository-wide review.
Analyze the code snippets below for:
- SECURITY (secrets, injections, unsafe eval/exec, SSRF, XSS)
- CORRECTNESS (logic bugs, error handling)
- PERFORMANCE (N+1 queries, heavy loops, blocking calls)
- TEST COVERAGE (critical paths missing tests)
- MAINTAINABILITY (risky patterns worth refactor)

Return STRICT JSON ONLY (no prose, no markdown):
{
  "findings": [
    { "file": "path/relative", "line": 123, "severity": "high|medium|low|info", "comment": "what & why", "suggestion": "optional small patch/snippet" }
  ],
  "summary": "1–2 sentence batch-level summary"
}

If unsure, return:
{"findings": [], "summary": "No major issues identified in this batch."}

--- BEGIN CODE BATCH ---
${batch}
--- END CODE BATCH ---
`;
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

function renderMarkdown(finalOut) {
  const findings = finalOut.findings || [];
  const summary = finalOut.summary || "Full-repo review completed.";
  const rows = findings.map(f =>
    `| ${String(f.severity||"info").toUpperCase()} | \`${f.file||"-"}\` | ${f.line ?? "-"} | ${(f.comment||"").replace(/\n/g," ")} |`
  ).join("\n");
  const suggestions = findings.filter(f => f.suggestion)
    .map((f,i)=>`**Suggestion ${i+1} — ${f.file||""}:${f.line ?? ""}**\n\`\`\`\n${f.suggestion}\n\`\`\``)
    .join("\n\n");

  const table = findings.length
    ? `| Severity | File | Line | Comment |\n|---|---|---|---|\n${rows}\n\n${suggestions ? `---\n${suggestions}\n` : ""}`
    : "_No actionable findings._";

  return `### 🤖 Full Repo Review (OpenRouter)
**Summary:** ${summary}

${table}`;
}

async function callOpenRouter(prompt) {
  // Node 20+ has global fetch. If your runner is older, add `npm i node-fetch` and import it.
  const resp = await fetch(`${OR_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OR_KEY}`,
      // Optional metadata headers recommended by OpenRouter:
      ...(process.env.OR_SITE_URL ? { "HTTP-Referer": process.env.OR_SITE_URL } : {}),
      ...(process.env.OR_PROJECT_NAME ? { "X-Title": process.env.OR_PROJECT_NAME } : {}),
    },
    body: JSON.stringify({
      model: OR_MODEL,          // e.g. "openrouter/auto" or a specific model id
      temperature: 0,
      max_tokens: 800,
      messages: [
        { role: "system", content: "You are a careful, structured code reviewer that always returns strict JSON." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!resp.ok) {
    const errTxt = await resp.text().catch(()=> "");
    throw new Error(`OpenRouter API ${resp.status}: ${errTxt}`);
  }
  const j = await resp.json();
  const text = j?.choices?.[0]?.message?.content ?? "";
  return text;
}

async function run() {
  const allFiles = walk(process.cwd()).slice(0, MAX_FILES);
  if (!allFiles.length) {
    console.log("No source files matched INCLUDE_EXTS."); process.exit(0);
  }

  const batches = batchesFromFiles(allFiles);
  const allFindings = [];
  const summaries = [];

  for (let i = 0; i < batches.length; i++) {
    console.log(`📦 Reviewing batch ${i+1}/${batches.length} with model: ${OR_MODEL} ...`);
    const prompt = promptFor(batches[i]);

    let jsonOut;
    try {
      const raw = await callOpenRouter(prompt);
      try { jsonOut = JSON.parse(raw); }
      catch {
        // Try to salvage JSON if model added extra text
        const m = raw.match(/\{[\s\S]*\}$/);
        if (m) { try { jsonOut = JSON.parse(m[0]); } catch {} }
      }
      if (!jsonOut || typeof jsonOut !== "object") {
        jsonOut = { findings: [], summary: "Model did not return valid JSON." };
      }
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("401")) {
        console.error("❌ 401 Unauthorized from OpenRouter. The API key is invalid/expired or missing scopes.");
        process.exit(1);
      }
      console.error(`❌ Batch ${i+1} failed:`, msg);
      continue;
    }

    const f = Array.isArray(jsonOut.findings) ? jsonOut.findings : [];
    allFindings.push(...f);
    if (jsonOut.summary) summaries.push(String(jsonOut.summary));
  }

  const merged = mergeFindings(allFindings);
  const finalSummary = summaries.length
    ? `Batches: ${batches.length}. ${summaries.slice(0,3).join(" ")}`
    : `Reviewed ${allFiles.length} file(s) across ${batches.length} batch(es).`;

  const finalOut = { summary: finalSummary, findings: merged };

  fs.writeFileSync("codex_full_review.json", JSON.stringify(finalOut, null, 2), "utf8");
  const md = renderMarkdown(finalOut);
  fs.writeFileSync("codex_full_review.md", md, "utf8");

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n", "utf8");
  }

  console.log(`✅ Full repo review complete. Files: ${allFiles.length}, Batches: ${batches.length}, Findings: ${merged.length}`);
}

run().catch(e => {
  console.error("Unexpected failure:", e);
  process.exit(1);
});
