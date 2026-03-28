const STORAGE_KEY = 'lakers_todo_plays_v3';

const form = document.getElementById('todo-form');
const input = document.getElementById('todo-input');
const categorySelect = document.getElementById('category-select');
const prioritySelect = document.getElementById('priority-select');
const dueDateInput = document.getElementById('due-date');
const list = document.getElementById('todo-list');
const emptyState = document.getElementById('empty-state');
const filtersRoot = document.getElementById('filters');
const playoffToggle = document.getElementById('playoff-toggle');
const soundToggle = document.getElementById('sound-toggle');
const notifyBtn = document.getElementById('notify-btn');
const appShell = document.getElementById('app-shell');

const clearCompletedBtn = document.getElementById('clear-completed');
const markAllCompleteBtn = document.getElementById('mark-all-complete');
const deleteAllBtn = document.getElementById('delete-all');
const exportBtn = document.getElementById('export-btn');
const importInput = document.getElementById('import-input');

const totalCount = document.getElementById('total-count');
const completedCount = document.getElementById('completed-count');
const dueTodayCount = document.getElementById('due-today-count');
const winRate = document.getElementById('win-rate');

let state = loadState();
let activeFilter = 'All';
let dragId = null;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      playoffMode: !!parsed.playoffMode,
      soundOn: !!parsed.soundOn
    };
  } catch {
    return { todos: [], playoffMode: false, soundOn: false };
  }
}

function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

function createTodo(text, category, priority, dueDate) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    text,
    category,
    priority,
    dueDate: dueDate || '',
    completed: false,
    createdAt: Date.now()
  };
}

function isDueToday(todo) {
  if (!todo.dueDate) return false;
  const today = new Date();
  const t = new Date(todo.dueDate + 'T00:00:00');
  return t.toDateString() === today.toDateString();
}

function dueState(todo) {
  if (!todo.dueDate || todo.completed) return 'none';
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(todo.dueDate + 'T00:00:00');
  const diffDays = Math.floor((due - today) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= 2) return 'soon';
  return 'ok';
}

function getVisibleTodos() {
  if (activeFilter === 'All') return state.todos;
  if (activeFilter === 'DueSoon') return state.todos.filter((t) => ['overdue', 'soon'].includes(dueState(t)));
  return state.todos.filter((t) => t.category === activeFilter);
}

function updateStats() {
  const total = state.todos.length;
  const completed = state.todos.filter((t) => t.completed).length;
  const dueToday = state.todos.filter((t) => isDueToday(t) && !t.completed).length;
  totalCount.textContent = total;
  completedCount.textContent = completed;
  dueTodayCount.textContent = dueToday;
  winRate.textContent = `${total ? Math.round((completed / total) * 100) : 0}%`;
}

function setPlayoffMode(on) {
  state.playoffMode = on;
  playoffToggle.checked = on;
  appShell.classList.toggle('playoff-mode', on);
}

function setSound(on) {
  state.soundOn = on;
  soundToggle.checked = on;
}

function beep(type = 'add') {
  if (!state.soundOn) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type === 'complete' ? 'triangle' : 'sine';
  osc.frequency.value = type === 'complete' ? 700 : 520;
  gain.gain.value = 0.05;
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.08);
}

function maybeNotify(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification('Lakers Todo', { body: msg });
}

function render() {
  list.innerHTML = '';
  const visible = getVisibleTodos();
  emptyState.style.display = visible.length ? 'none' : 'block';

  visible.forEach((todo) => {
    const li = document.createElement('li');
    li.className = `todo-item ${todo.completed ? 'completed' : ''}`;
    li.draggable = true;
    li.dataset.id = todo.id;

    li.addEventListener('dragstart', () => { dragId = todo.id; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { dragId = null; li.classList.remove('dragging'); });
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId || dragId === todo.id) return;
      reorderTodos(dragId, todo.id);
    });

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = todo.completed;
    checkbox.addEventListener('change', () => {
      todo.completed = checkbox.checked;
      if (todo.completed) beep('complete');
      saveState();
      render();
    });

    const main = document.createElement('div');
    main.className = 'todo-main';

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = todo.text;

    const meta = document.createElement('div');
    meta.className = 'meta';

    const cat = `<span class="badge cat-${todo.category}">${todo.category}</span>`;
    const pri = `<span class="badge pri-${todo.priority}">${todo.priority} Priority</span>`;
    let due = '';
    if (todo.dueDate) {
      const ds = dueState(todo);
      const dueClass = ds === 'overdue' ? 'due-overdue' : ds === 'soon' ? 'due-soon' : '';
      due = `<span class="badge due-chip ${dueClass}">Due ${todo.dueDate}</span>`;
    }
    meta.innerHTML = `${cat}${pri}${due}`;

    main.append(text, meta);

    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      const next = prompt('Edit task:', todo.text);
      if (!next || !next.trim()) return;
      todo.text = next.trim();
      saveState();
      render();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn delete-btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      state.todos = state.todos.filter((t) => t.id !== todo.id);
      saveState();
      render();
    });

    li.append(checkbox, main, editBtn, delBtn);
    list.appendChild(li);
  });

  updateStats();
}

function reorderTodos(sourceId, targetId) {
  const s = state.todos.findIndex((t) => t.id === sourceId);
  const t = state.todos.findIndex((x) => x.id === targetId);
  if (s < 0 || t < 0) return;
  const [moved] = state.todos.splice(s, 1);
  state.todos.splice(t, 0, moved);
  saveState();
  render();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  state.todos.unshift(createTodo(text, categorySelect.value, prioritySelect.value, dueDateInput.value));
  saveState();
  beep('add');
  maybeNotify(`New play added: ${text}`);
  form.reset();
  prioritySelect.value = 'Medium';
  categorySelect.value = 'Offense';
  input.focus();
  render();
});

filtersRoot.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  [...filtersRoot.querySelectorAll('.filter')].forEach((f) => f.classList.toggle('active', f === btn));
  render();
});

clearCompletedBtn.addEventListener('click', () => {
  state.todos = state.todos.filter((t) => !t.completed);
  saveState();
  render();
});

markAllCompleteBtn.addEventListener('click', () => {
  state.todos.forEach((t) => { t.completed = true; });
  saveState();
  render();
});

deleteAllBtn.addEventListener('click', () => {
  if (!confirm('Delete all tasks?')) return;
  state.todos = [];
  saveState();
  render();
});

playoffToggle.addEventListener('change', () => { setPlayoffMode(playoffToggle.checked); saveState(); });
soundToggle.addEventListener('change', () => { setSound(soundToggle.checked); saveState(); });

notifyBtn.addEventListener('click', async () => {
  if (!('Notification' in window)) return alert('Notifications not supported in this browser.');
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    notifyBtn.textContent = 'Alerts Enabled';
    maybeNotify('Championship alerts are live.');
  }
});

exportBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lakers-todo-backup.json';
  a.click();
  URL.revokeObjectURL(url);
});

importInput.addEventListener('change', async () => {
  const file = importInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    state = {
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      playoffMode: !!parsed.playoffMode,
      soundOn: !!parsed.soundOn
    };
    saveState();
    setPlayoffMode(state.playoffMode);
    setSound(state.soundOn);
    render();
  } catch {
    alert('Invalid JSON backup file.');
  } finally {
    importInput.value = '';
  }
});

function notifyDueItems() {
  const due = state.todos.filter((t) => !t.completed && ['soon', 'overdue'].includes(dueState(t)));
  if (due.length) maybeNotify(`${due.length} play(s) need attention.`);
}

setPlayoffMode(state.playoffMode);
setSound(state.soundOn);
render();
notifyDueItems();