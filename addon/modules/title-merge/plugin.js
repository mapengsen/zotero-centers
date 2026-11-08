var TitleMergePlugin = {
  windows: new Set(),
  dialogs: new Set(),
  windowStates: new Map(),
  sidebarOperation: null,
  engine: TitleMergeEngine,

  async init(info) {
    Object.assign(this, info);
    await this.engine.recoverZoplicate();
  },

  addToWindow(window) {
    if (this.windows.has(window)) return;
    this.windows.add(window);
    for (const [parentID, id] of [["menu_ToolsPopup", "title-merge-tools"],
      ["zotero-itemmenu", "title-merge-context"]]) {
      const parent = window.document.getElementById(parentID);
      if (!parent) continue;
      const menu = window.document.createXULElement("menuitem");
      menu.id = id;
      menu.setAttribute("label", "同标题合并… / Title Merge…");
      menu.addEventListener("command", () => this.open(window));
      parent.appendChild(menu);
    }
    this.attachSidebar(window);
  },

  removeFromWindow(window) {
    if (this.sidebarOperation?.window === window) this.stopSidebarOperation();
    const state = this.windowStates.get(window);
    if (state) {
      state.disposed = true;
      state.observer.disconnect();
      window.clearTimeout(state.timer);
      for (const id of ["zotero-items-tree", "zotero-collections-tree"]) {
        window.document.getElementById(id)?.removeEventListener("select", state.schedule, true);
      }
      for (const panel of state.panels.values()) panel.root.remove();
      state.styles.remove();
      this.windowStates.delete(window);
    }
    for (const id of ["title-merge-tools", "title-merge-context"]) window.document.getElementById(id)?.remove();
    this.windows.delete(window);
  },

  open(window, preview = {}) {
    for (const dialog of this.dialogs) {
      if (!dialog.closed) {
        dialog.focus();
        if (preview.autoScan) {
          if (dialog.titleMergePreview) dialog.titleMergePreview(preview);
          else dialog.addEventListener("load", () => dialog.titleMergePreview?.(preview), { once: true });
        }
        return dialog;
      }
    }
    const dialog = window.openDialog("chrome://zotero-centers-merge/content/dialog.xhtml", "title-merge",
      "chrome,centerscreen,resizable,dialog=no,width=1040,height=780", { plugin: this, pane: window.ZoteroPane, preview });
    this.dialogs.add(dialog);
    const onUnload = event => {
      // openDialog first unloads about:blank. Only remove the actual plugin document.
      if (event.target.documentURI !== "chrome://zotero-centers-merge/content/dialog.xhtml") return;
      this.dialogs.delete(dialog);
      dialog.removeEventListener("unload", onUnload);
    };
    dialog.addEventListener("unload", onUnload);
    return dialog;
  },

  attachSidebar(window) {
    const doc = window.document;
    const itemPane = doc.getElementById("zotero-item-pane");
    if (!itemPane) return;
    const styles = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    styles.id = "title-merge-sidebar-styles";
    styles.rel = "stylesheet";
    styles.href = "chrome://zotero-centers-merge/content/sidebar.css";
    doc.documentElement.appendChild(styles);
    const state = { panels: new Map(), groups: [], generation: 0, selection: "", running: false,
      scanning: false, result: "", disposed: false, styles };
    this.windowStates.set(window, state);
    state.schedule = () => {
      if (state.disposed) return;
      ++state.generation;
      // Disable the previous selection immediately, before the deferred scan starts.
      state.scanning = true;
      for (const panel of state.panels.values()) {
        panel.merge.disabled = true;
        panel.preview.disabled = true;
      }
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => this.refreshSidebar(window).catch(error => {
        Zotero.logError(error);
        if (state.disposed) return;
        state.scanning = false;
        state.groups = [];
        state.result = String(error);
        this.paintSidebar(window);
      }), 40);
    };
    // Both native merge and type-mismatch message panes need the same entry point.
    // Observe native view updates without replacing Zotero or Zoplicate methods.
    state.observer = new window.MutationObserver(records => {
      const changed = records.some(record => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        return !target?.closest("[data-title-merge-sidebar]");
      });
      if (changed) state.schedule();
    });
    state.observer.observe(itemPane, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["view-type", "selectedIndex", "readonly"] });
    for (const id of ["zotero-items-tree", "zotero-collections-tree"]) {
      doc.getElementById(id)?.addEventListener("select", state.schedule, true);
    }
    state.schedule();
  },

  ensureSidebarPanels(window) {
    const state = this.windowStates.get(window);
    const doc = window.document;
    for (const id of ["zotero-item-message", "zotero-duplicates-merge-pane"]) {
      const host = doc.getElementById(id);
      if (!host || state.panels.get(id)?.root.isConnected) continue;
      const html = (tag, className, text) => {
        const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
      };
      const root = html("section", "title-merge-sidebar");
      root.id = `title-merge-sidebar-${id}`;
      root.dataset.titleMergeSidebar = "true";
      root.setAttribute("aria-label", "同标题合并");
      root.hidden = true;
      const heading = html("strong", "title-merge-sidebar-heading", "同标题合并");
      const summary = html("p", "title-merge-sidebar-summary");
      const master = html("p", "title-merge-sidebar-master");
      const actions = html("div", "title-merge-sidebar-actions");
      const bulk = html("button", "title-merge-sidebar-bulk", "一键合并当前列表全部同标题文献");
      bulk.type = "button";
      bulk.disabled = true;
      bulk.title = "自动扫描并合并当前重复条目列表中的所有同标题组，包含当前筛选，无需逐组点击";
      bulk.addEventListener("click", () => this.mergeFromSidebar(window, { all: true }));
      const merge = html("button", "title-merge-sidebar-merge", "合并所选同标题文献");
      merge.type = "button";
      merge.disabled = true;
      merge.addEventListener("click", () => this.mergeFromSidebar(window));
      const preview = html("button", "title-merge-sidebar-preview", "预览");
      preview.type = "button";
      preview.title = "预览字段并选择主条目";
      preview.disabled = true;
      preview.addEventListener("click", () => this.open(window, {
        scope: "selected", autoScan: true, items: window.ZoteroPane.getSelectedItems().slice()
      }));
      actions.append(merge, preview);
      const progressLabel = html("p", "title-merge-sidebar-progress-label");
      progressLabel.setAttribute("role", "status");
      progressLabel.setAttribute("aria-live", "polite");
      const progress = html("progress", "title-merge-sidebar-progress");
      progress.setAttribute("aria-label", "批量合并进度");
      progress.max = 1;
      progress.value = 0;
      const stop = html("button", "title-merge-sidebar-stop", "完成当前组后停止");
      stop.type = "button";
      stop.addEventListener("click", () => this.stopSidebarOperation());
      const result = html("p", "title-merge-sidebar-result");
      result.setAttribute("role", "status");
      result.setAttribute("aria-live", "polite");
      root.append(heading, bulk, summary, master, actions, progressLabel, progress, stop, result);
      // Keep outside native custom-head, which Zotero recreates on every selection.
      host.insertBefore(root, host.firstChild);
      state.panels.set(id, { root, bulk, summary, master, merge, preview, progressLabel, progress, stop, result });
    }
  },

  sidebarSelection(window) {
    const pane = window.ZoteroPane;
    const mode = pane.itemsView?.viewMode;
    const items = pane.getSelectedItems();
    return { mode, items, key: JSON.stringify([mode, items.map(item => item.id).sort((a, b) => a - b)]) };
  },

  async refreshSidebar(window) {
    const state = this.windowStates.get(window);
    if (!state || state.disposed) return;
    const generation = ++state.generation;
    this.ensureSidebarPanels(window);
    const { mode, items, key } = this.sidebarSelection(window);
    if (key !== state.selection) state.result = "";
    state.selection = key;
    state.visible = mode === "duplicates";
    state.viewCount = state.visible ? window.ZoteroPane.getSortedItems().length : 0;
    state.groups = [];
    if (!state.visible || items.length < 2 || this.engine.busy || this.sidebarOperation || state.running) {
      state.scanning = false;
      this.paintSidebar(window);
      return;
    }
    state.scanning = true;
    this.paintSidebar(window);
    const groups = await this.engine.scan(items);
    // A slower scan must never re-enable a button for an older selection.
    if (state.disposed || generation !== state.generation || key !== this.sidebarSelection(window).key) return;
    state.groups = groups;
    state.scanning = false;
    this.paintSidebar(window);
  },

  paintSidebar(window) {
    const state = this.windowStates.get(window);
    if (!state || state.disposed) return;
    const count = state.groups.reduce((sum, group) => sum + group.records.length, 0);
    const operation = this.sidebarOperation;
    const busy = this.engine.busy || operation || state.running;
    for (const panel of state.panels.values()) {
      panel.root.hidden = !state.visible;
      panel.merge.disabled = busy || state.scanning || !state.groups.length;
      panel.preview.disabled = busy || state.scanning || !state.groups.length;
      panel.bulk.disabled = Boolean(busy) || state.viewCount < 2;
      panel.merge.textContent = busy ? "正在合并…" : "合并所选同标题文献";
      panel.summary.textContent = operation?.phase === "scan" ? "正在扫描当前列表中的同标题文献…"
        : busy ? "正在保留附件、笔记与分类…"
        : state.scanning ? "正在核对所选标题…"
        : count ? `所选文献中可合并 ${state.groups.length} 组，共 ${count} 条。`
        : "无需全选；点击上方按钮可自动处理当前列表。";
      const group = state.groups.length === 1 ? state.groups[0] : null;
      const record = group?.records.find(record => record.id === group.masterID);
      panel.master.textContent = record
        ? `默认保留：${Zotero.ItemTypes.getLocalizedString(record.data.itemType)} · ${record.data.shortTitle || record.data.title}`
        : count ? "默认优先保留期刊、会议、预印本；可点“预览”调整。" : "";
      panel.master.hidden = !panel.master.textContent;
      panel.result.textContent = state.result;
      panel.result.hidden = !state.result;
      panel.progressLabel.hidden = panel.progress.hidden = panel.stop.hidden = !operation;
      if (operation) {
        panel.progress.max = Math.max(operation.total, 1);
        panel.progress.value = operation.completed;
        panel.progressLabel.textContent = operation.phase === "scan"
          ? `正在扫描当前列表：${operation.completed}/${operation.total} 条…`
          : `正在合并：${Math.min(operation.completed + 1, operation.total)}/${operation.total} 组…`;
        panel.stop.disabled = operation.cancelRequested;
        panel.stop.textContent = operation.cancelRequested ? "正在停止…"
          : operation.phase === "scan" ? "停止扫描" : "完成当前组后停止";
      }
    }
  },

  stopSidebarOperation() {
    if (!this.sidebarOperation) return;
    this.sidebarOperation.cancelRequested = true;
    this.engine.cancelRequested = true;
    for (const target of this.windows) this.paintSidebar(target);
  },

  async mergeFromSidebar(window, { all = false } = {}) {
    const state = this.windowStates.get(window);
    if (!state || state.running || this.engine.busy || this.sidebarOperation) return;
    if (all) {
      if (window.ZoteroPane.itemsView?.viewMode !== "duplicates") return;
    }
    else {
      if (state.scanning || !state.groups.length) return;
      if (state.selection !== this.sidebarSelection(window).key) { state.schedule(); return; }
    }
    let groups = state.groups;
    // Freeze the list at click time: native merging changes the live duplicates list.
    const items = all ? window.ZoteroPane.getSortedItems().slice() : null;
    state.running = true;
    state.result = "";
    state.lastReport = null;
    ++state.generation;
    const operation = { window, phase: all ? "scan" : "merge", cancelRequested: false,
      completed: 0, total: all ? items.length : groups.length };
    this.sidebarOperation = operation;
    for (const target of this.windows) this.paintSidebar(target);
    try {
      if (all) {
        groups = await this.engine.scan(items, {
          shouldCancel: () => operation.cancelRequested,
          onProgress: progress => {
            Object.assign(operation, progress);
            if (progress.completed % 10 === 0 || progress.completed === progress.total) {
              for (const target of this.windows) this.paintSidebar(target);
            }
          }
        });
        if (operation.cancelRequested) {
          state.lastReport = { completed: [], errors: [], cancelled: true, scanCancelled: true };
          state.result = "已停止扫描，本次未合并任何文献。";
          return;
        }
        if (!groups.length) {
          state.lastReport = { completed: [], errors: [], cancelled: false };
          state.result = "当前列表中没有可合并的同标题文献。";
          return;
        }
      }
      operation.phase = "merge";
      operation.completed = 0;
      operation.total = groups.length;
      const pending = this.engine.run(groups, progress => {
        Object.assign(operation, progress);
        state.result = `正在合并 ${progress.completed + 1}/${progress.total} 组…`;
        for (const target of this.windows) this.paintSidebar(target);
      });
      for (const target of this.windows) this.paintSidebar(target);
      const report = await pending;
      state.lastReport = report;
      state.result = report.errors.length
        ? `已合并 ${report.completed.length} 组。${report.errors.map(error => error.message).join("；")}`
        : report.cancelled ? `已停止，完成 ${report.completed.length}/${groups.length} 组。再次点击可处理剩余记录。`
        : `已合并${all ? "当前列表全部" : ""} ${report.completed.length} 组同标题文献，附件、笔记和分类已保留。`;
    }
    catch (error) {
      Zotero.logError(error);
      state.lastReport = { completed: [], errors: [{ message: String(error) }], cancelled: false };
      state.result = String(error);
    }
    finally {
      state.running = false;
      this.sidebarOperation = null;
      const result = state.result;
      for (const target of this.windows) {
        try { await this.refreshSidebar(target); }
        catch (error) { Zotero.logError(error); }
      }
      if (!state.disposed) { state.result = result; this.paintSidebar(window); }
    }
  },

  async getItems(scope, pane) {
    if (scope === "selected") return pane.getSelectedItems();
    if (scope === "view") return pane.getSortedItems();
    if (scope.startsWith("library:")) return Zotero.Items.getAll(Number(scope.slice(8)), true, false);
    throw new Error("Unknown scan scope");
  },

  async shutdown() {
    this.stopSidebarOperation();
    this.engine.cancelRequested = true;
    // Finish the active group's transaction before unloading code or re-enabling Zoplicate.
    while (this.engine.busy || this.sidebarOperation) await Zotero.Promise.delay(100);
    for (const window of this.windows) this.removeFromWindow(window);
    for (const dialog of this.dialogs) if (!dialog.closed) dialog.close();
    this.dialogs.clear();
  }
};
