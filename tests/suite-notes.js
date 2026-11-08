/* Real note data, native mouse interaction, merge and conflict checks in the isolated profile. */
var SuitePromise = (async () => {
  const report = { checks: [], failures: [] };
  const w = Zotero.getMainWindow(), doc = w.document, pane = w.ZoteroPane;
  const assert = (ok, text) => { if (!ok) throw new Error(text); };
  const wait = async (fn, text) => {
    for (let i = 0; i < 160; i++) { if (await fn()) return; await Zotero.Promise.delay(50); }
    throw new Error(text);
  };
  const check = async (name, fn) => {
    report.running = name; await IOUtils.writeJSON(TEST_RESULT_PATH, report);
    try { await fn(); report.checks.push(name); }
    catch (error) { report.failures.push({ name, message: String(error), stack: error.stack }); }
    await IOUtils.writeJSON(TEST_RESULT_PATH, report);
  };
  const controller = () => InlineExtra.controllers.get(w);
  const view = () => pane.itemsView;
  const cell = item => controller().cellFor(item, view(), "centersNote");
  const key = (name, extra = {}) => controller().editor.input.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra }));
  const edit = async (item, value) => {
    assert(await controller().open(item, view(), "centersNote"), "Note editor missing");
    controller().editor.input.value = value;
    assert(await controller().finish(false), "Note did not save");
    await wait(() => Notes.getValue(item) === value, "Note cache did not refresh");
  };
  try {
    const collection = new Zotero.Collection(); collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = "Centers 可编辑笔记列"; await collection.saveTx();
    const make = async (title, type = "journalArticle") => {
      const item = new Zotero.Item(type); item.libraryID = collection.libraryID;
      item.setField("title", title); item.setField("extra", "Preserve Extra"); item.setField("shortTitle", "Preserve short title");
      item.addToCollection(collection.id); await item.saveTx(); return item;
    };
    const a = await make("Notes A"), b = await make("Notes B"), c = await make("Notes C");
    const ordinary = new Zotero.Item("note"); ordinary.libraryID = a.libraryID; ordinary.parentItemID = a.id;
    ordinary.setNote("<p>Existing ordinary note</p>"); await ordinary.saveTx();
    await pane.collectionsView.selectByID("C" + collection.id);
    await view().waitForLoad();
    await wait(() => !!cell(a), "Notes column not rendered");
    const manager = view().tree._columns;
    const publicationIndex = manager._columns.findIndex(column => column.dataKey === "publicationTitle");
    if (manager._columns[publicationIndex].hidden) manager.toggleHidden(publicationIndex);
    await Zotero.Promise.delay(100);
    await check("Notes column is visible after Publication and starts empty even with ordinary child notes", async () => {
      const columns = view().tree._columns._columns;
      const index = columns.findIndex(column => column.dataKey === Metrics.noteColumnKey);
      assert(index === columns.findIndex(column => column.dataKey === "publicationTitle") + 1, "Notes column is not after Publication");
      assert(!columns[index].hidden && columns[index].label === "笔记", "Notes column hidden or mislabeled");
      assert(Notes.getValue(a) === "" && cell(a).textContent === "", "Existing native notes were imported into the new column");
      assert((await Notes.query(a.id)).length === 0, "Empty column created a note");
    });
    await check("Native mouse click opens an empty Notes cell and cancel creates no note", async () => {
      await view().selectItems([b.id]);
      const bounds = controller().bounds(cell(a));
      const x = bounds.left + Math.min(12, bounds.width / 2), y = bounds.top + bounds.height / 2;
      w.windowUtils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      await Zotero.Promise.delay(50);
      w.windowUtils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
      await wait(() => controller().editor?.item.id === a.id, "Native mouse click did not open Notes");
      assert(controller().editor.field === "centersNote" && controller().editor.input.value === "", "Wrong editor value");
      controller().cancel();
      assert((await Notes.query(a.id)).length === 0, "Opening and cancelling created a note");
    });
    const original = "研究笔记：待验证\n<b>这是文字</b> & 中文";
    await check("Multiline Notes persist as a tagged native child note without modifying bibliographic fields", async () => {
      await edit(a, original);
      const rows = await Notes.query(a.id); assert(rows.length === 1, "Wrong number of managed notes");
      const note = await Zotero.Items.getAsync(rows[0].id);
      assert(note.parentItemID === a.id && note.libraryID === a.libraryID && note.hasTag("zotero-centers-note"), "Note ownership or marker wrong");
      assert(note.getNote().includes("&lt;b&gt;") && note.toJSON().note, "Plain input was interpreted as HTML or not serialized");
      assert(a.getField("extra") === "Preserve Extra" && a.getField("shortTitle") === "Preserve short title", "Notes changed an existing field");
      assert(ordinary.getNote().includes("Existing ordinary note") && !ordinary.deleted, "Ordinary note changed");
      await wait(() => cell(a)?.textContent === original, "Saved text not rendered in the native table");
    });
    await check("Notes Escape, Shift+Enter and IME confirmation preserve the saved value", async () => {
      await controller().open(a, view(), "centersNote");
      controller().editor.input.value = "Discard this draft";
      key("Enter", { shiftKey: true }); key("Enter", { isComposing: true });
      assert(controller().editor && Notes.getValue(a) === original, "IME or multiline Enter saved early");
      key("Escape");
      assert(!controller().editor && Notes.getValue(a) === original, "Escape saved the draft");
    });
    await check("Notes Enter saves and participates in native undo and redo", async () => {
      await controller().open(a, view(), "centersNote");
      controller().editor.input.value = "Saved with Enter"; key("Enter");
      await wait(() => !controller().editor && Notes.getValue(a) === "Saved with Enter", "Enter did not save");
      await Zotero.UndoHistory.undo(); await Notes.refresh();
      await wait(() => Notes.getValue(a) === original, "Native undo did not restore the previous note");
      await Zotero.UndoHistory.redo(); await Notes.refresh();
      await wait(() => Notes.getValue(a) === "Saved with Enter", "Native redo did not restore the edit");
    });
    await check("Notes Tab saves and moves to the next paper in the same column", async () => {
      const ordered = pane.getSortedItems().filter(item => item.isRegularItem());
      await controller().open(ordered[0], view(), "centersNote");
      controller().editor.input.value = "Saved with Tab"; key("Tab");
      await wait(() => controller().editor?.item.id === ordered[1].id, "Tab did not reach the next paper");
      assert(controller().editor.field === "centersNote", "Tab changed the editable field");
      assert(Notes.getValue(ordered[0]) === "Saved with Tab", "Tab lost the previous value");
      controller().cancel();
    });
    await check("Notes blur saves and clearing leaves a blank column without duplicate notes", async () => {
      await controller().open(b, view(), "centersNote");
      controller().editor.input.value = "Saved on blur";
      // Hidden Windows test windows do not reliably dispatch focusout from
      // focus() alone. Exercise the same event as the existing Extra suite.
      controller().editor.input.dispatchEvent(new w.FocusEvent("focusout", { bubbles: true }));
      doc.getElementById(view().id).focus();
      await wait(() => !controller().editor && Notes.getValue(b) === "Saved on blur", "Blur did not save");
      await edit(b, ""); assert((await Notes.query(b.id)).length === 1, "Clearing duplicated the managed note");
      await edit(b, "Refilled note"); assert((await Notes.query(b.id)).length === 1, "Refilling created a duplicate note");
    });
    await check("External native-note edits trigger a conflict and retain the column draft", async () => {
      await controller().open(a, view(), "centersNote"); controller().editor.input.value = "Keep my unsaved draft";
      const note = await Zotero.Items.getAsync((await Notes.query(a.id))[0].id);
      note.setNote("<p>Changed outside the column</p>"); await note.saveTx();
      assert(!await controller().finish(false), "Concurrent native-note change was overwritten");
      assert(controller().editor.input.value === "Keep my unsaved draft" && !controller().editor.error.hidden, "Conflict discarded the draft");
      assert(note.getNote().includes("Changed outside the column"), "External note was lost");
      controller().cancel();
    });
    await check("A failed Notes write rolls back cached note data and retains a retryable draft", async () => {
      await controller().open(a, view(), "centersNote"); controller().editor.input.value = "Retry this note";
      const note = await Zotero.Items.getAsync((await Notes.query(a.id))[0].id), realSave = note.save;
      note.save = async () => { throw new Error("Injected note save failure"); };
      try { assert(!await controller().finish(false), "Injected note failure was ignored"); }
      finally { note.save = realSave; }
      assert(controller().editor?.input.value === "Retry this note", "Failed write discarded draft");
      assert(note.getNote().includes("Changed outside the column"), "Failed write polluted the cached note");
      assert(await controller().finish(false), "Retry failed");
      await wait(() => Notes.getValue(a) === "Retry this note", "Retry not persisted");
    });
    await check("Notes are searchable through integrated global search", async () => {
      await edit(a, "CentersEditableNoteLookup");
      const found = await Centers.modules.search.engine.search(w, "CentersEditableNoteLookup");
      assert(found.some(result => result.id === a.id), "Managed note not found by global search");
    });
    await check("Read-only papers, trash, attachments and native note rows cannot edit the Notes column", async () => {
      assert(!InlineExtra.canEdit(ordinary, "centersNote"), "Native note accepted as parent");
      // Native undo can replace cached item objects. Persist the trash operation
      // on the current object instead of mutating an obsolete pre-undo reference.
      const current = Zotero.Items.get(a.id);
      current.deleted = true; await current.saveTx();
      try { assert(!InlineExtra.canEdit(current, "centersNote"), "Trash accepted"); }
      finally { current.deleted = false; await current.saveTx(); }
      const realEditable = current.isEditable; current.isEditable = () => false;
      try { assert(!InlineExtra.canEdit(current, "centersNote"), "Read-only item accepted"); }
      finally { current.isEditable = realEditable; }
      const attachment = await Zotero.Attachments.linkFromURL({ url: "https://example.org/notes-test", parentItemID: current.id, title: "Notes test link" });
      assert(!InlineExtra.canEdit(attachment, "centersNote"), "Attachment accepted as a note parent");
    });
    await check("Same-title merge preserves both Notes values and editing retains original child-note copies", async () => {
      const master = await make("Notes merge example"), source = await make("Notes merge example", "preprint");
      await edit(master, "Journal note"); await edit(source, "Preprint note");
      const sourceNote = await Zotero.Items.getAsync((await Notes.query(source.id))[0].id);
      const merged = await TitleMerge.engine.run(await TitleMerge.engine.scan([master, source]));
      assert(!merged.errors.length && merged.completed.length === 1, "Merge failed");
      await Notes.refresh();
      await wait(() => Notes.getValue(master) === "Journal note\n\nPreprint note", "Merged note values not both displayed");
      assert(sourceNote.parentItemID === master.id && !sourceNote.deleted, "Source note was lost during merge");
      await edit(master, "Combined edited note");
      assert(sourceNote.getNote().includes("Preprint note") && !sourceNote.deleted, "Editing the combined value deleted the original note");
      assert((await Notes.query(master.id)).length === 1, "Combined value duplicated on reopening");
      report.persisted = { id: master.id, value: "Combined edited note" };
    });
    await check("Editable group-library papers save Notes in the correct library", async () => {
      const library = Zotero.Libraries.getAll().find(library => library.libraryType === "group" && library.editable);
      const item = (await Zotero.Items.getAll(library.libraryID, true, false)).find(item => item.isRegularItem());
      await pane.collectionsView.selectByID("L" + library.libraryID);
      await edit(item, "Group library note");
      const note = await Zotero.Items.getAsync((await Notes.query(item.id))[0].id);
      assert(note.libraryID === library.libraryID && note.parentItemID === item.id, "Group note saved to the wrong library");
      await pane.collectionsView.selectByID("C" + collection.id);
    });
  }
  catch (error) { report.failures.push({ name: "Notes setup", message: String(error), stack: error.stack }); }
  finally { controller()?.cancel(); report.done = true; delete report.running; await IOUtils.writeJSON(TEST_RESULT_PATH, report); }
})();
