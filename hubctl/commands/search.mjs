/**
 * `hubctl search "text" [--since YYYY-MM-DD] [--source runs|notes|git] [--limit N] [--json] [--rebuild]`
 *
 * Full-text search over the run log, the working notes and git history, via a
 * derived index at logs/index.db (disposable; `--rebuild` deletes it first).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, STATE_DIR, INDEX_PATH } from "../common.mjs";
import { openIndex, reindex, search } from "../search.mjs";


export async function runSearch(argv) {
  const words = [];
  const opts = { limit: 20 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--rebuild") opts.rebuild = true;
    else if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--source") opts.source = argv[++i];
    else if (arg === "--limit") opts.limit = Number(argv[++i]) || 20;
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else words.push(arg);
  }
  if (opts.source && !["runs", "notes", "git"].includes(opts.source)) throw new Error("--source must be runs, notes or git");
  if (!words.length && !opts.rebuild) {
    process.stderr.write('usage: hubctl search "text" [--since YYYY-MM-DD] [--source runs|notes|git] [--limit N] [--json] [--rebuild]\n');
    process.exitCode = 1;
    return;
  }
  if (opts.rebuild) rmSync(INDEX_PATH, { force: true });
  const db = openIndex(INDEX_PATH);
  try {
    reindex(db, { logsDir: join(STATE_DIR, "logs"), workingDir: join(STATE_DIR, "working"), repo: ROOT });
    if (!words.length) return;
    const hits = search(db, words.join(" "), opts);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
      return;
    }
    if (!hits.length) process.stdout.write("no matches\n");
    for (const hit of hits) {
      process.stdout.write(`${hit.date}  ${hit.source.padEnd(8)} ${String(hit.label).slice(0, 40)}\n    ${hit.snippet.replace(/\s+/g, " ")}\n`);
    }
  } finally {
    db.close();
  }
}

