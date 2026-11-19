'use strict';

const byId = id => document.getElementById(id);
const storageKey = 'combine:planner:v1';
const dragType = 'application/x-combine-task';
const ganttScrollDays = 28;
const clearSchedule = { date: '', endDate: '', extraDates: [], time: '', ganttColor: null };
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
let ganttStart;
let ganttVisibleStart;
let ganttDateCount;
let plannerFilter = '';
let editing;
let remoteItems = [];
let remoteUser = null;
let remoteRequest = 0;
const editor = byId('editor');
const editForm = byId('edit-form');
const calendarBody = byId('calendar-body');
const notes = byId('notes');
const taskDescription = byId('task-description');
const notesToolbar = byId('notes-toolbar');
const descriptionToolbar = byId('description-toolbar');
const taskLinks = byId('task-links');
const linkName = byId('task-link-name');
const linkUrl = byId('task-link-url');
let taskSaveTimer;
let noteSelection;
let activeNote;
let syncing = false;
let syncAgain = false;
let activeDictation;
let draggedRow;
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

function capitalizeDictation(text, language) {
  return text.replace(/\p{L}/u, letter => letter.toLocaleUpperCase(language || undefined));
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
    const recognized = Array.from(event.results, result => result[0].transcript.trim()).join(' ').trim();
    const text = capitalizeDictation(recognized, recognition.lang).slice(0, field.maxLength);
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
  commit([createItem('tasks', { title, projectId: null, date: '', time: '', inGantt: true })]);
  form.elements.title.focus();
});
wireAdd(byId('add-project'), title => {
  byId('add-project').reset();
  commit([createItem('projects', { title })]);
});

function draggable(item, entry, collection = 'tasks', reorder = false) {
  item.draggable = true;
  item.addEventListener('dragstart', event => {
    event.dataTransfer.setData(dragType, collection + '/' + entry.id);
    event.dataTransfer.effectAllowed = 'move';
    draggedRow = reorder ? { entry, collection } : undefined;
  });
  if (reorder) item.addEventListener('dragend', () => {
    draggedRow = undefined;
    calendarBody.querySelectorAll('.drop-before, .drop-after').forEach(label => {
      label.classList.remove('drop-before', 'drop-after');
    });
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
  function cancelDraft() {
    if (activeDictation?.formId === formId) activeDictation.cancel();
    taskDraftRows.delete(formId);
    renderCalendar();
    byId(formId + '-trigger')?.focus();
  }
  const cancel = button('×', 'Cancel new task', cancelDraft, 'gantt-draft-cancel');
  cancel.title = 'Cancel new task';
  form.append(input, cancel);
  wireAdd(form, title => {
    taskDraftRows.delete(formId);
    const edit = createItem('tasks', { title, projectId, date: '', time: '', ...(!projectId && { inGantt: true }) });
    if (collection === 'projects') edit.beforeId = state.tasks.find(task => task.projectId === projectId)?.id;
    else edit.afterId = entry.id;
    commit([edit]);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') cancelDraft();
  });
  return form;
}

function openEditor(item, collection, scheduling = false) {
  const isTask = collection === 'tasks';
  const autosave = isTask && !scheduling;
  editing = { item: { ...item }, collection, autosave, links: [...(item.links || [])] };
  const { title, date, endDate, time } = editForm.elements;
  const heading = byId('edit-title');
  heading.textContent = !isTask ? 'Project properties' : scheduling ? 'Task scheduling' : 'Task properties';
  heading.classList.toggle('sr-only', autosave);
  editor.classList.toggle('task-details', autosave);
  byId('date-field').hidden = autosave;
  byId('time-field').hidden = autosave;
  byId('date-label').textContent = isTask ? 'Start date' : 'Date';
  byId('end-date-field').hidden = !scheduling;
  byId('description-field').hidden = !autosave;
  taskDescription.innerHTML = autosave ? cleanNotes(item.description || '') : '';
  byId('task-links-field').hidden = !autosave;
  linkName.value = linkUrl.value = '';
  linkUrl.setCustomValidity('');
  if (autosave) renderTaskLinks();
  byId('notes-field').hidden = scheduling;
  byId('remove').hidden = autosave;
  byId('cancel-edit').hidden = autosave;
  byId('save-edit').hidden = autosave;
  byId('done-task').hidden = !autosave;
  title.value = item.title;
  date.value = item.date || '';
  endDate.value = isTask && date.value ? item.endDate || '' : '';
  updateDateConstraints();
  time.value = item.time || '';
  notes.replaceChildren();
  for (const html of noteEntries(item)) addNoteEditor(html);
  if (!notes.children.length) addNoteEditor();
  activeNote = autosave ? taskDescription : notes.querySelector('.note-editor');
  noteSelection = null;
  byId('unschedule').hidden = autosave || !item.date;
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

function editedNotes() {
  return [...notes.querySelectorAll('.note-editor')].map(field => cleanNotes(field.innerHTML)).filter(Boolean);
}

function taskLinkUrl(text) {
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : 'https://' + text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function renderTaskLinks() {
  taskLinks.replaceChildren();
  editing.links.forEach(({ name, url }, index) => {
    const href = taskLinkUrl(url);
    if (!href) return;
    const row = element('li');
    const link = element('a', '', name);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    row.append(link, button('×', 'Remove link ' + name, () => {
      editing.links.splice(index, 1);
      renderTaskLinks();
      saveTaskEditor();
      linkName.focus();
    }));
    taskLinks.append(row);
  });
}

function addTaskLink() {
  const url = taskLinkUrl(linkUrl.value.trim());
  if (!url) {
    linkUrl.setCustomValidity('Enter a valid HTTP or HTTPS URL.');
    linkUrl.reportValidity();
    return;
  }
  editing.links.push({ name: linkName.value.trim() || new URL(url).hostname, url });
  renderTaskLinks();
  linkName.value = linkUrl.value = '';
  saveTaskEditor();
  linkName.focus();
}

byId('add-task-link').addEventListener('click', addTaskLink);
linkUrl.addEventListener('input', () => linkUrl.setCustomValidity(''));
for (const input of [linkName, linkUrl]) {
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addTaskLink();
  });
}

function saveTaskEditor() {
  clearTimeout(taskSaveTimer);
  if (!editor.open || !editing?.autosave) return;
  const { item } = editing;
  const patch = {};
  const title = editForm.elements.title.value.trim();
  const description = cleanNotes(taskDescription.innerHTML);
  const entries = editedNotes();
  if (title && title !== item.title) patch.title = title;
  if (description !== (item.description || '')) patch.description = description;
  if (JSON.stringify(entries) !== JSON.stringify(noteEntries(item))) patch.notes = entries;
  if (JSON.stringify(editing.links) !== JSON.stringify(item.links || [])) patch.links = [...editing.links];
  if (!Object.keys(patch).length) return;
  Object.assign(item, patch);
  commit([{ collection: 'tasks', id: item.id, patch }]);
}

function queueTaskSave() {
  if (!editing?.autosave) return;
  clearTimeout(taskSaveTimer);
  taskSaveTimer = setTimeout(saveTaskEditor, 300);
}

editForm.addEventListener('input', event => {
  if (activeDictation?.field === event.target) activeDictation.cancel();
  queueTaskSave();
});
editor.addEventListener('cancel', saveTaskEditor);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveTaskEditor();
});
window.addEventListener('pagehide', saveTaskEditor);
byId('done-task').addEventListener('click', () => {
  saveTaskEditor();
  editor.close();
});

function dictationButton(field, label) {
  const control = button('🎙️', label, () => {
    const listeningHere = activeDictation?.field === field;
    activeDictation?.cancel();
    if (!listeningHere) listenForRichText(field, control);
  }, 'dictate-rich-text');
  control.title = label;
  control.disabled = !SpeechRecognition;
  control.setAttribute('aria-pressed', 'false');
  return control;
}

function listenForRichText(field, control) {
  const recognition = new SpeechRecognition();
  const status = byId('editor-dictation-status');
  const selection = document.getSelection();
  const currentRange = selection.rangeCount ? selection.getRangeAt(0) : null;
  const range = currentRange && field.contains(currentRange.commonAncestorContainer) ? currentRange.cloneRange() :
    noteSelection && field.contains(noteSelection.commonAncestorContainer) ? noteSelection.cloneRange() : null;
  const session = {
    field,
    cancel() {
      finish();
      recognition.abort();
    }
  };
  function finish(message = '') {
    if (activeDictation !== session) return;
    activeDictation = undefined;
    control.setAttribute('aria-pressed', 'false');
    status.textContent = message;
  }
  activeDictation = session;
  recognition.lang = document.documentElement.lang;
  recognition.onresult = event => {
    if (activeDictation !== session || !editor.open || !field.isConnected) return;
    const text = Array.from(event.results, result => result[0].transcript.trim()).join(' ').trim();
    finish();
    if (!text) return;
    field.focus();
    const hasCaret = range && field.contains(range.commonAncestorContainer);
    const insertion = hasCaret ? range : document.createRange();
    if (!hasCaret) {
      insertion.selectNodeContents(field);
      insertion.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(insertion);
    const prefix = !hasCaret && field.textContent && !/\s$/.test(field.textContent) ? ' ' : '';
    document.execCommand('insertText', false, prefix + capitalizeDictation(text, recognition.lang));
    queueTaskSave();
  };
  recognition.onerror = event => finish(event.error === 'no-speech' ? '' : 'Dictation failed. Check microphone access or try again.');
  recognition.onend = () => finish();
  control.setAttribute('aria-pressed', 'true');
  status.textContent = 'Listening… Click the microphone again to cancel.';
  try {
    recognition.start();
  } catch {
    finish('Dictation could not start. Try again.');
  }
}

editor.addEventListener('close', () => {
  if (editor.open) return;
  if (activeDictation?.field) activeDictation.cancel();
  byId('editor-dictation-status').textContent = '';
});

function addNoteEditor(html = '') {
  const entry = element('div', 'note-entry');
  const field = element('div', 'note-editor');
  field.contentEditable = 'true';
  field.setAttribute('role', 'textbox');
  field.setAttribute('aria-multiline', 'true');
  field.setAttribute('aria-label', 'Note');
  field.innerHTML = html;
  entry.append(field, button('Remove note', null, () => {
    if (activeDictation?.field === field) activeDictation.cancel();
    entry.remove();
    noteSelection = null;
    (notes.querySelector('.note-editor') || addNoteEditor()).focus();
    queueTaskSave();
  }), dictationButton(field, 'Dictate note'));
  notes.append(entry);
  return field;
}

byId('add-note').addEventListener('click', () => addNoteEditor().focus());
editForm.addEventListener('focusin', event => {
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
descriptionToolbar.append(...[...notesToolbar.children].map(control => control.cloneNode(true)),
  dictationButton(taskDescription, 'Dictate description'));
for (const toolbar of [descriptionToolbar, notesToolbar]) {
  toolbar.addEventListener('mousedown', event => event.preventDefault());
  toolbar.addEventListener('click', event => {
    const control = event.target.closest('[data-command]');
    if (!control) return;
    const field = toolbar === descriptionToolbar ? taskDescription :
      notes.contains(activeNote) ? activeNote : notes.querySelector('.note-editor');
    if (!field) return;
    field.focus();
    if (noteSelection && field.contains(noteSelection.commonAncestorContainer)) {
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(noteSelection);
    }
    document.execCommand('styleWithCSS', false, false);
    if (control.dataset.command === 'dateStamp') {
      document.execCommand('insertText', false, format(new Date(), { dateStyle: 'short' }));
    } else {
      document.execCommand(control.dataset.command);
    }
    queueTaskSave();
  });
}
for (const container of [taskDescription, notes]) {
  container.addEventListener('paste', event => {
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  });
  container.addEventListener('drop', event => event.preventDefault());
}

function updateDateConstraints() {
  const { date, endDate } = editForm.elements;
  date.required = Boolean(endDate.value);
  endDate.min = date.value;
}

editForm.elements.date.addEventListener('input', updateDateConstraints);
editForm.elements.endDate.addEventListener('input', updateDateConstraints);

editForm.addEventListener('submit', event => {
  event.preventDefault();
  if (editing.autosave) {
    saveTaskEditor();
    return;
  }
  const { title, date, endDate, time } = editForm.elements;
  if (!title.value.trim()) return;
  const { item, collection } = editing;
  const patch = {};
  const safeNotes = editedNotes();
  if (title.value.trim() !== item.title) patch.title = title.value.trim();
  if (JSON.stringify(safeNotes) !== JSON.stringify(noteEntries(item))) patch.notes = safeNotes;
  const clock = date.value ? time.value : '';
  if (date.value !== (item.date || '') || clock !== (item.time || '')) {
    Object.assign(patch, date.value ? { date: date.value, time: clock } : clearSchedule);
  }
  if (collection === 'tasks' && endDate.value !== (item.endDate || '')) patch.endDate = endDate.value;
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
  commit([{ collection, id: item.id, patch: clearSchedule }]);
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

function plannerDropTarget(item, onDrop, reorderTarget) {
  const isReorder = () => draggedRow && reorderTarget && draggedRow.collection === reorderTarget.collection;
  const canReorder = () => draggedRow.entry.id !== reorderTarget.entry.id &&
    (reorderTarget.collection === 'projects' || draggedRow.entry.projectId === reorderTarget.entry.projectId);
  const dropBefore = event => {
    const { top, height } = item.getBoundingClientRect();
    return event.clientY < top + height / 2;
  };
  const clearDrop = () => item.classList.remove('drop-active', 'drop-before', 'drop-after');
  item.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer.types).includes(dragType)) return;
    if (isReorder() && !canReorder()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (isReorder()) {
      const before = dropBefore(event);
      item.classList.toggle('drop-before', before);
      item.classList.toggle('drop-after', !before);
    } else item.classList.add('drop-active');
  });
  item.addEventListener('dragleave', event => {
    if (!item.contains(event.relatedTarget)) clearDrop();
  });
  item.addEventListener('drop', event => {
    clearDrop();
    const [collection, id] = event.dataTransfer.getData(dragType).split('/');
    if (collection !== 'tasks' && collection !== 'projects') return;
    const entry = state[collection].find(entry => entry.id === id);
    if (!entry) return;
    event.preventDefault();
    if (isReorder()) {
      if (!canReorder() || collection !== draggedRow.collection || id !== draggedRow.entry.id) return;
      const anchor = dropBefore(event) ? 'beforeId' : 'afterId';
      const target = reorderTarget.entry;
      draggedRow = undefined;
      commit([{ collection, id, [anchor]: target.id }]);
      byId('notice').textContent = entry.title + ' moved ' + (anchor === 'beforeId' ? 'above ' : 'below ') + target.title;
      return;
    }
    onDrop(entry, collection);
  });
}

function dropTarget(item, date, time) {
  plannerDropTarget(item, (entry, collection) => {
    selected = parseDate(date);
    const clock = time ?? entry.time ?? '';
    const patch = { date, time: clock };
    if (collection === 'tasks' && entry.date) {
      const moveDate = key => dateKey(shift(selected, (Date.parse(key) - Date.parse(entry.date)) / 86400000));
      if (entry.endDate >= entry.date) patch.endDate = moveDate(entry.endDate);
      if (entry.extraDates?.length) patch.extraDates = entry.extraDates.map(moveDate);
    }
    commit([{ collection, id: entry.id, patch }]);
    byId('notice').textContent = entry.title + ' scheduled for ' + date + (clock ? ' at ' + timeLabel(minutesOf(clock)) : '');
  });
}

function moveIntoNames(entry, collection) {
  const standalone = collection === 'tasks' && standaloneTasks().includes(entry);
  if (!entry.date && (!standalone || entry.inGantt)) return;
  const patch = { ...clearSchedule };
  if (standalone) patch.inGantt = true;
  commit([{ collection, id: entry.id, patch }]);
  byId('notice').textContent = entry.title + ' moved to column A';
}

function plannerEvent({ entry, collection, time }) {
  const item = button(entry.title, null, () => openEditor(entry, collection), 'event planner');
  const details = [collection === 'projects' ? 'Project' : '', time ? timeLabel(minutesOf(time)) : ''].filter(Boolean);
  if (details.length) item.append(element('small', '', details.join(' · ')));
  if (collection === 'tasks') item.addEventListener('contextmenu', event => openTaskMenu(event, entry));
  draggable(item, entry, collection);
  return item;
}

function scheduledBetween(entry, firstDate, lastDate, collection) {
  if (!entry?.date) return false;
  const endDate = collection === 'tasks' && entry.endDate > entry.date ? entry.endDate : entry.date;
  return (entry.date <= lastDate && endDate >= firstDate) ||
    (collection === 'tasks' && entry.extraDates?.some(date => date >= firstDate && date <= lastDate));
}

function filterPlannerRows(rows, firstDate, lastDate) {
  const matchingEntries = new Set();
  const matchingProjects = new Set();
  for (const { entry, collection } of rows) {
    const matches = plannerFilter === 'unassigned' ? collection === 'tasks' && entry && !entry.date :
      scheduledBetween(entry, firstDate, lastDate, collection);
    if (matches) {
      matchingEntries.add(entry);
      if (collection === 'tasks' && entry.projectId) matchingProjects.add(entry.projectId);
    }
  }
  for (const { row, entry, collection, draftFor } of rows) {
    const anchor = draftFor || entry;
    const isVisible = matchingEntries.has(anchor) ||
      ((draftFor || collection === 'projects') && matchingProjects.has(anchor?.id));
    row.classList.toggle('gantt-outside-range', !isVisible);
  }
}

function scheduledEntries(date) {
  return ['tasks', 'projects'].flatMap(collection => state[collection]
    .filter(entry => scheduledBetween(entry, date, date, collection))
    .map(entry => ({ entry, collection, time: entry.date === date ? entry.time || '' : '' })))
    .sort((first, second) => first.time.localeCompare(second.time));
}

function standaloneTasks() {
  const projectIds = new Set(state.projects.map(project => project.id));
  return state.tasks.filter(task => !projectIds.has(task.projectId));
}

function renderStandalonePanel() {
  const tasks = plannerFilter === 'unassigned' ? [] : standaloneTasks();
  byId('standalone-tasks').replaceChildren(...tasks.filter(task => !task.date && !task.inGantt).map(task => {
    const name = button(task.title, null, () => openEditor(task, 'tasks'), 'standalone-task');
    name.addEventListener('contextmenu', event => openTaskMenu(event, task));
    draggable(name, task);
    return name;
  }));
}

function plannerMenu(label) {
  const menu = element('div', 'gantt-mark-menu');
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', label);
  return menu;
}

function addTaskSchedulingAction(menu, task) {
  menu.append(button('Scheduling and deletion…', null, () => {
    menu.hidePopover();
    openEditor(task, 'tasks', true);
  }));
}

function openTaskMenu(event, task) {
  const menu = plannerMenu('Task actions');
  addTaskSchedulingAction(menu, task);
  showPlannerMenu(event, menu);
}

function openGanttMarkMenu(event, entry, collection, date) {
  const mark = event.currentTarget;
  const menu = plannerMenu('Gantt square actions');
  for (const label of ['Red', 'Green', 'Clear']) {
    menu.append(button(label, null, () => {
      const clear = label === 'Clear';
      const patch = clear ? { ...clearSchedule } : { ganttColor: label.toLowerCase() };
      if (clear && collection === 'tasks' && standaloneTasks().includes(entry)) patch.inGantt = true;
      menu.hidePopover();
      commit([{ collection, id: entry.id, patch }]);
      const focusId = clear ? 'gantt-name-' + collection + '-' + entry.id : mark.id;
      byId(focusId)?.focus({ preventScroll: true });
    }));
  }
  if (collection === 'tasks' && entry.extraDates?.includes(date) &&
      (date < entry.date || date > (entry.endDate > entry.date ? entry.endDate : entry.date))) {
    menu.append(button('Remove this date', null, () => {
      menu.hidePopover();
      commit([{ collection, id: entry.id, removeDate: date }]);
      byId('gantt-name-' + collection + '-' + entry.id)?.focus({ preventScroll: true });
      byId('notice').textContent = date + ' removed from ' + entry.title;
    }));
  }
  if (collection === 'tasks') addTaskSchedulingAction(menu, entry);
  showPlannerMenu(event, menu);
}

function showPlannerMenu(event, menu) {
  event.preventDefault();
  calendarBody.querySelector('.gantt-mark-menu')?.remove();
  menu.addEventListener('toggle', event => {
    if (event.newState === 'closed') menu.remove();
  });
  calendarBody.append(menu);
  event.currentTarget.focus({ preventScroll: true });
  menu.showPopover();
  const { width, height } = menu.getBoundingClientRect();
  const bounds = document.documentElement;
  menu.style.left = Math.max(0, Math.min(event.clientX, bounds.clientWidth - width)) + 'px';
  menu.style.top = Math.max(0, Math.min(event.clientY, bounds.clientHeight - height)) + 'px';
  menu.firstElementChild.focus({ preventScroll: true });
}

function addGanttResizeHandle(cell, dates, dayWidth, task) {
  const handle = element('span', 'gantt-resize');
  handle.title = 'Drag to change the end date';
  const row = cell.parentElement;
  const chart = cell.closest('.gantt-scroll');
  const startIndex = dates.findIndex(({ key }) => key >= task.date);
  const endIndex = cell.cellIndex - 1;
  const previewClass = task.ganttColor === 'green' ? 'gantt-extension-green' : 'gantt-extension-red';
  let pointerId;
  let previewEnd = endIndex;

  function previewThrough(index) {
    for (let day = Math.min(previewEnd, index) + 1; day <= Math.max(previewEnd, index); day++) {
      const dayCell = row.cells[day + 1];
      if (day > endIndex) dayCell.classList.toggle(previewClass, day <= index);
      else dayCell.classList.toggle('gantt-trim-preview', day > index && !task.extraDates?.includes(dates[day].key));
    }
    previewEnd = index;
  }

  function updatePreview(event) {
    if (event.pointerId !== pointerId) return;
    const firstDateLeft = row.cells[1].getBoundingClientRect().left;
    const datesLeft = row.cells[0].getBoundingClientRect().right;
    const x = Math.max(datesLeft, Math.min(event.clientX, chart.getBoundingClientRect().right - 1));
    const index = Math.floor((x - firstDateLeft) / dayWidth);
    previewThrough(Math.max(startIndex, Math.min(dates.length - 1, index)));
  }

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointerId !== undefined) return;
    event.preventDefault();
    pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
  });
  handle.addEventListener('pointermove', updatePreview);
  handle.addEventListener('lostpointercapture', event => {
    if (event.pointerId !== pointerId) return;
    pointerId = undefined;
    previewThrough(endIndex);
  });
  handle.addEventListener('pointerup', event => {
    if (event.pointerId !== pointerId) return;
    updatePreview(event);
    const endDate = dates[previewEnd].key;
    const changed = previewEnd !== endIndex;
    pointerId = undefined;
    previewThrough(endIndex);
    if (!changed) return;
    commit([{ collection: 'tasks', id: task.id, patch: { endDate: endDate === task.date ? '' : endDate } }]);
    byId('notice').textContent = task.title + ' now ends on ' + endDate;
  });
  cell.append(handle);
}

function renderGantt(start, today, scrollLeft) {
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
  addPlannerRows(table, (row, entry, collection, draftFor) => plannerRows.push({ row, entry, collection, draftFor }));
  chart.append(table);
  calendarBody.replaceChildren(chart);

  // Measure the project and task column before adding dates.
  const dayWidth = parseFloat(getComputedStyle(chart).getPropertyValue('--gantt-day-width'));
  const namesWidth = table.getBoundingClientRect().width;
  const unassigned = plannerFilter === 'unassigned';
  const ganttDayLimit = plannerFilter === 'today' ? 1 : plannerFilter === 'five-days' ? 5 : 0;
  const visibleDays = ganttDayLimit || Math.max(1, Math.floor((chart.clientWidth - namesWidth) / dayWidth));
  if (ganttDayLimit) {
    chart.style.maxWidth = namesWidth + visibleDays * dayWidth + 'px';
  }
  if (ganttDayLimit || unassigned) {
    namesHeading.style.minWidth = namesHeading.getBoundingClientRect().width + 'px';
  }
  const dates = Array.from({ length: visibleDays + 2 * ganttScrollDays + 1 }, (_, index) => {
    const date = shift(start, index - ganttScrollDays);
    const weekday = date.getDay();
    return { date, key: dateKey(date), weekend: weekday === 0 || weekday === 6 };
  });
  for (const { date, key, weekend } of dates) {
    const weekday = element('th', '', format(date, { weekday: 'narrow' }));
    const showMonth = date.getDay() === 1 || date.getDate() === 1;
    const month = element('th', 'gantt-month');
    if (showMonth) month.append(element('span', '', format(date, { month: 'short' })));
    const cell = element('th', 'gantt-day');
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
      if (scheduledBetween(entry, key, key, collection)) {
        const color = entry.ganttColor === 'green' ? 'green' : 'red';
        const mark = button('', entry.title + ', scheduled ' + key + ', ' + color, () => openEditor(entry, collection), 'gantt-mark');
        mark.id = 'gantt-mark-' + collection + '-' + entry.id;
        if (key !== entry.date) mark.id += '-' + key;
        mark.classList.toggle('green', color === 'green');
        mark.addEventListener('contextmenu', event => openGanttMarkMenu(event, entry, collection, key));
        draggable(mark, entry, collection);
        cell.append(mark);
        if (collection === 'tasks' && key === (entry.endDate > entry.date ? entry.endDate : entry.date)) {
          addGanttResizeHandle(cell, dates, dayWidth, entry);
        }
      } else if (entry && collection === 'tasks') {
        cell.classList.add('gantt-add-date');
        cell.title = 'Add ' + key + ' to ' + entry.title;
        cell.addEventListener('click', () => {
          commit([{ collection, id: entry.id, addDate: key }]);
          byId('notice').textContent = key + ' added to ' + entry.title;
        });
      }
      dropTarget(cell, key, null);
    }
  }
  chart.scrollLeft = scrollLeft ?? ganttScrollDays * dayWidth;
  const shortDate = { month: 'short', day: 'numeric' };
  let visibleIndex;
  function updateVisibleDates() {
    const index = Math.max(0, Math.min(dates.length - visibleDays, Math.round(chart.scrollLeft / dayWidth)));
    if (index === visibleIndex) return;
    visibleIndex = index;
    ganttVisibleStart = dates[index].date;
    const last = dates[index + visibleDays - 1];
    if (ganttDayLimit || unassigned) {
      filterPlannerRows(plannerRows, dates[index].key, last.key);
    }
    const lastLabel = format(last.date, { ...shortDate, year: 'numeric' });
    byId('calendar-title').textContent = visibleDays === 1 ? lastLabel :
      format(ganttVisibleStart, shortDate) + ' – ' + lastLabel;
  }
  chart.addEventListener('scroll', updateVisibleDates);
  updateVisibleDates();
  return visibleDays;
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
  function addRow(entry, collection, child = false, draftFor) {
    const row = body.insertRow();
    const label = element('th', 'gantt-row-label');
    label.scope = 'row';
    if (entry) {
      const name = button(entry.title, null, () => openEditor(entry, collection), 'gantt-name');
      name.id = 'gantt-name-' + collection + '-' + entry.id;
      if ((collection === 'tasks' || entry.ganttColor) && (entry.date || entry.time)) {
        name.classList.add(entry.ganttColor === 'green' ? 'green-gantt-name' : 'red-gantt-name');
      }
      name.title = entry.title;
      if (collection === 'tasks') name.addEventListener('contextmenu', event => openTaskMenu(event, entry));
      draggable(name, entry, collection, child || collection === 'projects');
      const actions = element('div', 'gantt-name-actions');
      const formId = 'insert-task-' + collection + '-' + entry.id;
      const isProject = collection === 'projects';
      const insert = button('', (isProject ? 'Add task to ' : 'Insert task below ') + entry.title, () => {
        if (!taskDraftRows.has(formId) || (isProject && collapsedProjects.has(entry.id))) {
          taskDraftRows.add(formId);
          if (isProject) collapsedProjects.delete(entry.id);
          renderCalendar();
        }
        const input = byId(formId)?.elements.title;
        input?.focus();
        input?.click();
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
    if (collection === 'projects') {
      plannerDropTarget(label, (task, sourceCollection) => {
        if (sourceCollection !== 'tasks' || !standaloneTasks().includes(task)) {
          moveIntoNames(task, sourceCollection);
          return;
        }
        collapsedProjects.delete(entry.id);
        commit([{ collection: 'tasks', id: task.id, patch: { projectId: entry.id } }]);
        byId('notice').textContent = task.title + ' moved to ' + entry.title;
      }, { entry, collection });
    } else {
      plannerDropTarget(label, moveIntoNames, child && entry ? { entry, collection } : null);
    }
    addDateCells(row, entry, collection, draftFor);
    return row;
  }
  function addDraft(entry, collection, projectId) {
    const formId = 'insert-task-' + collection + '-' + entry.id;
    if (!taskDraftRows.has(formId)) return;
    const row = addRow(null, 'tasks', Boolean(projectId), entry);
    row.firstElementChild.append(inlineTaskForm(formId, entry, collection, projectId));
    return row;
  }
  const includeAllStandalone = plannerFilter === 'unassigned';
  for (const task of standaloneTasks().filter(task => includeAllStandalone || task.date || task.inGantt)) {
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
  const plannerRows = [];
  addPlannerRows(names, (row, entry, collection, draftFor) => plannerRows.push({ row, entry, collection, draftFor }));
  if (plannerFilter) {
    const lastDate = plannerFilter === 'five-days' ? dateKey(shift(parseDate(key), 4)) : key;
    filterPlannerRows(plannerRows, key, lastDate);
  }
  const schedule = element('div', 'schedule');
  schedule.tabIndex = 0;
  schedule.setAttribute('role', 'region');
  schedule.setAttribute('aria-label', 'Hourly schedule');
  const entries = plannerFilter === 'unassigned' ? [] : scheduledEntries(key);
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
      const start = minutesOf(scheduled.time);
      if (allDay ? !scheduled.time : start >= minutes && start < minutes + 60) items.push(plannerEvent(scheduled));
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
  const previousChart = calendarBody.querySelector('.schedule, .gantt-scroll');
  const scrollLeft = previousChart?.scrollLeft || 0;
  const scrollTop = previousChart?.scrollTop || 0;
  byId('date-picker').value = key;
  byId('days').setAttribute('aria-pressed', String(view === 'days'));
  byId('hours').setAttribute('aria-pressed', String(view === 'hours'));
  byId('previous').setAttribute('aria-label', view === 'days' ? 'Previous page of dates' : 'Previous day');
  byId('next').setAttribute('aria-label', view === 'days' ? 'Next page of dates' : 'Next day');
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
      if (key > today) {
        schedule.scrollLeft = 0;
      } else {
        const hour = Math.max(6, Math.min(22, now.getHours()));
        schedule.scrollLeft = schedule.querySelector(`[data-hour="${hour}"]`).offsetLeft;
      }
    } else {
      schedule.scrollLeft = scrollLeft;
    }
  } else {
    const previousScroll = !resetScroll && ganttStart ? scrollLeft : undefined;
    ganttStart ??= selected;
    ganttDateCount = renderGantt(ganttStart, today, previousScroll);
    calendarBody.querySelector('.gantt-scroll').scrollTop = scrollTop;
    ganttWidth = calendarBody.clientWidth;
  }
  if (restoreToggleFocus) panelToggle.focus({ preventScroll: true });
}

function changeView(nextView) {
  if (view === nextView) return;
  view = nextView;
  ganttStart = undefined;
  renderCalendar(true);
  loadDayFlow();
}

function navigate(date, pageStart) {
  selected = date;
  ganttStart = pageStart;
  renderCalendar(Boolean(pageStart) || (view === 'hours' && dateKey(date) > dateKey(new Date())));
  loadDayFlow();
}

function moveDates(direction) {
  if (view === 'hours') {
    navigate(shift(selected, direction));
    return;
  }
  const date = shift(ganttVisibleStart, direction * ganttDateCount);
  navigate(date, date);
}

function goToToday() {
  const today = new Date();
  navigate(today, today);
}

byId('days').onclick = () => changeView('days');
byId('hours').onclick = () => changeView('hours');
byId('planner-actions').addEventListener('change', event => {
  const action = event.target.value;
  event.target.value = '';
  switch (action) {
    case 'today':
    case 'five-days':
    case 'unassigned':
      plannerFilter = plannerFilter === action ? '' : action;
      if (plannerFilter === 'today') goToToday();
      else renderCalendar();
      break;
    case 'collapse':
    case 'expand': {
      const expanded = action === 'collapse';
      calendarBody.querySelectorAll(`.gantt-toggle[aria-expanded="${expanded}"]`).forEach(toggle => toggle.click());
      break;
    }
    case 'sort':
      commit([{ collection: 'projects', sortByTitle: true }]);
      break;
  }
});
byId('previous').onclick = () => moveDates(-1);
byId('next').onclick = () => moveDates(1);
byId('today').onclick = goToToday;
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
    if (editor.open) {
      saveTaskEditor();
      editor.close();
    }
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
  commit([{ collection, id: entry.id, patch: { ...clearSchedule, inGantt: false } }]);
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
