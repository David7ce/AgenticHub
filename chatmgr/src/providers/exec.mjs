import { spawn } from "node:child_process";

/**
 * Runs one provider CLI without a shell where that is possible. Every argument
 * that reaches a provider command is a validated session id (see safeId), so
 * the cmd.exe shim on Windows cannot be used to inject a second command.
 */
export function runProcess(file, args, { timeoutMs = 30_000, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error.message ?? error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/;

/** Refuses anything that is not a plain session id before it reaches argv. */
export function safeId(id) {
  if (!SAFE_ID.test(String(id))) {
    throw new Error(`refusing unsafe session id: ${JSON.stringify(id)}`);
  }
  return String(id);
}

export async function mustRun(run, file, args, what) {
  const result = await run(file, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`${what} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}
