// Recover the last successful model for a session without changing audit data.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

function* successfulRecords(logPath, { agent, sessionId, cwd }) {
  if (!sessionId) return;
  const ext = extname(logPath);
  const base = basename(logPath, ext);
  let archived = [];
  try {
    archived = readdirSync(dirname(logPath))
      .filter((name) => name.startsWith(`${base}-`) && name.endsWith(ext))
      .sort().reverse().map((name) => join(dirname(logPath), name));
  } catch {}
  const normalize = (path) => {
    const result = resolve(path);
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };
  for (const file of [logPath, ...archived]) {
    let lines;
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      let record;
      try { record = JSON.parse(lines[i]); } catch { continue; }
      if (record.status === 'ok' && record.agent === agent && record.sessionId === sessionId &&
          typeof record.cwd === 'string' && normalize(record.cwd) === normalize(cwd)) yield record;
    }
  }
}

export function sessionModel(logPath, scope) {
  for (const record of successfulRecords(logPath, scope)) {
    if (typeof record.model === 'string' && record.model) return record.model;
  }
  return null;
}

// The latest successful turn is authoritative even if it did not request a
// mode: never resurrect an older request or infer one from a reported value.
export function sessionRequestedMode(logPath, scope) {
  for (const record of successfulRecords(logPath, scope)) {
    return typeof record.requestedMode === 'string' && record.requestedMode
      ? record.requestedMode : null;
  }
  return null;
}
