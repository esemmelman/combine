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

const state = readStorage(storageKey, { tasks: [], projects: [], backup: [] });
let selected = new Date();
let view = 'days';
let editing;
let remoteItems = [];
let remoteUser = null;
let remoteRequest = 0;
const editor = byId('editor');
const editForm = byId('edit-form');
const calendarBody = byId('calendar-body');

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

function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    alert('Browser storage is unavailable. Your latest changes are available until you close this page.');
  }
}

function commit() {
  save();
  renderSidebar();
  renderCalendar();
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
  state.tasks.push({ id: crypto.randomUUID(), title, projectId, date: '', time: '' });
  commit();
  byId(projectId ? 'add-' + projectId : 'add-task').elements.title.focus();
}

wireAdd(byId('add-task'), title => {
  byId('add-task').reset();
  addTask(title, null);
});
wireAdd(byId('add-project'), title => {
  state.projects.push({ id: crypto.randomUUID(), title });
  byId('add-project').reset();
  commit();
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
    const submit = element('button', 'primary', '+');
    submit.setAttribute('aria-label', 'Add task to ' + project.title);
    form.append(input, submit);
    wireAdd(form, title => addTask(title, project.id));
    section.append(heading, form, ...state.tasks.filter(task => task.projectId === project.id).map(taskRow));
    return section;
  });
  byId('projects').replaceChildren(...projects);
}

function openEditor(item, kind) {
  editing = { item, kind };
  const { title, date, time } = editForm.elements;
  byId('edit-title').textContent = kind === 'schedule' ? 'Schedule ' + item.title : kind === 'project' ? 'Edit project' : 'Edit task';
  byId('name-field').hidden = kind === 'schedule';
  byId('date-field').hidden = kind === 'project';
  byId('time-field').hidden = kind === 'project';
  title.required = kind !== 'schedule';
  date.required = kind === 'schedule';
  title.value = item.title;
  date.value = item.date || (kind === 'schedule' ? dateKey(selected) : '');
  time.value = item.time || '';
  byId('remove').hidden = kind === 'schedule' && !item.date;
  byId('remove').textContent = kind === 'schedule' ? 'Unschedule' : 'Delete';
  editor.showModal();
  (kind === 'schedule' ? date : title).focus();
}

editForm.addEventListener('submit', event => {
  event.preventDefault();
  const { title, date, time } = editForm.elements;
  if (!title.value.trim()) return;
  const { item, kind } = editing;
  item.title = title.value.trim();
  if (kind !== 'project') {
    item.date = date.value;
    item.time = item.date ? time.value : '';
    if (kind === 'schedule') selected = parseDate(item.date);
  }
  editor.close();
  commit();
});

byId('remove').addEventListener('click', () => {
  const { item, kind } = editing;
  if (kind === 'project') {
    const hasTasks = state.tasks.some(task => task.projectId === item.id);
    if (hasTasks && !confirm('Delete this project and all of its tasks?')) return;
    state.projects = state.projects.filter(project => project !== item);
    state.tasks = state.tasks.filter(task => task.projectId !== item.id);
  } else if (kind === 'schedule') {
    item.date = '';
    item.time = '';
  } else {
    state.tasks = state.tasks.filter(task => task !== item);
  }
  editor.close();
  commit();
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
    task.date = date;
    task.time = time;
    selected = parseDate(date);
    commit();
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
  const dayFlowItems = (remoteUser ? remoteItems : state.backup).filter(item => item.date === key);
  for (let minutes = -30; minutes < 1440; minutes += 30) {
    const allDay = minutes < 0;
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
  if (remoteUser?.id !== user?.id) {
    remoteRequest++;
    remoteItems = [];
  }
  remoteUser = user;
  connectForm.hidden = Boolean(user) || !client;
  byId('connected').hidden = !user;
  dayFlowStatus.textContent = user ? 'Connected to DayFlow.' :
    client ? 'Connect your DayFlow account to show its calendar.' : 'Account connection is unavailable. You can import a backup below.';
  renderCalendar();
  loadDayFlow();
}

client?.auth.onAuthStateChange((_event, session) => setTimeout(() => updateAccount(session), 0));
connectForm.onsubmit = async event => {
  event.preventDefault();
  const { email, password } = connectForm.elements;
  const submit = connectForm.querySelector('button');
  submit.disabled = true;
  dayFlowStatus.textContent = 'Connecting…';
  try {
    const { error } = await client.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
    if (error) throw error;
    connectForm.reset();
  } catch (error) {
    dayFlowStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
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
  if (error) dayFlowStatus.textContent = error.message;
};
window.addEventListener('focus', loadDayFlow);
window.addEventListener('online', loadDayFlow);

function updateBackupStatus() {
  byId('clear-import').hidden = !state.backup.length;
  byId('import-status').textContent = state.backup.length ?
    state.backup.length + ' dated items saved for use when signed out of DayFlow.' : '';
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
    state.backup = items.map(normalizeDayFlow).filter(Boolean);
    save();
    updateBackupStatus();
    if (!state.backup.length) byId('import-status').textContent = 'The backup contains no dated items.';
    renderCalendar();
  } catch {
    byId('import-status').textContent = 'Could not read this file. Choose a DayFlow JSON backup.';
  } finally {
    event.target.value = '';
  }
};
byId('clear-import').onclick = () => {
  state.backup = [];
  save();
  updateBackupStatus();
  renderCalendar();
};

renderSidebar();
renderCalendar();
updateBackupStatus();
if (!client) updateAccount(null);
