var IntegrationPromise = (async () => {
  const out = PathUtils.join(TEST_ROOT, "test-results", "integration.json");
  const results = { version: Centers.version, zotero: Zotero.version, checks: [], failures: [], suites: {} };
  const assert = (ok, text) => { if (!ok) throw new Error(text); };
  const wait = async (fn, text) => {
    for (let i = 0; i < 200; i++) { if (await fn()) return; await Zotero.Promise.delay(100); }
    throw new Error(text);
  };
  const save = () => IOUtils.writeJSON(out, results);
  const check = async (name, fn) => {
    results.running = name; await save();
    try { await fn(); results.checks.push(name); }
    catch (error) { results.failures.push({ name, message: String(error), stack: error.stack }); }
    await save();
  };
  const suite = async (name, file, resultFile) => {
    results.running = name; await save();
    const scope = { Zotero, Services, ChromeUtils, IOUtils, PathUtils,
      TitleMerge: Centers.modules.merge, InlineExtra: Centers.modules.inline,
      Centers, Notes: Centers.modules.notes, Metrics: Centers.modules.metrics, Metadata: Centers.modules.metadata,
      TEST_ROOT, TEST_RESULT_PATH: PathUtils.join(TEST_ROOT, "test-results", resultFile) };
    Services.scriptloader.loadSubScript(Services.io.newFileURI(Zotero.File.pathToFile(
      PathUtils.join(TEST_ROOT, "tests", file))).spec, scope, "UTF-8");
    await scope.SuitePromise;
    const report = await IOUtils.readJSON(PathUtils.join(TEST_ROOT, "test-results", resultFile));
    results.suites[name] = { checks: report.checks, failures: report.failures, done: report.done, persisted: report.persisted };
    for (const text of report.checks) results.checks.push(`${name}: ${text}`);
    for (const error of report.failures) results.failures.push({ ...error, name: `${name}: ${error.name}` });
    await save();
  };
  try {
    await Zotero.uiReadyPromise;
    assert(Zotero.DataDirectory.dir.startsWith(PathUtils.join(TEST_ROOT, ".tools", "runs")), "Unsafe test data directory");
    const w = Zotero.getMainWindow(), doc = w.document, pane = w.ZoteroPane;
    w.resizeTo(1700, 1000);
    await Zotero.Libraries.userLibrary.waitForDataLoad("item");
    await wait(() => pane.itemsView?.tree, "Native item table missing");
    await pane.itemsView.waitForLoad();
    await check("One installed plugin initializes all modules", async () => {
      assert(doc.getElementById("global-search-input"), "Global search missing");
      assert(Centers.modules.inline.controllers.has(w), "Inline editing missing");
      assert(doc.getElementById("title-merge-tools"), "Merge tools missing");
      assert(Centers.modules.metrics.columnKey, "Index registration missing");
      assert(doc.getElementById("centers-metadata-toolbar"), "Metadata toolbar missing");
    });
    await suite("Title Merge", "suite-title-merge.js", "title-merge.json");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const zoplicate = await AddonManager.getAddonByID("zoplicate@chenglongma.com");
    if (zoplicate?.isActive) { await zoplicate.disable(); await Zotero.Promise.delay(150); }
    await suite("Inline Edit", "suite-inline-extra.js", "inline-extra.json");
    Centers.modules.inline.controllers.get(w)?.cancel();
    const metrics = Centers.modules.metrics;
    const makeCollection = async (name, parent = null, libraryID = Zotero.Libraries.userLibraryID) => {
      const c = new Zotero.Collection(); c.name = name; c.libraryID = libraryID;
      if (parent) c.parentID = parent.id;
      await c.saveTx(); return c;
    };
    const makeItem = async (title, collection, extra = "", type = "journalArticle") => {
      const item = new Zotero.Item(type); item.libraryID = collection.libraryID;
      item.setField("title", title); if (extra) item.setField("extra", extra);
      item.addToCollection(collection.id); await item.saveTx(); return item;
    };
    const parent = await makeCollection("Centers 计数父目录");
    const child = await makeCollection("Centers 计数子目录", parent);
    const sibling = await makeCollection("Centers 共享目录");
    const empty = await makeCollection("Centers 空目录");
    const a = await makeItem("Centers A", parent, "CentersSharedMarker");
    const b = await makeItem("Centers B", parent);
    const c = await makeItem("Centers C", parent);
    a.addToCollection(sibling.id); await a.saveTx();
    await makeItem("Centers child", child);
    const standalone = new Zotero.Item("note"); standalone.libraryID = parent.libraryID;
    standalone.setNote("<p>Standalone note does not count</p>"); standalone.addToCollection(parent.id); await standalone.saveTx();
    const note = new Zotero.Item("note"); note.libraryID = parent.libraryID; note.parentItemID = a.id;
    note.setNote("<p>CentersNoteMarker</p>"); await note.saveTx();
    const pdf = await Zotero.Attachments.importFromFile({ file: PathUtils.join(TEST_ROOT, "tests", "paper.pdf"), parentItemID: a.id });
    await pane.collectionsView.selectByID("C" + parent.id);
    await wait(() => pane.itemsView.getRowIndexByID(a.id) !== false, "Parent folder not displayed");
    const count = id => metrics.counts.get(id);
    const indexTexts = () => pane.itemsView._rows.map((row, i) => metrics.getIndex(w, i)).filter(Boolean);
    const docIDs = () => pane.getSortedItems().filter(item => item.isRegularItem() && item.isTopLevelItem()).map(item => item.id);
    await check("Collection counts include descendant documents and exclude attachments and notes", async () => {
      await wait(() => count(parent.id) === 4 && count(child.id) === 1 && count(sibling.id) === 1 && count(empty.id) === 0, "Wrong recursive folder counts");
      metrics.decorateCollections(w);
      const index = pane.collectionsView.getRowIndexByID("C" + parent.id);
      const row = doc.getElementById(pane.collectionsView.id + "-row-" + index);
      assert(row?.querySelector(".centers-collection-count")?.textContent === "(4)", "Recursive folder count not rendered");
      const badge = row.querySelector(".centers-collection-count").getBoundingClientRect();
      const label = row.querySelector(".cell-text").getBoundingClientRect();
      assert(badge.width > 0 && badge.left >= label.right && badge.left - label.right < 10, "Folder count is not adjacent to the name");
      assert(parent.name === "Centers 计数父目录", "Stored folder name was changed");
    });
    await check("My Library displays its total including unfiled records and deduplicates collection membership", async () => {
      const libraryID = Zotero.Libraries.userLibraryID;
      const expected = (await Zotero.Items.getAll(libraryID, true, false)).filter(item => item.isRegularItem() && !item.isFeedItem && !item.deleted).length;
      await wait(() => metrics.libraryCounts.get(libraryID) === expected, "Personal library total is wrong");
      const unfiled = new Zotero.Item("journalArticle"); unfiled.libraryID = libraryID;
      unfiled.setField("title", "Centers unfiled record"); await unfiled.saveTx();
      await wait(() => metrics.libraryCounts.get(libraryID) === expected + 1, "Unfiled reference not included");
      const left = await makeCollection("Centers library count A"), right = await makeCollection("Centers library count B");
      unfiled.addToCollection(left.id); unfiled.addToCollection(right.id); await unfiled.saveTx();
      await wait(() => count(left.id) === 1 && count(right.id) === 1, "Library fixture membership did not refresh");
      assert(metrics.libraryCounts.get(libraryID) === expected + 1, "Shared reference counted more than once");
      unfiled.deleted = true; await unfiled.saveTx();
      await wait(() => metrics.libraryCounts.get(libraryID) === expected, "Trashed reference still in library total");
      unfiled.deleted = false; unfiled.removeFromCollection(left.id); unfiled.removeFromCollection(right.id); await unfiled.saveTx();
      await wait(() => metrics.libraryCounts.get(libraryID) === expected + 1, "Restored unfiled reference not counted");
      await pane.collectionsView.selectByID("L" + libraryID);
      metrics.decorateCollections(w);
      const index = pane.collectionsView.getRowIndexByID("L" + libraryID);
      const root = doc.getElementById(pane.collectionsView.id + "-row-" + index);
      assert(root?.querySelector(".centers-collection-count")?.textContent === `(${expected + 1})`, "My Library total not in native sidebar");
      await pane.collectionsView.selectByID("C" + parent.id);
    });
    await check("Index is visible as the first column and starts at one", async () => {
      await wait(() => pane.itemsView.tree._columns._columns[0].dataKey === metrics.columnKey, "Index is not first");
      const columns = pane.itemsView.tree._columns._columns;
      assert(!columns[0].hidden && columns[0].label === "Index", "Index is hidden or mislabeled");
      assert(JSON.stringify(indexTexts()) === '["1","2","3"]', "Wrong initial indices: " + indexTexts());
      const cells = doc.querySelectorAll("#zotero-items-tree .centers-index-cell .cell-text");
      assert([...cells].some(cell => cell.textContent === "1"), "Index not in the real table DOM");
    });
    await check("Index numbers precede native item icons without overlapping tree controls", async () => {
      for (const item of [a, b, c]) {
        const index = pane.itemsView.getRowIndexByID(item.id);
        const cell = doc.getElementById(pane.itemsView.id + "-row-" + index)?.querySelector(".centers-index-cell");
        const number = cell?.querySelector(".cell-text")?.getBoundingClientRect();
        const icon = cell?.querySelector(".item-icon")?.getBoundingClientRect();
        const control = cell?.querySelector(".twisty, .spacer-twisty")?.getBoundingClientRect();
        assert(number?.width > 0 && icon?.width > 0 && control?.width > 0, "Index components are not visible");
        assert(control.right <= number.left && number.right < icon.left, "Index is not ordered control, number, icon");
        assert(icon.right <= cell.getBoundingClientRect().right, "Item icon is clipped");
      }
    });
    await check("Index renumbers after sorting and is not itself a sort key", async () => {
      const manager = pane.itemsView.tree._columns;
      const titleIndex = manager._columns.findIndex(column => column.dataKey === "title");
      const before = docIDs().join();
      const snapshot = () => ({ ids: docIDs(), sort: pane.itemsView.getSortField(), direction: pane.itemsView.getSortDirection(),
        native: pane.itemsView._getColumns().map(col => [col.dataKey,col.sortDirection]),
        table: manager._columns.map(col => [col.dataKey,col.sortDirection]) });
      results.sortTrace = [snapshot()];
      await manager.toggleSort(titleIndex);
      results.sortTrace.push(snapshot());
      // The initial order can already match title ascending even when another
      // column is the active sort key. A second native click reverses that order.
      if (docIDs().join() === before) await manager.toggleSort(titleIndex);
      results.sortTrace.push(snapshot()); await save();
      await wait(() => docIDs().join() !== before, "Native sort did not change order");
      assert(pane.itemsView.getSortField() === "title", "Native title sort was replaced");
      assert(JSON.stringify(indexTexts()) === '["1","2","3"]', "Indices did not follow the new sort");
      for (const item of [a, b, c]) {
        const index = pane.itemsView.getRowIndexByID(item.id);
        const node = doc.getElementById(pane.itemsView.id + "-row-" + index);
        assert(node?.querySelector(".centers-index-cell .cell-text")?.textContent === metrics.getIndex(w, index), "Rendered Index did not follow the sort");
      }
      await wait(() => metrics.windows.get(w)?.manager === pane.itemsView.tree._columns, "Index controls did not settle");
      const currentManager = pane.itemsView.tree._columns;
      const indexColumn = currentManager._columns.findIndex(column => column.dataKey === metrics.columnKey);
      assert(indexColumn >= 0, "Index disappeared after sorting");
      const sort = pane.itemsView.getSortField();
      await currentManager.toggleSort(indexColumn);
      assert(pane.itemsView.getSortField() === sort, "Index was used as a sort key");
    });
    await check("Expanded child items have no number and do not consume an index", async () => {
      const index = pane.itemsView.getRowIndexByID(a.id);
      const clickTwisty = () => {
        const twisty = doc.getElementById(pane.itemsView.id + "-row-" + index)?.querySelector(".centers-index-cell > .twisty");
        const rect = twisty?.getBoundingClientRect();
        assert(rect?.width > 0 && rect.height > 0, "Native expansion arrow is missing");
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        w.windowUtils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
        w.windowUtils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
      };
      if (pane.itemsView.isContainerOpen(index)) {
        clickTwisty();
        await wait(() => !pane.itemsView.isContainerOpen(index), "Native arrow did not collapse children");
      }
      clickTwisty();
      await wait(() => pane.getSortedItems().some(item => item.id === pdf.id), "PDF child not expanded");
      for (let i = 0; i < pane.itemsView._rows.length; i++) {
        if (pane.itemsView.getRow(i).ref?.parentItemID) assert(metrics.getIndex(w, i) === "", "Child got an index");
      }
      assert(indexTexts().join() === "1,2,3", "Expanded children shifted document indices");
      clickTwisty();
      await wait(() => !pane.itemsView.isContainerOpen(index), "Native arrow did not collapse children");
      assert(!pane.getSortedItems().some(item => item.id === pdf.id), "Collapsed PDF is still visible");
    });
    await check("Native filtering restarts Index at one without changing folder count", async () => {
      doc.getElementById("zotero-tb-search").searchTextbox.value = "Centers B";
      await pane.search();
      assert(docIDs().length === 1 && indexTexts().join() === "1", "Filtered view has wrong indices");
      assert(count(parent.id) === 4, "Folder count followed the transient search filter");
      await pane.clearQuicksearch();
    });
    await check("Folder counters refresh after a document is moved between folders", async () => {
      b.removeFromCollection(parent.id); b.addToCollection(child.id); await b.saveTx();
      await wait(() => count(parent.id) === 4 && count(child.id) === 2, "Moving within a subtree changed its total");
      assert(indexTexts().join() === "1,2", "Index did not follow membership removal");
    });
    await check("Trash and restore update all affected folder counts", async () => {
      a.deleted = true; await a.saveTx();
      await wait(() => count(parent.id) === 3 && count(sibling.id) === 0, "Trashed item still counted");
      a.deleted = false; await a.saveTx();
      await wait(() => count(parent.id) === 4 && count(sibling.id) === 1, "Restored item not counted");
    });
    await check("Native merge updates the folder count and keeps a single document index", async () => {
      const x = await makeItem("Centers merge check", parent);
      const y = await makeItem("Centers merge check", parent, "", "preprint");
      await wait(() => count(parent.id) === 6, "New references not counted");
      const report = await Centers.modules.merge.engine.run(await Centers.modules.merge.engine.scan([x, y]));
      assert(!report.errors.length && report.completed.length === 1, "Merge failed");
      await wait(() => count(parent.id) === 5, "Counter did not follow merge");
      assert(indexTexts().join() === "1,2,3", "Indices did not follow merge");
    });
    const group = new Zotero.Group(); group.id = 9812010; group.name = "Centers 测试群组";
    group.description = "Isolated integration fixture";
    group.version = 1; group.editable = true; group.filesEditable = true; await group.saveTx();
    const groupFolder = await makeCollection("Centers 群组目录", null, group.libraryID);
    const groupItem = await makeItem("Centers group record", groupFolder, "CentersSharedMarker");
    await check("Group-library folders get independent document counters", async () => {
      await wait(() => count(groupFolder.id) === 1, "Group folder count missing");
      await wait(() => metrics.libraryCounts.get(group.libraryID) === 1, "Group library total missing or mixed with personal library");
    });
    const search = Centers.modules.search;
    await pane.collectionsView.selectByID("C" + parent.id);
    const searchUI = async text => {
      const input = doc.getElementById("global-search-input"); input.value = text;
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
      await wait(() => !input.hasAttribute("aria-busy") && /篇$/.test(doc.querySelector(".global-search-status").textContent), "Search UI timed out");
    };
    await check("Integrated global search finds metadata and child notes", async () => {
      assert((await search.engine.search(w, "CentersNoteMarker")).some(result => result.id === a.id), "Child note search missing");
      await searchUI("CentersSharedMarker");
      assert(docIDs().includes(a.id) && docIDs().includes(groupItem.id) && docIDs().length === 2, "Cross-library search failed");
      assert(indexTexts().join() === "1,2", "Cross-library headers changed the sequence");
      assert(pane.getSelectedLibraryIDs().length === 2, "Native cross-library context missing");
    });
    await check("Global search retains native quick-search refinement and sequential Index", async () => {
      doc.getElementById("zotero-tb-search").searchTextbox.value = "Centers group record";
      await pane.search();
      assert(docIDs().join() === String(groupItem.id) && indexTexts().join() === "1", "Native refinement or Index failed");
      doc.getElementById("zotero-tb-search").searchTextbox.value = ""; await pane.search();
    });
    await check("Global-search results still allow inline editing and refresh the search index", async () => {
      const inline = Centers.modules.inline.controllers.get(w);
      assert(await inline.open(a, pane.itemsView, "shortTitle"), "Inline editor missing in search results");
      inline.editor.input.value = "Centers edited shortcut"; assert(await inline.finish(false), "Inline save failed");
      assert((await search.engine.search(w, "Centers edited shortcut")).some(result => result.id === a.id), "Edited value not searchable");
      await search.clear(search.windows.get(w));
      assert(pane.getCollectionTreeRows()[0].id === "C" + parent.id, "Search did not restore the prior directory");
    });
    await check("Integrated inline Extra editing remains available next to Index", async () => {
      const inline = Centers.modules.inline.controllers.get(w);
      assert(await inline.open(a, pane.itemsView, "extra"), "Extra editor missing");
      inline.editor.input.value = "Centers combined note"; assert(await inline.finish(false), "Extra save failed");
      assert(a.getField("shortTitle") === "Centers edited shortcut" && a.getField("extra") === "Centers combined note", "Fields were mixed");
    });
    let grandchild, deepItem;
    await check("Recursive totals include every depth and deduplicate shared collection membership", async () => {
      grandchild = await makeCollection("Centers 深层目录", child);
      deepItem = await makeItem("Centers deep record", grandchild);
      await wait(() => count(parent.id) === 6 && count(child.id) === 3 && count(grandchild.id) === 1, "Deep references were not accumulated");
      deepItem.addToCollection(child.id); deepItem.addToCollection(parent.id); await deepItem.saveTx();
      const emptyDescendant = await makeCollection("Centers 无文献子目录", grandchild);
      await wait(() => count(emptyDescendant.id) === 0, "Empty folder not counted");
      assert(count(parent.id) === 6 && count(child.id) === 3 && count(grandchild.id) === 1, "Folders or overlapping references were counted twice");
      const onlyDescendants = await makeCollection("Centers 仅子目录含文献");
      const nested = await makeCollection("Centers 文献子目录", onlyDescendants);
      await makeItem("Centers descendant one", nested); await makeItem("Centers descendant two", nested);
      await wait(() => count(onlyDescendants.id) === 2 && count(nested.id) === 2, "Parent without direct references did not show its descendants' documents");
    });
    await check("Moving a nested folder refreshes old and new ancestors", async () => {
      deepItem.removeFromCollection(parent.id); deepItem.removeFromCollection(child.id); await deepItem.saveTx();
      grandchild.parentID = sibling.id; await grandchild.saveTx();
      await wait(() => count(parent.id) === 5 && count(child.id) === 2 && count(sibling.id) === 2 && count(grandchild.id) === 1, "Ancestor totals did not follow the moved subtree");
    });
    const info = { id: Centers.id, version: Centers.version, rootURI: Centers.rootURI };
    await suite("Editable Notes", "suite-notes.js", "notes.json");
    await suite("Metadata", "suite-metadata.js", "metadata.json");
    await check("Disable cleans up all combined features and re-enable restores one copy", async () => {
      await Centers.shutdown(false);
      assert(!doc.getElementById("global-search-input") && !doc.getElementById("title-merge-tools")
        && !doc.getElementById("centers-metadata-toolbar") && !doc.querySelector(".centers-collection-count"), "Combined UI not removed");
      await Centers.init(info); Centers.addToWindow(w);
      await wait(() => doc.querySelectorAll("#global-search-input").length === 1 && Centers.modules.metrics.columnKey, "Features not restored");
      assert(doc.querySelectorAll("#centers-metadata-toolbar").length === 1, "Metadata toolbar not restored");
      const persistedNote = results.suites["Editable Notes"].persisted;
      assert(persistedNote, "No saved note to check after re-enable");
      const noteParent = await Zotero.Items.getAsync(persistedNote.id);
      await wait(() => Centers.modules.notes.getValue(noteParent) === persistedNote.value, "Notes did not persist across disable and re-enable");
      results.lifecycleReady = true;
    });
    await check("Installing Centers pauses three real legacy addons and disabling restores them", async () => {
      await Centers.shutdown(false);
      for (const name of ["global-search", "inline-extra", "title-merge"]) {
        const install = await AddonManager.getInstallForFile(Zotero.File.pathToFile(PathUtils.join(TEST_ROOT, ".cache", name + ".xpi")));
        await install.install();
      }
      await wait(async () => (await Promise.all(Centers.legacyIDs.map(id => AddonManager.getAddonByID(id)))).every(addon => addon?.isActive), "Legacy addons not active");
      await Centers.init(info); Centers.addToWindow(w);
      assert((await Promise.all(Centers.legacyIDs.map(id => AddonManager.getAddonByID(id)))).every(addon => !addon.isActive), "Legacy addons not paused");
      assert(doc.querySelectorAll("#global-search-input").length === 1, "Duplicate search boxes");
      await Centers.shutdown(true);
      await wait(async () => (await Promise.all(Centers.legacyIDs.map(id => AddonManager.getAddonByID(id)))).every(addon => addon.isActive), "Legacy addons not restored");
      await Centers.init(info); Centers.addToWindow(w);
      results.migrationReady = true;
    });
  }
  catch (error) { results.failures.push({ name: "runner", message: String(error), stack: error.stack }); }
  results.done = true; delete results.running; await save();
})();
