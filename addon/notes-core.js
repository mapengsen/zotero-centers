var CentersNotesCore = {
  TAG: "zotero-centers-note",
  SQL: `SELECT n.itemID, n.parentItemID, n.note
    FROM itemNotes n
    JOIN items i ON i.itemID = n.itemID
    JOIN items parent ON parent.itemID = n.parentItemID AND parent.libraryID = i.libraryID
    JOIN itemTags it ON it.itemID = n.itemID
    JOIN tags t ON t.tagID = it.tagID
    LEFT JOIN deletedItems dn ON dn.itemID = n.itemID
    LEFT JOIN deletedItems dp ON dp.itemID = parent.itemID
    LEFT JOIN feedItems f ON f.itemID = parent.itemID
    WHERE t.name = ? AND dn.itemID IS NULL AND dp.itemID IS NULL AND f.itemID IS NULL`,

  normalize(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  },
  toHTML(value) {
    const escaped = this.normalize(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return `<div data-schema-version="9"><p>${escaped.replace(/\n/g, "<br />")}</p></div>`;
  },
  fingerprint(entries) { return JSON.stringify(entries.map(entry => [entry.id, entry.html])); }
};
if (typeof module !== "undefined") module.exports = CentersNotesCore;
