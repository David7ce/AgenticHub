import test from "node:test";
import assert from "node:assert/strict";

import { evaluatePosture } from "../egress-posture.mjs";

const currentConsent = {
  _note: "test",
  claude: { enabled: true, overseerAck: true, expires: "2999-01-01T00:00:00Z" },
};

test("VS Code defaults report network as a warning", () => {
  const report = evaluatePosture({ settings: {}, hubConsent: currentConsent });
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(byId["vscode-terminal-sandbox"].level, "pass");
  assert.equal(byId["vscode-sandbox-network"].level, "warn");
  assert.equal(report.ok, false);
});

test("disabling the sandbox is a warning", () => {
  const report = evaluatePosture({
    settings: { "chat.agent.sandbox.enabled": false },
    hubConsent: currentConsent,
  });
  assert.equal(
    report.checks.find((check) => check.id === "vscode-terminal-sandbox").level,
    "warn",
  );
});

test("denying sandbox network access passes", () => {
  const report = evaluatePosture({
    settings: { "chat.agent.sandbox.network.allowNetwork": false },
    hubConsent: currentConsent,
  });
  const network = report.checks.find((check) => check.id === "vscode-sandbox-network");
  assert.equal(network.level, "pass");
  assert.equal(network.fix, null);
});

test("bridge permission other than deny is a warning", () => {
  const report = evaluatePosture({
    settings: { "chat.agent.sandbox.network.allowNetwork": false },
    bridge: { agents: { permission: "allow-all" } },
    hubConsent: currentConsent,
  });
  assert.equal(
    report.checks.find((check) => check.id === "bridge-agent-permission").level,
    "warn",
  );
});

test("expired consent is a warning", () => {
  const report = evaluatePosture({
    settings: { "chat.agent.sandbox.network.allowNetwork": false },
    hubConsent: {
      claude: { enabled: true, overseerAck: true, expires: "2000-01-01T00:00:00Z" },
    },
  });
  const consent = report.checks.find((check) => check.id === "hub-consent");
  assert.equal(consent.level, "warn");
  assert.match(consent.detail, /claude/);
});

test("ACP agents are reported as info, never a pass", () => {
  const report = evaluatePosture({ settings: {}, hubConsent: currentConsent });
  const acp = report.checks.find((check) => check.id === "acp-agents");
  assert.equal(acp.level, "info");
});

test("an accepted policy turns the network warning into info", () => {
  const report = evaluatePosture({
    settings: {},
    hubConsent: currentConsent,
    policy: { acceptSandboxNetwork: true, reason: "routine work needs network" },
  });
  const network = report.checks.find((check) => check.id === "vscode-sandbox-network");
  assert.equal(network.level, "info");
  assert.match(network.detail, /routine work needs network/);
  assert.equal(report.ok, true);
});

test("an accepted policy does not excuse a disabled sandbox", () => {
  const report = evaluatePosture({
    settings: { "chat.agent.sandbox.enabled": false },
    hubConsent: currentConsent,
    policy: { acceptSandboxNetwork: true },
  });
  assert.equal(report.ok, false);
});
