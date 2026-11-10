/**
 * Full-text index over the hub's own history (FTS5 in node:sqlite).
 *
 * The database is derived and disposable: delete `logs/index.db` and the next
 * search rebuilds it. Sources are fixed — `logs/runs*.jsonl`, the working
 * JOURNAL/HANDOFF/history notes and `git log` — nothing else is ever read.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
  create table if not exists meta (key text primary key, value text);
  create virtual table if not exists runs using fts5(
    time unindexed, agent unindexed, status unindexed, cwd unindexed, prompt, output,
    tokenize = 'unicode61 remove_diacritics 2');
  create virtual table if not exists notes using fts5(
    source unindexed, date unindexed, heading unindexed, text,
    tokenize = 'unicode61 remove_diacritics 2');
`;

export function openIndex(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

const getMeta = (db, key) => db.prepare("select value from meta where key = ?").get(key)?.value ?? null;
const setMeta = (db, key, value) =>
  db.prepare("insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value").run(key, String(value));

/** Read bytes [from, size) of a file, returning only whole lines and the new offset. */
function readNewLines(file, from) {
  const size = statSync(file).size;
  if (size <= from) return { lines: [], offset: from };
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], offset: from };
    const chunk = buffer.subarray(0, lastNewline + 1);
    return { lines: chunk.toString("utf8").split("\n").filter((l) => l.trim()), offset: from + chunk.length };
  } finally {
    closeSync(fd);
  }
}

export function indexRuns(db, logsDir) {
  if (!existsSync(logsDir)) return 0;
  const files = readdirSync(logsDir).filter((n) => /^runs(-.*)?\.jsonl$/.test(n)).sort();
  const insert = db.prepare("insert into runs(time, agent, status, cwd, prompt, output) values(?, ?, ?, ?, ?, ?)");
  let added = 0;
  for (const name of files) {
    const path = join(logsDir, name);
    const key = `runs-offset:${name}`;
    let offset = Number(getMeta(db, key) ?? 0);
    if (statSync(path).size < offset) {
      // A file that shrank was rewritten: start the whole runs table over.
      db.exec("delete from runs; delete from meta where key like 'runs-offset:%'");
      return indexRuns(db, logsDir);
    }
    const { lines, offset: next } = readNewLines(path, offset);
    db.exec("begin");
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      insert.run(
        String(rec.time ?? ""), String(rec.agent ?? ""), String(rec.status ?? ""), String(rec.cwd ?? ""),
        String(rec.prompt ?? ""), String(rec.output ?? rec.reason ?? ""),
      );
      added += 1;
    }
    setMeta(db, key, next);
    db.exec("commit");
  }
  return added;
}

/** Split Markdown on `## ` headings; text before the first heading is kept under the file title. */
export function splitSections(markdown) {
  const sections = [];
  let current = { heading: "", lines: [] };
  for (const line of String(markdown).split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      sections.push(current);
      current = { heading: line.replace(/^##\s+/, "").trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, text: s.lines.join("\n").trim() }))
    .filter((s) => s.text || s.heading);
}

const dateOf = (text, fallback) => text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? fallback;

export function indexNotes(db, workingDir) {
  if (!existsSync(workingDir)) return 0;
  const files = [];
  for (const name of ["JOURNAL.md", "HANDOFF.md"]) {
    if (existsSync(join(workingDir, name))) files.push({ path: join(workingDir, name), source: name.replace(".md", "").toLowerCase() });
  }
  const history = join(workingDir, "history");
  if (existsSync(history)) {
    for (const name of readdirSync(history).filter((n) => n.endsWith(".md")).sort()) files.push({ path: join(history, name), source: "history" });
  }
  const insert = db.prepare("insert into notes(source, date, heading, text) values(?, ?, ?, ?)");
  let added = 0;
  for (const { path, source } of files) {
    const mtime = String(statSync(path).mtimeMs);
    const key = `notes-mtime:${path}`;
    if (getMeta(db, key) === mtime) continue;
    const day = new Date(statSync(path).mtimeMs).toISOString().slice(0, 10);
    db.exec("begin");
    db.prepare("delete from notes where source = ? and heading like ?").run(source, `${basename(path)}%`);
    for (const section of splitSections(readFileSync(path, "utf8"))) {
      const heading = `${basename(path)} ${section.heading}`.trim();
      insert.run(source, dateOf(section.heading, day), heading, section.text || section.heading);
      added += 1;
    }
    setMeta(db, key, mtime);
    db.exec("commit");
  }
  return added;
}

export function indexGit(db, repo) {
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  if (head.status !== 0) return 0;
  const sha = head.stdout.trim();
  if (getMeta(db, "git-head") === sha) return 0;
  const log = spawnSync("git", ["-C", repo, "log", "--format=%x1e%h%x1f%cI%x1f%B"], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (log.status !== 0) return 0;
  const insert = db.prepare("insert into notes(source, date, heading, text) values('git', ?, ?, ?)");
  let added = 0;
  db.exec("begin");
  db.exec("delete from notes where source = 'git'");
  for (const entry of log.stdout.split("\x1e").filter((e) => e.trim())) {
    const [hash, date, body] = entry.split("\x1f");
    const text = String(body ?? "").trim();
    insert.run(String(date).slice(0, 10), hash.trim(), text);
    added += 1;
  }
  setMeta(db, "git-head", sha);
  db.exec("commit");
  return added;
}

export function reindex(db, { logsDir, workingDir, repo }) {
  return { runs: indexRuns(db, logsDir), notes: indexNotes(db, workingDir), git: indexGit(db, repo) };
}

/** Quote every word so user text can never be read as FTS5 syntax. */
export function toMatch(query) {
  const words = String(query).split(/\s+/).filter(Boolean);
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
}

const MARK = ["«", "»"];

export function search(db, query, { since = null, source = null, limit = 20 } = {}) {
  const match = toMatch(query);
  if (!match) return [];
  const sinceDay = since ? String(since).slice(0, 10) : null;
  const hits = [];
  if (!source || source === "runs") {
    const rows = db.prepare(
      `select time, agent, status, snippet(runs, -1, ?, ?, '…', 14) as snip, rank
       from runs where runs match ? ${sinceDay ? "and substr(time, 1, 10) >= ?" : ""} order by rank limit ?`,
    ).all(...[MARK[0], MARK[1], match, ...(sinceDay ? [sinceDay] : []), limit]);
    for (const r of rows) hits.push({ source: "runs", date: r.time.slice(0, 16).replace("T", " "), label: `${r.agent} ${r.status}`, snippet: r.snip, rank: r.rank });
  }
  if (!source || source === "notes" || source === "git") {
    const filter = source === "git" ? "and source = 'git'" : source === "notes" ? "and source != 'git'" : "";
    const rows = db.prepare(
      `select source, date, heading, snippet(notes, 3, ?, ?, '…', 14) as snip, rank
       from notes where notes match ? ${filter} ${sinceDay ? "and date >= ?" : ""} order by rank limit ?`,
    ).all(...[MARK[0], MARK[1], match, ...(sinceDay ? [sinceDay] : []), limit]);
    for (const r of rows) hits.push({ source: r.source, date: r.date, label: r.heading, snippet: r.snip, rank: r.rank });
  }
  return hits.sort((a, b) => a.rank - b.rank).slice(0, limit);
}
