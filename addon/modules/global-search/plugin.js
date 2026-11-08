var GlobalSearchPlugin = {
  windows: new Map(),
  engine: GlobalSearchEngine,

  init(info) {
    Object.assign(this, info);
    this.observerID = Zotero.Notifier.registerObserver({
      notify: () => {
        this.engine.invalidate();
        for (const state of this.windows.values()) {
          if (state.input.value.trim()) this.schedule(state);
        }
      }
    }, ["item", "item-tag", "tag", "collection", "collection-item", "group"], "global-search");
  },

  addToWindow(window) {
    if (this.windows.has(window)) return;
    const doc = window.document;
    const toolbar = doc.getElementById("zotero-items-toolbar");
    if (!toolbar) return;
    const html = (tag, className, text) => {
      const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      if (className) el.className = className;
      if (text != null) el.textContent = text;
      return el;
    };
    const css = html("link");
    css.id = "global-search-css";
    css.rel = "stylesheet";
    css.href = this.rootURI + "style.css";
    doc.documentElement.appendChild(css);

    const host = html("div", "global-search-host");
    host.id = "global-search-host";
    const box = html("div", "global-search-box");
    const icon = html("span", "global-search-icon", "⌕");
    icon.setAttribute("aria-hidden", "true");
    const input = html("input");
    input.id = "global-search-input";
    input.type = "search";
    input.placeholder = "全局搜索：所有文库 · 任意字段";
    input.setAttribute("aria-label", "全局搜索所有文库的任意字段");
    input.setAttribute("aria-controls", "zotero-items-tree");
    input.title = "搜索标题、作者、摘要、DOI、其他、标签、笔记、批注等；任一字段包含输入内容即可。Ctrl+Alt+F";
    const clear = html("button", "global-search-clear", "×");
    clear.type = "button";
    clear.title = "清空搜索（Esc）";
    clear.setAttribute("aria-label", "清空全局搜索");
    box.append(icon, input, clear);
    host.append(box);
    const spacer = [...toolbar.children].find(el => el.localName === "spacer");
    if (spacer) spacer.replaceWith(host);
    else toolbar.insertBefore(host, doc.getElementById("zotero-tb-search"));

    const status = html("span", "global-search-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    host.append(status);
    const state = { window, host, spacer, css, input, status, active: false,
      resultsByLibrary: new Map(), patches: new Map(), token: 0, timer: null,
      composing: false, changing: false, cleanups: [], queue: Promise.resolve() };
    this.windows.set(window, state);
    const on = (target, event, listener) => {
      target.addEventListener(event, listener);
      state.cleanups.push(() => target.removeEventListener(event, listener));
    };
    const pane = window.ZoteroPane;
    const originalSelection = pane.onCollectionSelected;
    const selectionWrapper = async (...args) => {
      // A deliberate sidebar selection leaves global mode before the native handler runs.
      if (!state.changing && (state.active || state.input.value)) {
        state.window.clearTimeout(state.timer);
        state.token++;
        state.input.value = "";
        state.status.hidden = true;
        await this.leave(state, false);
      }
      return originalSelection.apply(pane, args);
    };
    pane.onCollectionSelected = selectionWrapper;
    state.cleanups.push(() => {
      if (pane.onCollectionSelected === selectionWrapper) pane.onCollectionSelected = originalSelection;
    });
    on(input, "input", () => { if (!state.composing) this.schedule(state); });
    on(input, "compositionstart", () => { state.composing = true; window.clearTimeout(state.timer); state.token++; });
    on(input, "compositionend", () => { state.composing = false; this.schedule(state); });
    on(input, "keydown", event => {
      if (event.isComposing || state.composing) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); this.clear(state);
      }
      if (event.key === "Enter") { event.preventDefault(); this.schedule(state, 0); }
      if (event.key === "ArrowDown") { event.preventDefault(); pane.itemsView?.focus(); }
    });
    on(clear, "click", () => { this.clear(state); input.focus(); });
    on(window, "keydown", event => {
      if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === "KeyF") {
        event.preventDefault(); input.focus(); input.select();
      }
    });
    const menuParent = doc.getElementById("menu_ToolsPopup");
    if (menuParent) {
      const menu = doc.createXULElement("menuitem");
      menu.id = "global-search-tools";
      menu.setAttribute("label", "全局文献搜索（Ctrl+Alt+F）");
      on(menu, "command", () => { input.focus(); input.select(); });
      menuParent.append(menu);
      state.menu = menu;
    }
  },

  enqueue(state, action) {
    const promise = state.queue.then(action);
    state.queue = promise.catch(error => Zotero.logError(error));
    return promise;
  },

  schedule(state, delay = 250) {
    state.window.clearTimeout(state.timer);
    const token = ++state.token;
    const query = state.input.value.trim();
    if (!query) { this.clear(state); return; }
    state.status.hidden = false;
    state.status.textContent = "搜索中…";
    state.input.setAttribute("aria-busy", "true");
    state.timer = state.window.setTimeout(async () => {
      try {
        const results = await this.engine.search(state.window, query);
        await this.enqueue(state, async () => {
          if (state.token !== token || !this.windows.has(state.window)) return;
          await this.showResults(state, results);
          if (state.token !== token) return;
          state.status.textContent = `${results.length} 篇`;
          state.input.title = `找到 ${results.length} 篇，结果显示于下方原生文献列表。清空或 Esc 返回原视图。`;
        });
      }
      catch (error) {
        Zotero.logError(error);
        if (state.token === token) state.status.textContent = "搜索失败，请重试";
      }
      finally {
        if (state.token === token) state.input.removeAttribute("aria-busy");
      }
    }, delay);
  },

  async selectSources(state, ids) {
    const pane = state.window.ZoteroPane;
    const tree = pane.collectionsView;
    const rows = ids.map(id => tree.getRowIndexByID(id)).filter(index => index !== false);
    if (!rows.length) return;
    const selected = pane.getCollectionTreeRows().map(row => row.id);
    if (selected.length === ids.length && ids.every(id => selected.includes(id))) return;
    const selectedPromise = tree.waitForSelect();
    tree.selection.selectEventsSuppressed = true;
    try {
      tree.selection.select(rows[0]);
      for (const index of rows.slice(1)) tree.selection.toggleSelect(index);
    }
    finally { tree.selection.selectEventsSuppressed = false; }
    await selectedPromise;
  },

  patchSource(state, row) {
    if (state.patches.has(row)) return;
    const ownResults = Object.getOwnPropertyDescriptor(row, "getSearchResults");
    const ownMode = Object.getOwnPropertyDescriptor(row, "isSearchMode");
    const originalResults = row.getSearchResults;
    const originalMode = row.isSearchMode;
    const wrapper = async function (asTempTable, options = {}) {
      if (!state.active) return originalResults.call(this, asTempTable, options);
      const matches = state.resultsByLibrary.get(this.ref.libraryID) || [];
      let ids = matches;
      // The original quick search and tag selector can further refine global matches.
      if (!options.unfiltered && (this.searchText || this.tags?.size || this.advancedSearch)) {
        const allowed = new Set(matches);
        ids = [];
        const nativeIDs = await originalResults.call(this, false, options);
        const nativeItems = await Zotero.Items.getAsync(nativeIDs);
        for (const item of nativeItems) {
          let root = item;
          while (root.parentItemID) root = await Zotero.Items.getAsync(root.parentItemID);
          if (allowed.has(root.id)) ids.push(item.id);
        }
      }
      if (!asTempTable) return ids;
      if (!this._cachedTempTable) this._cachedTempTable = await Zotero.Search.idsToTempTable(ids);
      return this._cachedTempTable;
    };
    const modeWrapper = function () { return state.active || originalMode.call(this); };
    row.getSearchResults = wrapper;
    row.isSearchMode = modeWrapper;
    state.patches.set(row, () => {
      row.clearCache();
      if (row.getSearchResults === wrapper) {
        if (ownResults) Object.defineProperty(row, "getSearchResults", ownResults);
        else delete row.getSearchResults;
      }
      if (row.isSearchMode === modeWrapper) {
        if (ownMode) Object.defineProperty(row, "isSearchMode", ownMode);
        else delete row.isSearchMode;
      }
    });
  },

  async showResults(state, results) {
    const pane = state.window.ZoteroPane;
    const starting = !state.active;
    if (starting) {
      const search = state.window.document.getElementById("zotero-tb-search");
      state.previous = {
        sources: pane.getCollectionTreeRows().map(row => row.id),
        search: search.searchTextbox.value,
        tags: new Set(pane.tagSelector?.getTagSelection() || []),
        items: pane.getSelectedItems(true)
      };
      state.active = true;
      await pane.clearQuicksearch(true);
      pane.tagSelector?.clearTagSelection();
    }
    state.resultsByLibrary = new Map();
    for (const result of results) {
      if (!state.resultsByLibrary.has(result.libraryID)) state.resultsByLibrary.set(result.libraryID, []);
      state.resultsByLibrary.get(result.libraryID).push(result.id);
    }
    const libraries = Zotero.Libraries.getAll().filter(l => ["user", "group"].includes(l.libraryType));
    const ids = libraries.filter(l => state.resultsByLibrary.has(l.libraryID)).map(l => "L" + l.libraryID);
    if (!ids.length) ids.push("L" + Zotero.Libraries.userLibraryID);
    state.changing = true;
    try {
      for (const id of ids) {
        const index = pane.collectionsView.getRowIndexByID(id);
        if (index === false) throw new Error("Library is not visible in the collection tree: " + id);
        const row = pane.collectionsView.getRow(index);
        this.patchSource(state, row);
        if (starting) {
          row.setSearch("");
          row.setTags(new Set());
          row.setAdvancedSearch(null);
        }
        row.clearCache();
      }
      await this.selectSources(state, ids);
      await pane.itemsView.refreshAndMaintainSelection();
    }
    finally { state.changing = false; }
  },

  async clear(state, restore = true) {
    state.window.clearTimeout(state.timer);
    state.token++;
    state.input.value = "";
    state.input.removeAttribute("aria-busy");
    state.status.hidden = true;
    return this.enqueue(state, () => this.leave(state, restore));
  },

  async leave(state, restore) {
    if (!state.active) return;
    state.active = false;
    for (const undo of state.patches.values()) undo();
    state.patches.clear();
    state.resultsByLibrary.clear();
    const previous = state.previous;
    state.previous = null;
    if (!restore || state.window.closed) return;
    const pane = state.window.ZoteroPane;
    state.changing = true;
    try {
      for (const id of previous.sources) {
        if (id.startsWith("C")) await pane.collectionsView.expandToCollection(Number(id.slice(1)));
      }
      await this.selectSources(state, previous.sources);
      const search = state.window.document.getElementById("zotero-tb-search");
      search.searchTextbox.value = previous.search;
      await pane.itemsView.setFilter("search", previous.search);
      await pane.itemsView.setFilter("tags", previous.tags);
      await pane.itemsView.refreshAndMaintainSelection();
      if (previous.items.length) await pane.itemsView.selectItems(previous.items);
    }
    finally { state.changing = false; }
  },

  async removeFromWindow(window) {
    const state = this.windows.get(window);
    if (!state) return;
    await this.clear(state);
    state.cleanups.forEach(fn => fn());
    if (state.spacer) state.host.replaceWith(state.spacer);
    else state.host.remove();
    state.css.remove();
    state.menu?.remove();
    this.windows.delete(window);
  },

  async shutdown() {
    if (this.observerID != null) Zotero.Notifier.unregisterObserver(this.observerID);
    for (const window of [...this.windows.keys()]) await this.removeFromWindow(window);
    this.engine.invalidate();
  }
};

