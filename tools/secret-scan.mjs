#!/usr/bin/env node
// secret-scan.mjs — stop a credential from entering a commit.
//
//   node agent-hub/tools/secret-scan.mjs            # staged files (pre-commit)
//   node agent-hub/tools/secret-scan.mjs --all      # every tracked file (CI)
//   node agent-hub/tools/secret-scan.mjs --history  # last 500 commits (audit)
//   node agent-hub/tools/secret-scan.mjs --json
//
// It scans the content git would commit, not the working tree, and prints only
// the rule and location: echoing the match would put the secret in the
// terminal, CI log and transcript, which is the leak this tries to prevent.
// A line can opt out with `pragma: allowlist secret` or `secret-scan:allow`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RULES = [
  // Order matters only for readability; a line can match several rules.
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  {
    name: 'generic-assignment',
    re: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|password)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
];

const ALLOW = /pragma:\s*allowlist secret|secret-scan:allow/i;

function isPlaceholder(text) {
  return /(example|changeme|placeholder|your[_-]|xxxx|dummy|redacted|<[^>]*>|\.\.\.)/i.test(text);
}

/** Findings for one blob of text. Never returns the matched value. */
export function scanText(text) {
  const findings = [];
  String(text ?? '').split(/\r?\n/).forEach((line, index) => {
    if (ALLOW.test(line)) return;
    for (const rule of RULES) {
      const match = line.match(rule.re);
      if (!match) continue;
      if (rule.name === 'generic-assignment' && isPlaceholder(match[0])) continue;
      findings.push({ rule: rule.name, line: index + 1, column: (match.index ?? 0) + 1 });
    }
  });
  return findings;
}

/**
 * Findings in a `git log -p` patch, restricted to added lines. History cannot
 * be fixed by the next commit, so this is an audit tool, not a gate; one
 * finding per commit/file/rule keeps the output readable.
 */
export function scanPatch(text) {
  let commit = null;
  let file = null;
  const findings = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('commit ')) {
      commit = line.slice('commit '.length, 'commit '.length + 8);
      file = null;
    } else if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      for (const finding of scanText(line.slice(1))) {
        const key = `${commit}|${file}|${finding.rule}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ commit, file, rule: finding.rule });
      }
    }
  }
  return findings;
}

function git(args, options = {}) {
  return spawnSync('git', args, { encoding: 'utf8', windowsHide: true, ...options });
}

function listFiles(all) {
  if (all) {
    const result = git(['ls-files', '-z']);
    if (result.status !== 0) return null;
    return result.stdout.split('\0').filter(Boolean);
  }
  const result = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  if (result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean);
}

function contentOf(file, all) {
  if (all) return readFileSync(file, 'utf8');
  // Staged content, not the working tree: that is what the commit contains.
  const result = git(['show', `:${file}`], { maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function scanFiles(files, all) {
  const findings = [];
  for (const file of files) {
    if (all && !existsSync(file)) continue;
    let text;
    try { text = contentOf(file, all); } catch { continue; }
    if (text == null || text.includes('\0')) continue; // binary or gone
    for (const finding of scanText(text)) findings.push({ file, ...finding });
  }
  return findings;
}

export function runSecretScan(argv) {
  const all = argv.includes('--all');
  const history = argv.includes('--history');
  const asJson = argv.includes('--json');
  const maxIndex = argv.indexOf('--max-commits');
  const maxCommits = maxIndex === -1 ? 500 : Number(argv[maxIndex + 1]);
  if (!Number.isInteger(maxCommits) || maxCommits <= 0) {
    process.stderr.write('secret-scan: --max-commits needs a positive integer\n');
    return 1;
  }

  let findings;
  let scope;
  if (history) {
    const log = git(['log', '--all', '--no-color', '--unified=0', '-p', `-${maxCommits}`], {
      maxBuffer: 256 * 1024 * 1024,
    });
    if (log.status !== 0) {
      process.stderr.write('secret-scan: git log failed\n');
      return 1;
    }
    findings = scanPatch(log.stdout);
    scope = `history (last ${maxCommits} commits)`;
  } else {
    const files = listFiles(all);
    if (!files) {
      process.stderr.write('secret-scan: not a git repository\n');
      return 1;
    }
    findings = scanFiles(files, all);
    scope = `${files.length} ${all ? 'tracked' : 'staged'} file(s)`;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ scope, findings }, null, 2)}\n`);
  } else if (!findings.length) {
    process.stdout.write(`secret-scan · ${scope} · clean\n`);
  } else {
    process.stdout.write(`secret-scan · ${findings.length} finding(s) in ${scope}\n`);
    for (const finding of findings) {
      const where = finding.commit
        ? `${finding.commit} ${finding.file}`
        : `${finding.file}:${finding.line}:${finding.column}`;
      process.stdout.write(`  ${where}  ${finding.rule}\n`);
    }
    process.stdout.write('  Remove the value (and rotate it); allowlist a false positive with "pragma: allowlist secret".\n');
  }
  return findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runSecretScan(process.argv.slice(2));
}
