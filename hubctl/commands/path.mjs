/**
 * `hubctl path` — both spellings of one path (Windows/WSL).
 *
 * Debugging aid for the one thing that is easy to get wrong: the same file has
 * two names on this machine. Prints both instead of guessing.
 */
import { describe as describePath } from "../../acp/paths.mjs";
import { bold } from "../common.mjs";

export function runPath(argv) {
  const input = argv.find((arg) => !arg.startsWith("--"));
  if (!input) {
    process.stderr.write("usage: hubctl path <path> [--json]\n");
    process.exitCode = 1;
    return;
  }
  let info;
  try {
    info = describePath(input);
  } catch (error) {
    process.stderr.write(`hubctl path: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    [
      `${bold("input")}    ${info.input}`,
      `${bold("style")}    ${info.style}`,
      `${bold("wsl")}      ${info.wsl}`,
      `${bold("windows")}  ${info.windows}`,
      "",
    ].join("\n"),
  );
}
