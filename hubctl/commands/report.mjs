/**
 * `hubctl report` — completed turns by agent and model.
 */
import { existsSync, readFileSync } from "node:fs";
import { collectReport, renderReport } from "../report.mjs";
import { CONSENT_PATH, LOG_PATH, readJson, useColor } from "../common.mjs";

export async function runReport(argv) {
  const json = argv.includes("--json");
  const index = argv.indexOf("--days");
  const days = index === -1 ? 7 : Math.max(1, Number(argv[index + 1]) || 7);
  const text = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "";
  const consentAgents = Object.entries(readJson(CONSENT_PATH) ?? {}).filter(([k, v]) => !k.startsWith("_") && v?.enabled).map(([k]) => k);
  const agents = argv.includes("--all") || !consentAgents.length ? null : new Set(consentAgents);
  const report = collectReport(text, { days, agents });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report, {
      color: Boolean(useColor) && !argv.includes("--no-color"),
    })}\n`);
  }
}
