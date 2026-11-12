var CentersMetadataPlugin = {
  engine: CentersMetadataEngine,
  sources: CentersMetadataSources,
  windows: new Map(),
  dialogs: new Map(),
  pending: null,
  dialogURL: "chrome://zotero-centers-metadata/content/dialog.xhtml",

  async init(rootURI) {
    try {
      const contents = await Zotero.File.getResourceAsync(rootURI + "journal-abbreviations.json");
      const data = JSON.parse(contents);
      if (!data.byISSN || !data.byTitle) throw new Error("期刊简称库缺少索引");
      this.engine.journalAbbreviations = data;
    } catch (error) {
      Zotero.logError(error);
    }
  },

  addToWindow(window) {
    if (this.windows.has(window)) return;
    const doc = window.document;
    const pane = window.ZoteroPane;
    const elements = [];
    const add = (tag, id, label, action) => {
      const element = doc.createXULElement(tag);
      element.id = id;
      element.setAttribute("label", label);
      element.addEventListener("command", action);
      elements.push(element);
      return element;
    };
    const show = mode => this.open(window, mode).catch(error => {
      Zotero.logError(error);
      if (!window.closed) window.alert(error.message);
    });
    const lookup = doc.getElementById("zotero-tb-lookup");
    if (lookup) {
      const button = add("toolbarbutton", "centers-metadata-toolbar", "批量添加", () => show("import"));
      button.setAttribute("tooltiptext", "按 DOI、标题等批量添加文献，或从文件导入");
      lookup.after(button);
    }
    const toolsMenu = doc.getElementById("menu_ToolsPopup");
    toolsMenu?.append(add("menuitem", "centers-metadata-import", "批量添加文献…", () => show("import")));
    const itemMenu = doc.getElementById("zotero-itemmenu");
    const refresh = add("menuitem", "centers-metadata-refresh", "查询并更新元数据…", () => show("update"));
    itemMenu?.append(refresh);
    const updateMenu = event => {
      if (event.target === itemMenu) refresh.hidden = !this.engine.selected(pane).length;
    };
    itemMenu?.addEventListener("popupshowing", updateMenu);
    this.windows.set(window, () => {
      itemMenu?.removeEventListener("popupshowing", updateMenu);
      for (const element of elements) element.remove();
    });
  },

  async open(window, mode) {
    const pane = window.ZoteroPane;
    const destination = mode === "import" ? this.engine.destination(pane) : null;
    const items = mode === "update" ? this.engine.selected(pane) : [];
    if (mode === "import" && !destination) throw new Error("请先选择一个可编辑的文库或分类。");
    if (mode === "update" && !items.length) throw new Error("请选择可编辑的文献或 PDF。");
    const signature = JSON.stringify([mode, destination, items.map(item => item.id)]);
    for (const [dialog, data] of this.dialogs) {
      if (!dialog.closed && data.window === window && data.signature === signature) {
        dialog.focus();
        return dialog;
      }
    }
    await Promise.all(items.map(item => item.loadAllData()));
    if (!this.windows.has(window)) return null;
    const dialog = window.openDialog(this.dialogURL, "", "chrome,centerscreen,resizable,dialog=no,width=1080,height=790", {
      plugin: this, mode, destination, originals: items.map(item => this.engine.snapshot(item)),
      importFile: mode === "import" ? () => window.Zotero_File_Interface.showImportWizard() : null,
    });
    this.dialogs.set(dialog, { window, signature });
    dialog.addEventListener("unload", event => {
      if (event.target.documentURI === this.dialogURL) this.dialogs.delete(dialog);
    });
    return dialog;
  },

  async apply(plans, onResult, stopped) {
    if (this.pending) throw new Error("另一个元数据写入任务正在运行");
    this.pending = this.applyRows(plans, onResult, stopped);
    try { await this.pending; }
    finally { this.pending = null; }
  },

  async applyRows(plans, onResult, stopped) {
    for (const plan of plans) {
      if (stopped()) break;
      let result;
      try { result = await this.engine.save(plan); }
      catch (error) { result = { error: error.message || String(error) }; }
      onResult(plan, result);
    }
  },

  launch(url) { Zotero.launchURL(url); },
  typeLabel(type) { return Zotero.ItemTypes.getLocalizedString(type); },

  removeFromWindow(window) {
    for (const [dialog, data] of this.dialogs) if (data.window === window && !dialog.closed) dialog.close();
    this.windows.get(window)?.();
    this.windows.delete(window);
  },

  async shutdown() {
    for (const window of this.windows.keys()) this.removeFromWindow(window);
    await this.pending;
    this.dialogs.clear();
  },
};
