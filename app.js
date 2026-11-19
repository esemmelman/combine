'use strict';

const byId = id => document.getElementById(id);
const storageKey = 'combine:planner:v1';
const dragType = 'application/x-combine-task';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
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
let ganttWidth;
let editing;
let remoteItems = [];
let remoteUser = null;
let remoteRequest = 0;
const editor = byId('editor');
const editForm = byId('edit-form');
const calendarBody = byId('calendar-body');
const notes = byId('notes');
let noteSelection;
let activeNote;
let syncing = false;
let syncAgain = false;
let activeDictation;
const collapsedProjects = new Set();
const taskDraftRows = new Set();

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
  renderCalendar();
}

function createItem(collection, patch) {
  return { collection, id: crypto.randomUUID(), patch, create: true };
}

function wireAdd(form, action) {
  const input = form.elements.title;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    if (activeDictation?.formId === form.id) activeDictation.cancel();
    action(title);
  });
  if (!SpeechRecognition) return;

  input.addEventListener('input', () => {
    if (activeDictation?.formId === form.id) activeDictation.cancel();
  });
  input.addEventListener('click', () => {
    if (activeDictation?.formId === form.id) {
      activeDictation.cancel();
    } else if (!input.value.trim()) {
      activeDictation?.cancel();
      input.value = '';
      listenForName(form.id);
    }
  });
}

function startTaskDictation() {
  const input = byId('add-task').elements.title;
  const focused = document.activeElement;
  if (SpeechRecognition && !activeDictation && !input.value &&
      (focused === input || focused === document.body)) listenForName('add-task');
}

function listenForName(formId) {
  const recognition = new SpeechRecognition();
  const status = byId('dictation-status');
  let timer;
  let transcript = '';
  let ended = false;
  const session = {
    formId,
    cancel() {
      const field = byId(formId)?.elements.title;
      if (field && field.value === transcript) field.value = '';
      finish();
      if (!ended) recognition.abort();
    }
  };

  function finish(message = '') {
    clearTimeout(timer);
    activeDictation = undefined;
    status.textContent = message;
  }

  function save() {
    finish();
    const form = byId(formId);
    const field = form?.elements.title;
    if (transcript && field?.value === transcript) form.requestSubmit();
    if (!ended) recognition.abort();
  }

  function waitForSilence() {
    clearTimeout(timer);
    timer = setTimeout(save, 3000);
  }

  activeDictation = session;
  recognition.lang = document.documentElement.lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  status.textContent = 'Listening… Click again to cancel.';
  recognition.onsoundstart = recognition.onspeechstart = () => {
    if (activeDictation !== session) return;
    clearTimeout(timer);
    timer = undefined;
  };
  recognition.onsoundend = () => {
    if (activeDictation === session && transcript) waitForSilence();
  };
  recognition.onspeechend = () => {
    if (activeDictation === session && transcript && timer === undefined) waitForSilence();
  };
  recognition.onresult = event => {
    if (activeDictation !== session) return;
    const field = byId(formId)?.elements.title;
    if (!field || field.value !== transcript) return;
    const text = Array.from(event.results, result => result[0].transcript.trim()).join(' ').trim().slice(0, field.maxLength);
    if (text === transcript) return;
    transcript = text;
    field.value = text;
    if (text) waitForSilence();
    else {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  recognition.onerror = event => {
    if (activeDictation === session && event.error !== 'no-speech') {
      finish('Dictation failed. Check microphone access or try again.');
    }
  };
  recognition.onend = () => {
    ended = true;
    if (activeDictation !== session) return;
    if (!transcript) finish();
    else if (timer === undefined) waitForSilence();
  };
  try {
    recognition.start();
  } catch {
    finish('Dictation could not start. Try again.');
  }
}

wireAdd(byId('add-task'), title => {
  const form = byId('add-task');
  form.reset();
  commit([createItem('tasks', { title, projectId: null, date: '', time: '' })]);
  form.elements.title.focus();
});
wireAdd(byId('add-project'), title => {
  byId('add-project').reset();
  commit([createItem('projects', { title })]);
});

function draggable(item, entry, collection = 'tasks') {
  item.draggable = true;
  item.addEventListener('dragstart', event => {
    event.dataTransfer.setData(dragType, collection + '/' + entry.id);
    event.dataTransfer.effectAllowed = 'move';
  });
}

function inlineTaskForm(formId, entry, collection, projectId) {
  const form = element('form', 'inline');
  form.id = formId;
  const input = element('input');
  input.name = 'title';
  input.enterKeyHint = 'go';
  input.setAttribute('aria-label', 'New task below ' + entry.title);
  input.required = true;
  input.maxLength = 180;
  input.value = byId(form.id)?.elements.title.value || '';
  form.append(input);
  wireAdd(form, title => {
    taskDraftRows.delete(formId);
    const edit = createItem('tasks', { title, projectId, date: '', time: '', ...(!projectId && { inGantt: true }) });
    if (collection === 'projects') edit.beforeId = state.tasks.find(task => task.projectId === projectId)?.id;
    else edit.afterId = entry.id;
    commit([edit]);
  });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (activeDictation?.formId === formId) activeDictation.cancel();
    taskDraftRows.delete(formId);
    renderCalendar();
    byId(formId + '-trigger')?.focus();
  });
  return form;
}

function openEditor(item, collection) {
  editing = { item: { ...item }, collection };
  const { title, date, time } = editForm.elements;
  byId('edit-title').textContent = collection === 'projects' ? 'Project properties' : 'Task properties';
  title.value = item.title;
  date.value = item.date || '';
  time.value = item.time || '';
  notes.replaceChildren();
  for (const html of noteEntries(item)) addNoteEditor(html);
  if (!notes.children.length) addNoteEditor();
  activeNote = notes.querySelector('.note-editor');
  noteSelection = null;
  byId('unschedule').hidden = !item.date;
  const toggle = byId('toggle-project-tasks');
  toggle.hidden = collection !== 'projects';
  toggle.textContent = collapsedProjects.has(item.id) ? 'Show tasks' : 'Hide tasks';
  editor.showModal();
  title.focus();
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

function noteEntries(item) {
  const entries = Array.isArray(item.notes) ? item.notes : [item.notes || ''];
  return entries.map(cleanNotes).filter(Boolean);
}

function addNoteEditor(html = '') {
  const entry = element('div', 'note-entry');
  const field = element('div', 'note-editor');
  field.contentEditable = 'true';
  field.setAttribute('role', 'textbox');
  field.setAttribute('aria-multiline', 'true');
  field.setAttribute('aria-label', 'Note');
  field.innerHTML = html;
  entry.append(field, button('Remove note', null, () => {
    entry.remove();
    noteSelection = null;
    (notes.querySelector('.note-editor') || addNoteEditor()).focus();
  }));
  notes.append(entry);
  return field;
}

byId('add-note').addEventListener('click', () => addNoteEditor().focus());
notes.addEventListener('focusin', event => {
  if (!event.target.matches('.note-editor')) return;
  if (activeNote !== event.target) noteSelection = null;
  activeNote = event.target;
});
document.addEventListener('selectionchange', () => {
  const selection = document.getSelection();
  if (selection.rangeCount && activeNote?.contains(selection.anchorNode) && activeNote.contains(selection.focusNode)) {
    noteSelection = selection.getRangeAt(0).cloneRange();
  }
});
byId('notes-toolbar').addEventListener('mousedown', event => event.preventDefault());
byId('notes-toolbar').addEventListener('click', event => {
  const control = event.target.closest('[data-command]');
  if (!control || !activeNote) return;
  activeNote.focus();
  if (noteSelection && activeNote.contains(noteSelection.commonAncestorContainer)) {
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
  const { item, collection } = editing;
  const patch = {};
  const safeNotes = [...notes.querySelectorAll('.note-editor')].map(field => cleanNotes(field.innerHTML)).filter(Boolean);
  if (title.value.trim() !== item.title) patch.title = title.value.trim();
  if (JSON.stringify(safeNotes) !== JSON.stringify(noteEntries(item))) patch.notes = safeNotes;
  const clock = date.value ? time.value : '';
  if (date.value !== (item.date || '') || clock !== (item.time || '')) Object.assign(patch, { date: date.value, time: clock });
  editor.close();
  if (Object.keys(patch).length) commit([{ collection, id: item.id, patch }]);
  if (patch.date) navigate(parseDate(patch.date));
});

byId('remove').addEventListener('click', () => {
  const { item, collection } = editing;
  if (collection === 'projects') {
    const hasTasks = state.tasks.some(task => task.projectId === item.id);
    if (hasTasks && !confirm('Delete this project and all of its tasks?')) return;
  }
  editor.close();
  commit([{ collection, id: item.id, patch: null }]);
});

byId('unschedule').addEventListener('click', () => {
  const { item, collection } = editing;
  editor.close();
  commit([{ collection, id: item.id, patch: { date: '', time: '' } }]);
});

byId('toggle-project-tasks').addEventListener('click', () => {
  const { id } = editing.item;
  editor.close();
  byId('project-toggle-' + id)?.click();
  byId('project-toggle-' + id)?.focus();
});

document.querySelectorAll('[data-close]').forEach(item => {
  item.addEventListener('click', () => item.closest('dialog').close());
});

function plannerDropTarget(item, onDrop) {
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
    item.classList.remove('drop-active');
    const [collection, id] = event.dataTransfer.getData(dragType).split('/');
    if (collection !== 'tasks' && collection !== 'projects') return;
    const entry = state[collection].find(entry => entry.id === id);
    if (!entry) return;
    event.preventDefault();
    onDrop(entry, collection);
  });
}

function dropTarget(item, date, time) {
  plannerDropTarget(item, (entry, collection) => {
    selected = parseDate(date);
    const clock = time ?? entry.time ?? '';
    commit([{ collection, id: entry.id, patch: { date, time: clock } }]);
    byId('notice').textContent = entry.title + ' scheduled for ' + date + (clock ? ' at ' + timeLabel(minutesOf(clock)) : '');
  });
}

function moveIntoNames(entry, collection) {
  const standalone = collection === 'tasks' && standaloneTasks().includes(entry);
  if (!entry.date && (!standalone || entry.inGantt)) return;
  const patch = { date: '', time: '' };
  if (standalone) patch.inGantt = true;
  commit([{ collection, id: entry.id, patch }]);
  byId('notice').textContent = entry.title + ' moved to column A';
}

function plannerEvent({ entry, collection }) {
  const item = button(entry.title, null, () => openEditor(entry, collection), 'event planner');
  const details = [collection === 'projects' ? 'Project' : '', entry.time ? timeLabel(minutesOf(entry.time)) : ''].filter(Boolean);
  if (details.length) item.append(element('small', '', details.join(' · ')));
  draggable(item, entry, collection);
  return item;
}

function scheduledEntries(date) {
  return ['tasks', 'projects'].flatMap(collection => state[collection]
    .filter(entry => entry.date === date).map(entry => ({ entry, collection })))
    .sort((first, second) => (first.entry.time || '').localeCompare(second.entry.time || ''));
}

function standaloneTasks() {
  const projectIds = new Set(state.projects.map(project => project.id));
  return state.tasks.filter(task => !projectIds.has(task.projectId));
}

function renderStandalonePanel() {
  byId('standalone-tasks').replaceChildren(...standaloneTasks().filter(task => !task.date && !task.inGantt).map(task => {
    const name = button(task.title, null, () => openEditor(task, 'tasks'), 'standalone-task');
    draggable(name, task);
    return name;
  }));
}

function renderGantt(start, today) {
  const chart = element('div', 'gantt-scroll');
  chart.tabIndex = 0;
  chart.setAttribute('role', 'region');
  chart.setAttribute('aria-label', 'Gantt chart');
  const table = element('table', 'gantt');
  const header = table.createTHead();
  const weekdays = header.insertRow();
  const monthsRow = header.insertRow();
  const datesRow = header.insertRow();
  const namesHeading = plannerNamesHeading();
  namesHeading.rowSpan = 3;
  namesHeading.append(byId('toggle-standalone-panel'));
  weekdays.append(namesHeading);
  const plannerRows = [];
  addPlannerRows(table, (row, entry, collection) => plannerRows.push({ row, entry, collection }));
  chart.append(table);
  calendarBody.replaceChildren(chart);

  // Measure the project and task column before adding dates.
  const dayWidth = parseFloat(getComputedStyle(chart).getPropertyValue('--gantt-day-width'));
  const availableWidth = chart.clientWidth - table.getBoundingClientRect().width;
  const dayCount = Math.max(7, Math.floor(availableWidth / dayWidth));
  const dates = Array.from({ length: dayCount }, (_, index) => {
    const date = shift(start, index);
    const weekday = date.getDay();
    return { date, key: dateKey(date), weekend: weekday === 0 || weekday === 6 };
  });
  for (const { date, key, weekend } of dates) {
    const weekday = element('th', '', format(date, { weekday: 'narrow' }));
    const month = element('th', '', pad(date.getMonth() + 1));
    const cell = element('th');
    cell.scope = 'col';
    const heading = button(pad(date.getDate()), 'Show times for ' + format(date, { dateStyle: 'full' }), () => {
      selected = date;
      changeView('hours');
    }, 'gantt-date');
    if (weekend) {
      weekday.classList.add('weekend');
      month.classList.add('weekend');
      cell.classList.add('weekend');
    }
    if (key === today) {
      weekday.classList.add('current-day');
      month.classList.add('current-day');
      cell.classList.add('current-day');
      heading.setAttribute('aria-current', 'date');
    }
    cell.append(heading);
    weekdays.append(weekday);
    monthsRow.append(month);
    datesRow.append(cell);
    dropTarget(weekday, key, null);
    dropTarget(month, key, null);
    dropTarget(cell, key, null);
  }
  for (const { row, entry, collection } of plannerRows) {
    for (const { key, weekend } of dates) {
      const cell = row.insertCell();
      cell.classList.toggle('weekend', weekend);
      if (entry?.date === key) {
        const mark = button('', entry.title + ', scheduled ' + key, () => openEditor(entry, collection), 'gantt-mark');
        draggable(mark, entry, collection);
        cell.append(mark);
      }
      dropTarget(cell, key, null);
    }
  }
  return { chart, lastDate: dates.at(-1).date };
}

function plannerNamesHeading() {
  const heading = element('th', 'gantt-names');
  heading.scope = 'col';
  heading.append(element('span', 'sr-only', 'Projects and tasks'));
  plannerDropTarget(heading, moveIntoNames);
  return heading;
}

function addPlannerRows(table, addDateCells = () => {}) {
  const body = table.createTBody();
  function addRow(entry, collection, child = false) {
    const row = body.insertRow();
    const label = element('th', 'gantt-row-label');
    label.scope = 'row';
    if (entry) {
      const name = button(entry.title, null, () => openEditor(entry, collection), 'gantt-name');
      if (child && (view === 'hours' ? entry.time : entry.date)) name.classList.add('scheduled-project-task');
      name.title = entry.title;
      draggable(name, entry, collection);
      const actions = element('div', 'gantt-name-actions');
      const formId = 'insert-task-' + collection + '-' + entry.id;
      const isProject = collection === 'projects';
      const insert = button('', (isProject ? 'Add task to ' : 'Insert task below ') + entry.title, () => {
        if (!taskDraftRows.has(formId) || (isProject && collapsedProjects.has(entry.id))) {
          taskDraftRows.add(formId);
          if (isProject) collapsedProjects.delete(entry.id);
          renderCalendar();
        }
        byId(formId)?.elements.title.focus();
      }, 'gantt-insert');
      insert.id = formId + '-trigger';
      insert.title = isProject ? 'Add task to project' : 'Insert task below';
      actions.append(name, insert);
      label.append(actions);
      if (isProject) label.addEventListener('click', event => {
        if (event.target === label) insert.click();
      });
    }
    row.classList.toggle('gantt-child', child);
    row.classList.toggle('gantt-project', collection === 'projects');
    row.append(label);
    plannerDropTarget(label, moveIntoNames);
    addDateCells(row, entry, collection);
    return row;
  }
  function addDraft(entry, collection, projectId) {
    const formId = 'insert-task-' + collection + '-' + entry.id;
    if (!taskDraftRows.has(formId)) return;
    const row = addRow(null, 'tasks', Boolean(projectId));
    row.firstElementChild.append(inlineTaskForm(formId, entry, collection, projectId));
    return row;
  }
  for (const task of standaloneTasks().filter(task => task.date || task.inGantt)) {
    addRow(task, 'tasks');
    addDraft(task, 'tasks', null);
  }
  for (const project of state.projects) {
    const row = addRow(project, 'projects');
    const children = [addDraft(project, 'projects', project.id)].filter(Boolean);
    for (const task of state.tasks.filter(task => task.projectId === project.id)) {
      children.push(addRow(task, 'tasks', true));
      const draft = addDraft(task, 'tasks', project.id);
      if (draft) children.push(draft);
    }
    if (!children.length) continue;
    const toggle = button('', 'Toggle tasks for ' + project.title, () => {
      if (collapsedProjects.has(project.id)) collapsedProjects.delete(project.id);
      else {
        collapsedProjects.add(project.id);
        const dictationForm = activeDictation && byId(activeDictation.formId);
        if (dictationForm && children.some(child => child.contains(dictationForm))) activeDictation.cancel();
      }
      updateDisclosure();
    }, 'gantt-toggle');
    function updateDisclosure() {
      const collapsed = collapsedProjects.has(project.id);
      toggle.textContent = collapsed ? '›' : '⌄';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      children.forEach(child => { child.hidden = collapsed; });
    }
    toggle.id = 'project-toggle-' + project.id;
    row.firstElementChild.prepend(toggle);
    updateDisclosure();
  }
  if (!body.rows.length) addRow();
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
  const layout = element('div', 'times-layout');
  const names = element('table', 'gantt times-names');
  names.setAttribute('aria-label', 'Column A, projects and tasks');
  names.createTHead().insertRow().append(plannerNamesHeading());
  addPlannerRows(names);
  const schedule = element('div', 'schedule');
  schedule.tabIndex = 0;
  schedule.setAttribute('role', 'region');
  schedule.setAttribute('aria-label', 'Hourly schedule');
  const entries = scheduledEntries(key);
  const dayFlowItems = (remoteUser ? remoteItems : device.backup).filter(item => item.date === key);
  const hours = Array.from({ length: 17 }, (_, index) => index + 6);
  const grid = element('div', 'times-grid');
  const columns = [];
  for (const hour of [null, ...hours]) {
    const allDay = hour === null;
    const minutes = hour * 60;
    const slot = element('div', allDay ? 'slot all-day' : 'slot');
    if (!allDay) slot.dataset.hour = hour;
    const items = [];
    for (const scheduled of entries) {
      const start = minutesOf(scheduled.entry.time);
      if (allDay ? !scheduled.entry.time : start >= minutes && start < minutes + 60) items.push(plannerEvent(scheduled));
    }
    for (const item of dayFlowItems) {
      const occurs = item.start !== null && item.start < minutes + 60 && (item.end ?? item.start + 1) > minutes;
      if (allDay ? item.start === null : occurs) items.push(dayFlowEvent(item, !allDay && item.start < minutes));
    }
    slot.append(element('div', 'slot-label', allDay ? 'All day' : timeLabel(minutes)));
    dropTarget(slot, key, allDay ? '' : timeValue(minutes));
    columns.push({ slot, items });
  }
  const rows = Math.max(4, ...columns.map(column => column.items.length));
  grid.style.setProperty('--time-rows', rows);
  for (const { slot, items } of columns) {
    for (let index = 0; index < rows; index++) {
      const cell = element('div', 'time-cell');
      if (items[index]) cell.append(items[index]);
      slot.append(cell);
    }
    grid.append(slot);
  }
  schedule.append(grid);
  layout.append(names, schedule);
  return layout;
}

function renderCalendar(resetScroll = false) {
  renderStandalonePanel();
  const now = new Date();
  const today = dateKey(now);
  const key = dateKey(selected);
  const scrollLeft = calendarBody.querySelector('.schedule, .gantt-scroll')?.scrollLeft || 0;
  byId('date-picker').value = key;
  byId('days').setAttribute('aria-pressed', String(view === 'days'));
  byId('hours').setAttribute('aria-pressed', String(view === 'hours'));
  byId('previous').setAttribute('aria-label', view === 'days' ? 'Previous week' : 'Previous day');
  byId('next').setAttribute('aria-label', view === 'days' ? 'Next week' : 'Next day');
  const dateNavigation = byId('date-navigation');
  const panelToggle = byId('toggle-standalone-panel');
  const restoreToggleFocus = document.activeElement === panelToggle;
  const projectNavigation = byId('add-project').parentElement;
  if (view === 'hours' && panelToggle.parentElement !== projectNavigation) projectNavigation.append(panelToggle);
  const navigationParent = view === 'days' ? calendarBody.parentElement : projectNavigation;
  if (dateNavigation.parentElement !== navigationParent) {
    if (view === 'days') navigationParent.append(dateNavigation);
    else navigationParent.insertBefore(dateNavigation, panelToggle);
  }
  if (view === 'hours') {
    byId('calendar-title').textContent = format(selected, { dateStyle: 'full' });
    const content = renderSchedule(key);
    calendarBody.replaceChildren(content);
    const schedule = content.querySelector('.schedule');
    if (resetScroll) {
      const hour = Math.max(6, Math.min(22, now.getHours()));
      schedule.scrollLeft = schedule.querySelector(`[data-hour="${hour}"]`).offsetLeft;
    } else {
      schedule.scrollLeft = scrollLeft;
    }
  } else {
    const weekStart = shift(selected, -((selected.getDay() + 6) % 7));
    const shortDate = { month: 'short', day: 'numeric' };
    const { chart, lastDate } = renderGantt(weekStart, today);
    ganttWidth = calendarBody.clientWidth;
    byId('calendar-title').textContent = format(weekStart, shortDate) + ' – ' + format(lastDate, { ...shortDate, year: 'numeric' });
    if (!resetScroll) chart.scrollLeft = scrollLeft;
  }
  if (restoreToggleFocus) panelToggle.focus({ preventScroll: true });
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
    activeDictation?.cancel();
    taskDraftRows.clear();
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
    document.querySelectorAll('#add-task input, #add-project input, #calendar-body form input').forEach(input => { input.value = ''; });
  }
  if (!user) syncStatus.textContent = 'On this device';
  refreshPlanner();
  renderCalendar();
  loadDayFlow();
}

client?.auth.onAuthStateChange((event, session) => setTimeout(() => {
  updateAccount(session);
  if (event === 'INITIAL_SESSION') startTaskDictation();
}, 0));
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
  view = 'hours';
  renderCalendar(true);
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

plannerDropTarget(byId('standalone-panel'), (entry, collection) => {
  if (collection !== 'tasks' || !standaloneTasks().includes(entry) || !(entry.date || entry.inGantt)) return;
  commit([{ collection, id: entry.id, patch: { date: '', time: '', inGantt: false } }]);
  byId('notice').textContent = entry.title + ' moved to standalone tasks';
});
byId('toggle-standalone-panel').onclick = event => {
  const toggle = event.currentTarget;
  const panel = byId('standalone-panel');
  panel.hidden = !panel.hidden;
  if (panel.hidden && activeDictation?.formId === 'add-task') activeDictation.cancel();
  toggle.setAttribute('aria-expanded', String(!panel.hidden));
  toggle.setAttribute('aria-label', panel.hidden ? 'Show standalone tasks' : 'Hide standalone tasks');
  toggle.textContent = panel.hidden ? '›' : '‹';
};
renderCalendar(true);
new ResizeObserver(() => {
  if (view === 'days' && calendarBody.clientWidth !== ganttWidth) renderCalendar();
}).observe(calendarBody);
updateBackupStatus();
if (!client) {
  updateAccount(null);
  startTaskDictation();
}
