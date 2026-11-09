import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function tempDir(prefix = "chatmgr-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeJsonl(path, records) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

/** A Codex home with one live, one archived and one running session. */
export function codexFixture() {
  const home = tempDir("chatmgr-codex-");
  const live = "01a1aaaa-1111-7222-8333-944455556666";
  const archived = "01a1bbbb-1111-7222-8333-944455556666";
  const running = "01a1cccc-1111-7222-8333-944455556666";

  writeJsonl(join(home, "sessions", "2026", "11", "08", `rollout-${live}.jsonl`), [
    { timestamp: "2026-11-08T10:00:00.000Z", type: "session_meta", payload: { id: live, cwd: "D:\\repo", timestamp: "2026-11-08T10:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for D:\\repo" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the parser bug" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
  ]);

  writeJsonl(join(home, "sessions", "2026", "11", "08", `rollout-${running}.jsonl`), [
    { timestamp: "2026-11-08T11:00:00.000Z", type: "session_meta", payload: { id: running, cwd: "D:\\repo", timestamp: "2026-11-08T11:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Long task" }] } },
  ]);
  mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  writeFileSync(join(home, "thread-writer-locks", `${running}.lock`), "");

  writeJsonl(join(home, "archived_sessions", `rollout-${archived}.jsonl`), [
    { timestamp: "2026-11-07T09:00:00.000Z", type: "session_meta", payload: { id: archived, cwd: "C:\\other", timestamp: "2026-11-07T09:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Old archived work" }] } },
  ]);

  writeJsonl(join(home, "session_index.jsonl"), [{ id: live, thread_name: "Parser fix", updated_at: "2026-11-08T10:00:00Z" }]);
  return { home, live, archived, running };
}

/**
 * A Claude home with one idle session and its <id>/ sidecar folder.
 * `ageMs` sets the jsonl mtime so tests can choose idle vs recent; the default
 * is a day old, outside the ten-minute running window.
 */
export function claudeFixture({ ageMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const home = tempDir("chatmgr-claude-");
  const id = "11111111-2222-4333-8444-555555555555";
  const projectDir = join(home, "projects", "D--repo");
  const path = join(projectDir, `${id}.jsonl`);
  writeJsonl(path, [
    { type: "queue-operation", sessionId: id, timestamp: "2026-11-06T09:00:00.000Z" },
    { type: "user", sessionId: id, cwd: "D:\\repo", timestamp: "2026-11-06T09:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Refactor the loader" }] } },
    { type: "assistant", sessionId: id, cwd: "D:\\repo", timestamp: "2026-11-06T09:05:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Refactored." }] } },
  ]);
  const stamp = new Date(now - ageMs);
  utimesSync(path, stamp, stamp);

  const sidecarPath = join(projectDir, id);
  mkdirSync(join(sidecarPath, "subagents"), { recursive: true });
  mkdirSync(join(sidecarPath, "tool-results"), { recursive: true });
  writeFileSync(join(sidecarPath, "subagents", "agent-1.jsonl"), '{"type":"user"}\n', "utf8");
  writeFileSync(join(sidecarPath, "tool-results", "result.txt"), "subagent output\n", "utf8");

  return { home, id, path, projectDir, sidecarPath };
}

/** A Hermes state.db with one closed and one open session. */
export function hermesFixture() {
  const home = tempDir("chatmgr-hermes-");
  const dbPath = join(home, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT, cwd TEXT, last_activity_at REAL, started_at REAL,
      archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, ended_at REAL, message_count INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1
    );
  `);
  const insert = db.prepare(
    "INSERT INTO sessions (id,title,cwd,last_activity_at,started_at,archived,hidden,ended_at,message_count) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  insert.run("local-aaa", "Telegram catch-up", "D:\\repo", 1_760_000_000, 1_760_000_000, 0, 0, 1_760_000_100, 2);
  insert.run("local-bbb", "Still open", "D:\\repo", 1_760_100_000, 1_760_100_000, 0, 0, null, 1);
  db.prepare("INSERT INTO messages (session_id,role,content,timestamp) VALUES (?,?,?,?)").run("local-aaa", "user", "hello", 1_760_000_001);
  db.prepare("INSERT INTO messages (session_id,role,content,timestamp) VALUES (?,?,?,?)").run("local-aaa", "assistant", "hi", 1_760_000_002);
  db.close();
  return { home, dbPath };
}

/** An OpenCode opencode.db with one idle, one archived and one busy session. */
export function opencodeFixture() {
  const home = tempDir("chatmgr-opencode-");
  const dbPath = join(home, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER,
      time_archived INTEGER, time_busy INTEGER, time_idle INTEGER, parent_id TEXT
    );
    CREATE TABLE session_message (
      session_id TEXT, type TEXT, seq INTEGER, data TEXT
    );
  `);
  const insert = db.prepare(
    "INSERT INTO session_v2 (id,title,directory,time_created,time_updated,time_archived,time_busy,time_idle,parent_id) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  insert.run("ses_idle", "Idle chat", "D:/repo", 1_760_000_000_000, 1_760_000_500_000, null, 1_760_000_000_000, 1_760_000_500_000, null);
  insert.run("ses_arch", "Old chat", "D:/repo", 1_750_000_000_000, 1_750_000_500_000, 1_750_100_000_000, 1_750_000_000_000, 1_750_000_500_000, null);
  insert.run("ses_busy", "Busy chat", "D:/repo", 1_760_200_000_000, 1_760_200_900_000, null, 1_760_200_000_000, null, null);
  db.prepare("INSERT INTO session_message (session_id,type,seq,data) VALUES (?,?,?,?)").run(
    "ses_idle",
    "user",
    1,
    JSON.stringify({ content: [{ type: "text", text: "hola" }] }),
  );
  db.close();
  return { home, dbPath };
}

/** A fake provider surface for execute/backup tests. */
export function fakeProviders(overrides = {}) {
  const calls = [];
  const record = (name) => async (conv) => {
    calls.push(`${name}:${conv.id}`);
    if (overrides[conv.id] === "throw") throw new Error("boom");
  };
  const providers = {
    opencode: {
      remove: record("remove"),
      exportDump: async (conv) => ({ provider: "opencode", id: conv.id }),
    },
    codex: {
      remove: record("remove"),
      archive: record("archive"),
      unarchive: record("unarchive"),
      exportDump: async (conv) => ({ provider: "codex", id: conv.id }),
    },
  };
  return { providers, calls };
}
