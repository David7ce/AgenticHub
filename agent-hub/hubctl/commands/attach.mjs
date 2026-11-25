/**
 * `hubctl attach` — resume a session; infers the agent from runs.jsonl.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  buildHubArgs,
  inferSessionAgent,
  parseFlags,
  readPrompt,
  requireConsent,
  spawnHub,
  LOG_PATH,
} from "../common.mjs";
import { parseRuns } from "./status.mjs";

export async function attach(argv) {
  const session = argv[1];
  if (!session || session.startsWith("-")) {
    throw new Error("usage: hubctl attach <session> [--agent NAME] [--prompt TEXT|-]");
  }
  const opts = parseFlags(argv.slice(2));
  if (opts.help) {
    process.stdout.write("usage: hubctl attach <session> [--agent NAME] [--prompt TEXT|-]\n");
    return;
  }
  const runs = parseRuns(existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "", 500);
  const match = inferSessionAgent(runs, session);
  const agent = opts.agent ?? match?.agent;
  if (!agent) throw new Error("could not infer the agent for that session; pass --agent NAME");
  const sessionId = match?.sessionId ?? session;
  requireConsent(agent);
  const prompt = readPrompt(opts);
  if (!prompt.trim()) throw new Error("prompt is empty");
  const args = buildHubArgs({
    agent,
    prompt: "-",
    cwd: opts.cwd ?? null,
    permission: opts.permission,
    budget: opts.budget,
    timeout: opts.timeout,
    json: opts.json,
    resume: sessionId,
    model: opts.model ?? null,
  });
  process.exitCode = await spawnHub(args, prompt);
}
