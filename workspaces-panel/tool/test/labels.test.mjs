import assert from 'node:assert/strict';
import test from 'node:test';
import { displayLabel, withDisplayLabels } from '../lib/labels.mjs';
import { syncRepos } from '../lib/sync.mjs';

test('repository and project display labels preserve acronyms and brand spellings', () => {
  const fixtures = {
    'canarias-price-tracker': 'Canarias Price Tracker',
    'Arksys-os': 'ArkSys OS', 'arksys-pkgbuilds': 'ArkSys Pkgbuilds',
    'Arksys-os/arksys-pkgbuilds': 'ArkSys OS / ArkSys Pkgbuilds',
    'MediaHub-Org': 'MediaHub Org', 'workspace-panel': 'Workspaces Panel',
    'workspaces-panel': 'Workspaces Panel', 'Workspace Panel': 'Workspaces Panel',
    'Obsidian-pkm-vault': 'Obsidian PKM Vault', 'calendar-xyz': 'Calendar XYZ',
    'wikiterra-vault': 'WikiTerra Vault', 'compuwiki-website': 'CompuWiki Website',
    'audio2score-mcp': 'Audio2Score MCP', 'book-ocr-gen': 'Book OCR Gen',
    'GymLab-Cloud': 'GymLab Cloud', 'ClipFactory': 'ClipFactory',
    'SaaS-Product-Strategy': 'SaaS Product Strategy',
    '.github': 'GitHub', 'wikiterra.github.io': 'WikiTerra GitHub.io',
    'AgenticHub-private': 'AgenticHub Private', 'cli-app': 'CLI App',
  };
  for (const [input, expected] of Object.entries(fixtures)) assert.equal(displayLabel(input), expected, input);
  assert.equal(displayLabel(''), '');
});

test('display labels do not rename repositories or change paths, remotes or state', () => {
  const row = { name: 'canarias-price-tracker', project: 'web-app', local: 'D:/example/canarias-price-tracker', remote: 'git@example.invalid:owner/repo.git', dirty: 7 };
  const shown = withDisplayLabels(row);
  assert.equal(shown.displayName, 'Canarias Price Tracker');
  assert.equal(shown.project, 'Web App');
  for (const key of ['name', 'local', 'remote', 'dirty']) assert.equal(shown[key], row[key]);
  assert.equal(row.project, 'web-app');
});

test('sync selection accepts both original identifiers and readable display names', async () => {
  const rows = [withDisplayLabels({ name: 'sample-repo', project: 'web-app', local: 'D:/not-a-repo', remote: null })];
  for (const name of ['sample-repo', 'Sample Repo']) {
    const result = await syncRepos(rows, { names: [name], dryRun: true, log: () => {} });
    assert.equal(result.summary.total, 1);
    assert.equal(result.results[0].reason, 'no remote');
    assert.equal(result.results[0].name, 'Sample Repo');
  }
});
