/* Pure matching/index logic, shared by Zotero and the regression tests. */
var GlobalSearchCore = (() => {
  function normalize(value) {
    return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  }

  function rootFor(id, items) {
    const seen = new Set();
    while (id) {
      if (seen.has(id)) return null;
      seen.add(id);
      const item = items.get(id);
      if (!item || item.deleted) return null;
      if (!item.parentItemID) return item;
      id = item.parentItemID;
    }
    return null;
  }

  function makeEntry(row, root, plainText = String) {
    const value = String(row.value ?? "");
    const visible = row.field === "note" ? plainText(value) : value;
    return { id: root.itemID, libraryID: root.libraryID, field: row.field,
      value: visible, normalized: normalize(visible) };
  }

  function matchEntries(entries, query) {
    const needle = normalize(query);
    if (!needle) return [];
    const results = new Map();
    for (const entry of entries) {
      if (!entry.normalized.includes(needle)) continue;
      // One result per parent reference, even if several children/fields match.
      let result = results.get(entry.id);
      if (!result) {
        result = { id: entry.id, libraryID: entry.libraryID, matches: [], rank: 0 };
        results.set(entry.id, result);
      }
      if (!result.matches.some(m => m.field === entry.field) && result.matches.length < 5) {
        result.matches.push({ field: entry.field, value: entry.value });
      }
      result.rank = Math.max(result.rank, entry.field === "title"
        ? (entry.normalized === needle ? 3 : 2) : 1);
    }
    return [...results.values()].sort((a, b) => b.rank - a.rank || b.id - a.id);
  }

  function snippet(value, query, length = 150) {
    const text = String(value).replace(/\s+/gu, " ").trim();
    // Normalization can change offsets; only use the original string's offset.
    const pos = text.toLowerCase().indexOf(String(query).trim().toLowerCase());
    const start = Math.max(0, pos - 40);
    return (start ? "…" : "") + text.slice(start, start + length)
      + (start + length < text.length ? "…" : "");
  }
  return { normalize, rootFor, makeEntry, matchEntries, snippet };
})();
if (typeof module !== "undefined") module.exports = GlobalSearchCore;
