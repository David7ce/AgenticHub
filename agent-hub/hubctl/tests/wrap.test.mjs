import test from "node:test";
import assert from "node:assert/strict";

import { buildDraft, insertEntry, parseMarker, pickRuns } from "../commands/wrap.mjs";

test("parseMarker reads time and hash, and rejects garbage", () => {
  assert.deepEqual(parseMarker("2026-11-10T10:00:00.000Z\nabc1234\n"), { time: "2026-11-10T10:00:00.000Z", hash: "abc1234" });
  assert.equal(parseMarker("nope"), null);
  assert.equal(parseMarker(""), null);
});

test("pickRuns keeps only failed or costly runs after the marker", () => {
  const jsonl = [
    { time: "2026-11-10T08:00:00Z", agent: "a", status: "failed", prompt: "old" },
    { time: "2026-11-10T11:00:00Z", agent: "codex", status: "ok", cost: 0.4, prompt: "pagó\n  algo" },
    { time: "2026-11-10T11:05:00Z", agent: "opencode", status: "ok", cost: 0, prompt: "gratis" },
    { time: "2026-11-10T11:10:00Z", agent: "claude", status: "timeout", prompt: "falló" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n";
  const rows = pickRuns(jsonl, "2026-11-10T10:00:00Z");
  assert.deepEqual(rows.map((r) => r.agent), ["codex", "claude"]);
  assert.equal(rows[0].prompt, "pagó algo");
});

test("buildDraft lists commits, runs, warnings and dirty repos", () => {
  const draft = buildDraft({
    now: new Date("2026-11-10T20:30:00Z"),
    commits: [{ hash: "3b8b848", subject: "acp: split" }, { hash: "c0b1260", subject: "chatmgr: fix" }],
    runs: [{ time: "11:00", agent: "codex", status: "ok", cost: 0.4, prompt: "x" }],
    issues: [{ level: "warn", check: "links", detail: "broken" }],
    dirty: [{ name: "AgentHub", changed: 2 }, { name: "Clean", changed: 0 }],
  });
  assert.match(draft, /^## 2026-11-10 \(20:30\) — TITLE/);
  assert.match(draft, /`3b8b848` acp: split/);
  assert.match(draft, /codex ok \$0\.40/);
  assert.match(draft, /warn links: broken/);
  assert.match(draft, /AgentHub \(2\)/);
  assert.doesNotMatch(draft, /Clean/);
  assert.match(buildDraft({ now: new Date(), commits: [], runs: [], issues: [], dirty: [] }), /none since the last wrap/);
});

test("insertEntry puts the entry under the title and keeps CRLF", () => {
  const out = insertEntry("# Journal\r\n\r\n## viejo\r\ntexto\r\n", "## nuevo\n- a");
  assert.equal(out, "# Journal\r\n\r\n## nuevo\r\n- a\r\n\r\n## viejo\r\ntexto\r\n");
});
