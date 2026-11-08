var CentersMetrics = {
  windows: new Map(),
  counts: new Map(),
  libraryCounts: new Map(),
  revision: 0,
  ready: false,

  init(info) {
    Object.assign(this, info);
    this.columnKey = Zotero.ItemTreeManager.registerColumn({
      pluginID: info.id, dataKey: "index", label: "Index", enabledTreeIDs: ["main"],
      width: "76", minWidth: 60, flex: 0, staticWidth: true,
      dataProvider: () => "",
      renderCell: (rowIndex, data, column, first, doc) => {
        const cell = doc.createElement("span");
        cell.className = `cell ${column.className} centers-index-cell`;
        const label = doc.createElement("span"); label.className = "cell-text";
        label.textContent = this.getIndex(doc.defaultView, rowIndex);
        cell.append(label);
        return cell;
      }
    });
    if (!this.columnKey) throw new Error("无法注册 Index 列。");
    this.observerID = Zotero.Notifier.registerObserver({ notify: () => this.scheduleCounts() },
      ["item", "collection", "collection-item", "group"], "zotero-centers-counts");
    this.scheduleCounts();
  },

  scheduleCounts() {
    const revision = ++this.revision;
    if (!this.windows.size) return;
    const window = this.windows.keys().next().value;
    if (this.countTimer) this.countTimer.window.clearTimeout(this.countTimer.id);
    this.countTimer = { window, id: window.setTimeout(() => this.refreshCounts(revision)
      .catch(error => Zotero.logError(error)), 80) };
  },

  async refreshCounts(revision = this.revision) {
    const [records, libraries] = await Promise.all([
      Zotero.DB.queryAsync(CentersMetricsCore.COUNT_SQL),
      Zotero.DB.queryAsync(CentersMetricsCore.LIBRARY_COUNT_SQL)
    ]);
    if (revision !== this.revision) return;
    this.counts = new Map(records.map(record => [record.collectionID, Number(record.total)]));
    this.libraryCounts = new Map(libraries.map(record => [record.libraryID, Number(record.total)]));
    this.ready = true;
    for (const window of this.windows.keys()) this.decorateCollections(window);
  },

  addToWindow(window) {
    if (this.windows.has(window)) return;
    const doc = window.document;
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = "zotero-centers-metrics-style";
    style.textContent = "#zotero-collections-tree .cell:has(> .centers-collection-count) > .cell-text { flex-grow: 0; min-width: 0; } .centers-collection-count { margin-inline-start: 5px; opacity: .7; flex: 0 0 auto; font-variant-numeric: tabular-nums; } .centers-index-cell { font-variant-numeric: tabular-nums; }";
    doc.documentElement.append(style);
    const state = { style, cleanups: [], view: null, manager: null, numbers: null, disposed: false };
    this.windows.set(window, state);
    state.update = () => {
      if (state.disposed) return;
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => {
        this.ensureView(window);
        this.decorateCollections(window);
      }, 30);
    };
    state.observer = new window.MutationObserver(records => {
      if (records.some(record => !(record.target.nodeType === 1 ? record.target : record.target.parentElement)
        ?.closest(".centers-collection-count"))) state.update();
    });
    for (const id of ["zotero-items-tree", "zotero-collections-tree"]) {
      const root = doc.getElementById(id);
      if (root) state.observer.observe(root, { childList: true, subtree: true });
    }
    this.ensureView(window);
    state.update();
    Zotero.uiReadyPromise.then(() => { if (!state.disposed) state.update(); });
    this.scheduleCounts();
  },

  ensureView(window) {
    const state = this.windows.get(window);
    if (!state || state.disposed) return;
    const view = window.ZoteroPane?.itemsView;
    if (!view) return;
    if (state.view !== view) {
      for (const cleanup of state.cleanups) cleanup();
      state.cleanups = [];
      state.view = view;
      state.numbers = null;
      const original = view.handleRowModelUpdate;
      const own = Object.getOwnPropertyDescriptor(view, "handleRowModelUpdate");
      const wrapper = function (...args) {
        state.numbers = null;
        return original.apply(this, args);
      };
      view.handleRowModelUpdate = wrapper;
      state.cleanups.push(() => {
        if (view.handleRowModelUpdate !== wrapper) return;
        if (own) Object.defineProperty(view, "handleRowModelUpdate", own);
        else delete view.handleRowModelUpdate;
      });
    }
    const manager = view.tree?._columns;
    if (!manager || state.manager === manager) return;
    const key = this.columnKey;
    let index = manager._columns.findIndex(column => column.dataKey === key);
    if (index < 0) return;
    state.manager = manager;
    this.syncSort(view, manager);
    const metrics = this;
    const originalSort = manager.toggleSort;
    const own = Object.getOwnPropertyDescriptor(manager, "toggleSort");
    const sortWrapper = function (index, ...args) {
      if (this._columns[index]?.dataKey === key) return;
      metrics.syncSort(view, this);
      return originalSort.call(this, index, ...args);
    };
    manager.toggleSort = sortWrapper;
    state.cleanups.push(() => {
      if (manager.toggleSort !== sortWrapper) return;
      if (own) Object.defineProperty(manager, "toggleSort", own);
      else delete manager.toggleSort;
    });
    if (manager._columns[index].hidden) manager.toggleHidden(index);
    index = manager._columns.findIndex(column => column.dataKey === key);
    if (index > 0) manager.setOrder(index, 0);
    this.syncSort(view, manager);
  },

  syncSort(view, manager) {
    // Reordering/hiding columns rebuilds Zotero 10's canonical column objects.
    // Reattach its active sort to the rebuilt object before the native header
    // handler runs; otherwise an old _sortedColumn leaves every sort ascending.
    const columns = view._getColumns();
    const previous = view._sortedColumn;
    const key = previous?.dataKey && previous.dataKey !== this.columnKey ? previous.dataKey : "title";
    const column = columns.find(candidate => candidate.dataKey === key);
    if (!column) return;
    const direction = (previous?.dataKey === key && previous.sortDirection) || column.sortDirection || 1;
    column.sortDirection = direction;
    view._sortedColumn = column;
    const tableColumn = manager._columns.find(candidate => candidate.dataKey === key);
    if (tableColumn) tableColumn.sortDirection = direction;
    const prefs = view._getColumnPrefs();
    prefs[key] = prefs[key] || {};
    prefs[key].sortDirection = direction;
    for (const candidate of [...columns, ...manager._columns]) {
      if (candidate.dataKey === this.columnKey) delete candidate.sortDirection;
    }
    if (prefs[this.columnKey]) delete prefs[this.columnKey].sortDirection;
  },

  getIndex(window, rowIndex) {
    const state = this.windows.get(window);
    const view = window.ZoteroPane?.itemsView;
    if (!view) return "";
    const rows = view._rows;
    if (!state) return CentersMetricsCore.indexRows(rows)[rowIndex] || "";
    if (!state.numbers || state.rows !== rows || state.numbers.length !== rows.length) {
      state.rows = rows;
      state.numbers = CentersMetricsCore.indexRows(rows);
    }
    return state.numbers[rowIndex] || "";
  },

  decorateCollections(window) {
    const state = this.windows.get(window);
    if (!state || state.disposed || !this.ready) return;
    const view = window.ZoteroPane?.collectionsView;
    if (!view) return;
    for (const node of window.document.querySelectorAll("#zotero-collections-tree .row[id]")) {
      const index = Number(node.id.slice((view.id + "-row-").length));
      if (!node.id.startsWith(view.id + "-row-") || !Number.isInteger(index)) continue;
      const row = view.getRow(index);
      let badge = node.querySelector(".centers-collection-count");
      const isCollection = row?.isCollection();
      const isLibrary = row?.isLibrary() || row?.isGroup();
      if ((!isCollection && !isLibrary) || node.classList.contains("editing")) { badge?.remove(); continue; }
      const count = (isCollection ? this.counts.get(row.ref.id) : this.libraryCounts.get(row.ref.libraryID)) || 0;
      if (!badge) {
        badge = window.document.createElementNS("http://www.w3.org/1999/xhtml", "span");
        badge.className = "centers-collection-count";
        node.querySelector(".cell")?.append(badge);
      }
      const text = `(${count})`;
      if (badge.textContent !== text) badge.textContent = text;
      const title = isCollection
        ? `当前目录及所有层级子目录共 ${count} 篇文献，同一条目只计一次，不含附件和笔记`
        : `当前文库共 ${count} 篇文献，包含未分类文献，同一条目只计一次，不含附件、笔记和回收站条目`;
      if (badge.title !== title) badge.title = title;
    }
  },

  removeFromWindow(window) {
    const state = this.windows.get(window);
    if (!state) return;
    state.disposed = true;
    window.clearTimeout(state.timer);
    state.observer.disconnect();
    for (const cleanup of state.cleanups) cleanup();
    window.document.querySelectorAll(".centers-collection-count").forEach(badge => badge.remove());
    state.style.remove();
    this.windows.delete(window);
    if (this.countTimer?.window === window) {
      window.clearTimeout(this.countTimer.id);
      this.countTimer = null;
    }
  },

  async shutdown() {
    ++this.revision;
    for (const window of [...this.windows.keys()]) this.removeFromWindow(window);
    if (this.observerID != null) Zotero.Notifier.unregisterObserver(this.observerID);
    if (this.columnKey) Zotero.ItemTreeManager.unregisterColumn(this.columnKey);
    this.columnKey = null;
    this.counts.clear(); this.libraryCounts.clear(); this.ready = false;
  }
};
