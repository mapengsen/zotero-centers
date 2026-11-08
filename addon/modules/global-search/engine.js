/* Read-only projection of the Zotero 10 schema. No saved searches or writes. */
var GlobalSearchEngine = {
  revision: 0,
  cache: null,
  pending: null,
  SQL_ITEMS: `SELECT i.itemID, i.libraryID,
    COALESCE(a.parentItemID, n.parentItemID, an.parentItemID) AS parentItemID,
    (d.itemID IS NOT NULL) AS deleted
    FROM items i
    LEFT JOIN itemAttachments a USING (itemID)
    LEFT JOIN itemNotes n USING (itemID)
    LEFT JOIN itemAnnotations an USING (itemID)
    LEFT JOIN deletedItems d USING (itemID)`,
  SQL_FIELDS: `SELECT d.itemID, f.fieldName AS field, v.value AS value
    FROM itemData d JOIN fieldsCombined f USING (fieldID)
    JOIN itemDataValues v USING (valueID)
    UNION ALL SELECT ic.itemID, 'creator',
      trim(COALESCE(c.firstName, '') || ' ' || COALESCE(c.lastName, ''))
      FROM itemCreators ic JOIN creators c USING (creatorID)
    UNION ALL SELECT ic.itemID, 'creator',
      trim(COALESCE(c.lastName, '') || ' ' || COALESCE(c.firstName, ''))
      FROM itemCreators ic JOIN creators c USING (creatorID)
    UNION ALL SELECT it.itemID, 'tag', t.name FROM itemTags it JOIN tags t USING (tagID)
    UNION ALL SELECT itemID, 'note', note FROM itemNotes
    UNION ALL SELECT itemID, 'annotationText', text FROM itemAnnotations
    UNION ALL SELECT itemID, 'annotationComment', comment FROM itemAnnotations
    UNION ALL SELECT itemID, 'annotationAuthor', authorName FROM itemAnnotations
    UNION ALL SELECT itemID, 'annotationPage', pageLabel FROM itemAnnotations
    UNION ALL SELECT itemID, 'attachmentPath', path FROM itemAttachments
    UNION ALL SELECT itemID, 'contentType', contentType FROM itemAttachments
    UNION ALL SELECT itemID, 'key', key FROM items
    UNION ALL SELECT itemID, 'dateAdded', dateAdded FROM items
    UNION ALL SELECT itemID, 'dateModified', dateModified FROM items
    UNION ALL SELECT i.itemID, 'itemType', t.typeName
      FROM items i JOIN itemTypesCombined t USING (itemTypeID)
    UNION ALL SELECT ci.itemID, 'collection', c.collectionName
      FROM collectionItems ci JOIN collections c USING (collectionID)
    UNION ALL SELECT itemID, 'related', object FROM itemRelations`,

  invalidate() { this.revision++; this.cache = null; },

  async getIndex(window) {
    if (this.cache) return this.cache;
    if (this.pending) { await this.pending; return this.getIndex(window); }
    const revision = this.revision;
    this.pending = this.build(window).then(index => {
      if (revision === this.revision) this.cache = index;
      return index;
    }).finally(() => { this.pending = null; });
    const index = await this.pending;
    // A notification during a build must not leave a stale index in use.
    return revision === this.revision ? index : this.getIndex(window);
  },

  async build(window) {
    const libraries = new Set(Zotero.Libraries.getAll()
      .filter(l => ["user", "group"].includes(l.libraryType)).map(l => l.libraryID));
    const items = new Map((await Zotero.DB.queryAsync(this.SQL_ITEMS)).map(row =>
      [row.itemID, { itemID: row.itemID, libraryID: row.libraryID,
        parentItemID: row.parentItemID, deleted: !!row.deleted }]));
    const rows = await Zotero.DB.queryAsync(this.SQL_FIELDS);
    const entries = [];
    const parser = new window.DOMParser();
    const plainText = html => {
      const document = parser.parseFromString(String(html)
        .replace(/<(?:br\b[^>]*|\/(?:p|div|li|h[1-6]|tr|blockquote))>/gi, " "), "text/html");
      document.querySelectorAll("script, style").forEach(node => node.remove());
      return document.body.textContent;
    };
    let count = 0;
    for (const row of rows) {
      const root = GlobalSearchCore.rootFor(row.itemID, items);
      if (root && libraries.has(root.libraryID) && row.value != null && row.value !== "") {
        entries.push(GlobalSearchCore.makeEntry(row, root, plainText));
      }
      if (++count % 1500 === 0) await Zotero.Promise.delay(0);
    }
    return entries;
  },

  async search(window, query) {
    if (!GlobalSearchCore.normalize(query)) return [];
    return GlobalSearchCore.matchEntries(await this.getIndex(window), query);
  }
};
if (typeof module !== "undefined") module.exports = GlobalSearchEngine;
