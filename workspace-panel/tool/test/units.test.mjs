// Pure-logic tests: paths, remotes, arguments, local files, stars and the page.
//
//   node --test workspace-panel/tool/test/

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { commandRefresh, parseArgs } from '../cli.mjs';
import { ACCOUNTS, buildAccounts, classifyCommit } from '../lib/accounts.mjs';
import { AUTHOR, authorPattern, readExclusions, readLocalJson } from '../lib/local.mjs';
import { resolveRoot, toLocalPath, toWindowsPath } from '../lib/paths.mjs';
import { mapPool } from '../lib/pool.mjs';
import { resolveRemote, sanitizeRemote } from '../lib/remote.mjs';
import { filterExcludedRepos, folderLabels } from '../lib/scan.mjs';
import { applyStars, repoKeyFromWebUrl } from '../lib/stars.mjs';
import { CLIENT_SCRIPTS, renderPage } from '../page/render.mjs';

const clientFile = (name) => readFileSync(new URL(`../page/client/${name}`, import.meta.url), 'utf8');

/** The page's pure helpers, run in a sandbox with no DOM. */
function loadClient() {
  const context = { URL, Intl, localStorage: { getItem: () => null, setItem: () => {} } };
  const shell = readFileSync(new URL('../page/shared/shell.js', import.meta.url), 'utf8');
  vm.runInNewContext(`${shell}\n${clientFile('i18n.js')}\n${clientFile('common.js')}\nlang = 'en';\nthis.I18N = I18N;`, context);
  return context;
}

test('paths: WSL and drive-letter spellings agree, and round-trip', () => {
  assert.equal(toWindowsPath('/mnt/d/Workspaces/x'), 'D:\\Workspaces\\x');
  assert.equal(toWindowsPath('D:/Workspaces/x'), 'D:\\Workspaces\\x');
  assert.equal(toWindowsPath('/mnt/c/Users/user'), 'C:\\Users\\user');
  assert.equal(toWindowsPath('d:\\Workspaces\\x'), 'D:\\Workspaces\\x');
  const stored = 'D:\\Workspaces\\someone\\Owner-Org\\rss-reader';
  const local = toLocalPath(stored);
  assert.equal(local, process.platform === 'win32' ? stored : '/mnt/d/Workspaces/someone/Owner-Org/rss-reader');
  assert.equal(toWindowsPath(local), stored);
});

test('resolveRoot expands ~ instead of treating it as a folder name', () => {
  assert.equal(resolveRoot('~/Workspaces'), resolve(homedir(), 'Workspaces'));
});

test('exclusions match only the exact root-relative clone', () => {
  const root = resolve('workspace');
  const fork = resolve(root, 'Git-forks', 'opensidian');
  const other = resolve(root, 'other', 'opensidian');
  assert.deepEqual(filterExcludedRepos([fork, other], root, ['git-forks\\opensidian'], true), [other]);
  assert.deepEqual(filterExcludedRepos([fork, other], root, ['Git-forks/other'], true), [fork, other]);
});

test('local files: absent or empty -> fallback; broken or wrong shape -> error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-local-'));
  try {
    assert.deepEqual(readLocalJson('missing.json', {}, dir), {});
    writeFileSync(join(dir, 'empty.json'), '\n');
    assert.deepEqual(readLocalJson('empty.json', [], dir), []);
    writeFileSync(join(dir, 'broken.json'), '{ nope');
    assert.throws(() => readLocalJson('broken.json', {}, dir), /not valid JSON/);
    writeFileSync(join(dir, 'exclusions.json'), '{"a": 1}');
    assert.throws(() => readExclusions(dir), /must be a JSON array/);
    writeFileSync(join(dir, 'exclusions.json'), '[1]');
    assert.throws(() => readExclusions(dir), /path strings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mapPool keeps input order, bounds concurrency and can stop early', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapPool([30, 10, 20, 0], 2, async (ms) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((done) => setTimeout(done, ms));
    inFlight -= 1;
    return ms * 2;
  });
  assert.deepEqual(out, [60, 20, 40, 0]);
  assert.equal(peak, 2);
  let seen = 0;
  await mapPool([1, 2, 3, 4], 1, async () => { seen += 1; }, { stop: () => seen >= 2 });
  assert.equal(seen, 2);
});

test('sanitizeRemote strips credentials but keeps the SSH user', () => {
  assert.equal(sanitizeRemote('https://user:ghp_secret@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(sanitizeRemote('git@github.com:o/r.git'), 'git@github.com:o/r.git');
});

test('resolveRemote covers the clone URL spellings git produces', () => {
  const cases = [
    ['git@github.com:Owner/repo.git', 'https://github.com/Owner/repo', 'GitHub'],
    ['ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo', 'GitHub'],
    ['ssh://git@gitlab.com:2222/owner/repo.git', 'https://gitlab.com/owner/repo', 'GitLab'],
    ['https://user:token@github.com/owner/repo.git', 'https://github.com/owner/repo', 'GitHub'],
    ['https://github.com/owner/repo/', 'https://github.com/owner/repo', 'GitHub'],
    ['git://host.example/o/r', 'https://host.example/o/r', 'host.example'],
  ];
  for (const [input, webUrl, remoteHost] of cases) assert.deepEqual(resolveRemote(input, {}), { webUrl, remoteHost }, input);
  assert.deepEqual(resolveRemote('nonsense', {}), { webUrl: null, remoteHost: null });
  assert.deepEqual(resolveRemote('', {}), { webUrl: null, remoteHost: null });
});

test('resolveRemote maps an SSH identity alias to the real forge', () => {
  assert.equal(resolveRemote('git@github-alt.com:o/r.git', {}).webUrl, 'https://github.com/o/r');
  assert.equal(resolveRemote('git@github-alt.com:o/r.git', { 'github-alt.com': 'git.corp.example' }).webUrl,
    'https://git.corp.example/o/r');
});

test('parseArgs: build is the default; names belong to sync only', () => {
  assert.equal(parseArgs([]).command, 'build');
  assert.equal(parseArgs(['--jobs', '4', 'build']).command, 'build');
  assert.equal(parseArgs(['build', '--depth', '3']).depth, 3);
  assert.deepEqual(parseArgs(['sync', 'winutil', 'opensidian']).names, ['winutil', 'opensidian']);
  assert.equal(parseArgs(['sync']).jobsSet, false);
  assert.equal(parseArgs(['sync', '--jobs', '6']).jobsSet, true);
  const stars = parseArgs(['stars', '--refresh', '--max-age', '3']);
  assert.deepEqual([stars.command, stars.refresh, stars.maxAge], ['stars', true, 3]);
  assert.deepEqual([parseArgs(['costs']).command, parseArgs(['costs', '--write']).write], ['costs', true]);
  assert.throws(() => parseArgs(['build', '--write']), /only valid with costs/);
});

test('parseArgs: refresh is a command and takes no repo names', () => {
  assert.equal(parseArgs(['refresh']).command, 'refresh');
  assert.throws(() => parseArgs(['refresh', 'x']), /does not take repo names/);
});

test('refresh_runs_build_when_costs_fails', async () => {
  const calls = [];
  const failing = {
    costs: () => { calls.push('costs'); throw new Error('boom'); },
    build: async () => { calls.push('build'); return 0; },
  };
  assert.equal(await commandRefresh({}, failing), 1);
  assert.deepEqual(calls, ['costs', 'build']);

  let seen = null;
  const ok = { costs: (options) => { seen = options; return 0; }, build: async () => 0 };
  assert.equal(await commandRefresh({ root: 'R' }, ok), 0);
  assert.deepEqual([seen.write, seen.root], [true, 'R']);
  assert.equal(await commandRefresh({}, { costs: () => 0, build: async () => 1 }), 1);
});

test('parseArgs: typos and removed commands are errors, not a silent build', () => {
  assert.throws(() => parseArgs(['nope']), /unknown command: nope/);
  for (const removed of ['list', 'open', 'heatmap']) assert.throws(() => parseArgs([removed]), /unknown command/);
  assert.throws(() => parseArgs(['build', 'winutil']), /does not take repo names/);
  assert.throws(() => parseArgs(['sync', '--jobs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['build', '--depth']), /needs a value/);
});

test('stars: GitHub keys only, null when there is no data', () => {
  assert.equal(repoKeyFromWebUrl('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(repoKeyFromWebUrl('https://github.com/owner/repo/'), 'owner/repo');
  assert.equal(repoKeyFromWebUrl('https://gitlab.com/owner/repo'), null);
  assert.equal(repoKeyFromWebUrl('https://github.com/owner'), null);
  assert.equal(repoKeyFromWebUrl(null), null);
  const rows = [{ webUrl: 'https://github.com/a/b' }, { webUrl: 'https://gitlab.com/a/b' }, { webUrl: null }];
  applyStars(rows, { 'a/b': { stars: 12, at: '2026-11-19T00:00:00Z' } });
  assert.deepEqual(rows.map((r) => r.stars), [12, null, null]);
});

test('client: formatStars, escaping and VS Code links', () => {
  const c = loadClient();
  assert.deepEqual([0, 999, 1000, 1500, 22761, 120000, null].map(c.formatStars), ['0', '999', '1k', '1.5k', '22.8k', '120k', null]);
  assert.equal(c.esc('<a href="x">\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;');
  assert.equal(c.vscodeUrl('D:\\Work spaces\\a#b'), 'vscode://file/D:/Work%20spaces/a%23b/?windowId=_blank');
  assert.equal(c.codeNewWindowCommand('D:\\x "y"'), 'code -n "D:\\x y"');
});

test('client: both languages define the same keys and placeholders resolve', () => {
  const c = loadClient();
  assert.deepEqual(Object.keys(c.I18N.es).sort(), Object.keys(c.I18N.en).sort());
  assert.equal(c.t('showing', { shown: 1, total: 2 }), 'Showing 1 of 2');
  const html = clientFile('index.html');
  for (const key of html.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="(\w+)"/g)) {
    assert.ok(key[1] in c.I18N.en, `index.html uses unknown key ${key[1]}`);
  }
});

test('client: year summary names accounts, groups AI per account and drops empty years', () => {
  const c = loadClient();
  const activity = {
    accounts: [
      {
        name: 'David7ce',
        days: { '2026-01-02': 3, '2025-12-31': 9 },
        ai: [
          { provider: 'OpenCode', days: { '2026-01-02': 1 } },
          { provider: 'Claude', days: { '2026-01-02': 2 } },
        ],
      },
      {
        name: 'Second-Account',
        days: { '2026-01-03': 2 },
        ai: [{ provider: 'Claude', days: { '2026-01-03': 1 } }],
      },
    ],
    ai: [
      { provider: 'Copilot', days: { '2026-01-03': 1 } },
      { provider: 'Claude', days: { '2026-01-02': 4, '2024-01-01': 7 } },
    ],
  };
  assert.equal(
    c.formatYearActivity(activity, 2026),
    '3 commits by David7ce (2 by Claude, 1 by OpenCode), 2 commits by Second-Account (1 by Claude) in 2026',
  );
  // Older data without per-account ai still shows the global provider list, now without the word AI.
  const legacy = {
    accounts: activity.accounts.map(({ name, days }) => ({ name, days })),
    ai: activity.ai,
  };
  assert.equal(
    c.formatYearActivity(legacy, 2026),
    '3 commits by David7ce, 2 commits by Second-Account (4 by Claude, 1 by Copilot) in 2026',
  );
  // A new account in the data appears without a code change.
  const withThird = {
    ...activity,
    accounts: [...activity.accounts, { name: 'Other', days: { '2026-01-04': 1 } }],
  };
  assert.match(c.formatYearActivity(withThird, 2026), /1 commit by Other in 2026$/);
  // Accounts with no commits in the year vanish; AI still names its provider.
  assert.equal(c.formatYearActivity(activity, 2024), '7 by Claude in 2024');
  assert.equal(c.formatYearActivity(null, 2025, { total: 1, author: 'David7ce' }), '1 commit by David7ce in 2025');
  assert.ok(!c.formatYearActivity(activity, 2026).includes('@'), 'no address ever reaches the page');
});

test('accounts: authorship comes from the commit, never from the folder', () => {
  // Fixtures, not this machine's config: the owner and a second identity.
  const accounts = buildAccounts(
    { name: 'Owner', emails: ['owner@example.com'], githubUser: 'Owner' },
    [{ name: 'Second-Account', emails: ['second@example.com'] }],
  );
  const owner = accounts[0];
  assert.ok(owner.emails.includes('Owner@users.noreply.github.com'), 'the GitHub noreply alias counts as the owner');
  for (const email of owner.emails) {
    const hit = classifyCommit({ name: 'Owner', email }, accounts);
    assert.deepEqual([hit.account, hit.owner], ['Owner', true], email);
  }
  const other = classifyCommit({ name: 'Second-Account', email: 'second@example.com' }, accounts);
  assert.deepEqual([other.account, other.owner], ['Second-Account', false]);
  assert.throws(() => buildAccounts({ name: 'Owner', emails: [] }, [{ name: 'Broken' }]), /emails/);
  // The live list always starts with the configured owner.
  assert.ok(ACCOUNTS.length >= 1 && ACCOUNTS[0].emails.length >= 1);
  // Claude Sonnet and Claude Opus are one provider; a co-author trailer is enough.
  assert.deepEqual(classifyCommit({ name: 'Owner', email: owner.emails[0], trailers: 'Claude Opus 5.5 <noreply@anthropic.com>\u001fClaude Sonnet 5 <noreply@anthropic.com>' }, accounts).ai, ['Claude']);
  assert.deepEqual(classifyCommit({ name: 'OpenCode', email: owner.emails[0] }, accounts).ai, ['OpenCode']);
  // Automation that is not AI stays out, and a stranger is never attributed.
  assert.deepEqual(classifyCommit({ name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com', trailers: 'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>' }).ai, []);
  assert.deepEqual(classifyCommit({ name: 'stranger', email: 'stranger@example.org' }), { owner: false, account: null, ai: [] });
});

test('author: the page shows a name, never an address', () => {
  assert.ok(!AUTHOR.includes('@'), AUTHOR);
  assert.ok(!AUTHOR.includes(','), AUTHOR);
});

test('renderPage: links ordered scripts and embeds data safely', () => {
  const row = { owner: 'O', project: '', name: '</script>', local: 'D:\\x', webUrl: null, working: false };
  const html = renderPage(
    [row],
    [{ '2026-11-19': 2 }],
    { root: 'D:\\W', generatedAt: 'now', author: 'a@b', toolDir: 'D:\\t' },
    { agents: [], latestDate: '2026-11-23' },
  );
  // Shared scripts, page scripts and the inline data block.
  assert.equal((html.match(/<\/script>/g) || []).length, 9, 'three shared scripts, five page scripts and the data block');
  assert.ok(html.includes('\\u003c/script>'), 'the data escapes <');
  assert.ok(!html.includes('/*STYLES*/') && !html.includes('/*SCRIPT*/'));
  for (const name of CLIENT_SCRIPTS) assert.ok(html.includes(`shared/client/${name}?v=`), `${name} linked`);
  const positions = CLIENT_SCRIPTS.map((name) => html.indexOf(`shared/client/${name}?v=`));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(html.indexOf('const DATA =') < positions[0], 'data loads before page scripts');
  assert.match(html, /id="usagePreview"/);
  assert.match(html, /href="ai-usage\.html"/);
  assert.match(html, /"toolDir":"D:\/t"/);
  assert.match(html, /"commits":2/);
  assert.match(html, /"latestDate":"2026-11-23"/);
  assert.match(html, /"days":\{"2026-11-19":2\}/);
});

test('authorPattern: an email matches git log --author literally', () => {
  assert.equal(authorPattern('a.b@c.com'), 'a\\.b@c\\.com');
  assert.equal(authorPattern('x+tag@y.io'), 'x+tag@y\\.io');   // + is literal in a basic regex
  const re = new RegExp(authorPattern('a.b@c.com'));
  assert.ok(re.test('A <a.b@c.com>'));
  assert.ok(!re.test('A <aXb@c.com>'));
});

test('folder labels: owner and project are the folder names on disk, not re-cased', () => {
  assert.deepEqual(folderLabels(['Pkg-lab', 'GymLab-Cloud']), { owner: 'Pkg-lab', project: '' });
  assert.deepEqual(folderLabels(['David7ce-user', 'Pkg-lab', 'GymLab-Cloud']), { owner: 'David7ce', project: 'Pkg-lab' });
  assert.deepEqual(
    folderLabels(['David7ce-user', 'David7ce-code', 'web-app', 'charstudio']),
    { owner: 'David7ce', project: 'David7ce-code/web-app' },
  );
  assert.deepEqual(folderLabels(['Curiosity432-user', 'curiosity432-blog']), { owner: 'Curiosity432', project: '' });
  assert.deepEqual(folderLabels(['AgenticHub', 'workspace-panel', 'working']), { owner: 'AgenticHub', project: 'workspace-panel' });
  assert.deepEqual(folderLabels(['MediaHub-Org', 'rss-reader']), { owner: 'MediaHub-Org', project: '' });
  assert.deepEqual(folderLabels(['solo']), { owner: 'solo', project: '' });
});
