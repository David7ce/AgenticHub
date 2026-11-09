import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cleanTitle, flattenContent, isInjected, renderTranscript } from "./text.mjs";
import { toMs } from "../core/time.mjs";

/**
 * Claude Code stores one JSONL per session under
 * ~/.claude/projects/<encoded-project>/<sessionId>.jsonl and has no per-session
 * delete command. The manager lists and previews them, and deliberately leaves
 * deletion to the app's own `/resume` picker or the project-wide `claude purge`.
 */
export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function parseTranscript(path, readFile = readFileSync) {
  const raw = readFile(path, "utf8");
  let sessionId = "";
  let cwd = "";
  let firstUser = "";
  let last = 0;
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.sessionId) sessionId = record.sessionId;
    if (record.cwd) cwd = record.cwd;
    if (record.timestamp) last = Math.max(last, Date.parse(record.timestamp) || 0);
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (record.message?.role && record.message.role !== record.type) continue;
    const text = flattenContent(record.message?.content);
    if (!text || isInjected(text) || text.startsWith("<")) continue;
    if (record.type === "user" && !firstUser) firstUser = text;
    messages.push({ role: record.type, text });
  }
  return { sessionId, cwd, firstUser, last, messages };
}

export function list({ home = claudeHome() } = {}) {
  const root = join(home, "projects");
  if (!existsSync(root)) return [];
  const rows = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(dir, file.name);
      let parsed;
      try {
        parsed = parseTranscript(path);
      } catch {
        continue;
      }
      const id = parsed.sessionId || basename(file.name, ".jsonl");
      const stat = statSync(path);
      rows.push({
        provider: "claude",
        id,
        title: cleanTitle(parsed.firstUser),
        projectPath: parsed.cwd,
        lastActivity: toMs(parsed.last || stat.mtimeMs),
        archived: false,
        running: false,
        sourcePath: path,
        sizeBytes: stat.size,
      });
    }
  }
  return rows;
}

export async function preview(conv) {
  const { messages } = parseTranscript(conv.sourcePath);
  return renderTranscript(messages);
}

export async function remove() {
  throw new Error(
    "Claude Code has no per-session delete command; open the /resume picker or run `claude purge` for the project",
  );
}

export async function archive() {
  throw new Error("Claude Code has no archive command");
}

export const resumeCommand = (conv) => `claude --resume ${conv.id}`;
