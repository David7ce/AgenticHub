#!/usr/bin/env node
// hub.mjs — the one front door.
//
//   hub ask <agent|auto> "prompt" [hub-acp flags]     one agent, through the consent gate
//   hub fanout <a,b,...> "prompt" [fanout flags]      several agents in parallel
//   hub route "prompt" [router flags]                 let the router pick, with failover
//   hub mcp                                           speak MCP on stdio (what a chat client registers)
//   hub check [--no-bench]                            every test plus the bench dry run
//   hub <anything else>                               hubctl: status, live, doctor, tasks, ...
//
// A prompt can also be piped: `git diff | hub ask claude --permission deny`.
// Without `npm link`, `node hub.mjs ...` is the same thing.
//
// This file decides nothing. It maps a short command onto the script that
// already owns it and runs that script in this process (no extra spawn), so
// consent, audit, limits and exit codes are exactly the script's own.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HUB = dirname(fileURLToPath(import.meta.url));

const SCRIPTS = {
  ask: 'acp/hub-acp.mjs',
  fanout: 'acp/fanout-acp.mjs',
  route: 'acp/router.mjs',
  mcp: 'mcp/server.mjs',
  check: 'tools/check.mjs',
  hubctl: 'hubctl/hubctl.mjs',
};

export const USAGE = `usage: hub <command>

  ask <agent|auto> "prompt" [flags]   one agent through the consent gate (flags: hub ask --help)
  fanout <a,b,...> "prompt" [flags]   several agents in parallel; add --worktree if they edit
  route "prompt" [flags]              the router picks the agent and walks the failover chain
  mcp                                 the hub as an MCP server on stdio
  check [--no-bench]                  all tests plus the bench dry run
  init [--workspace] [--dry-run]      first-time setup (never overwrites, never grants)
  status | live | doctor | brief | spend | usage | tasks | handoff | verify | clean | ...
                                      the control room (hub help-ctl lists every command)

A prompt may be piped on stdin instead of written as an argument.
`;

// Leading words up to the first --flag are the prompt; the rest passes through.
function splitPrompt(args) {
  const firstFlag = args.findIndex((arg) => arg.startsWith('-'));
  const words = firstFlag === -1 ? args : args.slice(0, firstFlag);
  const flags = firstFlag === -1 ? [] : args.slice(firstFlag);
  return { text: words.join(' '), flags };
}

// The prompt as the target script wants it: text, or `-` for stdin when
// something is piped. A flag that needs no prompt (or brings its own) wins.
function promptArgs(args, { stdinIsTTY, command, needsNoPrompt = [] }) {
  const { text, flags } = splitPrompt(args);
  const selfSufficient = ['--prompt', '-h', '--help', ...needsNoPrompt];
  if (flags.some((flag) => selfSufficient.includes(flag))) {
    if (text) throw new Error(`hub ${command}: unexpected "${text}" before the flags`);
    return flags;
  }
  if (text) return ['--prompt', text, ...flags];
  if (!stdinIsTTY) return ['--prompt', '-', ...flags];
  throw new Error(`hub ${command}: no prompt (write it as an argument or pipe it on stdin)`);
}

// Pure: argv in, { script, args } out (or { usage } / a thrown Error).
export function resolveCommand(argv, { stdinIsTTY = true } = {}) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '-h' || command === '--help') {
    return { usage: USAGE };
  }
  if (command === 'ask') {
    const needsNoPrompt = ['--list', '--probe'];
    if (!rest.length || rest[0].startsWith('-')) {
      // `hub ask --list`, `hub ask --help`: no agent involved.
      if (rest.some((arg) => ['--list', '-h', '--help'].includes(arg))) {
        return { script: SCRIPTS.ask, args: rest };
      }
      throw new Error('hub ask: name an agent first (hub ask --list shows them, "auto" lets the router pick)');
    }
    const [agent, ...tail] = rest;
    return {
      script: SCRIPTS.ask,
      args: ['--agent', agent, ...promptArgs(tail, { stdinIsTTY, command, needsNoPrompt })],
    };
  }
  if (command === 'fanout') {
    if (!rest.length || rest[0].startsWith('-')) {
      if (rest.some((arg) => arg === '-h' || arg === '--help')) return { script: SCRIPTS.fanout, args: rest };
      throw new Error('hub fanout: list the agents first, e.g. hub fanout opencode,claude "prompt"');
    }
    const [agents, ...tail] = rest;
    return {
      script: SCRIPTS.fanout,
      args: ['--agents', agents, ...promptArgs(tail, { stdinIsTTY, command })],
    };
  }
  if (command === 'route') {
    return { script: SCRIPTS.route, args: promptArgs(rest, { stdinIsTTY, command }) };
  }
  if (command === 'mcp' || command === 'check') return { script: SCRIPTS[command], args: rest };
  if (command === 'help-ctl') return { script: SCRIPTS.hubctl, args: ['help'] };
  // Everything else is a hubctl command; hubctl reports the unknown ones.
  return { script: SCRIPTS.hubctl, args: argv };
}

async function main() {
  let target;
  try {
    target = resolveCommand(process.argv.slice(2), { stdinIsTTY: process.stdin.isTTY === true });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (target.usage) {
    process.stdout.write(target.usage);
    return;
  }
  // node:sqlite (the task queue, search, spend) announces that it is
  // experimental on every command. That one line is noise here; every other
  // warning still prints.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
    emitWarning.call(process, warning, ...rest);
  };
  // Run the script as if it had been started directly: it reads process.argv
  // and several check `argv[1]` to know they are the entry point.
  const script = join(HUB, target.script);
  process.argv = [process.argv[0], script, ...target.args];
  await import(pathToFileURL(script).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
