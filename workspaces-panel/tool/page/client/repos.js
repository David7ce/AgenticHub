// repos.js — the repo table: one row per repo, filters, sync command, VS Code links,
// and the author's commits in the period selected on the calendar.

/** Commits in `days` within the inclusive `[start, end]` range (null = all time). */
function commitsIn(days, range) {
  let count = 0;
  let last = null;
  for (const [date, n] of Object.entries(days || {})) {
    if (range && (date < range[0] || date > range[1])) continue;
    count += n;
    if (!last || date > last) last = date;
  }
  return { count, last };
}

/** Git letters and counts stay compact; tooltips explain each status. */
function gitChangeParts(r) {
  if (!(r.dirty > 0)) return [];
  const codes = { conflicted: 'C', modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };
  const kinds = Object.keys(codes).filter((kind) => r.changes && r.changes[kind] > 0);
  if (!kinds.length) return [[plural(r.dirty, 'changedOne', 'changed'), plural(r.dirty, 'changedOne', 'changed')]];
  return kinds.map((kind) => {
    const n = r.changes[kind];
    const key = 'git' + kind[0].toUpperCase() + kind.slice(1);
    return [codes[kind] + ' ' + n, plural(n, key + 'One', key), kind];
  });
}

function initRepos(icons, selectedRange) {
  const rows = DATA.repos;
  const CLONE = 'Git Clone';
  const workingTotal = rows.filter((r) => r.working).length;
  const cloneTotal = rows.filter((r) => r.project === CLONE).length;
  const owners = [...new Set(rows.map((r) => r.owner))].sort();
  // Counts and dates read best biggest/newest first.
  const state = { key: null, dir: 1, defaultDir: { pending: -1, shownCommits: -1, stars: -1, created: -1, lastCommit: -1 } };
  let visible = [];

  const q = $('q');
  const ownerEl = $('owner');
  const workEl = $('workingOnly');
  const cloneEl = $('clonesOnly');
  const body = $('reposBody');
  cloneEl.hidden = !cloneTotal;
  // Working and Git clones are exclusive views: at most one is on. Clicking the
  // active one turns it off; clicking the other switches to it.
  let view = null;
  const setView = (next) => {
    view = view === next ? null : next;
    workEl.setAttribute('aria-pressed', String(view === 'working'));
    cloneEl.setAttribute('aria-pressed', String(view === 'clones'));
    render();
  };

  /** Pending work as short tags; the tooltip spells it out. */
  function status(r) {
    const branches = r.otherBranches || [];
    const parts = [
      ...gitChangeParts(r),
      r.hasUpstream && r.ahead > 0 && ['↑' + r.ahead, t('toPush', { n: r.ahead })],
      r.hasUpstream && r.behind > 0 && ['↓' + r.behind, t('toPull', { n: r.behind })],
      r.stashes > 0 && [plural(r.stashes, 'stashOne', 'stashMany'), plural(r.stashes, 'stashOne', 'stashMany')],
      branches.length && [plural(branches.length, 'otherBranchOne', 'otherBranchMany'),
        plural(branches.length, 'otherBranchOne', 'otherBranchMany') + ': ' + branches.join(', ')],
    ].filter(Boolean);
    const notes = [];
    if (r.remote && !r.hasUpstream) notes.push(t('noUpstream'));
    if (!parts.length) {
      return '<span class="chip clean" title="' + esc(notes.join('. ') || t('cleanTitle')) + '">' + esc(t('clean')) + '</span>';
    }
    // Work marked not actionable (overrides `working: false`) keeps its counts, greyed, and says why.
    let title = parts.map((p) => p[1]).join(', ');
    if (!r.working) title = t('notCounted', { why: title });
    if (notes.length) title += '. ' + notes.join('. ');
    return '<span class="status" title="' + esc(title) + '">'
      + parts.map((p) => {
        // A git kind keeps its colour; the rest (↑ ↓ stashes branches) stay the green "pending" chip.
        const cls = p[2] ? ' git git-' + p[2] + (r.working ? '' : ' muted') : (r.working ? ' pending' : '');
        return '<span class="chip' + cls + '" title="' + esc(p[1]) + '">' + esc(p[0]) + '</span>';
      }).join('') + '</span>';
  }

  function cells(r) {

    const remote = r.webUrl
      ? '<a href="' + esc(r.webUrl) + '" target="_blank" rel="noopener">' + esc(r.remoteHost) + '</a>'
      : '<span class="disabled" title="' + esc(t('noneTitle')) + '">' + esc(t('none')) + '</span>';
    const starLabel = formatStars(r.stars);
    const starMark = '<span class="star' + (r.stars === 0 ? ' zero' : '') + '">★ ' + esc(starLabel) + '</span>';
    const stars = starLabel == null
      ? '<span class="disabled" title="' + esc(t('starsTitle')) + '">—</span>'
      : r.webUrl
        ? '<a href="' + esc(r.webUrl) + '" target="_blank" rel="noopener" title="' + esc(t('starsOnGithub', { n: r.stars })) + '">' + starMark + '</a>'
        : starMark;

    return [
      ['class="nowrap"', icons.owner(r.owner) + esc(r.owner)],
      ['class="nowrap"', icons.project(r.owner, r.project) + esc(r.project)],
      // The branch only shows when it is not the usual main/master.
      esc(r.displayName || r.name) + (/^(main|master)$/.test(r.branch) ? '' : ' <span class="chip" title="' + esc(t('branch')) + '">' + esc(r.branch) + '</span>'),
      status(r),
      ['class="nowrap"', '<a class="open" href="' + esc(vscodeUrl(r.local)) + '" title="' + esc(t('openTitle')) + '">' + esc(t('open')) + '</a>'
        + '<button type="button" class="copy-code" data-path="' + esc(r.local) + '" title="' + esc(t('copyCodeTitle')) + '" aria-label="' + esc(t('copyCodeTitle')) + '">⧉</button>'],
      ['class="nowrap"', remote],
      stars,
      // Date only; the time is in the tooltip.
      ['class="date" title="' + esc(r.created) + '"', esc((r.created || '—').slice(0, 10))],
      ['class="date" title="' + esc(r.lastCommit) + '"', esc((r.lastCommit || '—').slice(0, 10))],
      ['class="num" title="' + esc(r.commitsTitle) + '"', r.shownCommits || '—'],
    ].map((cell) => (Array.isArray(cell) ? '<td ' + cell[0] + '>' + cell[1] + '</td>' : '<td>' + cell + '</td>')).join('');
  }

  function render() {
    fillSelect(ownerEl, t('allOwners'), owners, ownerEl.value);
    const query = q.value.trim().toLowerCase();
    const range = selectedRange();
    visible = rows.filter((r) => {
      // Reference clones are hidden by default and the only rows shown when their filter is on.
      if ((r.project === CLONE) !== (view === 'clones')) return false;
      if (ownerEl.value && r.owner !== ownerEl.value) return false;
      if (view === 'working' && !r.working) return false;
      if (!query) return true;
      return [r.name, r.displayName, r.owner, r.project, r.branch, r.remote, r.remoteHost, (r.otherBranches || []).join(' ')]
        .join(' ').toLowerCase().includes(query);
    }).map((r) => {
      const mine = commitsIn(r.days, range);
      // Sort key for Status: pending repos first, then by how much is pending.
      const amount = r.dirty + (r.hasUpstream ? r.ahead + r.behind : 0) + r.stashes + (r.otherBranches || []).length;
      // One Commits column: all commits on the branch, or yours in the selected period.
      const shownCommits = range ? mine.count : r.commits;
      const commitsTitle = range
        ? t('commitsInPeriod', { n: mine.count }) + (mine.last ? ' · ' + t('lastMine', { date: mine.last }) : '')
        : t('commitsMine', { total: r.commits, mine: commitsIn(r.days, null).count });
      return { ...r, displayName: r.displayName || r.name, mine: mine.count, shownCommits, commitsTitle, pending: (r.working ? 1e6 : 0) + amount };
    }).filter((r) => !range || r.mine > 0); // a selected period shows only the repos you touched in it
    if (state.key) visible.sort(compareBy(state.key === 'name' ? 'displayName' : state.key, state.dir));
    $('commitsLabel').textContent = t(range ? 'commitsPeriodLabel' : 'commits');
    $('count').textContent = t('showing', { shown: visible.length, total: rows.length });
    paintSync();
    body.innerHTML = visible.length
      ? visible.map((r) => '<tr>' + cells(r) + '</tr>').join('')
      : '<tr><td colspan="10" class="empty">'
        + esc(view === 'working' && !workingTotal ? t('emptyWorking', { n: rows.length }) : t('emptyFilter')) + '</td></tr>';
  }

  q.addEventListener('input', render);
  ownerEl.addEventListener('change', render);
  workEl.addEventListener('click', () => setView('working'));
  cloneEl.addEventListener('click', () => setView('clones'));
  wireSort($('reposTable'), state, render);

  body.addEventListener('click', (event) => {
    const button = event.target.closest('button.copy-code');
    if (button) copyText(button, codeNewWindowCommand(button.dataset.path), '✓', '×');
  });

  // The sync command for what the table shows. Only repos sync can act on (a remote
  // with an upstream) are named; with no names the CLI syncs everything, so an empty
  // view disables the button instead of copying that. Double quotes: the line is
  // pasted into Git Bash, PowerShell or cmd, and only bash reads ' as a quote.
  const syncBtn = $('syncBtn');
  const canSync = (r) => Boolean(r.remote && r.hasUpstream);
  const allSyncable = rows.filter(canSync).length;
  let syncCmd = null;
  function paintSync() {
    const targets = visible.filter(canSync);
    const names = targets.length === allSyncable ? '' : ' ' + targets.map((r) => '"' + r.name.replace(/"/g, '') + '"').join(' ');
    syncCmd = targets.length ? 'node "' + DATA.toolDir + '/cli.mjs" sync' + names : null;
    syncBtn.textContent = t('copySync', { n: targets.length });
    syncBtn.disabled = !syncCmd;
    const skipped = visible.length - targets.length;
    syncBtn.title = syncCmd
      ? t('copySyncTitle', { cmd: syncCmd.length > 300 ? syncCmd.slice(0, 300) + '…' : syncCmd })
        + (skipped ? '\n' + t('copySyncSkipped', { n: skipped }) : '')
      : t('copySyncNone');
  }
  syncBtn.addEventListener('click', () => { if (syncCmd) copyText(syncBtn, syncCmd, t('copyOk'), t('copyFail')); });

  // "/" jumps to the search box; Escape clears it.
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      event.preventDefault();
      q.focus();
    } else if (event.key === 'Escape' && document.activeElement === q && q.value) {
      q.value = '';
      render();
    }
  });

  return { render };
}
