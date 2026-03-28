const form = document.getElementById('todo-form');
const input = document.getElementById('todo-input');
const list = document.getElementById('todo-list');
const count = document.getElementById('count');
const filterButtons = document.querySelectorAll('.filter');
const clearCompletedBtn = document.getElementById('clear-completed');

let todos = JSON.parse(localStorage.getItem('todos') || '[]');
let currentFilter = 'all';

function save() {
  localStorage.setItem('todos', JSON.stringify(todos));
}

function filteredTodos() {
  if (currentFilter === 'active') return todos.filter(t => !t.completed);
  if (currentFilter === 'completed') return todos.filter(t => t.completed);
  return todos;
}

function render() {
  list.innerHTML = '';

  filteredTodos().forEach(todo => {
    const li = document.createElement('li');
    li.className = `todo-item ${todo.completed ? 'completed' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = todo.completed;
    checkbox.addEventListener('change', () => {
      todo.completed = checkbox.checked;
      save();
      render();
    });

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = todo.text;

    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Bench';
    del.addEventListener('click', () => {
      todos = todos.filter(t => t.id !== todo.id);
      save();
      render();
    });

    li.append(checkbox, text, del);
    list.appendChild(li);
  });

  const activeCount = todos.filter(t => !t.completed).length;
  count.textContent = `${activeCount} play${activeCount === 1 ? '' : 's'} left this season`;

  filterButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === currentFilter);
  });
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  todos.unshift({
    id: crypto.randomUUID(),
    text,
    completed: false,
  });

  input.value = '';
  save();
  render();
});

filterButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter;
    render();
  });
});

clearCompletedBtn.addEventListener('click', () => {
  todos = todos.filter(t => !t.completed);
  save();
  render();
});

render();