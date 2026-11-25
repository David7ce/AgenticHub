/**
 * Full-text index over the hub's own history (FTS5 in node:sqlite).
 *
 * The database is derived and disposable: delete `logs/index.db` and the next
 * search rebuilds it. Sources are fixed — `logs/runs*.jsonl`, the working
 * JOURNAL/HANDOFF/history notes and `git log` — nothing else is ever read.
 */
import { existsSync, readdirSync, statSync, readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const SCHEMA = `
  create table if not exists meta (key text primary key, value text);
  create virtual table if not exists runs using fts5(
    time unindexed, agent unindexed, status unindexed, cwd unindexed, prompt, output, file unindexed,
    tokenize = 'unicode61 remove_diacritics 2');
  create virtual table if not exists notes using fts5(
    source unindexed, date unindexed, heading unindexed, text, file unindexed,
    tokenize = 'unicode61 remove_diacritics 2');
`;

// This cache contains only derived rows. Older caches lack source ownership;
// rebuild them once so stale rows from a previous rotation cannot survive.
const SCHEMA_VERSION = "2";

function transaction(db, work) {
  db.exec("begin");
  try {
    const result = work();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function openIndex(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("create table if not exists meta (key text primary key, value text)");
    if (getMeta(db, "schema-version") !== SCHEMA_VERSION) {
      transaction(db, () => {
        db.exec("drop table if exists runs; drop table if exists notes; delete from meta");
        db.exec(SCHEMA);
        setMeta(db, "schema-version", SCHEMA_VERSION);
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const getMeta = (db, key) => db.prepare("select value from meta where key = ?").get(key)?.value ?? null;
const setMeta = (db, key, value) =>
  db.prepare("insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value").run(key, String(value));
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const signature = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

// Only these two internal table names are used; file paths are bound values.
function removeMissing(db, table, prefix, current) {
  const previous = db.prepare("select key from meta where key like ?").all(`${prefix}%`);
  const removeRows = db.prepare(`delete from ${table} where file = ?`);
  const removeMeta = db.prepare("delete from meta where key = ?");
  for (const { key } of previous) {
    const file = key.slice(prefix.length);
    if (current.has(file)) continue;
    removeRows.run(file);
    removeMeta.run(key);
  }
}

export function indexRuns(db, logsDir) {
  const files = existsSync(logsDir)
    ? readdirSync(logsDir).filter((name) => /^runs(-.*)?\.jsonl$/.test(name)).sort().map((name) => resolve(logsDir, name))
    : [];
  return transaction(db, () => {
    removeMissing(db, "runs", "runs-state:", new Set(files));
    const insert = db.prepare("insert into runs(time, agent, status, cwd, prompt, output, file) values(?, ?, ?, ?, ?, ?, ?)");
    let added = 0;
    for (const file of files) {
      const key = `runs-state:${file}`;
      const previous = JSON.parse(getMeta(db, key) ?? "null");
      const currentSignature = signature(statSync(file));
      if (previous?.signature === currentSignature) continue;
      const buffer = readFileSync(file);
      let offset = previous?.offset ?? 0;
      // File size alone cannot distinguish append from rotation or an in-place
      // rewrite. Check the already-indexed prefix before trusting its offset.
      if (previous && (buffer.length < offset || hash(buffer.subarray(0, offset)) !== previous.hash)) {
        db.prepare("delete from runs where file = ?").run(file);
        offset = 0;
      }
      const lastNewline = buffer.lastIndexOf(0x0a);
      const next = lastNewline >= offset ? lastNewline + 1 : offset;
      for (const line of buffer.subarray(offset, next).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
        insert.run(
          String(rec.time ?? ""), String(rec.agent ?? ""), String(rec.status ?? ""), String(rec.cwd ?? ""),
          String(rec.prompt ?? ""), String(rec.output ?? rec.reason ?? ""), file,
        );
        added += 1;
      }
      setMeta(db, key, JSON.stringify({ signature: currentSignature, offset: next, hash: hash(buffer.subarray(0, next)) }));
    }
    return added;
  });
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
  const files = [];
  for (const name of ["JOURNAL.md", "HANDOFF.md"]) {
    const file = resolve(workingDir, name);
    if (existsSync(file)) files.push({ file, source: name.replace(".md", "").toLowerCase() });
  }
  const history = join(workingDir, "history");
  if (existsSync(history)) {
    for (const name of readdirSync(history).filter((name) => name.endsWith(".md")).sort()) {
      files.push({ file: resolve(history, name), source: "history" });
    }
  }
  return transaction(db, () => {
    removeMissing(db, "notes", "notes-state:", new Set(files.map(({ file }) => file)));
    const insert = db.prepare("insert into notes(source, date, heading, text, file) values(?, ?, ?, ?, ?)");
    let added = 0;
    for (const { file, source } of files) {
      const stat = statSync(file);
      const key = `notes-state:${file}`;
      const currentSignature = signature(stat);
      if (getMeta(db, key) === currentSignature) continue;
      const sections = splitSections(readFileSync(file, "utf8"));
      const day = new Date(stat.mtimeMs).toISOString().slice(0, 10);
      db.prepare("delete from notes where file = ?").run(file);
      for (const section of sections) {
        const heading = `${basename(file)} ${section.heading}`.trim();
        insert.run(source, dateOf(section.heading, day), heading, section.text || section.heading, file);
        added += 1;
      }
      setMeta(db, key, currentSignature);
    }
    return added;
  });
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

