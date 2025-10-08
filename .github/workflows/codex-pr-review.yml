import { Octokit } from "@octokit/rest";
import { Codex } from "@openai/codex-sdk";

const gh = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.REPO.split("/");
const prNumber = Number(process.env.PR_NUMBER);

const MAX = 120_000;
const truncate = (s) => (s.length > MAX ? s.slice(0, MAX) + "\n... [truncated]" : s);

async function getUnifiedDiff() {
  const files = await gh.paginate(gh.pulls.listFiles, {
    owner, repo, pull_number: prNumber, per_page: 100
  });
  let combined = "";
  for (const f of files) if (f.patch) {
    combined += `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n\n`;
  }
  return truncate(combined);
}

const STACK_HINT = `
Repo policy:
- Avoid hardcoded secrets or SQL string concatenation
- Use proper error handling, validations, and tests
- Keep components efficient and maintainable
`;

function promptFor(diff) {
  return `
You are a senior reviewer. Review this unified diff for SECURITY, CORRECTNESS, PERFORMANCE, and TEST COVERAGE.
Return STRICT JSON:
{
  "summary": "ALWAYS include 1–2 sentences on overall quality and risk, even if no issues are found.",
  "findings": [
    { "file": "path/in/repo", "line": 123, "severity": "high|medium|low|info",
      "comment": "specific issue & why it matters",
      "suggestion": "optional minimal patch" }
  ],
  "notes": ["If findings is empty, add positive observations."]
}

Context:
${STACK_HINT}

--- BEGIN DIFF ---
${diff}
--- END DIFF ---
`;
}

function renderMarkdown(out) {
  if (typeof out === "string") { try { out = JSON.parse(out); } catch { out = {}; } }
  const findings = Array.isArray(out.findings) ? out.findings : [];
  const summary = out.summary?.trim() || "No major risks detected.";
  const notes = Array.isArray(out.notes) ? out.notes : [];

  const rows = findings.map(f =>
    `| ${String(f.severity||"info").toUpperCase()} | \`${f.file||"-"}\` | ${f.line ?? "-"} | ${(f.comment||"").replace(/\n/g," ")} |`
  ).join("\n");

  const suggestions = findings
    .filter(f => f.suggestion)
    .map((f, i) => `**Suggestion ${i+1} — ${f.file||""}:${f.line ?? ""}**\n\`\`\`\n${f.suggestion}\n\`\`\``)
    .join("\n\n");

  const notesBlock = (!findings.length && notes.length)
    ? `\n**Notes:**\n- ${notes.map(n => String(n)).join("\n- ")}\n` : "";

  const table = findings.length
    ? `| Severity | File | Line | Comment |\n|---|---|---|---|\n${rows}\n\n${suggestions ? `---\n${suggestions}\n` : ""}`
    : "_No actionable findings._";

  return `### 🤖 Codex PR Review
**Summary:** ${summary}

${table}${notesBlock}`;
}

(async () => {
  try {
    const diff = await getUnifiedDiff();
    if (!diff.trim()) {
      await gh.issues.createComment({ owner, repo, issue_number: prNumber, body: "No textual diff to review." });
      return;
    }

    const codex = new Codex();        // uses OPENAI_API_KEY from env
    const t = codex.startThread();
    const result = await t.run(promptFor(diff), { output: "json" });

    const body = renderMarkdown(result);
    await gh.issues.createComment({ owner, repo, issue_number: prNumber, body });
    console.log("✅ Posted Codex review comment");
  } catch (e) {
    console.error("❌ Reviewer failed:", e.message);
    await gh.issues.createComment({
      owner, repo, issue_number: prNumber,
      body: `Codex reviewer failed: \`${String(e.message || e)}\``
    }).catch(()=>{});
  }
})();
