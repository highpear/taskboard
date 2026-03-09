// Taskboard MVP (Chrome/Edge) - File System Access API
// Data:
//   .taskboard/board.json (board config)
//   .taskboard/tasks.ndjson (snapshot - 1 task per line JSON)
//   .taskboard/events.ndjson (append-only event log)
//   .taskboard/README.md (AI developer guide)

const UI = {
  btnOpen: document.getElementById("btnOpen"),
  btnInit: document.getElementById("btnInit"),
  btnAdd: document.getElementById("btnAdd"),
  btnReload: document.getElementById("btnReload"),
  btnTheme: document.getElementById("btnTheme"),
  status: document.getElementById("status"),
  board: document.getElementById("board"),
  tplColumn: document.getElementById("tplColumn"),
  tplCard: document.getElementById("tplCard"),
  filterGroup: document.getElementById("filterGroup"),
  // Dialog elements
  dlgTask: document.getElementById("dlgTask"),
  frmTask: document.getElementById("frmTask"),
  dlgTitle: document.getElementById("dlgTitle"),
  taskTitle: document.getElementById("taskTitle"),
  taskPriority: document.getElementById("taskPriority"),
  taskColumn: document.getElementById("taskColumn"),
  taskDescription: document.getElementById("taskDescription"),
  btnCancelTask: document.getElementById("btnCancelTask"),
};

const PATH = {
  dir: ".taskboard",
  board: "board.json",
  tasks: "tasks.ndjson",
  events: "events.ndjson",
  readme: "README.md",
};

const DEFAULT_BOARD = {
  schema_version: 1,
  columns: [
    { id: "todo", title: "To Do" },
    { id: "doing", title: "Doing" },
    { id: "done", title: "Done" },
  ],
  wip_limits: { doing: 5 },
  ui: { show_done_by_default: true },
};

const DEFAULT_README = `Taskboard data format (AI-friendly)

Truth sources:
  - tasks.ndjson : current snapshot (one JSON per line; one line = one task)
  - events.ndjson: append-only event log (one JSON per line)

Rules:
  - If a line is invalid JSON, skip it.
  - Task id is immutable.
  - column is one of: todo | doing | done
  - checklist[].done is boolean.
  - order is a numeric sort key. Within a column, tasks are ordered by (order asc, updated_at desc).

Suggestion for AI tools:
  - For current state: read tasks.ndjson
  - For recent changes: read tail of events.ndjson
`;

let projectDirHandle = null;
let taskboardDirHandle = null;

let boardConfig = null;
let tasks = []; // array of task objects
let currentEditingTaskId = null; // tracking for dialog
let currentPriorityFilter = "all";

// ----------------------- Utilities -----------------------

function setStatus(msg) {
  UI.status.textContent = msg;
}

function nowIsoLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const hh = pad(Math.floor(Math.abs(tzMin) / 60));
  const mm = pad(Math.abs(tzMin) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
}

function genTaskId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6).toUpperCase();
  return `T-${ymd}-${hms}-${rand}`;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function toNdjson(lines) {
  return lines.map((o) => JSON.stringify(o)).join("\n") + (lines.length ? "\n" : "");
}

function sortTasksInColumn(columnId) {
  return tasks
    .filter((t) => t.column === columnId)
    .filter((t) => currentPriorityFilter === "all" || (t.priority || "P2") === currentPriorityFilter)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(b.updated_at).localeCompare(String(a.updated_at)));
}

function normalizeOrders(columnId) {
  const colTasks = sortTasksInColumn(columnId);
  let order = 1000;
  for (const t of colTasks) {
    t.order = order;
    order += 1000;
  }
}

function normalizeAllOrders() {
  for (const c of boardConfig.columns) normalizeOrders(c.id);
}

function getTask(taskId) {
  return tasks.find((t) => t.id === taskId) || null;
}

function checklistProgress(t) {
  const total = (t.checklist || []).length;
  const done = (t.checklist || []).filter((c) => c.done).length;
  return { done, total };
}

// ----------------------- File System -----------------------

async function getDirHandle(parentDir, name, create = false) {
  return await parentDir.getDirectoryHandle(name, { create });
}

async function getFileHandle(dir, name, create = false) {
  return await dir.getFileHandle(name, { create });
}

async function readTextFile(dir, name) {
  const fh = await getFileHandle(dir, name, false);
  const file = await fh.getFile();
  return await file.text();
}

async function writeTextFile(dir, name, text) {
  const fh = await getFileHandle(dir, name, true);
  const writable = await fh.createWritable();
  await writable.write(text);
  await writable.close();
}

async function appendTextFile(dir, name, textToAppend) {
  const fh = await getFileHandle(dir, name, true);
  const writable = await fh.createWritable({ keepExistingData: true });
  const file = await fh.getFile();
  await writable.seek(file.size);
  await writable.write(textToAppend);
  await writable.close();
}

async function existsDir(parentDir, name) {
  try {
    await parentDir.getDirectoryHandle(name, { create: false });
    return true;
  } catch {
    return false;
  }
}

async function existsFile(dir, name) {
  try {
    await dir.getFileHandle(name, { create: false });
    return true;
  } catch {
    return false;
  }
}

// ----------------------- Init / Load -----------------------

async function pickProjectFolder() {
  projectDirHandle = await window.showDirectoryPicker();
  setStatus("Project folder selected");
}

async function ensureTaskboardStructure() {
  if (!projectDirHandle) throw new Error("No project folder selected");
  taskboardDirHandle = await getDirHandle(projectDirHandle, PATH.dir, true);

  if (!(await existsFile(taskboardDirHandle, PATH.board))) {
    await writeTextFile(taskboardDirHandle, PATH.board, JSON.stringify(DEFAULT_BOARD, null, 2) + "\n");
  }
  if (!(await existsFile(taskboardDirHandle, PATH.tasks))) {
    await writeTextFile(taskboardDirHandle, PATH.tasks, "");
  }
  if (!(await existsFile(taskboardDirHandle, PATH.events))) {
    await writeTextFile(taskboardDirHandle, PATH.events, "");
  }
  if (!(await existsFile(taskboardDirHandle, PATH.readme))) {
    await writeTextFile(taskboardDirHandle, PATH.readme, DEFAULT_README);
  }
}

async function loadTaskboard() {
  if (!projectDirHandle) throw new Error("No project folder selected");

  const ok = await existsDir(projectDirHandle, PATH.dir);
  if (!ok) {
    taskboardDirHandle = null;
    boardConfig = null;
    tasks = [];
    renderEmptyBoard();
    setStatus("Not initialized (.taskboard missing)");
    UI.btnInit.disabled = false;
    UI.btnAdd.disabled = true;
    UI.btnReload.disabled = true;
    return;
  }

  taskboardDirHandle = await getDirHandle(projectDirHandle, PATH.dir, false);

  const boardText = await readTextFile(taskboardDirHandle, PATH.board);
  boardConfig = safeJsonParse(boardText) || DEFAULT_BOARD;

  const tasksText = await readTextFile(taskboardDirHandle, PATH.tasks);
  const lines = tasksText.split("\n").map((l) => l.trim()).filter(Boolean);
  tasks = [];
  for (const line of lines) {
    const obj = safeJsonParse(line);
    if (!obj || !obj.id) continue;
    obj.column = obj.column || "todo";
    obj.order = typeof obj.order === "number" ? obj.order : 0;
    obj.checklist = Array.isArray(obj.checklist) ? obj.checklist : [];
    obj.created_at = obj.created_at || nowIsoLocal();
    obj.updated_at = obj.updated_at || obj.created_at;
    tasks.push(obj);
  }

  normalizeAllOrders();
  await saveSnapshot("snapshot_normalized");

  renderBoard();
  populateColumnSelect();
  setStatus(`Loaded ${tasks.length} task(s)`);
  UI.btnInit.disabled = true;
  UI.btnAdd.disabled = false;
  UI.btnReload.disabled = false;
}

async function saveSnapshot(eventType = "snapshot_saved") {
  const text = toNdjson(tasks);
  await writeTextFile(taskboardDirHandle, PATH.tasks, text);
  await appendEvent({ type: eventType });
}

async function appendEvent(payload) {
  const ev = { ts: nowIsoLocal(), ...payload };
  await appendTextFile(taskboardDirHandle, PATH.events, JSON.stringify(ev) + "\n");
}

// ----------------------- Rendering -----------------------

function populateColumnSelect() {
  UI.taskColumn.innerHTML = "";
  for (const col of boardConfig.columns) {
    const opt = document.createElement("option");
    opt.value = col.id;
    opt.textContent = col.title;
    UI.taskColumn.appendChild(opt);
  }
}

function renderEmptyBoard() {
  UI.board.innerHTML = "";
  UI.board.style.gridTemplateColumns = `repeat(3, minmax(260px, 1fr))`;
  const hint = document.createElement("div");
  hint.className = "column";
  hint.style.padding = "16px";
  hint.innerHTML = `
    <div style="font-weight:800; margin-bottom:6px;">Not connected</div>
    <div style="color: var(--muted); font-size: 13px; line-height: 1.5;">
      Open your project folder, then initialize <code>.taskboard</code>.
    </div>
  `;
  UI.board.appendChild(hint);
}

function renderBoard() {
  UI.board.innerHTML = "";
  UI.board.style.gridTemplateColumns = `repeat(${boardConfig.columns.length}, minmax(260px, 1fr))`;

  for (const col of boardConfig.columns) {
    const node = UI.tplColumn.content.firstElementChild.cloneNode(true);
    node.dataset.columnId = col.id;
    node.querySelector(".columnTitle").textContent = col.title;
    const dz = node.querySelector(".dropzone");
    dz.dataset.dropzone = col.id;
    dz.addEventListener("dragover", (e) => onDragOver(e, dz));
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", (e) => onDrop(e, dz, col.id));
    UI.board.appendChild(node);
  }

  for (const col of boardConfig.columns) {
    const dz = UI.board.querySelector(`.dropzone[data-dropzone="${col.id}"]`);
    const colTasks = sortTasksInColumn(col.id);
    for (const t of colTasks) dz.appendChild(renderCard(t));
    updateColumnMeta(col.id);
  }
}

function updateColumnMeta(columnId) {
  const colNode = UI.board.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colNode) return;
  const count = tasks.filter((t) => t.column === columnId).length;
  const wip = boardConfig.wip_limits?.[columnId];
  const meta = colNode.querySelector(".columnMeta");
  meta.textContent = wip ? `${count} / WIP ${wip}` : `${count}`;
  meta.style.color = wip && count > wip ? "var(--danger)" : "var(--muted)";
}

function renderCard(task) {
  const node = UI.tplCard.content.firstElementChild.cloneNode(true);
  node.dataset.taskId = task.id;
  node.querySelector(".cardTitle").textContent = task.title;

  const prio = node.querySelector(".priorityBadge");
  const prioVal = task.priority || "P2";
  prio.textContent = prioVal;
  prio.className = `priorityBadge ${prioVal.toLowerCase()}`;

  const { done, total } = checklistProgress(task);
  node.querySelector(".pill").textContent = total ? `${done}/${total}` : "no checks";

  node.addEventListener("dragstart", (e) => onDragStart(e, node, task.id));
  node.addEventListener("dragend", () => node.classList.remove("dragging"));

  node.addEventListener("click", async (e) => {
    const btn = e.target?.closest("button[data-action]");
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === "add-check") await onAddCheck(task.id);
      if (action === "priority") await onTogglePriority(task.id);
      if (action === "rename") await openTaskDialog(task.id);
      if (action === "delete") await onDeleteTask(task.id);
    } else {
      await openTaskDialog(task.id);
    }
  });

  const list = node.querySelector(".checklist");
  list.innerHTML = "";
  for (const c of task.checklist || []) {
    const row = document.createElement("div");
    row.className = "checkItem";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!c.done;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", async () => {
      await onToggleCheck(task.id, c.id, cb.checked);
    });
    const text = document.createElement("div");
    text.className = "checkText" + (c.done ? " done" : "");
    text.textContent = c.text;
    row.appendChild(cb);
    row.appendChild(text);
    list.appendChild(row);
  }
  return node;
}

// ----------------------- Drag & Drop -----------------------

let dragState = { taskId: null };

function onDragStart(e, cardNode, taskId) {
  dragState.taskId = taskId;
  cardNode.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", taskId);
}

function onDragOver(e, dropzone) {
  e.preventDefault();
  dropzone.classList.add("over");
  e.dataTransfer.dropEffect = "move";
}

async function onDrop(e, dropzone, targetColumnId) {
  e.preventDefault();
  dropzone.classList.remove("over");
  const taskId = e.dataTransfer.getData("text/plain") || dragState.taskId;
  if (!taskId) return;
  const cardNode = UI.board.querySelector(`.card[data-task-id="${taskId}"]`);
  if (!cardNode) return;
  const afterElement = getDragAfterElement(dropzone, e.clientY);
  if (afterElement == null) dropzone.appendChild(cardNode);
  else dropzone.insertBefore(cardNode, afterElement);
  await applyDomOrderToModel(targetColumnId);
  dragState.taskId = null;
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll(".card:not(.dragging)")];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const child of draggableElements) {
    const box = child.getBoundingClientRect();
    const offset = y - (box.top + box.height / 2);
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: child };
    }
  }
  return closest.element;
}

async function applyDomOrderToModel(targetColumnId) {
  for (const col of boardConfig.columns) {
    const dz = UI.board.querySelector(`.dropzone[data-dropzone="${col.id}"]`);
    const ids = [...dz.querySelectorAll(".card")].map((n) => n.dataset.taskId);
    let order = 1000;
    for (const id of ids) {
      const t = getTask(id);
      if (!t) continue;
      const oldColumn = t.column;
      const oldOrder = t.order;
      t.column = col.id;
      t.order = order;
      t.updated_at = nowIsoLocal();
      if (oldColumn !== t.column) {
        await appendEvent({ type: "task_moved", task_id: t.id, from: oldColumn, to: t.column });
      }
      if (oldOrder !== t.order) {
        await appendEvent({ type: "task_reordered", task_id: t.id, column: t.column, old_order: oldOrder, new_order: t.order });
      }
      order += 1000;
    }
    updateColumnMeta(col.id);
  }
  await saveSnapshot("snapshot_after_drag");
  renderBoard();
  setStatus("Saved");
}

// ----------------------- Actions -----------------------

async function openTaskDialog(taskId = null) {
  currentEditingTaskId = taskId;
  UI.frmTask.reset();

  if (taskId) {
    const t = getTask(taskId);
    if (!t) return;
    UI.dlgTitle.textContent = "Edit Task";
    UI.taskTitle.value = t.title;
    UI.taskPriority.value = t.priority || "P2";
    UI.taskColumn.value = t.column || "todo";
    UI.taskDescription.value = t.description || "";
  } else {
    UI.dlgTitle.textContent = "New Task";
    UI.taskPriority.value = "P2";
    UI.taskColumn.value = "todo";
  }

  UI.dlgTask.showModal();
}

UI.frmTask.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = UI.taskTitle.value.trim();
  const priority = UI.taskPriority.value;
  const column = UI.taskColumn.value;
  const description = UI.taskDescription.value.trim();

  if (currentEditingTaskId) {
    const t = getTask(currentEditingTaskId);
    if (t) {
      const old = { ...t };
      t.title = title;
      t.priority = priority;
      t.column = column;
      t.description = description;
      t.updated_at = nowIsoLocal();
      await appendEvent({ type: "task_updated", task_id: t.id, changes: { title, priority, column, description } });
    }
  } else {
    const t = {
      id: genTaskId(),
      title,
      priority,
      column,
      description,
      order: 0,
      checklist: [],
      created_at: nowIsoLocal(),
      updated_at: nowIsoLocal(),
    };
    tasks.push(t);
    normalizeOrders(column);
    await appendEvent({ type: "task_created", task_id: t.id });
  }

  await saveSnapshot("snapshot_after_dialog");
  renderBoard();
  UI.dlgTask.close();
  setStatus(currentEditingTaskId ? "Task updated" : "Task added");
});

UI.btnCancelTask.addEventListener("click", () => UI.dlgTask.close());

async function onTogglePriority(taskId) {
  const t = getTask(taskId);
  if (!t) return;
  const cycle = { P1: "P2", P2: "P3", P3: "P1" };
  const next = cycle[t.priority || "P2"] || "P2";
  t.priority = next;
  t.updated_at = nowIsoLocal();
  await appendEvent({ type: "priority_changed", task_id: t.id, from: t.priority, to: next });
  await saveSnapshot("snapshot_after_priority");
  renderBoard();
}

async function onDeleteTask(taskId) {
  const t = getTask(taskId);
  if (!t || !confirm(`Delete task?\n\n${t.title}`)) return;
  tasks = tasks.filter((x) => x.id !== taskId);
  await appendEvent({ type: "task_deleted", task_id: taskId });
  await saveSnapshot("snapshot_after_delete");
  renderBoard();
}

async function onAddCheck(taskId) {
  const t = getTask(taskId);
  if (!t) return;
  const text = prompt("Checklist item?");
  if (!text) return;
  const nextId = `c${(t.checklist?.length || 0) + 1}`;
  t.checklist.push({ id: nextId, text: text.trim(), done: false });
  t.updated_at = nowIsoLocal();
  await appendEvent({ type: "check_added", task_id: t.id, check_id: nextId });
  await saveSnapshot("snapshot_after_check_add");
  renderBoard();
}

async function onToggleCheck(taskId, checkId, done) {
  const t = getTask(taskId);
  if (!t) return;
  const c = t.checklist.find((x) => x.id === checkId);
  if (!c) return;
  c.done = !!done;
  t.updated_at = nowIsoLocal();
  await appendEvent({ type: "check_done", task_id: t.id, check_id: checkId, done: !!done });
  await saveSnapshot("snapshot_after_check_toggle");
  renderBoard();
}

// ----------------------- Wire UI -----------------------

UI.btnOpen.addEventListener("click", async () => {
  try { await pickProjectFolder(); await loadTaskboard(); }
  catch (err) { console.error(err); alert(`Open failed: ${err?.message}`); }
});

UI.btnInit.addEventListener("click", async () => {
  try {
    if (!projectDirHandle) await pickProjectFolder();
    await ensureTaskboardStructure();
    await appendEvent({ type: "initialized" });
    await loadTaskboard();
  } catch (err) { console.error(err); alert(`Init failed: ${err?.message}`); }
});

UI.btnAdd.addEventListener("click", () => openTaskDialog());

UI.btnReload.addEventListener("click", async () => {
  try { await loadTaskboard(); }
  catch (err) { console.error(err); alert(`Reload failed: ${err?.message}`); }
});

// ----------------------- Theme Toggle -----------------------

function initTheme() {
  const saved = localStorage.getItem("taskboard-theme");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(saved || (systemDark ? "dark" : "light"));
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("taskboard-theme", theme);
  UI.btnTheme.textContent = theme === "dark" ? "Theme: Dark" : "Theme: Light";
}

UI.btnTheme.addEventListener("click", () => {
  setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
});

UI.filterGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".filterBtn");
  if (!btn) return;

  currentPriorityFilter = btn.dataset.filter;
  
  // UI update
  UI.filterGroup.querySelectorAll(".filterBtn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");

  renderBoard();
});

initTheme();
renderEmptyBoard();
setStatus("Open project folder to begin");
