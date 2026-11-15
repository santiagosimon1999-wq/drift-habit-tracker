const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');

// Pin "today" to Wednesday 2026-11-18 at 09:30 local time.
const setToday = (y, m, d) => L.setNowProvider(() => new Date(y, m - 1, d, 9, 30));
test.beforeEach(() => setToday(2026, 11, 18));
test.after(() => L.setNowProvider(null));

const habit = (days, extra = {}) => {
  const log = {};
  days.forEach(k => { log[k] = true; });
  return { id: 'h1', name: 'Test', type: 'good', log, weeklyGoal: 7, monthlyGoal: 30, ...extra };
};

test('todayStr uses local dates and shifts back across month boundaries', () => {
  assert.equal(L.todayStr(0), '2026-11-18');
  assert.equal(L.todayStr(18), '2026-10-31');
  setToday(2026, 3, 1);
  assert.equal(L.todayStr(1), '2026-02-28');
});

test('isValidDateKey rejects impossible dates and bad formats', () => {
  assert.equal(L.isValidDateKey('2026-02-28'), true);
  assert.equal(L.isValidDateKey('2026-02-30'), false);
  assert.equal(L.isValidDateKey('2026-2-3'), false);
  assert.equal(L.isValidDateKey(null), false);
});

test('dayStreak counts back from today, or from yesterday if today is unlogged', () => {
  assert.equal(L.dayStreak(habit(['2026-11-18', '2026-11-17', '2026-11-16'])), 3);
  assert.equal(L.dayStreak(habit(['2026-11-17', '2026-11-16'])), 2);
  assert.equal(L.dayStreak(habit(['2026-11-16'])), 0);
});

test('weekStreak: rest days do not break a 3-per-week goal', () => {
  // Weeks (Mon-Sun): Nov 2-8, Nov 9-15 both hit 3 days; current week (Nov 16-22) has 1 so far.
  const h = habit(
    ['2026-11-03', '2026-11-05', '2026-11-07', '2026-11-10', '2026-11-12', '2026-11-14', '2026-11-16'],
    { weeklyGoal: 3 }
  );
  assert.equal(L.weekStreak(h), 2);
  assert.deepEqual(L.streakInfo(h), { count: 2, unit: 'week' });
});

test('weekStreak counts the current week once its goal is met', () => {
  const h = habit(['2026-11-16', '2026-11-17', '2026-11-18'], { weeklyGoal: 3 });
  assert.equal(L.weekStreak(h), 1);
});

test('weekStreak breaks after a missed week', () => {
  const h = habit(['2026-11-02', '2026-11-03', '2026-11-04'], { weeklyGoal: 3 }); // Nov 9-15 empty
  assert.equal(L.weekStreak(h), 0);
});

test('daily goals use day streaks', () => {
  assert.deepEqual(L.streakInfo(habit(['2026-11-18'])), { count: 1, unit: 'day' });
});

test('bestStreak compares mixed units by day-equivalents', () => {
  const daily = habit(['2026-11-18', '2026-11-17']);
  const weekly = habit(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-09', '2026-11-10', '2026-11-11'], { weeklyGoal: 3 });
  assert.deepEqual(L.bestStreak([daily, weekly]), { count: 2, unit: 'week' });
  assert.equal(L.streakLabel({ count: 1, unit: 'week' }), '1 wk');
});

test('weeklyProgress counts Monday through today only', () => {
  const h = habit(['2026-11-15', '2026-11-16', '2026-11-18']); // Sunday belongs to the previous week
  assert.deepEqual(L.weeklyProgress(h), { done: 2, goal: 7 });
});

test('monthlyProgress caps the goal at the days in the month', () => {
  setToday(2026, 2, 10);
  assert.equal(L.monthlyProgress(habit([])).goal, 28);
  setToday(2026, 11, 10);
  assert.equal(L.monthlyProgress(habit([])).goal, 30);
});

test('progressPct clamps to 100 and handles empty goals', () => {
  assert.equal(L.progressPct(10, 5), 100);
  assert.equal(L.progressPct(1, 0), 0);
  assert.equal(L.progressPct(1, 3), 33);
});

test('normalizeHabit drops invalid log keys and falsy entries, keeps ids', () => {
  const n = L.normalizeHabit({
    id: 'keep', name: 'X', log: { '2026-11-01': true, '2026-11-02': false, 'nope': true, '2026-13-01': true },
    createdAt: 'garbage'
  });
  assert.deepEqual(n.log, { '2026-11-01': true });
  assert.equal(n.id, 'keep');
  assert.equal(n.createdAt, '2026-11-18');
  assert.equal(n.weeklyGoal, 7);
  assert.equal(n.monthlyGoal, 30);
});

test('week start can be Sunday: weekly progress and calendar follow it', () => {
  L.setWeekStart(0);
  try {
    // Wed 2026-11-18: the week runs Sun Nov 15 → Sat Nov 21
    assert.equal(L.localDateStr(L.startOfCurrentWeek()), '2026-11-15');
    assert.deepEqual(L.weeklyProgress(habit(['2026-11-15', '2026-11-16', '2026-11-14'])), { done: 2, goal: 7 });
    const cells = L.buildMonthCells(2026, 10); // Nov 1 is a Sunday → no leading blanks
    assert.equal(cells.indexOf(1), 0);
    assert.equal(cells.length, 35);
  } finally {
    L.setWeekStart(1);
  }
});

test('notes and status are sanitized and defaulted', () => {
  const n = L.normalizeHabit({
    name: 'X', status: 'weird',
    notes: { '2026-11-01': '  felt great  ', '2026-11-02': '', 'bad': 'x', '2026-11-03': 5, '2026-11-04': 'y'.repeat(500) }
  });
  assert.equal(n.status, 'active');
  assert.equal(n.notes['2026-11-01'], 'felt great');
  assert.equal(Object.keys(n.notes).length, 2);
  assert.equal(n.notes['2026-11-04'].length, 280);
  assert.equal(L.normalizeHabit({ name: 'X', status: 'archived' }).status, 'archived');
});

test('trackedHabits excludes paused and archived habits', () => {
  const list = ['active', 'paused', 'archived'].map(status => ({ ...habit([]), id: status, status }));
  assert.deepEqual(L.trackedHabits(list).map(h => h.id), ['active']);
});

test('moveHabit swaps within the same type and skips archived habits', () => {
  const mk = (id, type, status = 'active') => ({ id, type, status, log: {} });
  const list = [mk('a', 'good'), mk('x', 'bad'), mk('b', 'good', 'archived'), mk('c', 'good')];
  assert.deepEqual(L.moveHabit(list, 'c', -1).map(h => h.id), ['c', 'x', 'b', 'a']); // skips archived b
  assert.deepEqual(L.moveHabit(list, 'a', -1), list); // already first
  assert.deepEqual(L.moveHabit(list, 'c', 1), list);  // already last
  assert.equal(L.moveHabit(list, 'x', 1), list);      // only bad habit
});

test('remindersDue respects time, enabled flag, once-per-day and completed habits', () => {
  const list = [habit([]), { ...habit(['2026-11-18']), id: 'done' }, { ...habit([]), id: 'p', status: 'paused' }];
  const at = (h, m) => new Date(2026, 10, 18, h, m);
  const s = { enabled: true, time: '20:00', lastDay: null };
  assert.equal(L.remindersDue(s, list, at(19, 59)), 0);
  assert.equal(L.remindersDue(s, list, at(20, 0)), 1); // 'done' and paused are excluded
  assert.equal(L.remindersDue({ ...s, lastDay: '2026-11-18' }, list, at(21, 0)), 0);
  assert.equal(L.remindersDue({ ...s, enabled: false }, list, at(21, 0)), 0);
  assert.equal(L.remindersDue({ ...s, time: 'bad' }, list, at(21, 0)), 0);
  assert.equal(L.remindersDue(s, [{ ...habit(['2026-11-18']) }], at(21, 0)), 0);
});

test('buildMonthCells pads to full Monday-first weeks', () => {
  const cells = L.buildMonthCells(2026, 10); // November 2026 starts on a Sunday
  assert.equal(cells.length % 7, 0);
  assert.equal(cells.length, 42);
  assert.equal(cells.indexOf(1), 6);
  assert.equal(cells.filter(c => c !== null).length, 30);
});

test('parseBackupPayload accepts wrapped and bare arrays', () => {
  const habits = [{ id: 'a', name: ' Read ', type: 'good', log: { '2026-11-01': true } }];
  assert.equal(L.parseBackupPayload(JSON.stringify({ habits }))[0].name, 'Read');
  assert.equal(L.parseBackupPayload(JSON.stringify(habits)).length, 1);
});

test('parseBackupPayload rejects bad input', () => {
  assert.throws(() => L.parseBackupPayload('not json'), /valid JSON/);
  assert.throws(() => L.parseBackupPayload('{"x":1}'), /habits array/);
  assert.throws(() => L.parseBackupPayload('[{"name":""}]'), /usable/);
  assert.throws(() => L.parseBackupPayload('[{"name":"a","log":[]}]'), /usable/);
});

test('parseBackupPayload de-duplicates ids, trims long names and sanitizes logs', () => {
  const out = L.parseBackupPayload(JSON.stringify([
    { id: 'same', name: 'A'.repeat(100), log: { '2026-11-01': true, 'bad-key': true } },
    { id: 'same', name: 'B' }
  ]));
  assert.notEqual(out[0].id, out[1].id);
  assert.equal(out[0].name.length, 60);
  assert.deepEqual(out[0].log, { '2026-11-01': true });
});
