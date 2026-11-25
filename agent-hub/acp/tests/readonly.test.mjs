import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { permissionSafetyReason } from '../consent.mjs';
import {
  isEnforcedReadOnly, prepareReadOnlySession, readOnlyProfile, readOnlyViolations,
} from '../readonly.mjs';

const opencode = { name: 'opencode', command: 'opencode.cmd', args: ['acp'] };

test('only the native OpenCode ACP adapter is enforced read-only', () => {
  assert.equal(isEnforcedReadOnly(opencode), true);
  assert.equal(isEnforcedReadOnly({ ...opencode, command: 'C:\\tools\\opencode.exe' }), true);
  assert.equal(isEnforcedReadOnly({ ...opencode, name: 'alias' }), false);
  assert.equal(isEnforcedReadOnly({ ...opencode, command: process.execPath }), false);
  assert.equal(isEnforcedReadOnly({ ...opencode, args: ['run'] }), false);
  assert.equal(isEnforcedReadOnly({ name: 'claude', command: 'claude', args: ['acp'] }), false);
  assert.equal(isEnforcedReadOnly(null), false);
});

test('restricted policies stay closed except for the enforced adapter', () => {
  for (const permission of ['deny', 'allow-reads']) {
    assert.match(permissionSafetyReason(permission), /cannot be enforced/);
    assert.match(permissionSafetyReason(permission, { name: 'claude', command: 'claude', args: [] }), /cannot be enforced/);
    assert.equal(permissionSafetyReason(permission, opencode), null);
  }
  assert.equal(permissionSafetyReason('allow-all'), null);
});

test('the profile denies everything and allows reads only in the authorized tree', () => {
  const profile = readOnlyProfile('C:\\Work\\proj\\');
  assert.deepEqual(profile.permissions[0], { action: '*', resource: '*', effect: 'deny' });
  const allowed = profile.permissions.filter((rule) => rule.effect === 'allow').map((rule) => rule.action);
  assert.deepEqual(allowed, ['read', 'glob', 'grep', 'external_directory']);
  const external = profile.permissions.find((rule) => rule.action === 'external_directory');
  assert.match(external.resource, /\/Work\/proj\/\*$/);
  assert.doesNotMatch(external.resource, /\\/);
});

test('the scratch session is stable per tree and holds the profile, not the project', () => {
  const base = mkdtempSync(join(tmpdir(), 'readonly-'));
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  const first = prepareReadOnlySession(project, { base });
  const second = prepareReadOnlySession(project, { base });
  assert.equal(first.cwd, second.cwd);
  assert.notEqual(first.cwd, project);
  const written = JSON.parse(readFileSync(join(first.cwd, 'opencode.json'), 'utf8'));
  assert.equal(written.permissions[0].effect, 'deny');
  const other = prepareReadOnlySession(mkdtempSync(join(tmpdir(), 'project-')), { base });
  assert.notEqual(other.cwd, first.cwd);
});

test('mutating tool calls are reported as violations; reads and skills are not', () => {
  const tools = new Map([
    ['1', { kind: 'read', status: 'completed', title: 'Read a' }],
    ['2', { kind: 'other', status: 'completed', title: 'skill' }],
    ['3', { kind: 'edit', status: 'completed', title: 'Write b' }],
    ['4', { kind: 'execute', status: 'failed', title: 'shell' }],
  ]);
  assert.deepEqual(readOnlyViolations(tools).map((tool) => tool.title), ['Write b', 'shell']);
});
