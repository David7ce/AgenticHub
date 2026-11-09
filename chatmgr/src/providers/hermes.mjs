import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanTitle, renderTranscript } from "./text.mjs";
import { mustRun, safeId } from "./exec.mjs";
import { toMs } from "../core/time.mjs";

/**
 * Hermes keeps sessions in a SQLite database (state.db) and exposes them
 * through `hermes sessions`. Listing and previewing read the database
 * read-only; deleting goes through the CLI so FTS, transcripts and leases are
 * maintained by the agent itself.
 */
export function hermesHome(env = process.env) {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "hermes");
  const xdg = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const xdgPath = join(xdg, "hermes");
  return existsSync(xdgPath) ? xdgPath : join(homedir(), ".hermes");
}

export function stateDb(home = hermesHome()) {
  return join(home, "state.db");
}

export function list({ dbPath = stateDb() } = {}) {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, title, cwd, last_activity_at, started_at, archived, hidden, ended_at, message_count
           FROM sessions
          WHERE COALESCE(hidden, 0) = 0`,
      )
      .all();
    return rows.map((row) => ({
      provider: "hermes",
      id: row.id,
      title: cleanTitle(row.title) || "(untitled)",
      projectPath: row.cwd || "",
      lastActivity: toMs(row.last_activity_at) || toMs(row.started_at),
      archived: Boolean(row.archived),
      // No end timestamp means the session was never closed; treat it as live.
      running: row.ended_at == null,
      sourcePath: null,
      sizeBytes: null,
      messageCount: row.message_count ?? 0,
    }));
  } finally {
    db.close();
  }
}

export function readMessages(conv, { dbPath = stateDb(), limit = 40 } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT role, content FROM messages
          WHERE session_id = ? AND COALESCE(active, 1) = 1
          ORDER BY timestamp, rowid
          LIMIT ?`,
      )
      .all(conv.id, limit)
      .map((row) => ({ role: row.role, text: String(row.content ?? "") }))
      .filter((row) => row.text.trim());
  } finally {
    db.close();
  }
}

export async function preview(conv, options = {}) {
  return renderTranscript(readMessages(conv, options));
}

export function exportDump(conv, { dbPath = stateDb() } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(conv.id) ?? null;
    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, rowid")
      .all(conv.id);
    return { provider: "hermes", exportedAt: new Date().toISOString(), session, messages };
  } finally {
    db.close();
  }
}

export async function remove(conv, { run }) {
  await mustRun(run, "hermes", ["sessions", "delete", "--yes", safeId(conv.id)], `hermes sessions delete ${conv.id}`);
}

export async function archive() {
  throw new Error("hermes archive is bulk-filter only; single-session archive is not supported");
}

export const resumeCommand = (conv) => `hermes chat --resume ${conv.id}`;
