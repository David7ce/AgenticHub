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
