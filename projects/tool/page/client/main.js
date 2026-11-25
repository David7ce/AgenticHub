// main.js — start the page once every script above is loaded.

const icons = makeIcons(DATA.repos, DATA.ownerIcons, DATA.projectIcons);
let repos = null;

// The author's commits per day, summed over every repo.
const commitDays = new Map();
for (const repo of DATA.repos) {
  for (const [date, count] of Object.entries(repo.days || {})) commitDays.set(date, (commitDays.get(date) || 0) + count);
}
const calendar = createCalendar({
  root: $('calendar'),
  days: commitDays,
  countText: (n) => plural(n, 'commitOne', 'commitMany'),
  titleText: () => t('activity'),
  yearText: (total, year) => formatYearActivity(DATA.activity, year, { total, author: DATA.author }),
  hintText: () => t('selectionHint'),
  onSelect: () => repos && repos.render(),
  storageKey: 'calendar',
});
repos = initRepos(icons, calendar.range);
const usage = initUsage(DATA.usageSummary);
startApp([calendar, repos, usage]);
