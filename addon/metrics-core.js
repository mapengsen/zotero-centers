var CentersMetricsCore = {
  // Zotero.DB.queryAsync returns rows only for a top-level SELECT or PRAGMA.
  COUNT_SQL: `SELECT collectionID, total FROM (
    WITH RECURSIVE descendants(rootID, collectionID, libraryID) AS (
    SELECT c.collectionID, c.collectionID, c.libraryID
    FROM collections c
    LEFT JOIN deletedCollections dc ON dc.collectionID = c.collectionID
    WHERE dc.collectionID IS NULL
    UNION
    SELECT d.rootID, c.collectionID, d.libraryID
    FROM descendants d
    JOIN collections c ON c.parentCollectionID = d.collectionID AND c.libraryID = d.libraryID
    LEFT JOIN deletedCollections dc ON dc.collectionID = c.collectionID
    WHERE dc.collectionID IS NULL
  )
    SELECT descendants.rootID AS collectionID, COUNT(DISTINCT CASE
    WHEN i.itemID IS NOT NULL AND d.itemID IS NULL AND f.itemID IS NULL
      AND t.typeName NOT IN ('attachment', 'note', 'annotation') THEN i.itemID END) AS total
    FROM descendants
    LEFT JOIN collectionItems ci ON ci.collectionID = descendants.collectionID
    LEFT JOIN items i ON i.itemID = ci.itemID AND i.libraryID = descendants.libraryID
    LEFT JOIN itemTypesCombined t ON t.itemTypeID = i.itemTypeID
    LEFT JOIN deletedItems d ON d.itemID = i.itemID
    LEFT JOIN feedItems f ON f.itemID = i.itemID
    GROUP BY descendants.rootID
  )`,

  LIBRARY_COUNT_SQL: `SELECT l.libraryID, COUNT(DISTINCT CASE
    WHEN i.itemID IS NOT NULL AND d.itemID IS NULL AND f.itemID IS NULL
      AND t.typeName NOT IN ('attachment', 'note', 'annotation') THEN i.itemID END) AS total
    FROM libraries l
    LEFT JOIN items i ON i.libraryID = l.libraryID
    LEFT JOIN itemTypesCombined t ON t.itemTypeID = i.itemTypeID
    LEFT JOIN deletedItems d ON d.itemID = i.itemID
    LEFT JOIN feedItems f ON f.itemID = i.itemID
    WHERE l.type IN ('user', 'group')
    GROUP BY l.libraryID`,

  indexRows(rows) {
    let index = 0;
    return rows.map(row => row.isObjectRow && row.ref?.isRegularItem?.()
      && row.ref.isTopLevelItem() && !row.ref.isFeedItem ? String(++index) : "");
  }
};
if (typeof module !== "undefined") module.exports = CentersMetricsCore;
