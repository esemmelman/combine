'use strict';

const byId = id => document.getElementById(id);
const storageKey = 'combine:planner:v1';
const dragType = 'application/x-combine-task';
const pad = number => String(number).padStart(2, '0');
const dateKey = date => [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
const parseDate = key => new Date(key + 'T12:00:00');
const shift = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12);
const format = (date, options) => date.toLocaleDateString(undefined, options);
const timeValue = minutes => pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);

function minutesOf(time) {
  if (typeof time === 'number') return Math.round(time * 60);
  if (typeof time !== 'string' || !/^\d{1,2}:[0-5]\d(?::[0-5]\d)?$/.test(time)) return NaN;
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function timeLabel(minutes) {
  const hour = Math.floor(minutes / 60);
  return (hour % 12 || 12) + ':' + pad(minutes % 60) + (hour < 12 || hour === 24 ? ' AM' : ' PM');
}

function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

const device = readStorage(storageKey, { ...emptyPlanner(), backup: [] });
let state = device;
let selected = new Date();
let view = 'days';
let editing;
let remoteItems = [];
let remoteUser = null;
let remoteRequest = 0;
const editor = byId('editor');
const editForm = byId('edit-form');
const calendarBody = byId('calendar-body');
const notes = byId('notes');
let noteSelection;
let syncing = false;
let syncAgain = false;

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function button(text, label, action, className) {
  const item = element('button', className, text);
  item.type = 'button';
  if (label) item.setAttribute('aria-label', label);
  item.addEventListener('click', action);
  return item;
}

function saveDevice() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(device));
  } catch {
    alert('Browser storage is unavailable. Your latest changes are available until you close this page.');
  }
}

function commit(edits) {
  applyPlannerEdits(state, edits);
  if (remoteUser) {
    queuePlannerEdits(remoteUser.id, edits);
    refreshPlanner();
  } else {
    saveDevice();
  }
  renderSidebar();
  renderCalendar();
}

function createItem(collection, patch) {
  return { collection, id: crypto.randomUUID(), patch, create: true };
}

function wireAdd(form, action) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    const input = form.elements.title;
    const title = input.value.trim();
    if (!title) return;
    action(title);
  });
}

function addTask(title, projectId) {
  commit([createItem('tasks', { title, projectId, date: '', time: '' })]);
  byId(projectId ? 'add-' + projectId : 'add-task')?.elements.title.focus();
}

wireAdd(byId('add-task'), title => {
  byId('add-task').reset();
  addTask(title, null);
});
wireAdd(byId('add-project'), title => {
  byId('add-project').reset();
  commit([createItem('projects', { title })]);
});

function draggable(item, task) {
  item.draggable = true;
  item.addEventListener('dragstart', event => {
    event.dataTransfer.setData(dragType, task.id);
    event.dataTransfer.effectAllowed = 'move';
  });
}

function taskRow(task) {
  const row = element('div', 'task');
  const grip = element('span', 'grip', '⠿');
  grip.setAttribute('aria-hidden', 'true');
  row.append(grip, element('span', 'task-name', task.title),
    button('＋', 'Schedule ' + task.title, () => openEditor(task, 'schedule'), 'icon'),
    button('✎', 'Edit ' + task.title, () => openEditor(task, 'task'), 'icon'));
  draggable(row, task);
  return row;
}

function renderSidebar() {
  byId('tasks').replaceChildren(...state.tasks.filter(task => task.projectId === null).map(taskRow));
  const projects = state.projects.map(project => {
    const section = element('section', 'project');
    const heading = element('h3', 'project-title');
    heading.append(element('span', 'project-name', project.title),
      button('✎', 'Edit project ' + project.title, () => openEditor(project, 'project'), 'icon'));
    const form = element('form', 'inline');
    form.id = 'add-' + project.id;
    const input = element('input');
    input.name = 'title';
    input.placeholder = 'Add a task…';
    input.setAttribute('aria-label', 'Task name for ' + project.title);
    input.required = true;
    input.maxLength = 180;
    input.value = byId(form.id)?.elements.title.value || '';
    const submit = element('button', 'primary', '+');
    submit.setAttribute('aria-label', 'Add task to ' + project.title);
    form.append(input, submit);
    wireAdd(form, title => {
      form.reset();
      addTask(title, project.id);
    });
    section.append(heading, form, ...state.tasks.filter(task => task.projectId === project.id).map(taskRow));
    return section;
  });
  byId('projects').replaceChildren(...projects);
}

function openEditor(item, kind) {
  editing = { item: { ...item }, kind };
  const { title, date, time } = editForm.elements;
  byId('edit-title').textContent = kind === 'schedule' ? 'Schedule ' + item.title : kind === 'project' ? 'Edit project' : 'Edit task';
  byId('name-field').hidden = kind === 'schedule';
  byId('date-field').hidden = kind === 'project';
  byId('time-field').hidden = kind === 'project';
  byId('notes-field').hidden = kind === 'schedule';
  title.required = kind !== 'schedule';
  date.required = kind === 'schedule';
  title.value = item.title;
  date.value = item.date || (kind === 'schedule' ? dateKey(selected) : '');
  time.value = item.time || '';
  notes.innerHTML = cleanNotes(item.notes || '');
  noteSelection = null;
  byId('remove').hidden = kind === 'schedule' && !item.date;
  byId('remove').textContent = kind === 'schedule' ? 'Unschedule' : 'Delete';
  editor.showModal();
  (kind === 'schedule' ? date : title).focus();
}

const noteTags = new Set(['b', 'strong', 'i', 'em', 'u', 'br', 'p', 'div', 'ul', 'ol', 'li']);

function cleanNotes(html) {
  const source = document.createElement('template');
  source.innerHTML = html;
  const output = document.createElement('div');
  function appendSafe(parent, nodes) {
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        parent.append(node.textContent);
      } else if (node.nodeType === Node.ELEMENT_NODE && !['script', 'style', 'template'].includes(node.localName)) {
        const destination = noteTags.has(node.localName) ? parent.appendChild(element(node.localName)) : parent;
        appendSafe(destination, node.childNodes);
      }
    }
  }
  appendSafe(output, source.content.childNodes);
  return output.textContent.trim() ? output.innerHTML : '';
}

document.addEventListener('selectionchange', () => {
  const selection = document.getSelection();
  if (selection.rangeCount && notes.contains(selection.anchorNode) && notes.contains(selection.focusNode)) {
    noteSelection = selection.getRangeAt(0).cloneRange();
  }
});
byId('notes-toolbar').addEventListener('mousedown', event => event.preventDefault());
byId('notes-toolbar').addEventListener('click', event => {
  const control = event.target.closest('[data-command]');
  if (!control) return;
  notes.focus();
  if (noteSelection && notes.contains(noteSelection.commonAncestorContainer)) {
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(noteSelection);
  }
  document.execCommand('styleWithCSS', false, false);
  document.execCommand(control.dataset.command);
});
notes.addEventListener('paste', event => {
  event.preventDefault();
  document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
});
notes.addEventListener('drop', event => event.preventDefault());

editForm.addEventListener('submit', event => {
  event.preventDefault();
  const { title, date, time } = editForm.elements;
  if (!title.value.trim()) return;
  const { item, kind } = editing;
  const patch = {};
  if (kind !== 'schedule') {
    const safeNotes = cleanNotes(notes.innerHTML);
    if (title.value.trim() !== item.title) patch.title = title.value.trim();
    if (safeNotes !== cleanNotes(item.notes || '')) patch.notes = safeNotes;
  }
  if (kind !== 'project') {
    const clock = date.value ? time.value : '';
    if (date.value !== item.date || clock !== item.time) Object.assign(patch, { date: date.value, time: clock });
  }
  editor.close();
  if (kind === 'schedule') navigate(parseDate(date.value));
  if (Object.keys(patch).length) commit([{ collection: kind === 'project' ? 'projects' : 'tasks', id: item.id, patch }]);
});

byId('remove').addEventListener('click', () => {
  const { item, kind } = editing;
  if (kind === 'project') {
    const hasTasks = state.tasks.some(task => task.projectId === item.id);
    if (hasTasks && !confirm('Delete this project and all of its tasks?')) return;
  }
  editor.close();
  const patch = kind === 'schedule' ? { date: '', time: '' } : null;
  commit([{ collection: kind === 'project' ? 'projects' : 'tasks', id: item.id, patch }]);
});

document.querySelectorAll('[data-close]').forEach(item => {
  item.addEventListener('click', () => item.closest('dialog').close());
});

function dropTarget(item, date, time) {
  item.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer.types).includes(dragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    item.classList.add('drop-active');
  });
  item.addEventListener('dragleave', event => {
    if (!item.contains(event.relatedTarget)) item.classList.remove('drop-active');
  });
  item.addEventListener('drop', event => {
    const task = state.tasks.find(task => task.id === event.dataTransfer.getData(dragType));
    if (!task) return;
    event.preventDefault();
    item.classList.remove('drop-active');
    selected = parseDate(date);
    commit([{ collection: 'tasks', id: task.id, patch: { date, time } }]);
    byId('notice').textContent = task.title + ' scheduled for ' + date + (time ? ' at ' + timeLabel(minutesOf(time)) : '');
  });
}

function taskEvent(task) {
  const item = button(task.title, null, () => openEditor(task, 'schedule'), 'event planner');
  if (task.time) item.append(element('small', '', timeLabel(minutesOf(task.time))));
  draggable(item, task);
  return item;
}

function sortedTasks(date) {
  return state.tasks.filter(task => task.date === date).sort((first, second) => first.time.localeCompare(second.time));
}

function renderWeek(start, today) {
  const week = element('div', 'week');
  for (let index = 0; index < 7; index++) {
    const date = shift(start, index);
    const key = dateKey(date);
    const day = element('section', key === dateKey(selected) ? 'day selected' : 'day');
    const heading = button(format(date, { weekday: 'short' }), format(date, { dateStyle: 'full' }) + ' half-hour schedule', () => {
      selected = date;
      changeView('hours');
    }, 'day-heading');
    heading.append(element('span', '', format(date, { month: 'short', day: 'numeric' })));
    if (key === today) heading.setAttribute('aria-current', 'date');
    day.append(heading, ...sortedTasks(key).map(taskEvent));
    dropTarget(day, key, '');
    week.append(day);
  }
  return week;
}

function normalizeDayFlow(item) {
  const parts = typeof item.date === 'string' ? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(item.date) : null;
  if (!parts) return null;
  const date = [parts[1], pad(Number(parts[2])), pad(Number(parts[3]))].join('-');
  const start = minutesOf(item.start_time ?? item.time);
  const end = minutesOf(item.end_time ?? item.endTime);
  return {
    date,
    title: item.title,
    start: start >= 0 && start < 1440 ? start : null,
    end: end > start && end <= 1440 ? end : null
  };
}

function dayFlowEvent(item, continued) {
  const badge = element('div', continued ? 'event dayflow continued' : 'event dayflow', item.title);
  if (item.start !== null) {
    const time = continued ? 'Continues until ' + timeLabel(item.end) :
      timeLabel(item.start) + (item.end === null ? '' : ' – ' + timeLabel(item.end));
    badge.append(element('small', '', time));
  }
  return badge;
}

function renderSchedule(key) {
  const schedule = element('div', 'schedule');
  const tasks = sortedTasks(key);
  const dayFlowItems = (remoteUser ? remoteItems : device.backup).filter(item => item.date === key);
  for (let minutes = -30; minutes < 23 * 60; minutes += 30) {
    const allDay = minutes < 0;
    if (!allDay && minutes < 5 * 60 + 30) continue;
    const row = element('div', allDay ? 'slot all-day' : 'slot');
    row.dataset.minutes = minutes;
    const items = element('div', 'slot-items');
    for (const task of tasks) {
      const start = minutesOf(task.time);
      if (allDay ? !task.time : start >= minutes && start < minutes + 30) items.append(taskEvent(task));
    }
    for (const item of dayFlowItems) {
      const occurs = item.start !== null && item.start < minutes + 30 && (item.end ?? item.start + 1) > minutes;
      if (allDay ? item.start === null : occurs) items.append(dayFlowEvent(item, !allDay && item.start < minutes));
    }
    row.append(element('div', 'slot-label', allDay ? 'All day' : timeLabel(minutes)), items);
    dropTarget(row, key, allDay ? '' : timeValue(minutes));
    schedule.append(row);
  }
  return schedule;
}

function renderCalendar(resetScroll = false) {
  const today = dateKey(new Date());
  const key = dateKey(selected);
  const weekStart = shift(selected, -selected.getDay());
  const shortDate = { month: 'short', day: 'numeric' };
  const scrollTop = calendarBody.firstElementChild?.scrollTop || 0;
  byId('calendar-title').textContent = view === 'days' ?
    format(weekStart, shortDate) + ' – ' + format(shift(weekStart, 6), { ...shortDate, year: 'numeric' }) :
    format(selected, { dateStyle: 'full' });
  byId('date-picker').value = key;
  byId('legend').hidden = view !== 'hours';
  byId('days').setAttribute('aria-pressed', String(view === 'days'));
  byId('hours').setAttribute('aria-pressed', String(view === 'hours'));
  byId('previous').setAttribute('aria-label', view === 'days' ? 'Previous week' : 'Previous day');
  byId('next').setAttribute('aria-label', view === 'days' ? 'Next week' : 'Next day');
  const content = view === 'days' ? renderWeek(weekStart, today) : renderSchedule(key);
  calendarBody.replaceChildren(content);
  if (view === 'hours') {
    content.scrollTop = resetScroll ?
      content.querySelector('[data-minutes="480"]').offsetTop - content.offsetTop - content.firstElementChild.offsetHeight : scrollTop;
  }
}

function changeView(nextView) {
  if (view === nextView) return;
  view = nextView;
  renderCalendar(true);
  loadDayFlow();
}

function navigate(date) {
  selected = date;
  renderCalendar();
  loadDayFlow();
}

byId('days').onclick = () => changeView('days');
byId('hours').onclick = () => changeView('hours');
byId('previous').onclick = () => navigate(shift(selected, view === 'days' ? -7 : -1));
byId('next').onclick = () => navigate(shift(selected, view === 'days' ? 7 : 1));
byId('today').onclick = () => navigate(new Date());
byId('date-picker').onchange = event => {
  if (event.target.value) navigate(parseDate(event.target.value));
};

const settings = window.DAYFLOW_SUPABASE;
const client = window.supabase?.createClient(settings.url, settings.publishableKey, {
  auth: { storageKey: 'combine:dayflow-auth', detectSessionInUrl: false }
});
const dayFlowStatus = byId('dayflow-status');
const connectForm = byId('connect-form');
const accountStatus = byId('account-status');
const syncStatus = byId('sync-status');
const importedKey = id => 'combine:imported:' + id;

function setPlanner(planner) {
  if (JSON.stringify(state) === JSON.stringify(planner)) return;
  state = planner;
  renderSidebar();
  renderCalendar();
}

async function refreshPlanner() {
  const id = remoteUser?.id;
  if (!id) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  const isCurrent = () => remoteUser?.id === id;
  syncing = true;
  if (pendingPlannerEdits(id).length || syncStatus.textContent !== 'Synced') syncStatus.textContent = 'Syncing…';
  try {
    await syncPlanner(client, id, isCurrent, planner => {
      const pending = pendingPlannerEdits(id);
      setPlanner(applyPlannerEdits(planner, pending.flatMap(([, edits]) => edits)));
      syncStatus.textContent = pending.length ? 'Syncing…' : 'Synced';
      if (pending.length) syncAgain = true;
    });
  } catch {
    if (isCurrent()) syncStatus.textContent = 'Sync unavailable · retrying';
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      refreshPlanner();
    }
  }
}

async function loadDayFlow() {
  if (!remoteUser || view !== 'hours') return;
  const request = ++remoteRequest;
  const date = dateKey(selected);
  const items = [];
  const pageSize = 500;
  dayFlowStatus.textContent = 'Loading DayFlow…';
  try {
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await client.from('tasks')
        .select('title,date,start_time,end_time')
        .eq('user_id', remoteUser.id)
        .eq('date', date)
        .order('id')
        .range(offset, offset + pageSize - 1);
      if (request !== remoteRequest || view !== 'hours') return;
      if (error) throw error;
      items.push(...data.map(normalizeDayFlow).filter(Boolean));
      if (data.length < pageSize) break;
    }
    remoteItems = items;
    dayFlowStatus.textContent = 'Connected to DayFlow.';
  } catch (error) {
    if (request !== remoteRequest) return;
    dayFlowStatus.textContent = 'Could not refresh DayFlow. ' + error.message;
  }
  renderCalendar();
}

function updateAccount(session) {
  const user = session?.user || null;
  const changed = remoteUser?.id !== user?.id;
  if (changed) {
    remoteRequest++;
    remoteItems = [];
    if (editor.open) editor.close();
  }
  remoteUser = user;
  connectForm.hidden = Boolean(user) || !client;
  byId('connected').hidden = !user;
  byId('dayflow-account').hidden = Boolean(user);
  byId('refresh').hidden = !user;
  byId('import-local').hidden = !user || !(device.tasks.length || device.projects.length) ||
    readStorage(importedKey(user.id), false);
  accountStatus.textContent = user ? 'Signed in as ' + (user.email || 'your DayFlow account') + '.' :
    client ? 'Sign in with your DayFlow account to sync tasks, projects, and notes across devices.' :
      'Sign-in is unavailable. Changes are saved in this browser.';
  dayFlowStatus.textContent = user ? 'Connected to DayFlow.' :
    client ? 'Sign in to show your DayFlow calendar.' : 'Account connection is unavailable. You can import a backup below.';
  if (changed) {
    const planner = user ? readStorage(plannerCacheKey(user.id), emptyPlanner()) : device;
    if (user) applyPlannerEdits(planner, pendingPlannerEdits(user.id).flatMap(([, edits]) => edits));
    state = planner;
    document.querySelectorAll('aside input').forEach(input => { input.value = ''; });
    renderSidebar();
  }
  if (!user) syncStatus.textContent = 'On this device';
  refreshPlanner();
  renderCalendar();
  loadDayFlow();
}

client?.auth.onAuthStateChange((_event, session) => setTimeout(() => updateAccount(session), 0));
connectForm.onsubmit = async event => {
  event.preventDefault();
  const { email, password } = connectForm.elements;
  const submit = connectForm.querySelector('button');
  submit.disabled = true;
  accountStatus.textContent = 'Signing in…';
  try {
    const { error } = await client.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
    if (error) throw error;
    connectForm.reset();
  } catch (error) {
    accountStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

byId('account-settings').onclick = () => byId('account-dialog').showModal();
byId('dayflow-account').onclick = () => {
  byId('dayflow-dialog').close();
  byId('account-dialog').showModal();
};
byId('import-local').onclick = () => {
  if (!remoteUser) return;
  const edits = ['projects', 'tasks'].flatMap(collection =>
    device[collection].map(({ id, ...patch }) => ({ collection, id, patch, create: true })));
  commit(edits);
  try { localStorage.setItem(importedKey(remoteUser.id), 'true'); } catch {}
  byId('import-local').hidden = true;
};
byId('dayflow-settings').onclick = () => {
  byId('dayflow-dialog').showModal();
  loadDayFlow();
};
byId('refresh').onclick = () => {
  if (view !== 'hours') changeView('hours');
  else loadDayFlow();
};
byId('disconnect').onclick = async () => {
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) accountStatus.textContent = error.message;
};
window.addEventListener('focus', loadDayFlow);
window.addEventListener('online', loadDayFlow);
window.addEventListener('focus', refreshPlanner);
window.addEventListener('online', refreshPlanner);
setInterval(() => { if (!document.hidden) refreshPlanner(); }, 15000);

function updateBackupStatus() {
  byId('clear-import').hidden = !device.backup.length;
  byId('import-status').textContent = device.backup.length ?
    device.backup.length + ' dated items saved in this browser for use when signed out.' : '';
}

byId('import').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const backup = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
    const items = Array.isArray(backup) ? backup : backup?.format === 'dayflow-backup' && backup.tasks;
    if (!Array.isArray(items) || items.some(item => !item || typeof item.title !== 'string' || item.id == null)) {
      throw new Error('Choose a DayFlow JSON backup.');
    }
    device.backup = items.map(normalizeDayFlow).filter(Boolean);
    saveDevice();
    updateBackupStatus();
    if (!device.backup.length) byId('import-status').textContent = 'The backup contains no dated items.';
    renderCalendar();
  } catch {
    byId('import-status').textContent = 'Could not read this file. Choose a DayFlow JSON backup.';
  } finally {
    event.target.value = '';
  }
};
byId('clear-import').onclick = () => {
  device.backup = [];
  saveDevice();
  updateBackupStatus();
  renderCalendar();
};

renderSidebar();
renderCalendar();
updateBackupStatus();
if (!client) updateAccount(null);
