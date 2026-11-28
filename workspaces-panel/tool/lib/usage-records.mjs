// Local usage-record readers and token arithmetic. No account requests or prompt persistence.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function collectFiles(root, extension = '.jsonl') {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === extension) files.push(path);
    }
  }
  return files.sort();
}

export function readJsonLines(path) {
  const out = [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A partial final line is expected if the agent was writing during scan.
    }
  }
  return out;
}

/**
 * Tokens that cost allowance: input + output + cache writes, plus totals a
 * source cannot split (Codex reports one undisclosed total per thread).
 * Cache reads are shown apart.
 */
export function workTokens(row) {
  return numeric(row.input_tokens) + numeric(row.output_tokens) + numeric(row.cache_write_tokens)
    + numeric(row.unknown_tokens);
}
