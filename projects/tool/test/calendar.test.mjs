// The shared year calendar: pure aggregation and period ranges.
//
//   node --test projects/tool/test/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../page/shared/calendar.js', import.meta.url), 'utf8');

function loadCalendar() {
  const context = { Intl, Map };
  vm.runInNewContext(`${source}\nthis.CAL_COPY = CAL_COPY;`, context);
  return context;
}

test('aggregate_levels', () => {
  const c = loadCalendar();
  const levels = c.aggregateActivity(new Map([['2026-11-01', 4], ['2026-11-02', 1], ['2026-11-09', 0]]));
  assert.deepEqual({ ...levels.day.get('2026-11-01') }, { count: 4, level: 4 });
  assert.equal(levels.day.get('2026-11-02').level, 1);
  assert.equal(levels.day.get('2026-11-09').level, 0);
  assert.equal(levels.week.get('2026-11-01').count, 5);
  assert.equal(levels.month.get('2026-11').count, 5);
});

test('week_across_new_year', () => {
  const c = loadCalendar();
  const levels = c.aggregateActivity(new Map([['2026-12-31', 1], ['2027-01-01', 2]]));
  assert.equal(levels.week.get('2026-12-27').count, 3);
});

test('Monday and Sunday produce different week buckets without losing cross-year activity', () => {
  const c = loadCalendar();
  const days = new Map([['2026-12-27', 2], ['2026-12-28', 3], ['2027-01-01', 4]]);
  assert.equal(c.aggregateActivity(days, 1).week.get('2026-12-28').count, 7);
  assert.equal(c.aggregateActivity(days, 0).week.get('2026-12-27').count, 9);
  assert.equal(c.weekStart('2027-01-03', 1), '2026-12-28');
});

test('Monday is the default and explicit Sunday overrides it', () => {
  const c = loadCalendar();
  assert.equal(c.mondayFirst(null, null), true);
  assert.equal(c.mondayFirst(null, '0'), false);
  assert.equal(c.mondayFirst('monday', '0'), true);
  assert.equal(c.mondayFirst('sunday', '1'), false);
});

test('Islamic years and months group the actual days, not just relabeled Gregorian months', () => {
  const c = loadCalendar();
  const id = 'islamic-civil';
  assert.deepEqual([...c.calendarYearRange('2026-11-25', id)], ['2026-06-17', '2027-06-05']);
  assert.deepEqual([...c.periodRange('month', c.calendarMonthKey('2026-11-25', id), id)], ['2026-11-12', '2026-12-10']);
  const days = new Map([['2026-11-11', 2], ['2026-11-12', 3], ['2026-12-10', 4]]);
  assert.equal(c.aggregateActivity(days, 1, id).month.get('2026-11-12').count, 7);
  assert.equal(c.aggregateActivity(days, 1).month.get('2026-11').count, 5);
});

test('handles Hebrew and Chinese leap months and Buddhist and Persian year boundaries', () => {
  const c = loadCalendar();
  assert.deepEqual([...c.periodRange('month', c.calendarMonthKey('2024-03-25', 'hebrew'), 'hebrew')], ['2024-03-11', '2024-04-08']);
  assert.deepEqual([...c.periodRange('month', c.calendarMonthKey('2025-07-30', 'chinese'), 'chinese')], ['2025-07-25', '2025-08-22']);
  assert.deepEqual([...c.calendarYearRange('2026-11-25', 'persian')], ['2026-03-21', '2027-03-20']);
  assert.equal(c.calendarParts('2026-11-25', 'buddhist').year, '2569');
});

test('period_ranges', () => {
  const c = loadCalendar();
  assert.deepEqual([...c.periodRange('day', '2026-11-24')], ['2026-11-24', '2026-11-24']);
  assert.deepEqual([...c.periodRange('week', '2026-11-22')], ['2026-11-22', '2026-11-28']);
  assert.deepEqual([...c.periodRange('month', '2026-02')], ['2026-02-01', '2026-02-28']);
});

test('cal_copy_parity', () => {
  const c = loadCalendar();
  assert.deepEqual(Object.keys(c.CAL_COPY.es).sort(), Object.keys(c.CAL_COPY.en).sort());
});
