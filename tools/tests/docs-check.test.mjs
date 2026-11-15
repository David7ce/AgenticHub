import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { checkDocumentation } from '../docs-check.mjs';

function fixture(t, readme) {
  const root = mkdtempSync(join(tmpdir(), 'hub-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'README.md'), readme);
  writeFileSync(join(root, 'AGENTS.md'), '[Guide](docs/guide.md)\n');
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n[Home](../README.md)\n');
  return root;
}

test('documentation check catches missing files while ignoring code and external URLs', (t) => {
  const root = fixture(t, '[Missing](docs/gone.md)\n[External](https://example.com)\n[Heading](#local)\n```md\n[Example](not-a-file.md)\n```\n`[Inline](also-not-a-file.md)`\n');
  assert.deepEqual(checkDocumentation(root).errors, ['README.md: missing target docs/gone.md']);
});

test('documentation check supports relative, encoded and angle-bracket paths', (t) => {
  const root = fixture(t, '[Guide](docs/guide.md#heading)\n[Space](docs/with%20spaces.md)\n[Space](<docs/with spaces.md>)\n');
  writeFileSync(join(root, 'docs', 'with spaces.md'), '# Page\n');
  assert.deepEqual(checkDocumentation(root), { files: 4, errors: [] });
});

test('documentation check reports malformed URLs and missing root entry points', (t) => {
  const root = fixture(t, '[Bad](docs/%ZZ.md)\n');
  rmSync(join(root, 'AGENTS.md'));
  assert.deepEqual(checkDocumentation(root).errors, ['AGENTS.md: file is missing', 'README.md: invalid URL docs/%ZZ.md']);
});
