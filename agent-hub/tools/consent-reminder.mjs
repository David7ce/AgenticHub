#!/usr/bin/env node
/**
 * consent-reminder.mjs — decide whether a hub consent grant needs a nag.
 *
 * `hubctl status` already shows days-left, but only if someone runs it.
 * This is the headless half of that: it reads the same consent.json and
 * prints a message when a grant is close to expiring or already expired.
 * No external service, no token, no account -- it has no opinion on how
 * the nag reaches you. run-consent-reminder.ps1 is the Task Scheduler
 * entry point that turns this into a native Windows notification.
 *
 * Exit codes: 0 nothing due, 1 an error (e.g. missing consent.json),
 * 2 something is due -- the caller's signal to actually notify, so it
 * never has to parse the message text to decide.
 *
 * Usage:
 *   node agent-hub/tools/consent-reminder.mjs [--days N] [--consent FILE]
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONSENT_PATH } from "../acp/consent.mjs";

const DEFAULT_THRESHOLD_DAYS = 5;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Which grants deserve a nag today: enabled, with an expiry, and either
 * already expired or due within thresholdDays. Pure -- no clock or network
 * dependency -- so it is testable without a fake Telegram server.
 */
export function grantsNeedingReminder(consent, { now = Date.now(), thresholdDays = DEFAULT_THRESHOLD_DAYS } = {}) {
  const rows = [];
  for (const [name, grant] of Object.entries(consent ?? {})) {
    if (name.startsWith("_")) continue;
    if (grant?.enabled !== true || !grant.expires) continue;
    const expires = Date.parse(grant.expires);
    if (!Number.isFinite(expires)) continue;
    const daysLeft = Math.ceil((expires - now) / 86_400_000);
    if (daysLeft > thresholdDays) continue;
    rows.push({ name, daysLeft, expires: grant.expires });
  }
  return rows.sort((a, b) => a.daysLeft - b.daysLeft);
}

export function formatMessage(rows) {
  const lines = ["AgentHub consent renewal needed:"];
  for (const row of rows) {
    lines.push(
      row.daysLeft <= 0
        ? `- ${row.name}: EXPIRED on ${row.expires.slice(0, 10)}`
        : `- ${row.name}: ${row.daysLeft}d left (expires ${row.expires.slice(0, 10)})`,
    );
  }
  lines.push("", "Edit agent-hub/consent.json to renew.");
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const daysIndex = argv.indexOf("--days");
  const thresholdDays = daysIndex === -1 ? DEFAULT_THRESHOLD_DAYS : Number(argv[daysIndex + 1]);
  const consentIndex = argv.indexOf("--consent");
  const consentPath = consentIndex === -1 ? CONSENT_PATH : argv[consentIndex + 1];

  if (!existsSync(consentPath)) {
    process.stderr.write(`consent-reminder: no consent file at ${consentPath}\n`);
    process.exitCode = 1;
    return;
  }

  const rows = grantsNeedingReminder(readJson(consentPath), { thresholdDays });
  if (!rows.length) {
    process.stdout.write("consent-reminder: nothing due\n");
    return;
  }

  process.stdout.write(`${formatMessage(rows)}\n`);
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
