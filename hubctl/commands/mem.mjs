/**
 * `hubctl mem` — search claude-mem.
 */
import { spawnSync } from "node:child_process";

export async function mem(argv) {
  const query = argv.slice(1).filter((arg) => !arg.startsWith("-")).join(" ").trim();
  if (!query) throw new Error("usage: hubctl mem <query>");

  // The installed launcher answers `status` but returns nothing for `search`
  // on this machine, while `npx claude-mem search` works. Use the known-good
  // path. On Windows, go through cmd.exe because Node cannot spawn a .cmd.
  const quoted = `"${query.replace(/"/g, '""')}"`;
  let result;
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    result = spawnSync(
      comspec,
      ["/d", "/s", "/c", `npx.cmd -y claude-mem@15.6.0 search ${quoted}`],
      { stdio: "inherit", windowsVerbatimArguments: true, windowsHide: true },
    );
  } else {
    result = spawnSync("npx", ["-y", "claude-mem@15.6.0", "search", query], {
      stdio: "inherit",
    });
  }
  process.exitCode = result.status ?? 1;
}
