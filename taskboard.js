/**
 * Taskboard Refactored
 * Roles:
 * - FS: File System Access API operations
 * - State: Application data and business logic
 * - UI: DOM manipulation and rendering
 * - App: Main controller / Event orchestration
 */

// ----------------------- 1. FileSystem Manager -----------------------
const FS = {
  projectDir: null,
  taskboardDir: null,
  paths: {
    dir: ".taskboard",
    board: "board.json",
    tasks: "tasks.ndjson",
    events: "events.ndjson",
    readme: "README.md",
  },

  async pickFolder() {
    this.projectDir = await window.showDirectoryPicker();
    return this.projectDir;
  },

  async getDir(parent, name, create = false) {
    return await parent.getDirectoryHandle(name, { create });
  },

  async getFile(dir, name, create = false) {
    return await dir.getFileHandle(name, { create });
  },

  async readText(dir, name) {
    const fh = await this.getFile(dir, name, false);
    const file = await fh.getFile();
    return await file.text();
  },

  async writeText(dir, name, text) {
    const fh = await this.getFile(dir, name, true);
    const writable = await fh.createWritable();
    await writable.write(text);
    await writable.close();
  },

  async appendText(dir, name, text) {
    const fh = await this.getFile(dir, name, true);
    const writable = await fh.createWritable({ keepExistingData: true });
    const file = await fh.getFile();
    await writable.seek(file.size);
    await writable.write(text);
    await writable.close();
  },

  async existsDir(parent, name) {
    try { await parent.getDirectoryHandle(name, { create: false }); return true; }
    catch { return false; }
  },

  async existsFile(dir, name) {
    try { await dir.getFileHandle(name, { create: false }); return true; }
    catch { return false; }
  },

  toNdjson(items) {
    return items.map(o => JSON.stringify(o)).join("\n") + (items.length ? "\n" : "");
  },

  parseNdjson(text) {
    return text.split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(o => o !== null);
  }
};

// ----------------------- 2. State Manager -----------------------
const State = {
  boardConfig: null,
  tasks: [],
  currentPriorityFilter: "all",
  
  defaults: {
    board: {
      schema_version: 1,
      columns: [
        { id: "todo", title: "To Do" },
        { id: "doing", title: "Doing" },
        { id: "done", title: "Done" },
      ],
      wip_limits: { doing: 5 },
      ui: { show_done_by_default: true },
    },
    readme: `Taskboard data format (AI-friendly)

Truth sources:
  - tasks.ndjson : current snapshot (one JSON per line; one line = one task)
  - events.ndjson: append-only event log (one JSON per line)

Rules:
  - If a line is invalid JSON, skip it.
  - Task id is immutable.
  - column is one of: todo | doing | done
  - checklist[].done is boolean.
  - order is a numeric sort key. Within a column, tasks are ordered by (order asc, updated_at desc).
`
  },

  utils: {
    nowIso() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const tzMin = -d.getTimezoneOffset();
      const sign = tzMin >= 0 ? "+" : "-";
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(tzMin) / 60))}:${pad(Math.abs(tzMin) % 60)}`;
    },
    genId() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      return `T-${ymd}-${hms}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
    }
  },

  getTask(id) { return this.tasks.find(t => t.id === id) || null; },

  async initTaskboard() {
    FS.taskboardDir = await FS.getDir(FS.projectDir, FS.paths.dir, true);
    if (!(await FS.existsFile(FS.taskboardDir, FS.paths.board))) {
      await FS.writeText(FS.taskboardDir, FS.paths.board, JSON.stringify(this.defaults.board, null, 2) + "\n");
    }
    if (!(await FS.existsFile(FS.taskboardDir, FS.paths.tasks))) {
      await FS.writeText(FS.taskboardDir, FS.paths.tasks, "");
    }
    if (!(await FS.existsFile(FS.taskboardDir, FS.paths.events))) {
      await FS.writeText(FS.taskboardDir, FS.paths.events, "");
    }
    if (!(await FS.existsFile(FS.taskboardDir, FS.paths.readme))) {
      await FS.writeText(FS.taskboardDir, FS.paths.readme, this.defaults.readme);
    }
  },

  async load() {
    if (!await FS.existsDir(FS.projectDir, FS.paths.dir)) return false;
    FS.taskboardDir = await FS.getDir(FS.projectDir, FS.paths.dir, false);

    const configText = await FS.readText(FS.taskboardDir, FS.paths.board);
    this.boardConfig = JSON.parse(configText) || this.defaults.board;

    const tasksText = await FS.readText(FS.taskboardDir, FS.paths.tasks);
    this.tasks = FS.parseNdjson(tasksText).map(t => ({
      ...t,
      column: t.column || "todo",
      order: t.order ?? 0,
      checklist: t.checklist || [],
      created_at: t.created_at || this.utils.nowIso(),
      updated_at: t.updated_at || t.created_at
    }));

    this.normalizeAllOrders();
    await this.saveSnapshot("load_normalized");
    return true;
  },

  async saveSnapshot(type = "snapshot") {
    await FS.writeText(FS.taskboardDir, FS.paths.tasks, FS.toNdjson(this.tasks));
    await this.logEvent({ type });
  },

  async logEvent(payload) {
    const ev = { ts: this.utils.nowIso(), ...payload };
    await FS.appendText(FS.taskboardDir, FS.paths.events, JSON.stringify(ev) + "\n");
  },

  getSortedTasks(columnId) {
    const priorityMap = { P1: 1, P2: 2, P3: 3 };
    return this.tasks
      .filter(t => t.column === columnId)
      .filter(t => this.currentPriorityFilter === "all" || (t.priority || "P2") === this.currentPriorityFilter)
      .sort((a, b) => {
        const pa = priorityMap[a.priority || "P2"] || 2;
        const pb = priorityMap[b.priority || "P2"] || 2;
        if (pa !== pb) return pa - pb;
        if (a.due_date || b.due_date) {
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          if (a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date);
        }
        return (a.order ?? 0) - (b.order ?? 0) || String(b.updated_at).localeCompare(String(a.updated_at));
      });
  },

  normalizeOrders(columnId) {
    const colTasks = this.getSortedTasks(columnId);
    let order = 1000;
    for (const t of colTasks) { t.order = order; order += 1000; }
  },

  normalizeAllOrders() {
    this.boardConfig.columns.forEach(c => this.normalizeOrders(c.id));
  }
};

// ----------------------- 3. UI Manager -----------------------
const UI = {
  els: {
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
    dlgTask: document.getElementById("dlgTask"),
    frmTask: document.getElementById("frmTask"),
    dlgTitle: document.getElementById("dlgTitle"),
    taskTitle: document.getElementById("taskTitle"),
    taskPriority: document.getElementById("taskPriority"),
    taskColumn: document.getElementById("taskColumn"),
    taskDueDate: document.getElementById("taskDueDate"),
    taskDescription: document.getElementById("taskDescription"),
    btnCancelTask: document.getElementById("btnCancelTask"),
  },

  setStatus(msg) { this.els.status.textContent = msg; },

  renderEmpty() {
    this.els.board.innerHTML = `<div class="column" style="padding:16px;">
      <div style="font-weight:800; margin-bottom:6px;">Not connected</div>
      <div style="color: var(--muted); font-size: 13px;">Open your project folder to begin.</div>
    </div>`;
  },

  renderBoard() {
    const { boardConfig, currentPriorityFilter } = State;
    this.els.board.innerHTML = "";
    this.els.board.style.gridTemplateColumns = `repeat(${boardConfig.columns.length}, minmax(260px, 1fr))`;

    boardConfig.columns.forEach(col => {
      const node = this.els.tplColumn.content.firstElementChild.cloneNode(true);
      node.dataset.columnId = col.id;
      node.querySelector(".columnTitle").textContent = col.title;
      
      const dz = node.querySelector(".dropzone");
      dz.dataset.dropzone = col.id;
      dz.addEventListener("dragover", e => App.onDragOver(e, dz));
      dz.addEventListener("dragleave", () => dz.classList.remove("over"));
      dz.addEventListener("drop", e => App.onDrop(e, dz, col.id));
      
      const colTasks = State.getSortedTasks(col.id);
      colTasks.forEach(t => dz.appendChild(this.renderCard(t)));
      
      this.els.board.appendChild(node);
      this.updateColumnMeta(col.id);
    });

    // Sync Filter UI
    this.els.filterGroup.querySelectorAll(".filterBtn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === currentPriorityFilter);
    });
  },

  updateColumnMeta(columnId) {
    const colNode = this.els.board.querySelector(`.column[data-column-id="${columnId}"]`);
    if (!colNode) return;
    const count = State.tasks.filter(t => t.column === columnId).length;
    const wip = State.boardConfig.wip_limits?.[columnId];
    const meta = colNode.querySelector(".columnMeta");
    meta.textContent = wip ? `${count} / WIP ${wip}` : `${count}`;
    meta.style.color = wip && count > wip ? "var(--danger)" : "var(--muted)";
  },

  renderCard(task) {
    const node = this.els.tplCard.content.firstElementChild.cloneNode(true);
    node.dataset.taskId = task.id;
    node.querySelector(".cardTitle").textContent = task.title;

    const prio = node.querySelector(".priorityBadge");
    const prioVal = task.priority || "P2";
    prio.textContent = prioVal;
    prio.className = `priorityBadge ${prioVal.toLowerCase()}`;

    const due = node.querySelector(".dueDate");
    if (task.due_date) {
      due.textContent = task.due_date;
      const today = new Date().toISOString().split("T")[0];
      if (task.due_date < today) due.classList.add("overdue");
      else if (task.due_date === today) due.classList.add("today");
    } else {
      due.style.display = "none";
    }

    const doneCount = (task.checklist || []).filter(c => c.done).length;
    const totalCount = (task.checklist || []).length;
    node.querySelector(".pill").textContent = totalCount ? `${doneCount}/${totalCount}` : "no checks";

    node.addEventListener("dragstart", e => App.onDragStart(e, node, task.id));
    node.addEventListener("dragend", () => node.classList.remove("dragging"));
    node.addEventListener("click", e => App.onCardClick(e, task.id));

    const list = node.querySelector(".checklist");
    (task.checklist || []).forEach(c => {
      const row = document.createElement("div");
      row.className = "checkItem";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!c.done;
      cb.addEventListener("click", e => e.stopPropagation());
      cb.addEventListener("change", () => App.onToggleCheck(task.id, c.id, cb.checked));
      
      const text = document.createElement("div");
      text.className = "checkText" + (c.done ? " done" : "");
      text.textContent = c.text;
      
      row.appendChild(cb);
      row.appendChild(text);
      list.appendChild(row);
    });

    return node;
  },

  populateColumnSelect() {
    this.els.taskColumn.innerHTML = "";
    State.boardConfig.columns.forEach(col => {
      const opt = document.createElement("option");
      opt.value = col.id;
      opt.textContent = col.title;
      this.els.taskColumn.appendChild(opt);
    });
  },

  showTaskDialog(taskId = null) {
    this.els.frmTask.reset();
    if (taskId) {
      const t = State.getTask(taskId);
      this.els.dlgTitle.textContent = "Edit Task";
      this.els.taskTitle.value = t.title;
      this.els.taskPriority.value = t.priority || "P2";
      this.els.taskColumn.value = t.column || "todo";
      this.els.taskDueDate.value = t.due_date || "";
      this.els.taskDescription.value = t.description || "";
    } else {
      this.els.dlgTitle.textContent = "New Task";
    }
    this.els.dlgTask.showModal();
  },

  initTheme() {
    const saved = localStorage.getItem("taskboard-theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    this.setTheme(saved || (systemDark ? "dark" : "light"));
  },

  setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("taskboard-theme", theme);
    this.els.btnTheme.textContent = theme === "dark" ? "Theme: Dark" : "Theme: Light";
  }
};

// ----------------------- 4. App Controller -----------------------
const App = {
  dragState: { taskId: null },
  editingTaskId: null,

  async init() {
    UI.initTheme();
    UI.renderEmpty();
    this.wireEvents();
  },

  wireEvents() {
    UI.els.btnOpen.addEventListener("click", () => this.handleOpen());
    UI.els.btnInit.addEventListener("click", () => this.handleInit());
    UI.els.btnAdd.addEventListener("click", () => {
      this.editingTaskId = null;
      UI.showTaskDialog();
    });
    UI.els.btnReload.addEventListener("click", () => this.handleReload());
    UI.els.btnTheme.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      UI.setTheme(current === "dark" ? "light" : "dark");
    });
    UI.els.filterGroup.addEventListener("click", (e) => this.handleFilter(e));
    UI.els.frmTask.addEventListener("submit", (e) => this.handleTaskSubmit(e));
    UI.els.btnCancelTask.addEventListener("click", () => UI.els.dlgTask.close());
  },

  async handleOpen() {
    try {
      await FS.pickFolder();
      const loaded = await State.load();
      if (loaded) {
        UI.populateColumnSelect();
        UI.renderBoard();
        UI.setStatus(`Loaded ${State.tasks.length} task(s)`);
        UI.els.btnInit.disabled = true;
        UI.els.btnAdd.disabled = false;
        UI.els.btnReload.disabled = false;
      } else {
        UI.setStatus("Not initialized (.taskboard missing)");
        UI.els.btnInit.disabled = false;
      }
    } catch (err) {
      console.error(err);
      UI.setStatus(`Open failed: ${err.message}`);
    }
  },

  async handleInit() {
    try {
      if (!FS.projectDir) await FS.pickFolder();
      await State.initTaskboard();
      await State.logEvent({ type: "initialized" });
      await this.handleReload();
    } catch (err) {
      console.error(err);
      UI.setStatus(`Init failed: ${err.message}`);
    }
  },

  async handleReload() {
    if (await State.load()) {
      UI.populateColumnSelect();
      UI.renderBoard();
      UI.setStatus("Reloaded");
    }
  },

  handleFilter(e) {
    const btn = e.target.closest(".filterBtn");
    if (!btn) return;
    State.currentPriorityFilter = btn.dataset.filter;
    UI.renderBoard();
  },

  async handleTaskSubmit(e) {
    e.preventDefault();
    const data = new FormData(UI.els.frmTask);
    const taskData = Object.fromEntries(data.entries());

    if (this.editingTaskId) {
      const t = State.getTask(this.editingTaskId);
      Object.assign(t, taskData);
      t.updated_at = State.utils.nowIso();
      await State.logEvent({ type: "task_updated", task_id: t.id, changes: taskData });
    } else {
      const t = {
        id: State.utils.genId(),
        ...taskData,
        order: 0,
        checklist: [],
        created_at: State.utils.nowIso(),
        updated_at: State.utils.nowIso()
      };
      State.tasks.push(t);
      State.normalizeOrders(t.column);
      await State.logEvent({ type: "task_created", task_id: t.id });
    }
    await State.saveSnapshot("snapshot_after_dialog");
    UI.renderBoard();
    UI.els.dlgTask.close();
    UI.setStatus(this.editingTaskId ? "Task updated" : "Task added");
  },

  async onCardClick(e, taskId) {
    const btn = e.target?.closest("button[data-action]");
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === "add-check") await this.handleAddCheck(taskId);
      if (action === "priority") await this.handleTogglePriority(taskId);
      if (action === "rename") { this.editingTaskId = taskId; UI.showTaskDialog(taskId); }
      if (action === "delete") await this.handleDeleteTask(taskId);
    } else {
      this.editingTaskId = taskId;
      UI.showTaskDialog(taskId);
    }
  },

  async handleTogglePriority(taskId) {
    const t = State.getTask(taskId);
    const cycle = { P1: "P2", P2: "P3", P3: "P1" };
    t.priority = cycle[t.priority || "P2"] || "P2";
    t.updated_at = State.utils.nowIso();
    await State.logEvent({ type: "priority_changed", task_id: taskId, to: t.priority });
    await State.saveSnapshot();
    UI.renderBoard();
  },

  async handleDeleteTask(taskId) {
    const t = State.getTask(taskId);
    if (!confirm(`Delete task?\n\n${t.title}`)) return;
    State.tasks = State.tasks.filter(x => x.id !== taskId);
    await State.logEvent({ type: "task_deleted", task_id: taskId });
    await State.saveSnapshot();
    UI.renderBoard();
  },

  async handleAddCheck(taskId) {
    const text = prompt("Checklist item?");
    if (!text) return;
    const t = State.getTask(taskId);
    const cId = `c${(t.checklist?.length || 0) + 1}`;
    t.checklist.push({ id: cId, text: text.trim(), done: false });
    t.updated_at = State.utils.nowIso();
    await State.logEvent({ type: "check_added", task_id: taskId, check_id: cId });
    await State.saveSnapshot();
    UI.renderBoard();
  },

  async onToggleCheck(taskId, checkId, done) {
    const t = State.getTask(taskId);
    const c = t.checklist.find(x => x.id === checkId);
    if (c) {
      c.done = !!done;
      t.updated_at = State.utils.nowIso();
      await State.logEvent({ type: "check_done", task_id: taskId, check_id: checkId, done });
      await State.saveSnapshot();
      UI.renderBoard();
    }
  },

  // Drag & Drop
  onDragStart(e, node, taskId) {
    this.dragState.taskId = taskId;
    node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId);
  },

  onDragOver(e, dropzone) {
    e.preventDefault();
    dropzone.classList.add("over");
    e.dataTransfer.dropEffect = "move";
  },

  async onDrop(e, dropzone, targetColumnId) {
    e.preventDefault();
    dropzone.classList.remove("over");
    const taskId = e.dataTransfer.getData("text/plain") || this.dragState.taskId;
    if (!taskId) return;

    const cardNode = UI.els.board.querySelector(`.card[data-task-id="${taskId}"]`);
    if (!cardNode) return;

    const afterElement = this.getDragAfterElement(dropzone, e.clientY);
    if (afterElement == null) dropzone.appendChild(cardNode);
    else dropzone.insertBefore(cardNode, afterElement);

    await this.applyDomOrderToModel();
    this.dragState.taskId = null;
  },

  getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll(".card:not(.dragging)")];
    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - (box.top + box.height / 2);
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      else return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  },

  async applyDomOrderToModel() {
    for (const col of State.boardConfig.columns) {
      const dz = UI.els.board.querySelector(`.dropzone[data-dropzone="${col.id}"]`);
      const ids = [...dz.querySelectorAll(".card")].map(n => n.dataset.taskId);
      let order = 1000;
      for (const id of ids) {
        const t = State.getTask(id);
        if (t.column !== col.id) {
          await State.logEvent({ type: "task_moved", task_id: id, from: t.column, to: col.id });
          t.column = col.id;
        }
        t.order = order;
        t.updated_at = State.utils.nowIso();
        order += 1000;
      }
      UI.updateColumnMeta(col.id);
    }
    await State.saveSnapshot("snapshot_after_drag");
    UI.renderBoard();
    UI.setStatus("Saved");
  }
};

App.init();
