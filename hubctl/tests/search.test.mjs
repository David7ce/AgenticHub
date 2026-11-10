import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { openIndex, reindex, search, splitSections, toMatch } from "../search.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "search-"));
  const logs = join(root, "logs");
  const working = join(root, "working");
  mkdirSync(logs);
  mkdirSync(join(working, "history"), { recursive: true });
  writeFileSync(
    join(logs, "runs.jsonl"),
    [
      { time: "2026-11-09T10:00:00Z", agent: "codex", status: "ok", prompt: "fix sandbox", output: "set unelevated mode" },
      { time: "2026-11-10T10:00:00Z", agent: "opencode", status: "failed", prompt: "otra tarea", output: "sesión caída" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  writeFileSync(join(working, "JOURNAL.md"), "# J\n\n## 2026-11-10 — Cuota\nseclogon queda deshabilitado\n\n## 2026-11-08 — Otro\nnada\n");
  writeFileSync(join(working, "HANDOFF.md"), "# H\n\n## Pendiente\nprecios de Codex\n");
  spawnSync("git", ["-C", root, "init", "-q"]);
  writeFileSync(join(root, "f.txt"), "x");
  spawnSync("git", ["-C", root, "add", "."]);
  spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "doctor: aviso de handoff desfasado"]);
  return { root, dirs: { logsDir: logs, workingDir: working, repo: root } };
}

test("toMatch quotes words so FTS syntax in user text is inert", () => {
  assert.equal(toMatch('a "b" OR'), '"a" """b""" "OR"');
});

test("splitSections splits on level-2 headings", () => {
  const s = splitSections("intro\n## A\nuno\n## B\ndos");
  assert.deepEqual(s.map((x) => x.heading), ["", "A", "B"]);
});

test("search finds runs, notes and git, diacritic-insensitive, and filters", () => {
  const { root, dirs } = fixture();
  const db = openIndex(join(root, "logs", "index.db"));
  reindex(db, dirs);
  assert.equal(search(db, "unelevated")[0].source, "runs");
  assert.equal(search(db, "sesion")[0].agent ?? search(db, "sesion")[0].label, "opencode failed");
  assert.equal(search(db, "seclogon")[0].source, "journal");
  assert.equal(search(db, "desfasado")[0].source, "git");
  assert.equal(search(db, "precios")[0].source, "handoff");
  assert.equal(search(db, "unelevated", { since: "2026-11-10" }).length, 0);
  assert.equal(search(db, "seclogon", { source: "runs" }).length, 0);
  assert.equal(search(db, "desfasado", { source: "notes" }).length, 0);
  assert.match(search(db, "seclogon")[0].snippet, /«seclogon»/);
  db.close();
});

test("reindexing is idempotent and picks up appended runs", () => {
  const { root, dirs } = fixture();
  const db = openIndex(join(root, "logs", "index.db"));
  reindex(db, dirs);
  const again = reindex(db, dirs);
  assert.deepEqual(again, { runs: 0, notes: 0, git: 0 });
  appendFileSync(join(dirs.logsDir, "runs.jsonl"), JSON.stringify({ time: "2026-11-11T00:00:00Z", agent: "claude", status: "ok", prompt: "nuevo", output: "zzzmarker" }) + "\n");
  assert.equal(reindex(db, dirs).runs, 1);
  assert.equal(search(db, "zzzmarker").length, 1);
  assert.equal(search(db, "unelevated").length, 1);
  db.close();
});
