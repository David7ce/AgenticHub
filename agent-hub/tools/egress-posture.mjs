#!/usr/bin/env node
/**
 * Egress posture check.
 *
 * There is no custom network filter here on purpose: VS Code already ships
 * OS-level agent sandboxing for shell commands, including a network switch
 * (`chat.agent.sandbox.network.allowNetwork`). This reports whether that
 * protection is actually on for the editor, plus the hub's own defaults, so a
 * weak posture is visible instead of assumed.
 *
 * It cannot sandbox the hub's ACP agents; that is reported as info, not a
 * pass. Use a container for genuinely untrusted work.
 *
 * Usage:
 *   node agent-hub/tools/egress-posture.mjs [--settings FILE] [--json]
 *
 * Exit: 0 when no warnings, 1 when at least one warning.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = resolve(HERE, "..");

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function defaultSettingsPath() {
  if (process.platform === "win32") {
    return process.env.APPDATA
      ? join(process.env.APPDATA, "Code", "User", "settings.json")
      : null;
  }
  const user = process.env.USER || process.env.USERNAME;
  const candidates = [
    user ? `/mnt/c/Users/${user}/AppData/Roaming/Code/User/settings.json` : null,
    join(homedir(), ".config", "Code", "User", "settings.json"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Pure evaluation so the rules can be tested without touching a real editor.
 * Absent settings use VS Code's documented defaults: sandbox on, network on.
 */
export function evaluatePosture({ settings = {}, hubConsent = null, policy = null }) {
  const checks = [];

  const sandboxOn = settings["chat.agent.sandbox.enabled"] !== false;
  checks.push({
    id: "vscode-terminal-sandbox",
    level: sandboxOn ? "pass" : "warn",
    detail: sandboxOn
      ? "agent shell sandbox is on (default)"
      : "agent shell sandbox is disabled; terminal commands run unconfined",
    fix: sandboxOn ? null : 'Set "chat.agent.sandbox.enabled": true',
  });

  const networkAllowed = settings["chat.agent.sandbox.network.allowNetwork"] !== false;
  const networkAccepted = networkAllowed && policy?.acceptSandboxNetwork === true;
  checks.push({
    id: "vscode-sandbox-network",
    level: networkAccepted ? "info" : networkAllowed ? "warn" : "pass",
    detail: networkAccepted
      ? `network egress allowed by accepted policy${policy.reason ? `: ${policy.reason}` : ""}`
      : networkAllowed
        ? "sandboxed commands may still reach the network (allowNetwork defaults to true)"
        : "sandboxed commands are denied outbound network access",
    fix: networkAllowed && !networkAccepted
      ? 'Set "chat.agent.sandbox.network.allowNetwork": false, or accept it in tools/egress-policy.json'
      : null,
  });

  if (hubConsent) {
    const now = Date.now();
    const entries = Object.entries(hubConsent).filter(([key]) => !key.startsWith("_"));
    const bad = entries.filter(([, grant]) => {
      if (grant?.enabled !== true) return false;
      return grant.expires && Date.parse(grant.expires) <= now;
    });
    checks.push({
      id: "hub-consent",
      level: bad.length ? "warn" : "pass",
      detail: bad.length
        ? `expired consent for: ${bad.map(([name]) => name).join(", ")}`
        : `${entries.length} hub consent entries are current`,
      fix: bad.length ? "Refresh or revoke the expired entries in agent-hub/consent.json" : null,
    });
  }

  checks.push({
    id: "acp-agents",
    level: "info",
    detail:
      "hub ACP agents are not covered by VS Code sandboxing; " +
      "run untrusted work in a container with default-deny egress",
    fix: null,
  });

  return {
    checks,
    ok: checks.every((check) => check.level !== "warn"),
  };
}

function render(report, paths) {
  const lines = ["Egress posture", ""];
  for (const check of report.checks) {
    const mark = check.level === "pass" ? "PASS" : check.level === "warn" ? "WARN" : "INFO";
    lines.push(`[${mark}] ${check.id}: ${check.detail}`);
    if (check.fix) lines.push(`       fix: ${check.fix}`);
  }
  lines.push("");
  lines.push(`settings: ${paths.settings ?? "(not found)"}`);
  lines.push(`policy:   ${paths.policy ?? "(not found)"}`);
  lines.push("");
  lines.push(report.ok ? "OK: no warnings" : "ATTENTION: at least one warning");
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const settingsPath = argValue(argv, "--settings") ?? defaultSettingsPath();

  const settings = readJson(settingsPath) ?? {};
  const hubConsent = readJson(join(HUB, "consent.json"));
  const policyPath = argValue(argv, "--policy") ?? join(HERE, "egress-policy.json");
  const policy = readJson(policyPath);

  const report = evaluatePosture({ settings, hubConsent, policy });
  const paths = { settings: settingsPath, policy: policyPath };

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...report, paths }, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(report, paths)}\n`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
