import { automatedPath, automatedTitle } from "../core/automated.mjs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanTitle, renderTranscript } from "./text.mjs";
import { mustRun, safeId } from "./exec.mjs";
import { toMs } from "../core/time.mjs";

/**
 * OpenCode v2 stores sessions in opencode.db (session_v2, session_message).
 * The manager reads that database read-only for listing and preview, and
 * deletes through `opencode session delete`, which also removes child
 * sessions and their data. Archive has no CLI, so it stays unsupported.
 */
export function opencodeHome(env = process.env) {
  const candidates = [
    env.OPENCODE_DATA_HOME,
    join(homedir(), ".local", "share", "opencode"),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "opencode") : null,
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? candidates[1];
}

export function sessionDb(home = opencodeHome()) {
  return join(home, "opencode.db");
}

function openReadOnly(dbPath) {
  if (!existsSync(dbPath)) return null;
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function list({ dbPath = sessionDb() } = {}) {
  const db = openReadOnly(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id, title, directory, time_created, time_updated, time_archived,
                time_busy, time_idle, parent_id
           FROM session_v2
          WHERE parent_id IS NULL
          ORDER BY time_updated DESC`,
      )
      .all();
    const childCount = db.prepare("SELECT COUNT(*) AS n FROM session_v2 WHERE parent_id = ?");
    return rows.map((row) => ({
      provider: "opencode",
      id: row.id,
      title: cleanTitle(row.title) || "(untitled)",
      projectPath: row.directory || "",
      automated: automatedTitle(row.title) || automatedPath(row.directory),
      lastActivity: toMs(row.time_updated) || toMs(row.time_created),
      archived: row.time_archived != null,
      // A session is live while it was marked busy and has not gone idle again.
      running: row.time_busy != null && (row.time_idle == null || row.time_busy > row.time_idle),
      sourcePath: null,
      sizeBytes: null,
      childCount: childCount.get(row.id)?.n ?? 0,
    }));
  } finally {
    db.close();
  }
}

export function readMessages(conv, { dbPath = sessionDb(), limit = 40 } = {}) {
  const db = openReadOnly(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT type, data FROM session_message
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT ?`,
      )
      .all(conv.id, limit);
    return rows
      .reverse()
      .map((row) => ({ role: row.type, text: extractText(row.data) }))
      .filter((row) => row.text.trim());
  } finally {
    db.close();
  }
}

/** session_message.data carries content: [{type:"text", text}, ...]. */
export function extractText(data) {
  let parsed;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    return "";
  }
  const content = parsed?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

export async function preview(conv, options = {}) {
  return renderTranscript(readMessages(conv, options));
}

export function exportDump(conv, { dbPath = sessionDb() } = {}) {
  const db = openReadOnly(dbPath);
  if (!db) throw new Error(`OpenCode database not found at ${dbPath}`);
  try {
    const session = db.prepare("SELECT * FROM session_v2 WHERE id = ?").get(conv.id) ?? null;
    const messages = db
      .prepare("SELECT * FROM session_message WHERE session_id = ? ORDER BY seq")
      .all(conv.id);
    return { provider: "opencode", exportedAt: new Date().toISOString(), session, messages };
  } finally {
    db.close();
  }
}

export async function remove(conv, { run }) {
  await mustRun(run, "opencode", ["session", "delete", safeId(conv.id)], `opencode session delete ${conv.id}`);
}

export async function archive() {
  throw new Error("OpenCode has no archive command");
}

export const resumeCommand = (conv) => `opencode --session ${conv.id}`;
