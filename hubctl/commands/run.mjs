/**
 * `hubctl run` — one agent through hub-acp, with consent checked first.
 */
import { resolve } from "node:path";
import {
  createWorktree,
  removeWorktree,
  repoInfo,
  worktreeHasChanges,
  worktreePath,
} from "../../acp/fanout-acp.mjs";
import {
  buildHubArgs,
  parseFlags,
  readPrompt,
  requireConsent,
  spawnHub,
  stamp,
} from "../common.mjs";

export async function runAgent(argv) {
  const agent = argv[1];
  if (!agent || agent.startsWith("-")) {
    throw new Error("usage: hubctl run <agent> [--worktree] [--prompt TEXT|-]");
  }
  const opts = parseFlags(argv.slice(2));
  if (opts.help) {
    process.stdout.write("usage: hubctl run <agent> [--worktree] [--prompt TEXT|-] [--cwd DIR] [--permission deny|allow-reads|allow-all]\n");
    return;
  }
  requireConsent(agent);
  const prompt = readPrompt(opts);
  if (!prompt.trim()) throw new Error("prompt is empty");

  let tree = null;
  if (opts.worktree) {
    const base = resolve(opts.cwd ?? process.cwd());
    const info = repoInfo(base);
    if (!info) throw new Error(`--worktree needs a git repository; ${base} is not inside one`);
    tree = { root: info.root, path: worktreePath(info.commonDir, stamp(), agent) };
    createWorktree(info.root, tree.path);
  }

  try {
    const args = buildHubArgs({
      agent,
      prompt: "-",
      cwd: tree?.path ?? opts.cwd ?? null,
      permission: opts.permission,
      budget: opts.budget,
      timeout: opts.timeout,
      json: opts.json,
      model: opts.model ?? null,
    });
    process.exitCode = await spawnHub(args, prompt);
  } finally {
    if (tree) {
      if (worktreeHasChanges(tree.path)) {
        process.stderr.write(`[hubctl] worktree kept (has changes): ${tree.path}\n`);
      } else {
        removeWorktree(tree.root, tree.path);
      }
    }
  }
}
