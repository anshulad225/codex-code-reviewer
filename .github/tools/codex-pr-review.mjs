import fs from "fs";
import path from "path";
import { Codex } from "@openai/codex-sdk";

// ---------- config ----------
const INCLUDE_EXTS = [".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".go", ".rb", ".php", ".cs", ".cpp", ".c", ".rs", ".kt", ".m", ".swift", ".sql", ".sh", ".yml", ".yaml"];
const EXCLUDE_DIRS = [".git", "node_modules", "dist", "build", "out", ".next", ".venv", "venv", "coverage"];
const MAX_BATCH_CHARS = 100_000;    // per Codex call
const MAX_FILE_CHARS = 40_000;      // per file slice
const MAX_FILES = 500;              // overall hard cap to control cost
// -----------------------------

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

Return STRICT JSON:
{
  "findings": [
    { "file": "path/relative", "line": 123, "severity": "high|medium|low|info", "comment": "what & why", "suggestion": "optional small patch/snippet" }
  ],
  "summary": "1–2 sentence batch-level summary"
}

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

  return `### 🤖 Codex Full Repo Review
**Summary:** ${summary}

${table}`;
}

async function run() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY env.");
    process.exit(1);
  }

  const allFiles = walk(process.cwd()).slice(0, MAX_FILES);
  if (!allFiles.length) {
    console.log("No source files matched INCLUDE_EXTS."); process.exit(0);
  }

  const batches = batchesFromFiles(allFiles);
  const codex = new Codex();
  const t = codex.startThread();

  const allFindings = [];
  const summaries = [];
  for (let i = 0; i < batches.length; i++) {
    const prompt = promptFor(batches[i]);
    let out;
    try {
      out = await t.run(prompt, { output: "json" });
    } catch (e) {
      console.error(`Batch ${i+1}/${batches.length} failed:`, e.message);
      continue;
    }
    const f = Array.isArray(out.findings) ? out.findings : [];
    f.forEach(x => {
      if (!x.file) return;
      // normalize path looks
      x.file = String(x.file);
      if (!INCLUDE_EXTS.some(ext => x.file.endsWith(ext))) {
        // keep anyway; Codex may echo the correct relative path already
      }
    });
    allFindings.push(...f);
    if (out.summary) summaries.push(String(out.summary));
  }

  const merged = mergeFindings(allFindings);
  const finalSummary = summaries.length
    ? `Batches: ${batches.length}. ` + summaries.slice(0,3).join(" ")
    : `Reviewed ${allFiles.length} file(s) across ${batches.length} batch(es).`;

  const finalOut = { summary: finalSummary, findings: merged };

  // write artifacts
  fs.writeFileSync("codex_full_review.json", JSON.stringify(finalOut, null, 2), "utf8");
  const md = renderMarkdown(finalOut);
  fs.writeFileSync("codex_full_review.md", md, "utf8");

  // publish to GitHub job summary (if available)
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n", "utf8");
  }

  console.log(`✅ Full repo review complete. Files: ${allFiles.length}, Batches: ${batches.length}, Findings: ${merged.length}`);
}

run().catch(e => {
  console.error("Unexpected failure:", e);
  process.exit(1);
});
