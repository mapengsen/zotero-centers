var CentersCollectionsPlugin = {
  windows: new Map(),
  autoLocatePref: "extensions.zoteroCenters.autoLocateCollections",

  init(search) {
    this.search = search;
  },

  addToWindow(window) {
    if (this.windows.has(window)) return;
    const doc = window.document;
    const add = doc.getElementById("zotero-tb-collection-add");
    if (!add) return;
    const chinese = Zotero.locale.startsWith("zh");
    const collapse = this.toolbarButton(doc, "centers-collapse-collections", chinese ? "折叠全部目录" : "Collapse All Folders");
    const locate = this.toolbarButton(doc, "centers-auto-locate-collections", chinese ? "自动定位分类" : "Auto-Locate Folders");
    locate.setAttribute("type", "checkbox");
    add.after(collapse, locate);

    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    doc.documentElement.append(style);
    const state = { window, collapse, locate, style, highlighted: [], revision: 0, itemID: null, queue: Promise.resolve() };
    this.windows.set(window, state);

    // Collection row elements are virtualized and their DOM IDs are based on row indices.
    state.observer = new window.MutationObserver(() => this.paint(state));
    state.observer.observe(doc.getElementById("zotero-collections-tree"), { childList: true, subtree: true });
    state.onSelect = () => this.selectionChanged(state);
    const attach = () => {
      if (!locate.isConnected) return;
      state.itemsView = window.ZoteroPane.itemsView;
      state.itemsView?.onSelect?.addListener(state.onSelect);
      this.selectionChanged(state);
    };
    if (window.ZoteroPane.itemsView) attach();
    else Zotero.uiReadyPromise.then(attach).catch(error => Zotero.logError(error));
    this.updateToggle(state);

    locate.addEventListener("command", () => {
      Zotero.Prefs.set(this.autoLocatePref, !this.isAutoLocateEnabled(), true);
      for (const current of this.windows.values()) {
        this.updateToggle(current);
        this.selectionChanged(current);
      }
    });
    collapse.addEventListener("command", async () => {
      if (collapse.disabled) return;
      collapse.disabled = true;
      window.clearTimeout(state.timer);
      state.revision++;
      try {
        await this.runInTree(state, tree => this.collapse(tree));
      } catch (error) {
        Zotero.logError(error);
      } finally {
        collapse.disabled = false;
      }
    });
  },

  toolbarButton(doc, id, label) {
    const button = doc.createXULElement("toolbarbutton");
    button.id = id;
    button.className = "zotero-tb-button";
    button.setAttribute("label", label);
    button.setAttribute("tooltiptext", label);
    button.style.width = "auto";
    return button;
  },

  isAutoLocateEnabled() {
    return Zotero.Prefs.get(this.autoLocatePref, true) ?? true;
  },

  updateToggle(state) {
    const enabled = this.isAutoLocateEnabled();
    state.locate.checked = enabled;
    state.locate.setAttribute("aria-pressed", String(enabled));
    state.locate.style.boxShadow = enabled ? "inset 0 -2px currentColor" : "";
  },

  runInTree(state, action) {
    const searchState = this.search.windows.get(state.window);
    const run = async () => {
      const tree = state.window.ZoteroPane.collectionsView;
      if (!state.locate.isConnected || !tree?.tree) return;
      if (searchState) searchState.changing = true;
      try { await action(tree); }
      finally { if (searchState) searchState.changing = false; }
    };
    if (searchState) return this.search.enqueue(searchState, run);
    const result = state.queue.then(run);
    state.queue = result.catch(() => {});
    return result;
  },

  selectionChanged(state) {
    const selected = this.isAutoLocateEnabled() ? state.itemsView?.getSelectedItems?.() : null;
    let item = selected?.length === 1 ? selected[0] : null;
    item = item?.parentItem || item;
    if (!item?.isRegularItem() || item.deleted) item = null;
    const itemID = item?.id ?? null;
    if (state.itemID === itemID) return;
    state.itemID = itemID;
    state.highlighted = [];
    this.paint(state);

    state.window.clearTimeout(state.timer);
    const revision = ++state.revision;
    if (!item) return;
    state.timer = state.window.setTimeout(() => {
      this.runInTree(state, async tree => {
        const current = () => revision === state.revision;
        if (!current()) return;
        const collections = item.getCollections();
        if (!tree._editing && tree.filterEquals("")) {
          for (const id of collections) {
            if (!current()) return;
            if (!await tree.expandToCollection(id) || !current()) continue;
            const index = tree.getRowIndexByID("C" + id);
            if (index !== false && !tree.isContainerOpen(index)) await tree.toggleOpenState(index);
          }
        }
        if (!current()) return;
        state.highlighted = collections.map(id => "C" + id);
        const rows = this.paint(state);
        if (rows.length) tree.ensureRowIsVisible(Math.min(...rows));
      }).catch(error => Zotero.logError(error));
    }, 100);
  },

  paint(state) {
    const tree = state.window.ZoteroPane.collectionsView;
    if (!tree?.tree) return [];
    const rows = state.highlighted.map(id => tree.getRowIndexByID(id)).filter(index => index !== false);
    const selectors = rows.map(index => `#${tree.id}-row-${index}.row`).join(", ");
    // The native Ctrl highlight is held separately and is cleared on key release.
    const css = selectors ? `${selectors} { background: var(--highlight-color, var(--accent-highlight)) !important; }` : "";
    if (state.style.textContent !== css) state.style.textContent = css;
    return rows;
  },

  async collapse(tree) {
    if (!tree?.tree) return;
    const openCollections = Object.keys(tree._containerState).filter(id => /^C\d+$/.test(id));
    for (let index = 0; index < tree.rowCount; index++) {
      const row = tree.getRow(index);
      if (row.isCollection() && row.isOpen) openCollections.push(row.id);
    }
    if (!openCollections.length) return;

    const selection = tree.selection;
    const ancestors = index => {
      const ids = [];
      while (index >= 0 && tree.getRow(index)) {
        ids.push(tree.getRow(index).id);
        index = tree.getParentIndex(index);
      }
      return ids;
    };
    const selectedPaths = [...selection.selected].map(ancestors);
    const focusedPath = ancestors(selection.focused);
    for (const id of openCollections) delete tree._containerState[id];
    const selected = tree.waitForSelect();
    selection.selectEventsSuppressed = true;
    try {
      await tree.reload();
      const survivingRow = ids => ids.map(id => tree.getRowIndexByID(id)).find(index => index !== false);
      const rows = [...new Set(selectedPaths.map(survivingRow).filter(index => index !== undefined))];
      const focused = survivingRow(focusedPath);
      const first = rows.includes(focused) ? focused : rows[0];
      if (first !== undefined) {
        selection.select(first);
        for (const index of rows) if (index !== first) selection.toggleSelect(index);
      } else {
        selection.clearSelection();
      }
      await tree._saveOpenStates();
    } finally {
      selection.selectEventsSuppressed = false;
    }
    await selected;
  },

  removeFromWindow(window) {
    const state = this.windows.get(window);
    if (!state) return;
    state.revision++;
    window.clearTimeout(state.timer);
    state.itemsView?.onSelect?.removeListener(state.onSelect);
    state.observer.disconnect();
    state.style.remove();
    state.collapse.remove();
    state.locate.remove();
    this.windows.delete(window);
  },

  shutdown() {
    for (const window of this.windows.keys()) this.removeFromWindow(window);
  }
};
