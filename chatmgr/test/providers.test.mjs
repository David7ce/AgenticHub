import assert from "node:assert/strict";
import test from "node:test";

import * as codex from "../src/providers/codex.mjs";
import * as claude from "../src/providers/claude.mjs";
import * as hermes from "../src/providers/hermes.mjs";
import * as opencode from "../src/providers/opencode.mjs";
import { codexFixture, claudeFixture, hermesFixture, opencodeFixture } from "./fixtures.mjs";

test("codex lists live and archived rollouts, names them from the index and flags locks", () => {
  const { home, live, archived, running } = codexFixture();
  const rows = codex.list({ home });
  assert.equal(rows.length, 3);

  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get(live).title, "Parser fix"); // session_index wins
  assert.equal(byId.get(live).archived, false);
  assert.equal(byId.get(archived).archived, true);
  assert.equal(byId.get(archived).title, "Old archived work"); // first real user message
  assert.equal(byId.get(running).running, true); // thread-writer lock
  assert.equal(byId.get(live).running, false);
});

test("codex preview skips injected AGENTS.md context", async () => {
  const { home, live } = codexFixture();
  const conv = codex.list({ home }).find((row) => row.id === live);
  const text = await codex.preview(conv);
  assert.match(text, /Fix the parser bug/);
  assert.match(text, /Done\./);
  assert.doesNotMatch(text, /AGENTS\.md instructions/);
});

test("codex deletes through the CLI with a validated id", async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  await codex.remove({ id: "01a1-abc_DEF" }, { run });
  assert.deepEqual(calls, [["codex", "delete", "--force", "01a1-abc_DEF"]]);
  await assert.rejects(() => codex.remove({ id: "x; rm -rf /" }, { run }), /unsafe session id/);
});

test("codex surfaces a CLI failure instead of claiming success", async () => {
  const run = async () => ({ code: 1, stdout: "", stderr: "session not found" });
  await assert.rejects(() => codex.remove({ id: "abc" }, { run }), /failed \(exit 1\): session not found/);
});

test("claude reads project transcripts and refuses to delete them", async () => {
  const { home, id } = claudeFixture();
  const rows = claude.list({ home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].title, "Refactor the loader");
  assert.equal(rows[0].projectPath, "D:\\repo");
  assert.match(await claude.preview(rows[0]), /Refactored\./);
  await assert.rejects(() => claude.remove(rows[0]), /no per-session delete/);
});

test("hermes treats a session without ended_at as running", () => {
  const { dbPath } = hermesFixture();
  const rows = hermes.list({ dbPath });
  const closed = rows.find((row) => row.id === "local-aaa");
  const open = rows.find((row) => row.id === "local-bbb");
  assert.equal(closed.running, false);
  assert.equal(open.running, true);
  assert.equal(closed.title, "Telegram catch-up");
});

test("hermes preview reads only the session's own messages", async () => {
  const { dbPath } = hermesFixture();
  const conv = hermes.list({ dbPath }).find((row) => row.id === "local-aaa");
  const text = await hermes.preview(conv, { dbPath });
  assert.match(text, /hello/);
  assert.match(text, /hi/);
});

test("hermes deletes through `hermes sessions delete --yes`", async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  await hermes.remove({ id: "local-abc" }, { run });
  assert.deepEqual(calls, [["hermes", "sessions", "delete", "--yes", "local-abc"]]);
});

test("opencode flags busy sessions and archived ones", () => {
  const { dbPath } = opencodeFixture();
  const rows = opencode.list({ dbPath });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(rows.length, 3);
  assert.equal(byId.get("ses_idle").running, false);
  assert.equal(byId.get("ses_busy").running, true);
  assert.equal(byId.get("ses_arch").archived, true);
});

test("opencode extracts only text parts from message data", () => {
  assert.equal(
    opencode.extractText(JSON.stringify({ content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "visible" }] })),
    "visible",
  );
  assert.equal(opencode.extractText("not json"), "");
});

test("opencode deletes through `opencode session delete`", async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  await opencode.remove({ id: "ses_abc" }, { run });
  assert.deepEqual(calls, [["opencode", "session", "delete", "ses_abc"]]);
});

test("an unsupported archive is explicit, not silent", async () => {
  await assert.rejects(() => opencode.archive({ id: "ses_x" }, {}), /no archive command/);
  await assert.rejects(() => claude.archive({ id: "x" }, {}), /no archive command/);
});
