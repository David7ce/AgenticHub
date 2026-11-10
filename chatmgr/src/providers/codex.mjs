import { automatedCodexMeta, automatedPath } from "../core/automated.mjs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { cleanTitle, flattenContent, isInjected, renderTranscript } from "./text.mjs";
import { mustRun, safeId } from "./exec.mjs";
import { toMs } from "../core/time.mjs";

/**
 * Codex keeps one rollout JSONL per session under
 * $CODEX_HOME/sessions/YYYY/MM/DD/, moves archived ones to
 * $CODEX_HOME/archived_sessions, and names them in session_index.jsonl.
 * Deletion goes through `codex delete`, never through the files, so the
 * thread database and index stay consistent.
 */
export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

function walkJsonl(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  return out;
}

/** Reads the head of a rollout without loading a 24 MB transcript. */
export function parseRollout(path, readFile = readFileSync) {
  const buffer = readFile(path);
  const head = buffer.subarray(0, Math.min(buffer.length, 64 * 1024)).toString("utf8");
  const lines = head.split(/\r?\n/).filter(Boolean);
  let meta = null;
  let firstUser = "";
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a truncated last line is normal
    }
    if (record.type === "session_meta" && record.payload?.id) {
      meta = record.payload;
      continue;
    }
    if (
      !firstUser &&
      record.type === "response_item" &&
      record.payload?.type === "message" &&
      record.payload.role === "user"
    ) {
      const text = flattenContent(record.payload.content);
      if (text && !isInjected(text)) firstUser = text;
    }
  }
  return { meta, firstUser };
}

export function readIndex(home = codexHome()) {
  const path = join(home, "session_index.jsonl");
  const map = new Map();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.id) map.set(row.id, row.thread_name);
    } catch {
      /* ignore malformed index lines */
    }
  }
  return map;
}

export function list({ home = codexHome() } = {}) {
  const index = readIndex(home);
  const rows = [];
  for (const [dirName, archived] of [
    ["sessions", false],
    ["archived_sessions", true],
  ]) {
    for (const path of walkJsonl(join(home, dirName))) {
      let parsed;
      try {
        parsed = parseRollout(path);
      } catch {
        continue;
      }
      const meta = parsed.meta;
      if (!meta?.id) continue;
      const stat = statSync(path);
      rows.push({
        provider: "codex",
        id: meta.id,
        title: index.get(meta.id) || cleanTitle(parsed.firstUser) || "(untitled)",
        automated: automatedCodexMeta(meta) || automatedPath(meta?.cwd),
        projectPath: meta.cwd || "",
        lastActivity: toMs(stat.mtimeMs),
        archived,
        running: existsSync(join(home, "thread-writer-locks", `${meta.id}.lock`)),
        sourcePath: path,
        sizeBytes: stat.size,
      });
    }
  }
  return rows;
}

export function readTranscript(path, { limit = 40 } = {}) {
  const messages = [];
  let lines;
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "response_item" || record.payload?.type !== "message") continue;
    const role = record.payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = flattenContent(record.payload.content);
    if (!text || isInjected(text)) continue;
    messages.push({ role, text });
  }
  return messages.slice(-limit);
}

export async function preview(conv, { readTranscriptFn = readTranscript } = {}) {
  return renderTranscript(readTranscriptFn(conv.sourcePath));
}

export async function remove(conv, { run }) {
  await mustRun(run, "codex", ["delete", "--force", safeId(conv.id)], `codex delete ${conv.id}`);
}

export async function archive(conv, { run, unarchive = false }) {
  await mustRun(run, "codex", [unarchive ? "unarchive" : "archive", safeId(conv.id)], `codex ${unarchive ? "unarchive" : "archive"} ${conv.id}`);
}

export const unarchive = (conv, options) => archive(conv, { ...options, unarchive: true });

export { sep };
