/* Drift — Habit Tracker
 * Vanilla JS app logic. Persists habits under localStorage key "drift-habits".
 */

// =============================================================================
// Constants / state
// =============================================================================

const QUOTES = [
  "Progress is a whisper repeated daily, not a shout said once.",
  "You don't rise to your goals, you fall to your systems.",
  "The habit doesn't care how you feel about it today. Show up anyway.",
  "Small and consistent beats big and occasional, every time.",
  "Every day you don't quit is a day you're becoming who you want to be.",
  "The bad habit doesn't disappear — it gets outcompeted. Keep starving it.",
  "You're not starting over. You're continuing from wherever you are.",
  "One rep, one page, one clean day. That's the whole job today.",
  "Discipline is choosing between what you want now and what you want most.",
  "The streak isn't the point. Who you're becoming is.",
  "Motivation gets you started. The habit is what keeps you going.",
  "You already know what to do. Today's task is just doing it.",
  "Boring, repeated action wins. It always has.",
  "Don't break the chain — even a small link holds.",
  "The days you don't feel like it are the days that count most.",
  "You're one decision away from a different day.",
  "Cravings pass whether you feed them or not. Let this one pass.",
  "Future you is built entirely out of what today-you decides.",
  "Slip-ups aren't failures — stopping is. Get back on today.",
  "Identity follows action. Act like who you're trying to become."
];

const DEFAULT_WEEKLY_GOAL = 7;
const DEFAULT_MONTHLY_GOAL = 30;
const BACKUP_VERSION = 1;
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW_LABELS = ['MON','TUE','WED','THU','FRI','SAT','SUN'];

let habits = [];
let selectedType = 'good';
let editingId = null;
let historyId = null;
let historyCursor = null; // { year, month } month is 0-11
let pendingImportHabits = null;
let confirmResolver = null;
let modalReturnFocus = null;
let renderedDay = null;

// =============================================================================
// DOM helpers
// =============================================================================

const $ = (id) => document.getElementById(id);

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

/** Today's local calendar date, optionally shifted by whole days. */
function todayStr(offset=0){
  const d = new Date();
  d.setHours(12, 0, 0, 0); // noon avoids DST edge cases when shifting days
  d.setDate(d.getDate() - offset);
  return localDateStr(d);
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

/** Monday (local) of the current week at noon. */
function startOfCurrentWeek(){
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  const day = d.getDay(); // 0=Sun … 6=Sat
  const mondayOffset = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - mondayOffset);
  return d;
}

function endOfCurrentWeek(){
  const d = startOfCurrentWeek();
  d.setDate(d.getDate() + 6);
  return d;
}

function startOfCurrentMonth(){
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0, 0);
}

function endOfCurrentMonth(){
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0, 12, 0, 0, 0);
}

/** Later of two dates (local noon copies). */
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
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const end = minDate(endOfCurrentWeek(), today); // don't count future days
  const done = countLoggedDays(h, startOfCurrentWeek(), end);
  const goal = getWeeklyGoal(h);
  return { done, goal };
}

function monthlyProgress(h){
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const end = minDate(endOfCurrentMonth(), today); // don't count future days
  const done = countLoggedDays(h, startOfCurrentMonth(), end);
  const goal = getMonthlyGoal(h);
  return { done, goal };
}

function progressPct(done, goal){
  if(!goal || goal <= 0) return 0;
  return Math.min(100, Math.round((done / goal) * 100));
}

// =============================================================================
// Habit model
// =============================================================================

/** Ensure existing habits without goals keep working; never wipe log/history or regenerate ids. */
function normalizeHabit(h){
  const log = (h && h.log && typeof h.log === 'object' && !Array.isArray(h.log)) ? h.log : {};
  return {
    ...h,
    name: typeof (h && h.name) === 'string' ? h.name : '',
    type: h && h.type === 'bad' ? 'bad' : 'good',
    log,
    createdAt: (h && h.createdAt) || todayStr(0),
    weeklyGoal: !h || h.weeklyGoal == null ? DEFAULT_WEEKLY_GOAL : getWeeklyGoal(h),
    monthlyGoal: !h || h.monthlyGoal == null ? DEFAULT_MONTHLY_GOAL : getMonthlyGoal(h)
  };
}

// =============================================================================
// Storage (localStorage key: "drift-habits")
// =============================================================================
function loadHabits() {
  try {
    const savedHabits = localStorage.getItem('drift-habits');
    const parsed = savedHabits ? JSON.parse(savedHabits) : [];
    habits = Array.isArray(parsed) ? parsed.map(normalizeHabit) : [];
  } catch (e) {
    console.error('Load failed', e);
    habits = [];
  }
}

function saveHabits() {
  try {
    localStorage.setItem('drift-habits', JSON.stringify(habits));
  } catch (e) {
    console.error('Save failed', e);

    const status = $('statusMsg');
    status.hidden = false;
    status.textContent =
      "Couldn't save — your last change may not persist.";

    setTimeout(() => {
      status.hidden = true;
    }, 3000);
  }
}

// =============================================================================
// Habit calculations (streaks, progress)
// =============================================================================
function currentStreak(h){
  let streak = 0;
  let offset = 0;
  // if today not logged yet, start counting from yesterday
  if(!h.log[todayStr(0)]) offset = 1;
  while(h.log[todayStr(offset)]){
    streak++;
    offset++;
  }
  return streak;
}

function last14(h){
  const arr = [];
  for(let i=13;i>=0;i--){
    arr.push(!!h.log[todayStr(i)]);
  }
  return arr;
}

function checkMilestone(h){
  const s = currentStreak(h);
  const milestones = [3,7,14,30,60,100];
  return milestones.includes(s) ? s : null;
}

// =============================================================================
// Dashboard / statistics helpers
// =============================================================================
function aggregateProgress(progressFn){
  let completions = 0;
  let goalsMet = 0;
  let target = 0;
  let achieved = 0;
  habits.forEach(h => {
    const p = progressFn(h);
    completions += p.done;
    target += p.goal;
    achieved += p.done;
    if(p.done >= p.goal) goalsMet++;
  });
  const pct = progressPct(achieved, target);
  return { completions, goalsMet, pct, target, achieved };
}

function mostConsistentThisMonth(){
  if(habits.length === 0) return null;
  let best = null;
  habits.forEach(h => {
    const p = monthlyProgress(h);
    const pct = p.goal ? (p.done / p.goal) : 0;
    const candidate = { habit: h, done: p.done, goal: p.goal, pct };
    if(!best){
      best = candidate;
      return;
    }
    if(candidate.pct > best.pct ||
       (candidate.pct === best.pct && candidate.done > best.done) ||
       (candidate.pct === best.pct && candidate.done === best.done && candidate.habit.name.localeCompare(best.habit.name) < 0)){
      best = candidate;
    }
  });
  return best;
}

// =============================================================================
// Calendar / history helpers
// =============================================================================
function buildMonthCells(year, month){
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const sunBased = first.getDay(); // 0=Sun
  const mondayOffset = sunBased === 0 ? 6 : sunBased - 1;
  const cells = [];
  for(let i = 0; i < mondayOffset; i++) cells.push(null);
  for(let d = 1; d <= daysInMonth; d++) cells.push(d);
  while(cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function shiftHistoryMonth(delta){
  if(!historyCursor) return;
  let y = historyCursor.year;
  let m = historyCursor.month + delta;
  while(m < 0){ m += 12; y -= 1; }
  while(m > 11){ m -= 12; y += 1; }
  historyCursor = { year: y, month: m };
  render();
}

// =============================================================================
// Rendering
// =============================================================================
function render(){
  const goodList = $('goodList');
  const badList = $('badList');
  goodList.innerHTML = '';
  badList.innerHTML = '';

  const good = habits.filter(h => h.type === 'good');
  const bad = habits.filter(h => h.type === 'bad');

  if(good.length === 0){
    goodList.innerHTML = '<div class="empty">No habits yet. Add something you want to start doing.</div>';
  } else {
    good.forEach(h => goodList.appendChild(renderCard(h)));
  }

  if(bad.length === 0){
    badList.innerHTML = '<div class="empty">No habits yet. Add something you want to quit.</div>';
  } else {
    bad.forEach(h => badList.appendChild(renderCard(h)));
  }

  renderDashboard();
  renderStats();
  renderedDay = todayStr(0);
}

function renderProgressItem(label, done, goal, fillClass){
  const item = document.createElement('div');
  item.className = 'progress-item';
  const pct = progressPct(done, goal);
  item.innerHTML = `
    <div class="progress-meta">
      <span class="progress-label">${label}</span>
      <span class="progress-count">${done} / ${goal}</span>
    </div>
    <div class="progress-track"><div class="progress-fill ${fillClass || ''}" style="width:${pct}%"></div></div>
  `;
  return item;
}

function renderCard(h){
  const card = document.createElement('div');
  card.className = 'card ' + h.type;

  if(editingId === h.id){
    card.appendChild(renderCardEditor(h));
    return card;
  }

  const streak = currentStreak(h);
  const doneToday = !!h.log[todayStr(0)];
  const wave = last14(h);
  const week = weeklyProgress(h);
  const month = monthlyProgress(h);
  const historyOpen = historyId === h.id;

  const top = document.createElement('div');
  top.className = 'card-top';
  top.innerHTML = `
    <div class="card-name">${escapeHtml(h.name)}</div>
    <div class="card-actions">
      <span class="streak-pill">${streak} day${streak===1?'':'s'}</span>
      <button type="button" class="hist-btn${historyOpen ? ' active' : ''}" title="History" aria-label="View habit history" aria-expanded="${historyOpen}">▣</button>
      <button type="button" class="edit-btn" title="Edit habit" aria-label="Edit habit">✎</button>
      <button type="button" class="del-btn" title="Delete habit" aria-label="Delete habit">✕</button>
    </div>
  `;
  top.querySelector('.hist-btn').addEventListener('click', () => toggleHistory(h.id));
  top.querySelector('.edit-btn').addEventListener('click', () => editHabit(h.id));
  top.querySelector('.del-btn').addEventListener('click', () => deleteHabit(h.id));
  card.appendChild(top);

  const waveEl = document.createElement('div');
  waveEl.className = 'wave';
  wave.forEach(on => {
    const t = document.createElement('div');
    t.className = 'tick' + (on ? ' on' : '');
    t.style.height = on ? '100%' : '20%';
    waveEl.appendChild(t);
  });
  card.appendChild(waveEl);

  const progress = document.createElement('div');
  progress.className = 'progress-block';
  progress.appendChild(renderProgressItem('Weekly', week.done, week.goal));
  progress.appendChild(renderProgressItem('Monthly', month.done, month.goal));
  card.appendChild(progress);

  const bottom = document.createElement('div');
  bottom.className = 'card-bottom';
  bottom.innerHTML = `<span class="wave-label">LAST 14 DAYS</span>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'check-btn' + (doneToday ? ' done' : '');
  btn.textContent = doneToday
    ? (h.type === 'good' ? '✓ DONE TODAY' : '✓ STAYED CLEAN')
    : (h.type === 'good' ? 'MARK DONE' : 'MARK CLEAN');
  btn.addEventListener('click', () => toggleToday(h.id));
  bottom.appendChild(btn);
  card.appendChild(bottom);

  if(historyOpen){
    card.appendChild(renderHistoryPanel(h));
  }

  return card;
}

function renderHistoryPanel(h){
  if(!historyCursor){
    const now = new Date();
    historyCursor = { year: now.getFullYear(), month: now.getMonth() };
  }

  const { year, month } = historyCursor;
  const today = todayStr(0);
  const cells = buildMonthCells(year, month);
  const loggedCount = countLoggedDays(
    h,
    new Date(year, month, 1, 12, 0, 0, 0),
    new Date(year, month + 1, 0, 12, 0, 0, 0)
  );

  const panel = document.createElement('div');
  panel.className = 'history-panel';

  const nav = document.createElement('div');
  nav.className = 'cal-nav';
  nav.innerHTML = `
    <button type="button" class="cal-nav-btn" aria-label="Previous month">‹</button>
    <div class="cal-title">${MONTH_NAMES[month]} ${year}</div>
    <button type="button" class="cal-nav-btn" aria-label="Next month">›</button>
  `;
  const navBtns = nav.querySelectorAll('.cal-nav-btn');
  navBtns[0].addEventListener('click', () => shiftHistoryMonth(-1));
  navBtns[1].addEventListener('click', () => shiftHistoryMonth(1));
  panel.appendChild(nav);

  const grid = document.createElement('div');
  grid.className = 'cal-grid';
  DOW_LABELS.forEach(label => {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = label;
    grid.appendChild(el);
  });

  cells.forEach(day => {
    if(day == null){
      const empty = document.createElement('div');
      empty.className = 'cal-day empty';
      grid.appendChild(empty);
      return;
    }
    const date = new Date(year, month, day, 12, 0, 0, 0);
    const key = localDateStr(date);
    const logged = !!h.log[key];
    const isToday = key === today;
    const isFuture = key > today; // YYYY-MM-DD compares chronologically
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cal-day' + (logged ? ' logged' : '') + (isToday ? ' today' : '');
    el.textContent = String(day);
    el.dataset.date = key;
    el.setAttribute('aria-pressed', logged ? 'true' : 'false');
    const longDate = date.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
    el.setAttribute('aria-label', `${longDate}${logged ? ', logged' : ', not logged'}`);
    if(isFuture){
      el.disabled = true;
      el.title = key + ' · future';
    } else {
      el.title = key + (logged ? ' · logged (click to undo)' : ' · click to log');
      el.addEventListener('click', () => toggleDay(h.id, key));
    }
    grid.appendChild(el);
  });
  panel.appendChild(grid);

  const note = document.createElement('div');
  note.className = 'cal-note';
  note.textContent = `${loggedCount} successful day${loggedCount === 1 ? '' : 's'} this month · click a day to fix it`;
  panel.appendChild(note);

  return panel;
}

function renderCardEditor(h){
  const form = document.createElement('div');
  form.className = 'card-edit';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 60;
  nameInput.value = h.name;
  nameInput.setAttribute('aria-label', 'Habit name');
  form.appendChild(nameInput);

  const goals = document.createElement('div');
  goals.className = 'card-edit-goals';
  goals.innerHTML = `
    <label class="goal-field" title="Successful days per week (1–7)">
      <span>Week</span>
      <input type="number" class="edit-weekly" min="1" max="7" inputmode="numeric" aria-label="Weekly goal">
    </label>
    <label class="goal-field" title="Successful days per month (1–31)">
      <span>Month</span>
      <input type="number" class="edit-monthly" min="1" max="31" inputmode="numeric" aria-label="Monthly goal">
    </label>
  `;
  const weeklyInput = goals.querySelector('.edit-weekly');
  const monthlyInput = goals.querySelector('.edit-monthly');
  weeklyInput.value = String(getWeeklyGoal(h));
  monthlyInput.value = String(getMonthlyGoal(h));
  form.appendChild(goals);

  const errorEl = document.createElement('div');
  errorEl.className = 'card-edit-error';
  errorEl.style.display = 'none';
  form.appendChild(errorEl);

  const actions = document.createElement('div');
  actions.className = 'card-edit-actions';
  actions.innerHTML = `
    <button type="button" class="edit-cancel">CANCEL</button>
    <button type="button" class="edit-save">SAVE</button>
  `;
  actions.querySelector('.edit-cancel').addEventListener('click', cancelEditHabit);
  actions.querySelector('.edit-save').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if(!name){
      errorEl.style.display = 'block';
      errorEl.textContent = 'Habit name cannot be blank.';
      nameInput.focus();
      return;
    }

    const weeklyGoal = parseWeeklyGoal(weeklyInput.value);
    if(weeklyGoal === null){
      errorEl.style.display = 'block';
      errorEl.textContent = 'Weekly goal must be a whole number from 1 to 7.';
      weeklyInput.focus();
      return;
    }

    const monthlyGoal = parseMonthlyGoal(monthlyInput.value);
    if(monthlyGoal === null){
      errorEl.style.display = 'block';
      errorEl.textContent = 'Monthly goal must be a whole number from 1 to 31.';
      monthlyInput.focus();
      return;
    }

    saveEditedHabit(h.id, name, weeklyGoal, monthlyGoal);
  });
  form.appendChild(actions);

  queueMicrotask(() => nameInput.focus());

  return form;
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderDashboard(){
  const el = $('dashboard');
  if(habits.length === 0){
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;

  const week = aggregateProgress(weeklyProgress);
  const month = aggregateProgress(monthlyProgress);
  const bestStreak = habits.reduce((m, h) => Math.max(m, currentStreak(h)), 0);
  const consistent = mostConsistentThisMonth();

  el.innerHTML = `
    <div class="dashboard-title">Overview</div>
    <div class="dash-grid">
      <div class="dash-panel" id="dashWeek"></div>
      <div class="dash-panel" id="dashMonth"></div>
      <div class="dash-panel" id="dashConsistency"></div>
    </div>
  `;

  const weekPanel = el.querySelector('#dashWeek');
  weekPanel.innerHTML = `<h3>This Week</h3>`;
  weekPanel.appendChild(dashRow('Completions', String(week.completions)));
  weekPanel.appendChild(dashRow('Weekly goals', `${week.goalsMet}/${habits.length}`));
  weekPanel.appendChild(dashRow('Completion', `${week.pct}%`));
  const weekBar = document.createElement('div');
  weekBar.className = 'dash-bar-wrap';
  weekBar.appendChild(renderProgressItem('Toward weekly goals', week.achieved, week.target, 'dash-fill'));
  weekPanel.appendChild(weekBar);

  const monthPanel = el.querySelector('#dashMonth');
  monthPanel.innerHTML = `<h3>This Month</h3>`;
  monthPanel.appendChild(dashRow('Completions', String(month.completions)));
  monthPanel.appendChild(dashRow('Monthly goals', `${month.goalsMet}/${habits.length}`));
  monthPanel.appendChild(dashRow('Completion', `${month.pct}%`));
  const monthBar = document.createElement('div');
  monthBar.className = 'dash-bar-wrap';
  monthBar.appendChild(renderProgressItem('Toward monthly goals', month.achieved, month.target, 'dash-fill'));
  monthPanel.appendChild(monthBar);

  const consPanel = el.querySelector('#dashConsistency');
  consPanel.innerHTML = `<h3>Consistency</h3>`;
  consPanel.appendChild(dashRow('Best active streak', `${bestStreak} day${bestStreak === 1 ? '' : 's'}`));
  const label = document.createElement('div');
  label.className = 'dash-row';
  label.innerHTML = `<span class="k">Most consistent</span>`;
  consPanel.appendChild(label);
  if(consistent){
    const name = document.createElement('div');
    name.className = 'dash-consistent';
    name.textContent = consistent.habit.name;
    consPanel.appendChild(name);
    const meta = document.createElement('div');
    meta.className = 'dash-consistent-meta';
    meta.textContent = `${consistent.done} / ${consistent.goal} this month · ${progressPct(consistent.done, consistent.goal)}%`;
    consPanel.appendChild(meta);
  } else {
    const name = document.createElement('div');
    name.className = 'dash-consistent';
    name.textContent = '—';
    consPanel.appendChild(name);
  }
}

function dashRow(k, v){
  const row = document.createElement('div');
  row.className = 'dash-row';
  row.innerHTML = `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`;
  return row;
}

function renderStats(){
  const statsEl = $('stats');
  if(habits.length === 0){ statsEl.hidden = true; return; }
  statsEl.hidden = false;

  const totalHabits = habits.length;
  const doneTodayCount = habits.filter(h => h.log[todayStr(0)]).length;
  const longest = habits.reduce((m,h) => Math.max(m, currentStreak(h)), 0);

  const weeklyMet = habits.filter(h => {
    const p = weeklyProgress(h);
    return p.done >= p.goal;
  }).length;

  const monthlyMet = habits.filter(h => {
    const p = monthlyProgress(h);
    return p.done >= p.goal;
  }).length;

  statsEl.innerHTML = `
    <div class="stat"><div class="num">${doneTodayCount}/${totalHabits}</div><div class="lbl">Done today</div></div>
    <div class="stat"><div class="num">${weeklyMet}/${totalHabits}</div><div class="lbl">Weekly goals</div></div>
    <div class="stat"><div class="num">${monthlyMet}/${totalHabits}</div><div class="lbl">Monthly goals</div></div>
    <div class="stat"><div class="num">${longest}</div><div class="lbl">Longest active streak</div></div>
  `;
}

// =============================================================================
// Habit actions
// =============================================================================
function toggleToday(id){
  const h = habits.find(x => x.id === id);
  if(!h) return;
  const t = todayStr(0);
  h.log[t] = !h.log[t];
  render();
  saveHabits();

  const milestone = checkMilestone(h);
  if(milestone && h.log[t]){
    showQuote(`${milestone}-day streak on "${h.name}" — that's momentum. Don't stop now.`, true);
  }
}

/** Toggle any past/present day from the history calendar (future days are refused). */
function toggleDay(id, key){
  const h = habits.find(x => x.id === id);
  if(!h || key > todayStr(0)) return;
  h.log[key] = !h.log[key];
  render();
  saveHabits();
  const btn = document.querySelector(`.cal-day[data-date="${key}"]`);
  if(btn) btn.focus();
}

async function deleteHabit(id){
  const h = habits.find(x => x.id === id);
  if(!h) return;
  const ok = await openConfirmModal(
    'Delete this habit?',
    `"${h.name}" and all of its history will be permanently deleted. This cannot be undone.`,
    'DELETE'
  );
  if(!ok) return;
  if(editingId === id) editingId = null;
  if(historyId === id){
    historyId = null;
    historyCursor = null;
  }
  habits = habits.filter(x => x.id !== id);
  render();
  saveHabits();
}

function editHabit(id){
  const h = habits.find(x => x.id === id);
  if(!h) return;
  if(historyId === id){
    historyId = null;
    historyCursor = null;
  }
  editingId = id;
  render();
}

function cancelEditHabit(){
  editingId = null;
  render();
}

function saveEditedHabit(id, name, weeklyGoal, monthlyGoal){
  const h = habits.find(x => x.id === id);
  if(!h) return;

  // Preserve log/history, streak data, createdAt, and Building/Breaking type
  h.name = name;
  h.weeklyGoal = weeklyGoal;
  h.monthlyGoal = monthlyGoal;
  editingId = null;
  render();
  saveHabits();
}

function toggleHistory(id){
  const h = habits.find(x => x.id === id);
  if(!h) return;

  if(historyId === id){
    historyId = null;
    historyCursor = null;
    render();
    return;
  }

  editingId = null;
  historyId = id;
  const now = new Date();
  historyCursor = { year: now.getFullYear(), month: now.getMonth() };
  render();
}

function addHabit(){
  const input = $('habitInput');
  const name = input.value.trim();
  if(!name){
    setBackupMsg('Habit name cannot be blank.', true);
    return;
  }

  const weeklyGoal = parseWeeklyGoal($('weeklyGoalInput').value);
  if(weeklyGoal === null){
    setBackupMsg('Weekly goal must be a whole number from 1 to 7.', true);
    return;
  }

  const monthlyGoal = parseMonthlyGoal($('monthlyGoalInput').value);
  if(monthlyGoal === null){
    setBackupMsg('Monthly goal must be a whole number from 1 to 31.', true);
    return;
  }

  habits.push({
    id: uid(),
    name,
    type: selectedType,
    log: {},
    createdAt: todayStr(0),
    weeklyGoal,
    monthlyGoal
  });
  input.value = '';
  $('weeklyGoalInput').value = String(DEFAULT_WEEKLY_GOAL);
  $('monthlyGoalInput').value = String(DEFAULT_MONTHLY_GOAL);
  setBackupMsg('');
  render();
  saveHabits();
}

// =============================================================================
// Backup import / export
// =============================================================================
function setBackupMsg(text, isError){
  const el = $('backupMsg');
  el.textContent = text || '';
  el.className = 'backup-msg' + (text ? (isError ? ' error' : ' ok') : '');
}

function exportBackup(){
  const payload = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appName: 'Drift',
    habits: habits.map(h => ({
      id: h.id,
      name: h.name,
      type: h.type,
      weeklyGoal: getWeeklyGoal(h),
      monthlyGoal: getMonthlyGoal(h),
      log: h.log || {},
      createdAt: h.createdAt
    }))
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `drift-backup-${todayStr(0)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setBackupMsg('Backup exported.', false);
}

function isUsableHabit(raw){
  if(!raw || typeof raw !== 'object') return false;
  if(typeof raw.name !== 'string' || !raw.name.trim()) return false;
  if(raw.type != null && raw.type !== 'good' && raw.type !== 'bad') return false;
  if(raw.log != null && (typeof raw.log !== 'object' || Array.isArray(raw.log))) return false;
  if(raw.id != null && typeof raw.id !== 'string') return false;
  return true;
}

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

  // Normalize without mutating until confirmed; preserve ids/logs
  return list.map(h => {
    const normalized = normalizeHabit({
      id: (typeof h.id === 'string' && h.id) ? h.id : uid(),
      name: h.name.trim(),
      type: h.type === 'bad' ? 'bad' : 'good',
      log: h.log || {},
      createdAt: h.createdAt,
      weeklyGoal: h.weeklyGoal,
      monthlyGoal: h.monthlyGoal
    });
    return normalized;
  });
}

function openConfirmModal(title, body, confirmLabel){
  // Resolve any modal still open so its promise never hangs
  if(confirmResolver) closeConfirmModal(false);
  return new Promise(resolve => {
    confirmResolver = resolve;
    modalReturnFocus = document.activeElement;
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    $('confirmOk').textContent = confirmLabel || 'REPLACE DATA';
    $('confirmModal').hidden = false;
    $('confirmCancel').focus(); // safe default for destructive actions
  });
}

function closeConfirmModal(result){
  $('confirmModal').hidden = true;
  const resolve = confirmResolver;
  confirmResolver = null;
  const back = modalReturnFocus;
  modalReturnFocus = null;
  if(back && document.contains(back) && typeof back.focus === 'function') back.focus();
  if(resolve) resolve(result);
}

/** Esc closes the modal; Tab is kept inside it. */
function handleModalKeydown(e){
  if($('confirmModal').hidden) return;
  if(e.key === 'Escape'){
    e.preventDefault();
    closeConfirmModal(false);
    return;
  }
  if(e.key === 'Tab'){
    const items = [$('confirmCancel'), $('confirmOk')];
    const i = items.indexOf(document.activeElement);
    e.preventDefault();
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === -1 || i === items.length - 1 ? 0 : i + 1);
    items[next].focus();
  }
}

async function handleImportFile(file){
  if(!file) return;
  setBackupMsg('');

  let text;
  try {
    text = await file.text();
  } catch (e) {
    setBackupMsg('Could not read the selected file.', true);
    return;
  }

  let imported;
  try {
    imported = parseBackupPayload(text);
  } catch (e) {
    setBackupMsg(e.message || 'Invalid backup file.', true);
    return;
  }

  pendingImportHabits = imported;
  const ok = await openConfirmModal(
    'Replace current data?',
    `Import ${imported.length} habit${imported.length === 1 ? '' : 's'} from this backup? This will replace all current habits and history.`
  );

  if(!ok){
    pendingImportHabits = null;
    setBackupMsg('Import cancelled. Your current data was not changed.', false);
    return;
  }

  habits = pendingImportHabits;
  pendingImportHabits = null;
  editingId = null;
  historyId = null;
  historyCursor = null;
  saveHabits();
  render();
  setBackupMsg(`Imported ${habits.length} habit${habits.length === 1 ? '' : 's'} successfully.`, false);
}

// =============================================================================
// Motivation
// =============================================================================
function dayIndexSeed(){
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  return Math.floor(diff / 86400000);
}

function showQuote(text, isMilestone){
  $('quoteText').textContent = text;
  $('flameIcon').textContent = isMilestone ? '⭐' : '🔥';
  $('quoteMeta').textContent = isMilestone ? 'MILESTONE' : new Date().toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
}

function showTodaysQuote(){
  const idx = dayIndexSeed() % QUOTES.length;
  showQuote(QUOTES[idx], false);
}

function showRandomQuote(){
  const idx = Math.floor(Math.random() * QUOTES.length);
  showQuote(QUOTES[idx], false);
}

// =============================================================================
// Initialization
// =============================================================================
function setHabitType(type){
  selectedType = type;
  const isGood = type === 'good';
  $('btnGood').classList.toggle('active', isGood);
  $('btnBad').classList.toggle('active', !isGood);
  $('btnGood').setAttribute('aria-pressed', isGood ? 'true' : 'false');
  $('btnBad').setAttribute('aria-pressed', isGood ? 'false' : 'true');
}

function init(){
  showTodaysQuote();

  loadHabits();
  $('statusMsg').hidden = true;
  $('columns').hidden = false;
  render();

  $('addHabitForm').addEventListener('submit', (e) => {
    e.preventDefault();
    addHabit();
  });

  $('btnGood').addEventListener('click', () => setHabitType('good'));
  $('btnBad').addEventListener('click', () => setHabitType('bad'));

  $('refreshQuote').addEventListener('click', showRandomQuote);

  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    await handleImportFile(file);
  });

  $('confirmCancel').addEventListener('click', () => closeConfirmModal(false));
  $('confirmOk').addEventListener('click', () => closeConfirmModal(true));
  document.addEventListener('keydown', handleModalKeydown);

  // Re-render when the calendar day changes while the tab stays open
  const refreshIfNewDay = () => {
    if(renderedDay && renderedDay !== todayStr(0) && editingId === null) render();
  };
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden) refreshIfNewDay();
  });
  window.addEventListener('focus', refreshIfNewDay);
  setInterval(refreshIfNewDay, 60000);

  $('confirmModal').addEventListener('click', (e) => {
    if(e.target === $('confirmModal')) closeConfirmModal(false);
  });

  $('resetBtn').addEventListener('click', () => {
    openConfirmModal(
      'Clear all data?',
      'This will delete all your habits and history. This cannot be undone.',
      'DELETE ALL'
    ).then((ok) => {
      if(!ok) return;
      habits = [];
      editingId = null;
      historyId = null;
      historyCursor = null;
      setBackupMsg('');
      render();
      saveHabits();
    });
  });
}

init();
