/* Drift — pure logic (dates, goals, progress, streaks, backup parsing).
 * No DOM access, so it can be unit tested with Node (see tests/).
 * Loaded in the browser before script.js; exported for Node via module.exports.
 */

const DEFAULT_WEEKLY_GOAL = 7;
const DEFAULT_MONTHLY_GOAL = 30;
const MAX_NAME_LENGTH = 60;
const MAX_NOTE_LENGTH = 280;
const HABIT_STATUSES = ['active', 'paused', 'archived'];
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// =============================================================================
// Clock (injectable so tests can pin "today")
// =============================================================================

let nowProvider = () => new Date();

function setNowProvider(fn){
  nowProvider = fn || (() => new Date());
}

/** A fresh copy of "now" at local noon (noon avoids DST edge cases when shifting days). */
function noonToday(){
  const d = new Date(nowProvider().getTime());
  d.setHours(12, 0, 0, 0);
  return d;
}

// =============================================================================
// Date utilities (local calendar dates — avoid UTC / toISOString for day keys)
// =============================================================================

/** Format a Date as local YYYY-MM-DD (never UTC / toISOString). */
function localDateStr(date){
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's local calendar date, optionally shifted back by whole days. */
function todayStr(offset=0){
  const d = noonToday();
  d.setDate(d.getDate() - offset);
  return localDateStr(d);
}

/** True for a real calendar date written as YYYY-MM-DD. */
function isValidDateKey(key){
  if(typeof key !== 'string' || !DATE_KEY_RE.test(key)) return false;
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function daysInMonth(year, month){
  return new Date(year, month + 1, 0).getDate();
}

function uid(){ return 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }

// =============================================================================
// Goal helpers & validation
// =============================================================================

function getWeeklyGoal(h){
  const g = Number(h && h.weeklyGoal);
  if(Number.isInteger(g) && g >= 1 && g <= 7) return g;
  return DEFAULT_WEEKLY_GOAL;
}

function getMonthlyGoal(h){
  const g = Number(h && h.monthlyGoal);
  if(Number.isInteger(g) && g >= 1 && g <= 31) return g;
  return DEFAULT_MONTHLY_GOAL;
}

function parseWeeklyGoal(value){
  const n = parseInt(String(value).trim(), 10);
  if(!Number.isInteger(n) || n < 1 || n > 7) return null;
  return n;
}

function parseMonthlyGoal(value){
  const n = parseInt(String(value).trim(), 10);
  if(!Number.isInteger(n) || n < 1 || n > 31) return null;
  return n;
}

// First day of the week: 1 = Monday (default), 0 = Sunday
let weekStartsOn = 1;

function setWeekStart(day){
  weekStartsOn = day === 0 ? 0 : 1;
}

function getWeekStart(){
  return weekStartsOn;
}

/** First day (local, noon) of the current week, per the week-start setting. */
function startOfCurrentWeek(){
  const d = noonToday();
  const back = (d.getDay() - weekStartsOn + 7) % 7; // getDay: 0=Sun … 6=Sat
  d.setDate(d.getDate() - back);
  return d;
}

function endOfCurrentWeek(){
  const d = startOfCurrentWeek();
  d.setDate(d.getDate() + 6);
  return d;
}

function startOfCurrentMonth(){
  const now = noonToday();
  return new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0, 0);
}

function endOfCurrentMonth(){
  const now = noonToday();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0, 12, 0, 0, 0);
}

/** Earlier of two dates. */
function minDate(a, b){
  return a.getTime() <= b.getTime() ? a : b;
}

/** Count successful logged calendar days in [start, end], each day once. */
function countLoggedDays(h, startDate, endDate){
  if(!h || !h.log) return 0;
  let count = 0;
  const d = new Date(startDate.getTime());
  d.setHours(12, 0, 0, 0);
  const end = new Date(endDate.getTime());
  end.setHours(12, 0, 0, 0);
  while(d <= end){
    if(h.log[localDateStr(d)]) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function weeklyProgress(h){
  const end = minDate(endOfCurrentWeek(), noonToday()); // don't count future days
  const done = countLoggedDays(h, startOfCurrentWeek(), end);
  const goal = getWeeklyGoal(h);
  return { done, goal };
}

function monthlyProgress(h){
  const today = noonToday();
  const end = minDate(endOfCurrentMonth(), today); // don't count future days
  const done = countLoggedDays(h, startOfCurrentMonth(), end);
  // A goal can never exceed the number of days in the current month (e.g. 30 in February).
  const goal = Math.min(getMonthlyGoal(h), daysInMonth(today.getFullYear(), today.getMonth()));
  return { done, goal };
}

function progressPct(done, goal){
  if(!goal || goal <= 0) return 0;
  return Math.min(100, Math.round((done / goal) * 100));
}

// =============================================================================
// Habit model
// =============================================================================

/** Keep only real calendar dates that are marked successful. */
function sanitizeLog(log){
  const out = {};
  if(!log || typeof log !== 'object' || Array.isArray(log)) return out;
  Object.keys(log).forEach(key => {
    if(isValidDateKey(key) && log[key]) out[key] = true;
  });
  return out;
}

/** Keep only notes attached to real dates, trimmed and length-limited. */
function sanitizeNotes(notes){
  const out = {};
  if(!notes || typeof notes !== 'object' || Array.isArray(notes)) return out;
  Object.keys(notes).forEach(key => {
    if(!isValidDateKey(key) || typeof notes[key] !== 'string') return;
    const text = notes[key].trim().slice(0, MAX_NOTE_LENGTH);
    if(text) out[key] = text;
  });
  return out;
}

/** Ensure existing habits without goals keep working; never wipe log/history or regenerate ids. */
function normalizeHabit(h){
  return {
    ...h,
    name: typeof (h && h.name) === 'string' ? h.name : '',
    type: h && h.type === 'bad' ? 'bad' : 'good',
    log: sanitizeLog(h && h.log),
    notes: sanitizeNotes(h && h.notes),
    status: h && HABIT_STATUSES.includes(h.status) ? h.status : 'active',
    createdAt: (h && isValidDateKey(h.createdAt)) ? h.createdAt : todayStr(0),
    weeklyGoal: !h || h.weeklyGoal == null ? DEFAULT_WEEKLY_GOAL : getWeeklyGoal(h),
    monthlyGoal: !h || h.monthlyGoal == null ? DEFAULT_MONTHLY_GOAL : getMonthlyGoal(h)
  };
}

// =============================================================================
// Streaks
// =============================================================================

/** Consecutive logged days ending today (or yesterday if today isn't logged yet). */
function dayStreak(h){
  let streak = 0;
  let offset = h.log[todayStr(0)] ? 0 : 1;
  while(h.log[todayStr(offset)]){
    streak++;
    offset++;
  }
  return streak;
}

/**
 * Consecutive weeks that reached the habit's weekly goal. The current week
 * counts once it is met, but never breaks the streak while still in progress.
 */
function weekStreak(h){
  const goal = getWeeklyGoal(h);
  const weekMet = (start) => {
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + 6);
    return countLoggedDays(h, start, end) >= goal;
  };
  const cursor = startOfCurrentWeek();
  if(!weekMet(cursor)) cursor.setDate(cursor.getDate() - 7);
  let streak = 0;
  while(streak < 1000 && weekMet(cursor)){
    streak++;
    cursor.setDate(cursor.getDate() - 7);
  }
  return streak;
}

/**
 * A daily goal (7/week) tracks day streaks; a lighter goal (e.g. 3/week) tracks
 * week streaks so planned rest days don't break the streak.
 */
function streakInfo(h){
  return getWeeklyGoal(h) === 7
    ? { count: dayStreak(h), unit: 'day' }
    : { count: weekStreak(h), unit: 'week' };
}

function streakLabel(info){
  return info.unit === 'week'
    ? `${info.count} wk${info.count === 1 ? '' : 's'}`
    : `${info.count} day${info.count === 1 ? '' : 's'}`;
}

function streakDaysEquivalent(info){
  return info.unit === 'week' ? info.count * 7 : info.count;
}

/** The longest active streak across habits (compared in day-equivalents). */
function bestStreak(list){
  let best = { count: 0, unit: 'day' };
  list.forEach(h => {
    const info = streakInfo(h);
    if(streakDaysEquivalent(info) > streakDaysEquivalent(best)) best = info;
  });
  return best;
}

const MILESTONES = { day: [3, 7, 14, 30, 60, 100], week: [2, 4, 8, 12, 26, 52] };

function checkMilestone(h){
  const info = streakInfo(h);
  return MILESTONES[info.unit].includes(info.count) ? info : null;
}

function last14(h){
  const arr = [];
  for(let i = 13; i >= 0; i--){
    arr.push(!!h.log[todayStr(i)]);
  }
  return arr;
}

// =============================================================================
// Organizing habits (status, order) and reminders
// =============================================================================

/** Habits that count toward stats, streaks and reminders (not paused or archived). */
function trackedHabits(list){
  return list.filter(h => h.status !== 'paused' && h.status !== 'archived');
}

/**
 * Move a habit up (-1) or down (+1) among habits of the same type that are
 * still on the board (archived ones are skipped). Returns a new array.
 */
function moveHabit(list, id, dir){
  const h = list.find(x => x.id === id);
  if(!h) return list;
  const group = list.filter(x => x.type === h.type && x.status !== 'archived');
  const other = group[group.findIndex(x => x.id === id) + dir];
  if(!other) return list;
  const copy = list.slice();
  copy[list.indexOf(h)] = other;
  copy[list.indexOf(other)] = h;
  return copy;
}

/**
 * How many habits to remind about right now (0 = don't notify).
 * settings: { enabled, time: 'HH:MM', lastDay: 'YYYY-MM-DD' | null }
 */
function remindersDue(settings, list, date){
  if(!settings || !settings.enabled || !/^\d{2}:\d{2}$/.test(settings.time || '')) return 0;
  const hhmm = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  if(hhmm < settings.time) return 0;
  if(settings.lastDay === localDateStr(date)) return 0;
  const today = todayStr(0);
  return trackedHabits(list).filter(h => !h.log[today]).length;
}

// =============================================================================
// Calendar helpers
// =============================================================================

function buildMonthCells(year, month){
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  const total = daysInMonth(year, month);
  const leadingBlanks = (first.getDay() - weekStartsOn + 7) % 7;
  const cells = [];
  for(let i = 0; i < leadingBlanks; i++) cells.push(null);
  for(let d = 1; d <= total; d++) cells.push(d);
  while(cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// =============================================================================
// Backup parsing
// =============================================================================

function isUsableHabit(raw){
  if(!raw || typeof raw !== 'object') return false;
  if(typeof raw.name !== 'string' || !raw.name.trim()) return false;
  if(raw.type != null && raw.type !== 'good' && raw.type !== 'bad') return false;
  if(raw.log != null && (typeof raw.log !== 'object' || Array.isArray(raw.log))) return false;
  if(raw.id != null && typeof raw.id !== 'string') return false;
  return true;
}

/** Parse and sanitize a backup file; throws an Error with a user-facing message. */
function parseBackupPayload(text){
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('File is not valid JSON.');
  }

  let list = null;
  if(Array.isArray(data)){
    list = data;
  } else if(data && typeof data === 'object' && Array.isArray(data.habits)){
    list = data.habits;
  } else {
    throw new Error('Backup must include a habits array.');
  }

  if(!list.every(isUsableHabit)){
    throw new Error('One or more habits are missing usable id/name/type/log data.');
  }

  // Ids stay stable when possible, but duplicates get a fresh id so habits never collide.
  const seen = new Set();
  return list.map(h => {
    let id = (typeof h.id === 'string' && h.id) ? h.id : uid();
    if(seen.has(id)) id = uid();
    seen.add(id);
    return normalizeHabit({
      id,
      name: h.name.trim().slice(0, MAX_NAME_LENGTH),
      type: h.type === 'bad' ? 'bad' : 'good',
      log: h.log || {},
      notes: h.notes,
      status: h.status,
      createdAt: h.createdAt,
      weeklyGoal: h.weeklyGoal,
      monthlyGoal: h.monthlyGoal
    });
  });
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    setNowProvider, setWeekStart, getWeekStart, startOfCurrentWeek, todayStr, localDateStr, isValidDateKey, daysInMonth,
    getWeeklyGoal, getMonthlyGoal, parseWeeklyGoal, parseMonthlyGoal,
    countLoggedDays, weeklyProgress, monthlyProgress, progressPct,
    sanitizeLog, normalizeHabit,
    dayStreak, weekStreak, streakInfo, streakLabel, bestStreak, checkMilestone,
    last14, buildMonthCells, parseBackupPayload,
    sanitizeNotes, trackedHabits, moveHabit, remindersDue
  };
}
