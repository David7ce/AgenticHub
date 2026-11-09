/**
 * `hubctl usage` — estimated allowance spent per Go model, plus the Claude
 * seven-day window.
 *
 * No provider exposes "allowance left" locally, so this is assembled from what
 * each tool does expose: OpenCode's own stats (tokens per model), the published
 * Go prices, and claude-mem's 7-day rate-limit window for the Claude plan.
 */
import { spawnSync } from "node:child_process";
import { MEMORY_URL, paint, probe } from "../common.mjs";

// OpenCode Go is flat-rate: its own stats report cost 0 for `opencode-go/*`
// models, so the only local way to see how much of the monthly allowance is
// spent is to price the tokens against the published table. Prices are per 1M
// tokens, off-peak for DeepSeek, and the limit is that model's monthly
// allowance on the Go plan. Update from https://opencode.ai/docs/go/.
const GO_PRICES = {
  "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cache: 0.003, limit: 100 },
  "mimo-v2.6-flash": { input: 0.14, output: 0.28, cache: 0.0028, limit: 60 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cache: 0.01, limit: 15 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cache: 0.01, limit: 15 },
  "gemini-4-argon": { input: 2.0, output: 10.0, cache: 0.1, limit: 30 },
  "iceman-contributor-free": { input: 0, output: 0, cache: 0, limit: null },
};

// Models whose terms allow training on request data. They appear in the usage
// table so a session that used one is visible, not silently accepted.
const TRAINS_ON_DATA = new Set(["muse-spark-1.2-contributor", "muse-spark-1.3-contributor", "iceman-contributor-free"]);

function opencodeStats(days) {
  const bin = process.env.OPENCODE_BIN || "opencode";
  const args = ["stats", "--days", String(days), "--cost", "--models", "--json"];
  const result =
    process.platform === "win32"
      ? spawnSync("wsl.exe", ["-e", bin, ...args], { encoding: "utf8", windowsHide: true })
      : spawnSync(bin, args, { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function estimateGo(entry) {
  const price = GO_PRICES[entry.model?.id];
  if (!price) return null;
  const tokens = entry.tokens ?? {};
  const million = 1_000_000;
  const cost =
    ((tokens.input ?? 0) / million) * price.input +
    ((tokens.output ?? 0) / million) * price.output +
    ((tokens.cache?.read ?? 0) / million) * price.cache;
  return { cost, limit: price.limit, pct: cost / price.limit };
}

export function humanTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export async function runUsage(argv) {
  const daysArg = argv.find((arg) => arg.startsWith("--days"));
  const days = daysArg ? Number(daysArg.split("=")[1] ?? argv[argv.indexOf(daysArg) + 1]) : 30;
  const asJson = argv.includes("--json");

  const stats = opencodeStats(days);
  const memory = await probe(MEMORY_URL, "/api/health");
  const claudePct = memory.body?.rateLimits?.seven_day?.utilization ?? null;

  const models = [];
  for (const entry of stats?.models ?? []) {
    if (entry.model?.providerID !== "opencode-go") continue;
    const estimate = estimateGo(entry);
    models.push({
      model: entry.model.id,
      steps: entry.steps ?? 0,
      input: entry.tokens?.input ?? 0,
      output: entry.tokens?.output ?? 0,
      cacheRead: entry.tokens?.cache?.read ?? 0,
      ...(estimate ?? {}),
    });
  }
  models.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));

  const payload = {
    days,
    opencode: stats ? { sessions: stats.sessions, models } : null,
    claude: { sevenDayUtilization: claudePct, source: memory.up ? "claude-mem" : null },
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  const lines = [`usage · last ${days} days`, ""];
  if (!stats) {
    lines.push("opencode   unavailable (is the binary reachable?)");
  } else if (!models.length) {
    lines.push("opencode   no opencode-go usage in this window");
  } else {
    lines.push(
      `${"model".padEnd(24)}${"steps".padEnd(8)}${"in/out/cache".padEnd(22)}${"est.".padEnd(9)}of allowance`,
    );
    for (const row of models) {
      const est = row.cost == null ? "—" : `$${row.cost.toFixed(2)}`;
      const pct =
        row.limit === null
          ? "free"
          : row.pct == null
            ? "no price entry"
            : `${(row.pct * 100).toFixed(1)}% of $${row.limit}`;
      const flag = TRAINS_ON_DATA.has(row.model) ? " · trains on data" : "";
      lines.push(
        `${row.model.padEnd(24)}${String(row.steps).padEnd(8)}` +
          `${`${humanTokens(row.input)}/${humanTokens(row.output)}/${humanTokens(row.cacheRead)}`.padEnd(22)}` +
          `${est.padEnd(9)}${pct}${flag}`,
      );
    }
  }
  lines.push(
    "",
    claudePct == null
      ? "claude     claude-mem down, no rate-limit window available"
      : `claude     ${Math.round(claudePct * 100)}% of the 7-day window (claude-mem)`,
    "",
    paint("2", "Go reports cost 0 for opencode-go models; the estimate prices the tokens at the published table."),
  );
  process.stdout.write(lines.join("\n") + "\n");
}
