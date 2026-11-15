import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { openIndex, indexRuns, indexNotes, reindex, search, splitSections, toMatch } from "../search.mjs";

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



function indexFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "search-refresh-"));
  const logs = join(root, "logs"), working = join(root, "working");
  mkdirSync(logs);
  mkdirSync(join(working, "history"), { recursive: true });
  const db = openIndex(join(root, "index.db"));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, logs, working, db };
}
const runLine = (output) => JSON.stringify({ time: "2026-11-15T00:00:00Z", agent: "a", status: "ok", output }) + "\n";

test("rotation preserves old hits once and indexes a larger replacement from its first line", (t) => {
  const { logs, db } = indexFixture(t);
  const live = join(logs, "runs.jsonl");
  writeFileSync(live, runLine("oldmarker"));
  indexRuns(db, logs);
  renameSync(live, join(logs, "runs-20261115.jsonl"));
  writeFileSync(live, runLine("newmarker") + runLine("lastentry"));
  indexRuns(db, logs);
  for (const word of ["oldmarker", "newmarker", "lastentry"]) assert.equal(search(db, word).length, 1, word);
  assert.equal(indexRuns(db, logs), 0);
});

test("same-size and shorter rewrites replace stale indexed rows", (t) => {
  const { logs, db } = indexFixture(t);
  const live = join(logs, "runs.jsonl");
  writeFileSync(live, runLine("oldmarker"));
  indexRuns(db, logs);
  writeFileSync(live, runLine("newmarker"));
  indexRuns(db, logs);
  assert.equal(search(db, "oldmarker").length, 0);
  assert.equal(search(db, "newmarker").length, 1);
  writeFileSync(live, runLine("short"));
  indexRuns(db, logs);
  assert.equal(search(db, "newmarker").length, 0);
  assert.equal(search(db, "short").length, 1);
});

test("a partial final record is indexed once when completed", (t) => {
  const { logs, db } = indexFixture(t);
  const live = join(logs, "runs.jsonl");
  const line = runLine("multibyte café completion");
  writeFileSync(live, runLine("firstmarker") + line.slice(0, -3));
  assert.equal(indexRuns(db, logs), 1);
  assert.equal(search(db, "completion").length, 0);
  appendFileSync(live, line.slice(-3));
  assert.equal(indexRuns(db, logs), 1);
  assert.equal(indexRuns(db, logs), 0);
  assert.equal(search(db, "cafe").length, 1);
});

test("deleted run sources disappear without changing records from other files", (t) => {
  const { logs, db } = indexFixture(t);
  const archive = join(logs, "runs-archive.jsonl");
  writeFileSync(archive, runLine("archivemarker"));
  writeFileSync(join(logs, "runs.jsonl"), runLine("livemarker"));
  indexRuns(db, logs);
  rmSync(archive);
  indexRuns(db, logs);
  assert.equal(search(db, "archivemarker").length, 0);
  assert.equal(search(db, "livemarker").length, 1);
  rmSync(logs, { recursive: true });
  indexRuns(db, logs);
  assert.equal(search(db, "livemarker").length, 0);
});

test("deleted and renamed notes are reconciled without touching git history", (t) => {
  const { working, db } = indexFixture(t);
  const handoff = join(working, "HANDOFF.md");
  writeFileSync(handoff, "## State\nremovedmarker\n");
  indexNotes(db, working);
  db.prepare("insert into notes(source, date, heading, text) values('git', '2026-11-15', 'abc', 'gitmarker')").run();
  renameSync(handoff, join(working, "history", "handoff.md"));
  indexNotes(db, working);
  const hits = search(db, "removedmarker");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "history");
  rmSync(working, { recursive: true });
  indexNotes(db, working);
  assert.equal(search(db, "removedmarker").length, 0);
  assert.equal(search(db, "gitmarker").length, 1);
});

test("note filenames containing SQL wildcard characters do not erase neighboring files", (t) => {
  const { working, db } = indexFixture(t);
  const first = join(working, "history", "a_.md");
  writeFileSync(first, "## First\nfirstmarker\n");
  writeFileSync(join(working, "history", "ab.md"), "## Second\nsecondmarker\n");
  indexNotes(db, working);
  writeFileSync(first, "## Updated\nupdatedmarker and more text\n");
  indexNotes(db, working);
  assert.equal(search(db, "firstmarker").length, 0);
  assert.equal(search(db, "updatedmarker").length, 1);
  assert.equal(search(db, "secondmarker").length, 1);
});

test("an interrupted refresh rolls back rows and offsets so retry loses no records", (t) => {
  const { logs, db } = indexFixture(t);
  const live = join(logs, "runs.jsonl");
  writeFileSync(live, runLine("oldmarker"));
  indexRuns(db, logs);
  writeFileSync(live, runLine("newmarker"));
  db.exec(`create trigger fail_refresh before insert on meta
    when new.key like 'runs-state:%' begin select raise(abort, 'refresh interrupted'); end`);
  assert.throws(() => indexRuns(db, logs), /refresh interrupted/);
  assert.equal(search(db, "oldmarker").length, 1, "the old snapshot is still usable");
  assert.equal(search(db, "newmarker").length, 0, "partial replacements were rolled back");
  db.exec("drop trigger fail_refresh");
  assert.equal(indexRuns(db, logs), 1);
  assert.equal(search(db, "oldmarker").length, 0);
  assert.equal(search(db, "newmarker").length, 1);
});

test("legacy caches rebuild once without modifying source logs", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "search-upgrade-"));
  const logs = join(root, "logs"), working = join(root, "working");
  mkdirSync(logs); mkdirSync(working);
  const live = join(logs, "runs.jsonl"), path = join(root, "index.db");
  const original = runLine("originalmarker");
  writeFileSync(live, original);
  let db = new DatabaseSync(path);
  t.after(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec(`create table meta (key text primary key, value text);
    create virtual table runs using fts5(time unindexed, agent unindexed, status unindexed, cwd unindexed, prompt, output);
    create virtual table notes using fts5(source unindexed, date unindexed, heading unindexed, text);
    insert into runs(output) values('stalemarker');
    insert into notes(source,text) values('handoff','stalemarker');
    insert into meta values('runs-offset:runs.jsonl','999');
    insert into meta values('git-head','stale-head');`);
  db.close(); db = null;
  db = openIndex(path);
  assert.equal(indexRuns(db, logs), 1);
  indexNotes(db, working);
  assert.equal(search(db, "originalmarker").length, 1);
  assert.equal(search(db, "stalemarker").length, 0);
  assert.equal(db.prepare("select value from meta where key = 'git-head'").get(), undefined, "git history will be reindexed too");
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(live, "utf8"), original);
  db.close(); db = null;
  db = openIndex(path);
  assert.equal(indexRuns(db, logs), 0, "reopening the upgraded cache keeps its offsets");
  assert.equal(search(db, "originalmarker").length, 1);
});

test("invalid JSON and non-record values do not prevent later run records from being indexed", (t) => {
  const { logs, db } = indexFixture(t);
  writeFileSync(join(logs, "runs.jsonl"), 'not json\nnull\n[]\n42\nfalse\n' + runLine("validmarker"));
  assert.equal(indexRuns(db, logs), 1);
  assert.equal(indexRuns(db, logs), 0);
  assert.equal(search(db, "validmarker").length, 1);
});
