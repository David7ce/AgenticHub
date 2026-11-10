import test from 'node:test';
import assert from 'node:assert/strict';

import { scanPatch, scanText } from '../secret-scan.mjs';

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

test('history scanning reads added lines and attributes the commit', () => {
  const patch = [
    'commit abcdef1234567890',
    'diff --git a/x.js b/x.js',
    '+++ b/x.js',
    '@@ -0,0 +1 @@',
    `+const k = "${awsKey}";`,
    '+const safe = "nothing here";',
    'commit 1234567890abcdef',
    'diff --git a/y.md b/y.md',
    '+++ b/y.md',
    '@@ -1 +1 @@',
    '+unrelated',
  ].join('\n');
  const findings = scanPatch(patch);
  assert.deepEqual(findings, [{ commit: 'abcdef12', file: 'x.js', rule: 'aws-access-key' }]);
  assert.deepEqual(scanPatch('+no newline'), []);
});

test('findings never include the value', () => {
  const [finding] = scanText(`const k = "${awsKey}";`);
  assert.equal(finding.rule, 'aws-access-key');
  assert.equal(Object.values(finding).some((v) => String(v).includes(awsKey)), false);
});
