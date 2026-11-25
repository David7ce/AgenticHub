import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatMessage, grantsNeedingReminder } from "../consent-reminder.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "consent-reminder.mjs");

function run(consent, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "consent-reminder-"));
  const consentPath = join(dir, "consent.json");
  writeFileSync(consentPath, JSON.stringify(consent));
  return spawnSync(process.execPath, [SCRIPT, "--consent", consentPath, ...args], { encoding: "utf8" });
}

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-01T00:00:00Z");

test("a grant far from expiring is not reported", () => {
  const consent = { claude: { enabled: true, expires: new Date(NOW + 30 * DAY).toISOString() } };
  assert.deepEqual(grantsNeedingReminder(consent, { now: NOW }), []);
});

test("a grant inside the threshold is reported with days left", () => {
  const consent = { claude: { enabled: true, expires: new Date(NOW + 3 * DAY).toISOString() } };
  const rows = grantsNeedingReminder(consent, { now: NOW, thresholdDays: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "claude");
  assert.equal(rows[0].daysLeft, 3);
});

test("an already-expired grant is reported too, with daysLeft <= 0", () => {
  const consent = { claude: { enabled: true, expires: new Date(NOW - DAY).toISOString() } };
  const rows = grantsNeedingReminder(consent, { now: NOW });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].daysLeft <= 0);
});

test("a disabled grant is never reported, however close its expiry", () => {
  const consent = { claude: { enabled: false, expires: new Date(NOW - DAY).toISOString() } };
  assert.deepEqual(grantsNeedingReminder(consent, { now: NOW }), []);
});

test("an underscore key (metadata, not a grant) is skipped", () => {
  const consent = { _note: "x", claude: { enabled: true, expires: new Date(NOW - DAY).toISOString() } };
  assert.equal(grantsNeedingReminder(consent, { now: NOW }).length, 1);
});

test("rows come back soonest-first", () => {
  const consent = {
    claude: { enabled: true, expires: new Date(NOW + 4 * DAY).toISOString() },
    hermes: { enabled: true, expires: new Date(NOW + 1 * DAY).toISOString() },
  };
  const rows = grantsNeedingReminder(consent, { now: NOW, thresholdDays: 5 });
  assert.deepEqual(rows.map((r) => r.name), ["hermes", "claude"]);
});

test("formatMessage distinguishes expired from expiring", () => {
  const text = formatMessage([
    { name: "claude", daysLeft: -2, expires: "2026-10-30T00:00:00Z" },
    { name: "hermes", daysLeft: 3, expires: "2026-11-04T00:00:00Z" },
  ]);
  assert.match(text, /claude: EXPIRED on 2026-10-30/);
  assert.match(text, /hermes: 3d left \(expires 2026-11-04\)/);
  assert.match(text, /agent-hub\/consent\.json/);
});

// ── CLI contract: the exit code is the signal, not the text ────────────────

test("CLI exits 0 and prints nothing-due when no grant qualifies", () => {
  const result = run({ claude: { enabled: true, expires: "2099-01-01T00:00:00Z" } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /nothing due/);
});

test("CLI exits 2 and prints the message when a grant is due", () => {
  const result = run(
    { claude: { enabled: true, expires: "2026-11-02T00:00:00Z" } },
    ["--days", "365"],
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /claude/);
  assert.match(result.stdout, /consent\.json/);
});

test("CLI exits 1 when the consent file does not exist", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--consent", "/no/such/file.json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no consent file/);
});
