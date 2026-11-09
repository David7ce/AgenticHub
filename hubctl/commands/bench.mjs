/**
 * `hubctl bench` — run the benchmark from the control room.
 *
 * The bench lives in bench/run.mjs; stdio is inherited so per-task progress
 * streams as it happens.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { HUB, ROOT } from "../common.mjs";

export async function runBench(argv) {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HUB, "bench", "run.mjs"), ...argv], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
