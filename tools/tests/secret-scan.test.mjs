import test from 'node:test';
import assert from 'node:assert/strict';

import { scanText } from '../secret-scan.mjs';

// Built at runtime so this fixture file does not itself look like a leak to the
// scanner that runs on commit.
const awsKey = `AKI${'A'}${'ABCDEFGHIJKLMNOP'}`;
const githubToken = `gh${'p'}_${'a'.repeat(36)}`;
const privateKey = `-----BEGIN ${'RSA '}PRIVATE KEY-----`;

test('provider key shapes are found with a line and column', () => {
  const text = `first\nconst k = "${awsKey}";\nconst t = "${githubToken}";`;
  const findings = scanText(text);
  assert.deepEqual(findings.map((f) => f.rule), ['aws-access-key', 'github-token']);
  assert.deepEqual(findings.map((f) => f.line), [2, 3]);
});

test('private key headers and generic assignments are found', () => {
  assert.equal(scanText(privateKey)[0].rule, 'private-key');
  const generic = 'password = "' + 'Q7m2Np4Rs8Tu1Vw3Xy5Za6Bc' + '"';
  assert.equal(scanText(generic)[0].rule, 'generic-assignment');
});

test('placeholders and allowlisted lines do not fire', () => {
  assert.deepEqual(scanText(`password = "changeme_changeme"`), []);
  assert.deepEqual(scanText(`const k = "${awsKey}" // pragma: allowlist secret`), []);
  assert.deepEqual(scanText(`api_key = "your_api_key_here_123456"`), []);
});

test('findings never include the value', () => {
  const [finding] = scanText(`const k = "${awsKey}";`);
  assert.equal(finding.rule, 'aws-access-key');
  assert.equal(Object.values(finding).some((v) => String(v).includes(awsKey)), false);
});
