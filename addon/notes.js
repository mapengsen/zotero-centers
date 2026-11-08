var CentersNotes = {
  cache: new Map(),
  revision: 0,
  disposed: true,

  async init(info, inline) {
    this.disposed = false;
    this.unregisterField = inline.registerField("centersNote", {
      multiline: true, labels: { zh: "笔记", en: "Notes" },
      adapter: {
        read: (item, window) => this.read(item, window),
        write: (item, value, snapshot, window) => this.write(item, value, snapshot, window),
        rollback: item => this.reload(item),
        refresh: () => this.refresh()
      }
    });
    this.observerID = Zotero.Notifier.registerObserver({ notify: () => this.schedule() },
      ["item", "item-tag", "tag"], "zotero-centers-notes");
    await this.refresh();
  },

  async query(parentID = null) {
    const records = await Zotero.DB.queryAsync(CentersNotesCore.SQL
      + (parentID == null ? "" : " AND n.parentItemID = ?") + " ORDER BY n.parentItemID, i.dateAdded, n.itemID",
    parentID == null ? [CentersNotesCore.TAG] : [CentersNotesCore.TAG, parentID]);
    return records.map(record => ({ id: record.itemID, parentID: record.parentItemID, html: record.note }));
  },

  text(entries, window = Zotero.getMainWindow()) {
    if (!window) return "";
    const parser = new window.DOMParser();
    return entries.map(entry => {
      if (entry.text == null) {
        const doc = parser.parseFromString(entry.html.replace(/<br\b[^>]*>/gi, "\n")
          .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, "\n"), "text/html");
        doc.querySelectorAll("script, style").forEach(node => node.remove());
        entry.text = CentersNotesCore.normalize(doc.body.textContent);
      }
      return entry.text;
    }).filter(Boolean).join("\n\n");
  },

  getValue(item) {
    return item?.isRegularItem?.() && !item.deleted && !item.isFeedItem
      ? this.text(this.cache.get(item.id) || []) : "";
  },

  async read(item, window) {
    const entries = await this.query(item.id);
    return { value: this.text(entries, window), snapshot: CentersNotesCore.fingerprint(entries) };
  },

  async write(item, value, snapshot, window) {
    Zotero.DB.requireTransaction();
    if (!item.isRegularItem() || item.deleted || item.isFeedItem || !item.isEditable()) {
      throw new Error("此文献不可编辑。");
    }
    value = CentersNotesCore.normalize(value);
    const entries = await this.query(item.id);
    const current = this.text(entries, window);
    if (snapshot !== CentersNotesCore.fingerprint(entries) && value !== current) {
      throw new Error("笔记已在别处修改。输入仍保留；请复制草稿后重新打开。");
    }
    if (current === value) return;
    const saveOptions = { undoAction: "undo-action-edit-field", undoActionArgs: { field: "笔记", count: 1 } };
    let primary;
    for (const entry of entries) {
      const note = await Zotero.Items.getAsync(entry.id);
      await note.reload(["primaryData", "note", "tags"], true);
      if (!primary) { primary = note; continue; }
      // Merge can move several managed notes under one paper. Keep originals as
      // ordinary child notes when the user edits their combined column value.
      note.removeTag(CentersNotesCore.TAG);
      await note.save(saveOptions);
    }
    if (!primary) {
      if (!value) return;
      primary = new Zotero.Item("note");
      primary.libraryID = item.libraryID;
      primary.parentItemID = item.id;
      primary.addTag(CentersNotesCore.TAG, 1);
    }
    primary.setNote(CentersNotesCore.toHTML(value));
    await primary.save(saveOptions);
  },

  async reload(item) {
    for (const entry of await this.query(item.id)) {
      const note = await Zotero.Items.getAsync(entry.id);
      await note.reload(["primaryData", "note", "tags"], true);
    }
    await this.refresh();
  },

  schedule() {
    ++this.revision;
    if (this.scheduled || this.disposed) return;
    this.scheduled = Zotero.Promise.delay(60).then(() => {
      this.scheduled = null;
      if (!this.disposed) return this.refresh();
    }).catch(error => Zotero.logError(error));
  },

  async refresh() {
    const revision = ++this.revision;
    const entries = await this.query();
    if (this.disposed || revision !== this.revision) return;
    const affected = new Set(this.cache.keys());
    const cache = new Map();
    for (const entry of entries) {
      if (!cache.has(entry.parentID)) cache.set(entry.parentID, []);
      cache.get(entry.parentID).push(entry);
      affected.add(entry.parentID);
    }
    const changed = [...affected].filter(id => CentersNotesCore.fingerprint(this.cache.get(id) || [])
      !== CentersNotesCore.fingerprint(cache.get(id) || []));
    this.cache = cache;
    if (!changed.length) return;
    for (const window of Zotero.getMainWindows()) {
      const view = window.ZoteroPane?.itemsView;
      if (!view?.tree) continue;
      view.invalidateRowCache(changed);
      if (this.columnKey && view.getSortField() === this.columnKey) await view.sort();
      view.tree.invalidate();
    }
  },

  shutdown() {
    this.disposed = true;
    ++this.revision;
    if (this.observerID != null) Zotero.Notifier.unregisterObserver(this.observerID);
    this.unregisterField?.();
    this.unregisterField = null;
    this.columnKey = null;
    this.cache.clear();
  }
};
