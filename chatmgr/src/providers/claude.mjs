import { automatedTitle } from "../core/automated.mjs";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { cleanTitle, flattenContent, isInjected, renderTranscript } from "./text.mjs";
import { toMs } from "../core/time.mjs";

/**
 * Claude Code stores one JSONL per session under
 * ~/.claude/projects/<encoded-project>/<sessionId>.jsonl, with an optional
 * sibling folder <sessionId>/ for subagent transcripts and tool output.
 *
 * Claude has no per-session delete command (`claude purge` is project-wide and
 * `claude rm` only handles background agents), so the manager removes exactly
 * two paths — that session's JSONL and its sidecar folder. It never globs,
 * never touches a project folder, and verifies both targets are real paths
 * inside ~/.claude/projects before removing anything.
 */
export const RECENT_WINDOW_MS = 10 * 60 * 1000;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function isSafeSessionId(id) {
  return typeof id === "string" && SESSION_ID.test(id) && !id.includes("..");
}

function sameDir(a, b) {
  const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  return fold(a) === fold(b);
}

/** True when target is a strict descendant of root (never root itself). */
function isInside(root, target) {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolves the two paths a Claude session owns and proves they are inside the
 * projects root. A `..` segment, a symlink/junction escaping the root, or a
 * filename that does not match the session id all reject. Fail closed: throw
 * instead of deleting when anything is uncertain.
 */
export function sessionTargets(conv, { home = claudeHome() } = {}) {
  if (!conv?.sourcePath) throw new Error(`no transcript path for claude:${conv?.id ?? "?"}`);
  if (!isSafeSessionId(conv.id)) throw new Error(`refusing unsafe claude session id: ${JSON.stringify(conv.id)}`);

  if (String(conv.sourcePath).split(/[\\/]+/).includes("..")) {
    throw new Error(`refusing transcript path with a .. segment: ${conv.sourcePath}`);
  }

  const projectsRoot = join(home, "projects");
  if (!existsSync(projectsRoot)) throw new Error(`claude projects root not found: ${projectsRoot}`);
  const rootReal = realpathSync(projectsRoot);

  const sourceResolved = resolve(conv.sourcePath);
  const sourceStat = lstatSync(sourceResolved);
  if (sourceStat.isSymbolicLink()) throw new Error(`refusing to delete symlinked transcript: ${sourceResolved}`);

  const projectReal = realpathSync(dirname(sourceResolved));
  if (!isInside(rootReal, projectReal) || !sameDir(dirname(projectReal), rootReal)) {
    throw new Error(`refusing to delete outside the project directory: ${sourceResolved}`);
  }

  const jsonlReal = realpathSync(sourceResolved);
  if (!isInside(projectReal, jsonlReal)) {
    throw new Error(`refusing to delete transcript outside its project: ${sourceResolved}`);
  }
  if (basename(jsonlReal) !== `${conv.id}.jsonl`) {
    throw new Error(`refusing to delete transcript whose filename is not ${conv.id}.jsonl: ${jsonlReal}`);
  }

  let sidecarReal = null;
  const sidecarCandidate = join(projectReal, conv.id);
  if (existsSync(sidecarCandidate)) {
    const sidecarStat = lstatSync(sidecarCandidate);
    if (sidecarStat.isSymbolicLink()) throw new Error(`refusing to delete symlinked sidecar: ${sidecarCandidate}`);
    sidecarReal = realpathSync(sidecarCandidate);
    if (!isInside(projectReal, sidecarReal)) {
      throw new Error(`refusing to delete sidecar outside its project: ${sidecarCandidate}`);
    }
    if (basename(sidecarReal) !== conv.id) {
      throw new Error(`refusing to delete sidecar that is not ${conv.id}: ${sidecarReal}`);
    }
  }

  return { jsonl: jsonlReal, sidecar: sidecarReal, projectDir: projectReal };
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

/**
 * `running` is a conservative heuristic: Claude Code holds no per-session lock
 * file, so a transcript modified inside the last ten minutes is treated as
 * live. The plan refuses to delete a running row, and a stat failure skips the
 * row entirely rather than guessing.
 */
export function list({ home = claudeHome(), now = Date.now(), recentWindowMs = RECENT_WINDOW_MS } = {}) {
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
      let stat;
      try {
        parsed = parseTranscript(path);
        stat = statSync(path);
      } catch {
        continue;
      }
      const fileId = basename(file.name, ".jsonl");
      const id = parsed.sessionId || fileId;
      const sidecarPath = join(dir, fileId);
      rows.push({
        automated: automatedTitle(cleanTitle(parsed.firstUser)),
        provider: "claude",
        id,
        title: cleanTitle(parsed.firstUser),
        projectPath: parsed.cwd,
        lastActivity: toMs(parsed.last || stat.mtimeMs),
        archived: false,
        running: now - stat.mtimeMs < recentWindowMs,
        runningUnknown: false,
        sourcePath: path,
        sidecarPath: existsSync(sidecarPath) ? sidecarPath : null,
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

/**
 * Removes the session's own jsonl and sidecar folder. The backup runs before
 * this in core/execute.mjs, so a failure there never reaches here. Only the two
 * verified paths are touched; nothing else under ~/.claude is enumerated.
 */
export async function remove(conv, { home = claudeHome() } = {}) {
  const { jsonl, sidecar } = sessionTargets(conv, { home });
  rmSync(jsonl, { force: false });
  if (sidecar) rmSync(sidecar, { recursive: true, force: false });
}

export async function archive() {
  throw new Error("Claude Code has no archive command");
}

export const resumeCommand = (conv) => `claude --resume ${conv.id}`;
