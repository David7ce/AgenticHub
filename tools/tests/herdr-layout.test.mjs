import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLayout } from '../herdr-layout.mjs';

test('the layout makes a workspace, three splits, one start per agent and a live pane', () => {
  const plan = planLayout({ cwd: 'D:/r', label: 'AgentHub', agents: true });
  assert.deepEqual(plan.map((s) => s.id), ['main', 'codex', 'claude', 'live', 'start-opencode', 'start-codex', 'start-claude', 'run-live']);
  const ids = { main: 'w1:p1', codex: 'w1:p2', claude: 'w1:p3', live: 'w1:p4' };
  const args = (id) => { const s = plan.find((p) => p.id === id); return typeof s.args === 'function' ? s.args(ids) : s.args; };
  assert.deepEqual(args('start-codex'), ['agent', 'start', 'codex', '--kind', 'codex', '--pane', 'w1:p2']);
  assert.deepEqual(args('start-opencode').slice(-2), ['--pane', 'w1:p1']);
  assert.ok(args('run-live').join(' ').includes('hubctl.mjs live'));
});

test('--no-agents starts nothing', () => {
  const plan = planLayout({ cwd: 'D:/r', label: 'x', agents: false });
  assert.ok(!plan.some((s) => s.id.startsWith('start-')));
});
