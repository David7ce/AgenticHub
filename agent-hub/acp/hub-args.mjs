// hub-args.mjs — the command line of hub-acp.mjs.

import { readFileSync } from 'node:fs';

export const USAGE = `usage: node hub-acp.mjs --agent NAME|auto (--prompt TEXT | --prompt -) [options]

  --agent NAME          registry entry to drive (see --list); "auto" applies the
                        router's rules (scope/consequence signals) to the prompt
  --prompt TEXT|-       prompt text, or - to read it from stdin
  --cwd DIR             session working directory (default: current dir)
  --load SESSION_ID     resume via session/load (replays history first;
                        requires the agent's loadSession capability)
  --resume SESSION_ID   resume via session/resume (no replay; requires the
                        agent's sessionCapabilities.resume capability)
  --continue SESSION_ID continue a session whichever way the agent supports
                        (resume if it advertises it, otherwise load); this is what
                        a follow-up question should use: the agent keeps its context
  --mcp FILE            JSON file with mcpServers to pass at session/new
                        (array, or { "mcpServers": [...] })
  --permission POLICY   deny (default) | allow-reads | ask | allow-all
                        ask runs the adapter's attended mode from the registry
                        (permissionModes.attended.force) and holds every risky
                        request for the caller to answer (see
                        --permission-timeout); an explicit --config mode= still
                        wins
  --permission-timeout MS  how long a held ask request waits for an answer
                        (default 300000); it is rejected after that
  --allow-concurrent-write  explicitly bypass a conflicting tree claim
  --timeout MS          prompt turn timeout (default 300000)
  --max-prompt-chars N  reject prompts longer than N chars (default 4000;
                        fan-out synthesis raises this for its own merge call)
  --budget USD          cancel the turn when reported cost exceeds this
                        (default 0.50; 0 = off)
  --max-context N       cancel the turn when the reported context window
                        exceeds N tokens (default: the grant's maxContextTokens,
                        else off); the tighter of the two wins
  --config ID=VALUE     set a session config option (repeatable); e.g.
                        --config model=opencode-go/deepseek-v4.1-flash
  --model NAME          shorthand for --config model=NAME
  --effort LEVEL        reasoning effort: low | medium | high | max, mapped to the
                        agent's own option (registry "effort"); low is enough for
                        text and mechanical work and is several times faster
  --task-id ID          tag the audit line and JSON result with a queue task id
  --label NAME          friendly session name, recorded in the audit line
  --auth METHOD         call authenticate with this methodId after initialize
  --registry FILE       alternate agents.json
  --json                machine-readable result on stdout (no streaming)
  --no-stream           do not print answer chunks as they arrive
  --no-save             do not write a result file under ../results/
  --verbose             tool calls, permission decisions, agent stderr
  --probe               initialize + session/new, print capabilities, no prompt
  --list                list registry entries and availability
`;

export function parseArgs(argv) {
  const opts = {
    permission: 'deny',
    permissionTimeout: 300_000,
    timeout: 300_000,
    budget: 0.5,
    stream: true,
    save: true,
    json: false,
    verbose: false,
    probe: false,
    list: false,
    configs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--agent': opts.agent = next(); break;
      case '--prompt': opts.prompt = next(); break;
      case '--cwd': opts.cwd = next(); break;
      case '--load': opts.loadSession = next(); break;
      case '--resume': opts.resumeSession = next(); break;
      case '--continue': opts.continueSession = next(); break;
      case '--mcp': opts.mcp = next(); break;
      case '--permission': opts.permission = next(); break;
      case '--permission-timeout': opts.permissionTimeout = Number(next()); break;
      case '--allow-concurrent-write': opts.allowConcurrentWrite = true; break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--max-prompt-chars': opts.maxPromptChars = Number(next()); break;
      case '--budget': opts.budget = Number(next()); break;
      case '--max-context': opts.maxContext = Number(next()); break;
      case '--config': opts.configs.push(next()); break;
      case '--model': opts.configs.push(`model=${next()}`); break;
      case '--effort': opts.effort = next(); break;
      case '--task-id': opts.taskId = next(); break;
      case '--label': opts.label = next(); break;
      case '--auth': opts.auth = next(); break;
      case '--registry': opts.registry = next(); break;
      case '--json': opts.json = true; break;
      case '--no-stream': opts.stream = false; break;
      case '--no-save': opts.save = false; break;
      case '--verbose': opts.verbose = true; break;
      case '--probe': opts.probe = true; break;
      case '--list': opts.list = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: fail(`unknown option: ${arg}`);
    }
  }
  return opts;
}

export function fail(message) {
  process.stderr.write(`[acp] ${message}\n\n${USAGE}`);
  process.exit(1);
}

export function readPrompt(opts) {
  if (opts.prompt === '-') return readFileSync(0, 'utf8');
  if (opts.prompt !== undefined) return opts.prompt;
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8');
  fail('no prompt given (use --prompt TEXT, --prompt -, or pipe into stdin)');
}
