'use strict';

const emptyPlanner = () => ({ tasks: [], projects: [] });

function applyPlannerEdits(planner, edits) {
  for (const { collection, id, patch, create, beforeId, afterId, sortByTitle } of edits) {
    if (collection === 'projects' && sortByTitle) {
      planner.projects.sort((first, second) => first.title.localeCompare(second.title, 'en', { sensitivity: 'base', numeric: true }));
      continue;
    }
    if (collection === 'tasks' && patch?.projectId &&
      !planner.projects.some(project => project.id === patch.projectId)) continue;
    const items = planner[collection];
    const index = items.findIndex(item => item.id === id);
    if (patch === null) {
      if (index >= 0) items.splice(index, 1);
      if (collection === 'projects') planner.tasks = planner.tasks.filter(task => task.projectId !== id);
    } else if (index >= 0) {
      if (create) continue;
      if (collection === 'tasks' && (beforeId || afterId)) {
        const task = items[index];
        const anchor = items.findIndex(item => item.id === (beforeId ?? afterId) && item.projectId === task.projectId);
        if (!task.projectId || anchor < 0 || anchor === index) continue;
        const adjustedAnchor = index < anchor ? anchor - 1 : anchor;
        items.splice(index, 1);
        items.splice(beforeId ? adjustedAnchor : adjustedAnchor + 1, 0, task);
      } else Object.assign(items[index], patch);
    } else if (create) {
      const anchorId = beforeId ?? afterId;
      const anchor = anchorId ? items.findIndex(item => item.id === anchorId && item.projectId === patch.projectId) : -1;
      const position = anchor < 0 ? items.length : anchor + (beforeId ? 0 : 1);
      items.splice(position, 0, { ...patch, id });
    }
  }
  return planner;
}

const plannerCacheKey = id => 'combine:cache:' + id;
const plannerQueuePrefix = id => 'combine:outbox:' + id + ':';
const volatileEdits = new Map();

function queuePlannerEdits(id, edits) {
  const key = plannerQueuePrefix(id) + Date.now().toString().padStart(15, '0') + ':' + crypto.randomUUID();
  try {
    localStorage.setItem(key, JSON.stringify(edits));
  } catch {
    volatileEdits.set(key, edits);
  }
}

function pendingPlannerEdits(id) {
  const prefix = plannerQueuePrefix(id);
  const keys = new Set(volatileEdits.keys());
  try {
    for (let index = 0; index < localStorage.length; index++) keys.add(localStorage.key(index));
  } catch {}
  return [...keys].filter(key => key?.startsWith(prefix)).sort()
    .map(key => [key, volatileEdits.get(key) ?? readStorage(key, [])]);
}

function clearPlannerEdits(pending) {
  for (const [key] of pending) {
    try { localStorage.removeItem(key); } catch {}
    volatileEdits.delete(key);
  }
}

async function syncPlanner(client, id, isCurrent, onSnapshot) {
  const run = async () => {
    for (let attempt = 0; attempt < 6 && isCurrent(); attempt++) {
      const pending = pendingPlannerEdits(id);
      const table = () => client.from('combine_planners');
      const { data, error } = await table().select('planner,revision').eq('user_id', id).maybeSingle();
      if (!isCurrent()) return;
      if (error) throw error;
      const planner = applyPlannerEdits(data?.planner || emptyPlanner(), pending.flatMap(([, edits]) => edits));
      if (pending.length) {
        const result = data
          ? await table().update({ planner, revision: data.revision + 1 })
            .eq('user_id', id).eq('revision', data.revision).select('revision').maybeSingle()
          : await table().insert({ user_id: id, planner }).select('revision').single();
        if (result.error?.code === '23505' || (!result.error && !result.data)) continue;
        if (result.error) throw result.error;
      }
      // Keep the confirmed snapshot and queued operations scoped to this account.
      try { localStorage.setItem(plannerCacheKey(id), JSON.stringify(planner)); } catch {}
      clearPlannerEdits(pending);
      if (isCurrent()) onSnapshot(planner);
      return;
    }
    if (isCurrent()) throw new Error('The planner changed on another device. Retrying shortly.');
  };
  const lock = 'combine:sync:' + id;
  return navigator.locks ? navigator.locks.request(lock, run) : run();
}
