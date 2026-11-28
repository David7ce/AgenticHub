// Optional Claude Code status line. Only subscription percentages and timestamps leave stdin.
import { readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { CLAUDE_LIVE_PATH, CLAUDE_USAGE_PATH, claudeLiveScript, claudeStatusWindows } from './lib/subscription-usage.mjs';

function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

try {
  const now = new Date();
  const windows = claudeStatusWindows(JSON.parse(readFileSync(0, 'utf8')), now);
  if (windows.length) {
    const snapshot = { measuredAt: now.toISOString(), windows };
    atomicWrite(CLAUDE_USAGE_PATH, JSON.stringify(snapshot) + '\n');
    try { atomicWrite(CLAUDE_LIVE_PATH, claudeLiveScript(snapshot)); } catch { /* panel not built yet */ }
    console.log(windows.map(({ label, usedPercent }) => `${label === 'week' ? '7d' : '5h'}: ${usedPercent}%`).join(' · '));
  }
} catch {
  // Keep Claude usable even if the panel is missing or the cache isn't writable.
}
