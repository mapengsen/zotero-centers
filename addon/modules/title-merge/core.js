/* Pure title matching and master selection; shared by Zotero and Node tests. */
var TitleMergeCore = (() => {
  "use strict";
  const priorities = { journalArticle: 4, conferencePaper: 3, preprint: 2 };
  const ignored = new Set(["key", "version", "itemType", "title", "dateAdded", "dateModified",
    "collections", "tags", "relations", "attachments", "notes", "uri", "deleted"]);

  function normalizeTitle(title) {
    return typeof title === "string" ? title.trim().replace(/\s+/gu, " ").toLowerCase() : "";
  }

  function completeness(data) {
    return Object.entries(data).reduce((score, [key, value]) => {
      if (ignored.has(key) || value === null || value === undefined || value === "") return score;
      if (Array.isArray(value)) return score + (value.length ? 1 : 0);
      return score + (typeof value === "string" ? Number(Boolean(value.trim())) : 1);
    }, 0);
  }

  function compareRecords(a, b) {
    return (priorities[b.data.itemType] || 1) - (priorities[a.data.itemType] || 1)
      || completeness(b.data) - completeness(a.data)
      || String(a.data.dateAdded || "9999").localeCompare(String(b.data.dateAdded || "9999"))
      || a.id - b.id;
  }

  function groupRecords(records) {
    const groups = new Map();
    for (const record of records) {
      const title = normalizeTitle(record.data.title);
      if (!title) continue;
      // Never merge across libraries, including personal and group libraries.
      const key = JSON.stringify([record.libraryID, title]);
      if (!groups.has(key)) groups.set(key, { key, libraryID: record.libraryID, title, records: [] });
      groups.get(key).records.push(record);
    }
    return [...groups.values()].filter(group => group.records.length > 1).map(group => {
      group.records.sort(compareRecords);
      group.masterID = group.records[0].id;
      return group;
    }).sort((a, b) => a.title.localeCompare(b.title));
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  return Object.freeze({ normalizeTitle, completeness, compareRecords, groupRecords, escapeHTML });
})();
if (typeof module !== "undefined") module.exports = TitleMergeCore;
