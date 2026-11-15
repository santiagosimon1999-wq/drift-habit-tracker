/* Drift — Habit Tracker
 * Vanilla JS UI. Pure logic (dates, goals, streaks, backup parsing) lives in logic.js. Persists habits under localStorage key "drift-habits".
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

const BACKUP_VERSION = 1;
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW_LABELS_MON = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
const DOW_LABELS_SUN = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

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

const svgIcon = (paths) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const ICON_HISTORY = svgIcon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>');
const ICON_EDIT = svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>');
const ICON_DELETE = svgIcon('<path d="M18 6 6 18M6 6l12 12"/>');

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
    <div class="progress-track" role="progressbar" aria-label="${label}: ${done} of ${goal}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="progress-fill ${fillClass || ''}" style="width:${pct}%"></div></div>
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

  const streak = streakInfo(h);
  const doneToday = !!h.log[todayStr(0)];
  const wave = last14(h);
  const week = weeklyProgress(h);
  const month = monthlyProgress(h);
  const historyOpen = historyId === h.id;
  const streakTitle = streak.unit === 'week'
    ? `Consecutive weeks reaching your ${getWeeklyGoal(h)}-day weekly goal`
    : 'Consecutive days';

  const top = document.createElement('div');
  top.className = 'card-top';
  top.innerHTML = `
    <div class="card-name">${escapeHtml(h.name)}</div>
    <div class="card-actions">
      <span class="streak-pill" title="${streakTitle}">${streakLabel(streak)}</span>
      <button type="button" class="hist-btn${historyOpen ? ' active' : ''}" title="History" aria-label="View habit history" aria-expanded="${historyOpen}">${ICON_HISTORY}</button>
      <button type="button" class="edit-btn" title="Edit habit" aria-label="Edit habit">${ICON_EDIT}</button>
      <button type="button" class="del-btn" title="Delete habit" aria-label="Delete habit">${ICON_DELETE}</button>
    </div>
  `;
  top.querySelector('.hist-btn').addEventListener('click', () => toggleHistory(h.id));
  top.querySelector('.edit-btn').addEventListener('click', () => editHabit(h.id));
  top.querySelector('.del-btn').addEventListener('click', () => deleteHabit(h.id));
  card.appendChild(top);

  const waveEl = document.createElement('div');
  waveEl.className = 'wave';
  waveEl.setAttribute('role', 'img');
  waveEl.setAttribute('aria-label', `Last 14 days: ${wave.filter(Boolean).length} of 14 days logged`);
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
  (getWeekStart() === 0 ? DOW_LABELS_SUN : DOW_LABELS_MON).forEach(label => {
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
  const best = bestStreak(habits);
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
  consPanel.appendChild(dashRow('Best active streak', streakLabel(best)));
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
  const longest = streakLabel(bestStreak(habits));

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
    <div class="stat"><div class="num">${escapeHtml(longest)}</div><div class="lbl">Longest active streak</div></div>
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
    showQuote(`${milestone.count}-${milestone.unit} streak on "${h.name}" — that's momentum. Don't stop now.`, true);
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

// =============================================================================
// Theme (System → Light → Dark)
// =============================================================================
const THEMES = ['system', 'light', 'dark'];

function getSavedTheme(){
  try {
    const t = localStorage.getItem('drift-theme');
    return THEMES.includes(t) ? t : 'system';
  } catch (e) { return 'system'; }
}

function applyTheme(theme){
  const root = document.documentElement;
  if(theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  $('themeBtn').textContent = 'Theme: ' + theme.charAt(0).toUpperCase() + theme.slice(1);
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta){
    const light = theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    meta.setAttribute('content', light ? '#f6f3ec' : '#12141a');
  }
}

function cycleTheme(){
  const next = THEMES[(THEMES.indexOf(getSavedTheme()) + 1) % THEMES.length];
  try {
    if(next === 'system') localStorage.removeItem('drift-theme');
    else localStorage.setItem('drift-theme', next);
  } catch (e) { /* theme just won't persist */ }
  applyTheme(next);
}

// =============================================================================
// Week start (Monday / Sunday)
// =============================================================================
function loadWeekStart(){
  try {
    setWeekStart(localStorage.getItem('drift-week-start') === 'sun' ? 0 : 1);
  } catch (e) { setWeekStart(1); }
  $('weekStartBtn').textContent = 'Week starts: ' + (getWeekStart() === 0 ? 'Sunday' : 'Monday');
}

function toggleWeekStart(){
  const next = getWeekStart() === 0 ? 'mon' : 'sun';
  try { localStorage.setItem('drift-week-start', next); } catch (e) { /* setting just won't persist */ }
  loadWeekStart();
  render();
}

function init(){
  showTodaysQuote();
  applyTheme(getSavedTheme());
  $('themeBtn').addEventListener('click', cycleTheme);
  loadWeekStart();
  $('weekStartBtn').addEventListener('click', toggleWeekStart);

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

  // Keep several open tabs in sync instead of letting a stale tab overwrite newer data
  window.addEventListener('storage', (e) => {
    if(e.key !== 'drift-habits' && e.key !== null) return;
    loadHabits();
    if(editingId && !habits.some(h => h.id === editingId)) editingId = null;
    if(historyId && !habits.some(h => h.id === historyId)){
      historyId = null;
      historyCursor = null;
    }
    render();
  });

  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  }

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
