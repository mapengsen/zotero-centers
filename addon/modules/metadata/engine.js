var CentersMetadataEngine = {
  get core() { return CentersMetadataCore; },

  canEdit(item) {
    return Boolean(item && !item.deleted && !item.isFeedItem && item.isEditable()
      && (item.isRegularItem() || (item.isFileAttachment() && !item.parentItemID && item.attachmentContentType === "application/pdf")));
  },

  selected(pane) {
    const items = new Map();
    for (const selected of pane.getSelectedItems()) {
      if (selected.deleted) continue;
      const item = selected.isAttachment() && selected.parentItemID ? Zotero.Items.get(selected.parentItemID) : selected;
      if (this.canEdit(item)) items.set(item.id, item);
    }
    return [...items.values()];
  },

  destination(pane) {
    const [libraryID, ...others] = pane.getSelectedLibraryIDs();
    if (!libraryID || others.length || !Zotero.Libraries.get(libraryID)?.editable) return null;
    const collections = pane.getSelectedCollections();
    if (collections.length > 1) return null;
    const collection = collections[0];
    return { libraryID, collectionID: collection?.id, name: collection?.name || Zotero.Libraries.get(libraryID).name };
  },

  itemDOI(item) {
    return this.core.normalizeDOI(item.getField("DOI")) || this.core.normalizeDOI(item.getExtraField("DOI"));
  },

  snapshot(item) {
    const data = item.toJSON();
    const fingerprint = JSON.stringify(Object.keys(data).sort().map(key => [key, data[key]]));
    return { id: item.id, libraryID: item.libraryID, key: item.key, attachment: item.isAttachment(),
      type: data.itemType, title: item.getField("title"), doi: this.itemDOI(item), data, fingerprint };
  },

  fieldID(type, field) {
    if (field === "container") field = ({ journalArticle: "publicationTitle", conferencePaper: "proceedingsTitle",
      bookSection: "bookTitle", preprint: "repository", dataset: "repository" })[type];
    if (!field || !Zotero.ItemFields.getID(field)) return false;
    return Zotero.ItemFields.getFieldIDFromTypeAndBase(type, field);
  },

  preview(row, candidate, mode, changeType) {
    const recommendation = this.core.recommend(candidate.records, mode);
    const original = row.original && !row.original.attachment ? row.original : null;
    const type = original && !changeType ? original.type : recommendation.workType;
    const fields = [];
    for (const [name, label] of Object.entries(this.core.fields)) {
      const options = recommendation.options[name];
      if (!options) continue;
      const id = name === "creators" ? null : this.fieldID(type, name);
      if (id === false) continue;
      const originalID = original && name !== "creators" && this.fieldID(original.type, name);
      const current = name === "creators" ? original?.data.creators || [] :
        originalID ? original.data[Zotero.ItemFields.getName(originalID)] || "" : "";
      const compatibleDate = name === "date" && this.core.isoDate(current).startsWith(options[0].value + "-");
      const alreadyCurrent = original && (this.core.equivalent(name, current, options[0].value) || compatibleDate);
      const preferred = alreadyCurrent || options[0].rank < 0 ? -1 : 0;
      fields.push({ name, label, id, options, current, preferred });
    }
    const lacksIssueDate = recommendation.workType === "journalArticle"
      && !candidate.records.some(record => record.dates.some(date => date.kind === "issue" || date.kind === "print"));
    const dateConflict = lacksIssueDate && new Set((recommendation.options.date || []).map(option => option.value.slice(0, 4))).size > 1;
    return { type, suggestedType: recommendation.workType, fields, original, lacksIssueDate, dateConflict,
      titleMismatch: original && !this.core.similarTitle(original.title, recommendation.options.title[0].value),
      doiChanged: original?.doi && original.doi !== candidate.doi,
      missingTypeFields: original && type !== original.type ? Object.keys(original.data)
        .filter(name => Zotero.ItemFields.getID(name) && !this.fieldID(type, name)) : [] };
  },

  async findDuplicates(libraryID, doi, ignoreID = 0) {
    const rows = await Zotero.DB.queryAsync(`SELECT i.itemID, f.fieldName, v.value
      FROM items i JOIN itemData d USING(itemID) JOIN itemDataValues v USING(valueID)
      JOIN fieldsCombined f USING(fieldID)
      WHERE i.libraryID = ? AND i.itemID != ? AND i.itemTypeID NOT IN (?, ?, ?)
        AND NOT EXISTS (SELECT 1 FROM deletedItems x WHERE x.itemID = i.itemID)
        AND (f.fieldName = 'DOI' OR (f.fieldName = 'extra' AND lower(v.value) LIKE ?))`,
    [libraryID, ignoreID, ...["attachment", "note", "annotation"].map(name => Zotero.ItemTypes.getID(name)), "%doi:%"]);
    return [...new Set(rows.filter(row => {
      if (row.fieldName === "DOI") return this.core.normalizeDOI(row.value) === doi;
      return row.value.split(/\r?\n/).some(line => /^\s*doi:\s*/i.test(line) && this.core.normalizeDOI(line) === doi);
    }).map(row => row.itemID))];
  },

  async backup(item, original) {
    const directory = PathUtils.join(Zotero.DataDirectory.dir, "centers-metadata-backups");
    await IOUtils.makeDirectory(directory, { ignoreExisting: true });
    const path = PathUtils.join(directory, `${Date.now()}-${item.libraryID}-${item.key}.json`);
    await IOUtils.writeJSON(path, { version: 1, itemID: item.id, libraryID: item.libraryID, data: original.data }, { tmpPath: path + ".tmp" });
  },

  setCreators(item, creators) {
    const type = item.itemTypeID;
    const incoming = creators.filter(person => Zotero.CreatorTypes.isValidForItemType(Zotero.CreatorTypes.getID(person.creatorType), type));
    const roles = new Set(incoming.map(person => person.creatorType));
    if (!incoming.length) return;
    const preserved = item.getCreatorsJSON().filter(person => !roles.has(person.creatorType));
    item.setCreators([...incoming, ...preserved]);
  },

  async save(plan) {
    const { original, destination, candidate, preview, fields } = plan;
    const libraryID = original?.libraryID || destination?.libraryID;
    if (!Zotero.Libraries.get(libraryID)?.editable) throw new Error("目标文库不可编辑");
    let item, created, modified;
    try {
      return await Zotero.DB.executeTransaction(async () => {
        item = original && await Zotero.Items.getAsync(original.id);
        if (original && (!this.canEdit(item) || item.key !== original.key || this.snapshot(item).fingerprint !== original.fingerprint)) {
          throw new Error("条目自打开窗口后已变化，请重新打开预览");
        }
        const currentDOI = original?.doi || "";
        const doiField = preview.fields.find(field => field.name === "DOI");
        const doi = doiField && fields.DOI !== undefined ? this.core.normalizeDOI(fields.DOI) : currentDOI;
        if ((!item || original.attachment || candidate.doi !== currentDOI) && doi !== candidate.doi) {
          throw new Error("请采用所选版本的 DOI");
        }
        if (doi && (!original || original.attachment || doi !== currentDOI)
          && (await this.findDuplicates(libraryID, doi, item?.id)).length) {
          throw new Error("该文库已有此 DOI，已跳过");
        }
        if (!item || original.attachment) {
          if (!fields.title) throw new Error("新条目必须有标题");
          created = new Zotero.Item(preview.type);
          created.libraryID = libraryID;
          if (original?.attachment) {
            await this.backup(item, original);
            created.setCollections(item.getCollections());
          } else if (destination.collectionID) {
            const collection = Zotero.Collections.get(destination.collectionID);
            if (!collection || collection.deleted || collection.libraryID !== libraryID) throw new Error("目标分类已变化");
            created.addToCollection(collection.id);
          }
        } else {
          const changed = preview.type !== original.type || Object.keys(fields).length > 0;
          if (!changed) return { id: item.id, action: "无差异" };
          await this.backup(item, original);
          modified = true;
          if (preview.type !== original.type) item.setType(Zotero.ItemTypes.getID(preview.type));
        }
        const target = created || item;
        for (const field of preview.fields) {
          if (!Object.hasOwn(fields, field.name)) continue;
          if (field.name === "creators") this.setCreators(target, fields.creators);
          else target.setField(field.id, fields[field.name]);
        }
        // A legacy DOI in Extra should not contradict the new native DOI field.
        if (modified && fields.DOI && original.data.extra) {
          const extra = target.getField("extra").split(/\r?\n/).filter(line =>
            !(/^\s*doi:\s*/i.test(line) && this.core.normalizeDOI(line))).join("\n");
          target.setField("extra", extra);
        }
        await target.save(created ? {} : { undoAction: "undo-action-edit-metadata", undoActionArgs: { count: 1 } });
        if (original?.attachment) {
          modified = true;
          item.setCollections([]);
          item.parentItemID = created.id;
          await item.save({ undoAction: "undo-action-change-parent-item", undoActionArgs: { count: 1 } });
        }
        return { id: target.id, action: created ? original?.attachment ? "已创建条目并关联 PDF" : "已添加" : "已更新" };
      });
    } catch (error) {
      // The database transaction also covers a standalone PDF's new parent.
      if (modified) {
        try { await item.reload(["primaryData", "itemData", "creators", "collections"], true); }
        catch (reloadError) { Zotero.logError(reloadError); }
      }
      if (created?.id && !await Zotero.DB.valueQueryAsync("SELECT 1 FROM items WHERE itemID = ?", [created.id])) {
        Zotero.Items.unload(created.id);
      }
      throw error;
    }
  },
};
