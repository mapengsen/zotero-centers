var TitleMergeEngine = {
  busy: false,
  cancelRequested: false,
  restorePref: "extensions.titleMerge.restoreAddon",

  async scan(items, { shouldCancel = () => false, onProgress = () => {} } = {}) {
    const unique = [...new Map(items.filter(item => item && item.isRegularItem()
      && item.isTopLevelItem() && !item.deleted && !item.isFeedItem)
      .map(item => [item.id, item])).values()];
    const records = [];
    let completed = 0;
    onProgress({ completed, total: unique.length });
    for (const item of unique) {
      if (shouldCancel()) break;
      await item.loadAllData();
      if (Zotero.Libraries.get(item.libraryID).editable) {
        const data = item.toJSON();
        records.push({ id: item.id, libraryID: item.libraryID, data, fingerprint: JSON.stringify(data) });
      }
      onProgress({ completed: ++completed, total: unique.length });
    }
    return TitleMergeCore.groupRecords(records);
  },

  async recoverZoplicate() {
    const id = Zotero.Prefs.get(this.restorePref, true);
    if (!id) return;
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID(id);
    if (addon && addon.userDisabled) await addon.enable();
    Zotero.Prefs.clear(this.restorePref, true);
  },

  async pauseZoplicate() {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addons = await AddonManager.getAllAddons();
    const addon = addons.find(a => a.isActive && /zoplicate/i.test(a.id + " " + a.name));
    if (!addon) return async () => {};
    Zotero.Prefs.set(this.restorePref, addon.id, true);
    try {
      await addon.disable();
      // Drain observer work already queued by other plugins before validating snapshots.
      await Zotero.Promise.delay(100);
    }
    catch (error) {
      await this.recoverZoplicate();
      throw error;
    }
    return () => this.recoverZoplicate();
  },

  async archive(group, items, masterID, batchDir) {
    const children = [];
    for (const item of items) {
      for (const id of [...item.getNotes(true), ...item.getAttachments(true)]) {
        const child = await Zotero.Items.getAsync(id);
        await child.loadAllData();
        children.push({ id, parentID: item.id, data: child.toJSON() });
        if (child.isFileAttachment()) {
          for (const annotation of child.getAnnotations(true)) {
            await annotation.loadAllData();
            children.push({ id: annotation.id, parentID: child.id, data: annotation.toJSON() });
          }
        }
      }
    }
    const snapshot = {
      format: "zotero-title-merge-metadata-v1", createdAt: new Date().toISOString(),
      zoteroVersion: Zotero.version, libraryID: group.libraryID, normalizedTitle: group.title,
      masterID, items: items.map(item => ({ id: item.id, data: item.toJSON() })), children
    };
    const path = PathUtils.join(batchDir, `group-${masterID}.json`);
    await IOUtils.writeJSON(path, snapshot, { tmpPath: path + ".tmp" });
    return { snapshot, path };
  },

  async validate(group) {
    if (!group.records.some(record => record.id === group.masterID)) throw new Error("Invalid master item");
    const items = await Zotero.Items.getAsync(group.records.map(record => record.id));
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.deleted || !item.isRegularItem() || item.libraryID !== group.libraryID) {
        throw new Error("条目已删除或移动，请重新扫描。 Item was deleted or moved; scan again.");
      }
      await item.loadAllData();
      if (JSON.stringify(item.toJSON()) !== group.records[i].fingerprint
        || TitleMergeCore.normalizeTitle(item.getField("title")) !== group.title) {
        throw new Error("条目在预览后发生变化，请重新扫描。 Item changed since preview; scan again.");
      }
    }
    if (!Zotero.Libraries.get(group.libraryID).editable) throw new Error("Library is read-only");
    return items;
  },

  fillEmptyFields(master, others) {
    for (const other of others) {
      // Map an UNSAVED clone. The native merge accepts mixed types; only Zotero's UI
      // rejects them. Never change the persisted source type or its cached original.
      const mapped = other.clone();
      mapped.setType(master.itemTypeID);
      for (const fieldID of mapped.getUsedFields()) {
        const field = Zotero.ItemFields.getName(fieldID);
        if (field === "title" || !Zotero.ItemFields.isValidForType(fieldID, master.itemTypeID)) continue;
        const value = mapped.getField(field);
        if (!master.getField(field) && value) master.setField(field, value);
      }
      if (!master.numCreators() && mapped.numCreators()) master.setCreators(mapped.getCreators());
    }
  },

  async mergeGroup(group, batchDir) {
    const items = await this.validate(group);
    const master = items.find(item => item.id === group.masterID);
    const others = items.filter(item => item !== master);
    const { snapshot, path } = await this.archive(group, items, master.id, batchDir);
    const { mergeItems } = ChromeUtils.importESModule("chrome://zotero/content/mergeItems.mjs");
    // The native merge owns its transaction. Zotero DB transactions cannot be nested.
    // Store the archive note first. Type mapping uses unsaved clones only. The native
    // merge saves original items, child moves and citation relations in one transaction.
    const note = new Zotero.Item("note");
    note.libraryID = master.libraryID;
    note.parentItemID = master.id;
    note.setNote(`<div><h1>Title Merge / 合并前元数据快照</h1><p>${TitleMergeCore.escapeHTML(snapshot.createdAt)}</p>`
      + "<p>合并前的原始条目元数据；冲突字段以主条目为准。操作结果见本地 report.json。 Original item metadata before merging. See local report.json for the outcome.</p>"
      + `<pre>${TitleMergeCore.escapeHTML(JSON.stringify({ masterID: master.id, items: snapshot.items }, null, 2))}</pre></div>`);
    await note.saveTx();
    // Revalidate after disk I/O and the archive note transaction, before changing types.
    await this.validate(group);
    try {
      this.fillEmptyFields(master, others);
      await mergeItems(master, others);
    }
    catch (error) {
      // Native merge rolls the DB back; restore all cached parents and children as well.
      const ids = [...items.map(item => item.id), ...snapshot.children.map(child => child.id)];
      await Zotero.Items.reload(ids, null, true);
      throw error;
    }
    return { masterID: master.id, masterKey: master.key, mergedIDs: others.map(item => item.id), archive: path };
  },

  async run(groups, onProgress = () => {}) {
    if (this.busy) throw new Error("已有合并任务运行中。 A merge is already running.");
    if (!groups.length) throw new Error("请选择至少一个重复组。 Select at least one group.");
    this.busy = true;
    this.cancelRequested = false;
    let restore = async () => {};
    const report = { startedAt: new Date().toISOString(), completed: [], errors: [], cancelled: false };
    const batchDir = PathUtils.join(Zotero.DataDirectory.dir, "title-merge-archives",
      `${Date.now()}-${Zotero.Utilities.randomString(6)}`);
    try {
      await IOUtils.makeDirectory(batchDir, { createAncestors: true });
      report.directory = batchDir;
      restore = await this.pauseZoplicate();
      for (const group of groups) {
        if (this.cancelRequested) { report.cancelled = true; break; }
        onProgress({ completed: report.completed.length, total: groups.length, title: group.title });
        try {
          const result = await this.mergeGroup(group, batchDir);
          report.completed.push(result);
          // Persist progress after every committed group, so a later failure doesn't hide successes.
          await IOUtils.writeJSON(PathUtils.join(batchDir, "report.json"), report);
        }
        catch (error) {
          Zotero.logError(error);
          report.errors.push({ title: group.title, message: String(error) });
          break;
        }
      }
    }
    catch (error) {
      report.errors.push({ message: String(error) });
    }
    finally {
      try { await restore(); }
      catch (error) { report.errors.push({ message: "Zoplicate restore: " + error }); }
      report.finishedAt = new Date().toISOString();
      try { await IOUtils.writeJSON(PathUtils.join(batchDir, "report.json"), report); }
      catch (error) { report.errors.push({ message: "Report write: " + error }); }
      this.busy = false;
    }
    return report;
  }
};
