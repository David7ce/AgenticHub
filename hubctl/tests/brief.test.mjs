import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { gatherBrief, parseWatchList, pendingSection, renderBrief, summarizePending, MAX_LINES } from "../commands/brief.mjs";

const doctorOk = { ok: true, counts: { ok: 14, warn: 1, fail: 0 }, checks: [
  { level: "ok", check: "consent", detail: "fine" },
  { level: "warn", check: "links", detail: "one broken link" },
] };

test("pendingSection returns the section body without blanks or later sections", () => {
  const md = "# H\n\n## Pendiente, en orden\n\nuno\n\ndos\n\n## Estado\nno\n";
  assert.deepEqual(pendingSection(md), ["uno", "dos"]);
  assert.deepEqual(pendingSection("# nada"), []);
});

test("parseWatchList skips comments and resolves relative paths", () => {
  const rows = parseWatchList("# c\n\nfoo\n", join(tmpdir(), "base"));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].endsWith("foo"));
});

test("gatherBrief + renderBrief stay within the line budget and report dirty repos", () => {
  const root = mkdtempSync(join(tmpdir(), "brief-"));
  mkdirSync(join(root, "working"));
  const pending = Array.from({ length: 80 }, (_, i) => `- item ${i}`).join("\n");
  writeFileSync(join(root, "working", "HANDOFF.md"), `## Pendiente\n${pending}\n`);
  const log = join(root, "runs.jsonl");
  const today = new Date().toISOString();
  writeFileSync(log, `${JSON.stringify({ time: today, agent: "claude", status: "ok", durationMs: 2500, cost: 0.25 })}\n`);
  const consent = join(root, "consent.json");
  writeFileSync(consent, JSON.stringify({ claude: { enabled: true, overseerAck: true } }));

  const brief = gatherBrief({
    root,
    stateDir: root,
    hub: root,
    logPath: log,
    consentPath: consent,
    doctor: doctorOk,
    dirty: (dir) => ({ dir, name: "AgentHub", missing: false, changed: 3 }),
  });
  assert.equal(brief.spend.claude, 0.25);
  assert.equal(brief.runs[0].agent, "claude");
  const text = renderBrief(brief);
  const lines = text.split("\n");
  assert.ok(lines.length <= MAX_LINES, `${lines.length} lines`);
  assert.match(text, /warn links: one broken link/);
  assert.match(text, /AgentHub \(3\)/);
  assert.match(text, /claude \$0\.25/);
  assert.match(text, /puntos más en HANDOFF/);
});

test("summarizePending joins wrapped bullets, drops link targets and keeps one sentence", () => {
  const out = summarizePending([
    "0. **Uno (2026-11-10)**: primera frase larga con [`link`](ruta.md) y `code`.",
    "   Continuación que no debe salir.",
    "desfasado, y esto tampoco debe empezar un punto.",
    "",
    "- **Dos** — solo una frase",
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0], "**Uno (2026-11-10)**: primera frase larga con link y code.");
  assert.equal(out[1], "**Dos** — solo una frase");
});

test("brief on a real git repo counts uncommitted files", () => {
  const root = mkdtempSync(join(tmpdir(), "brief-git-"));
  spawnSync("git", ["-C", root, "init", "-q"]);
  writeFileSync(join(root, "a.txt"), "x");
  const brief = gatherBrief({ root, stateDir: root, hub: root, logPath: join(root, "none.jsonl"), consentPath: join(root, "none.json"), doctor: doctorOk });
  assert.equal(brief.repos[0].changed, 1);
  assert.equal(brief.pending, null);
});
