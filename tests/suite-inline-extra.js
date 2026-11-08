/* Runs only from the staging plugin in scripts/prepare-test.py's fresh profile. */
var SuitePromise = (async () => {
  const results = { zotero: Zotero.version, checks: [], failures: [] };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const delay = ms => Zotero.Promise.delay(ms);
  const until = async (fn, message) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await delay(50); }
    throw new Error(message);
  };
  const check = async (name, fn) => {
    try { await fn(); results.checks.push(name); }
    catch (error) { results.failures.push({ name, message: String(error), stack: error.stack }); }
    await IOUtils.writeJSON(TEST_RESULT_PATH, results);
  };
  try {
    await Zotero.uiReadyPromise;
    const w = Zotero.getMainWindow();
    const doc = w.document;
    const controller = InlineExtra.controllers.get(w);
    assert(controller, 'No main-window controller');
    await Zotero.Libraries.get(Zotero.Libraries.userLibraryID).waitForDataLoad('item');
    await until(() => w.ZoteroPane.itemsView?.tree, 'Initial item table not mounted');
    const collection = new Zotero.Collection();
    collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = 'Inline Extra 插件测试（独立库）';
    await collection.saveTx();
    const makeItem = async (title, extra = '') => {
      const item = new Zotero.Item('journalArticle');
      item.libraryID = collection.libraryID;
      item.setField('title', title); item.setField('extra', extra);
      item.setField('DOI', '10.1000/inline-test');
      item.setField('publicationTitle', 'Test Journal');
      item.setField('date', '2026');
      item.addToCollection(collection.id); await item.saveTx();
      return item;
    };
    const a = await makeItem('A · 单击“其他”即可编辑', '原有内容\n第二行');
    const b = await makeItem('B · 空白单元格同样支持编辑');
    const c = await makeItem('C · Enter 保存，Esc 取消', '保留 DOI、笔记和附件');
    a.setField('shortTitle', '原有短标题'); await a.saveTx();
    await w.ZoteroPane.collectionsView.selectByID('C' + collection.id);
    await until(() => w.ZoteroPane.itemsView?.tree && w.ZoteroPane.itemsView.getRowIndexByID(a.treeViewID) !== false,
      'Test collection not displayed');
    const view = w.ZoteroPane.itemsView;
    for (const field of ['extra', 'shortTitle']) {
      const columns = view.tree._columns._columns;
      const index = columns.findIndex(col => col.dataKey === field);
      assert(index >= 0, field + ' column missing');
      if (columns[index].hidden) view.tree._columns.toggleHidden(index);
      await delay(50);
    }
    await delay(200);
    const cell = (item, field = 'extra') => controller.cellFor(item, view, field);
    const click = async (item, options = {}, field = 'extra') => {
      const target = cell(item, field); assert(target, 'Cell not rendered');
      target.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options }));
      await controller.queue;
    };
    const key = (keyName, options = {}) => controller.editor.input.dispatchEvent(
      new w.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...options }));
    const closed = () => until(() => !controller.editor, 'Editor did not close');
    const persisted = async (item, field = 'extra') => {
      await item.reload(['itemData'], true);
      return item.getField(field) || '';
    };
    const nativeClick = async (item, rerender = false, field = 'extra') => {
      const oldCell = cell(item, field);
      assert(oldCell, 'Native click cell not rendered');
      const rect = controller.bounds(oldCell);
      const x = rect.left + Math.min(12, rect.width / 2), y = rect.top + rect.height / 2;
      w.windowUtils.sendMouseEvent('mousedown', x, y, 0, 1, 0);
      await delay(50);
      if (rerender) {
        view.tree.invalidateRow(view.getRowIndexByID(item.treeViewID));
        await delay(50);
        assert(!oldCell.isConnected, 'Regression fixture did not replace the cell');
      }
      w.windowUtils.sendMouseEvent('mouseup', x, y, 0, 1, 0);
      await delay(1000); await controller.queue;
    };
    await check('Gecko mouse down/up opens Extra on an unselected row', async () => {
      await view.selectItems([b.id]);
      const trace = [];
      const record = event => {
        const hit = controller.hit(event.target, event);
        trace.push({ type: event.type, target: event.target.className, trusted: event.isTrusted,
          item: hit?.item.id, down: controller.mouseDown?.item.id, editor: controller.editor?.item.id,
          x: event.clientX, y: event.clientY, bounds: controller.bounds(cell(a)), active: doc.activeElement?.id });
      };
      for (const type of ['mousedown', 'mouseup', 'click', 'blur']) doc.addEventListener(type, record, true);
      try {
        await nativeClick(a);
        results.nativeMouseTrace = trace;
        assert(controller.editor?.item.id === a.id, 'Native mouse click did not open Extra: ' + JSON.stringify(trace));
        controller.cancel();
      } finally {
        for (const type of ['mousedown', 'mouseup', 'click', 'blur']) doc.removeEventListener(type, record, true);
      }
    });
    await check('Gecko mouse down/up also opens an already selected row', async () => {
      await view.selectItems([a.id]);
      await nativeClick(a);
      assert(controller.editor?.item.id === a.id, 'Selected-row mouse click failed');
      assert(doc.activeElement === controller.editor.input, 'Input focus stolen by row mouseup');
      controller.cancel();
    });
    await check('Gecko mouse down/up opens an empty Extra cell', async () => {
      await nativeClick(b);
      assert(controller.editor?.item.id === b.id && controller.editor.input.value === '', 'Empty native cell failed');
      assert(controller.editor.panel.style.left && controller.editor.panel.style.top, 'Empty cell editor not anchored');
      controller.cancel();
    });
    await check('Mouse editing survives explicit DOM replacement between down and up', async () => {
      await view.selectItems([b.id]);
      await nativeClick(a, true);
      assert(controller.editor?.item.id === a.id, 'Rerendered-cell mouse click failed');
      controller.cancel();
    });
    await check('Click opens the correct real Extra cell with the full multiline value', async () => {
      await click(a);
      assert(controller.editor?.item.id === a.id, 'Wrong item');
      assert(controller.editor.input.value === '原有内容\n第二行', 'Multiline value truncated');
      assert(doc.activeElement === controller.editor.input, 'Input did not receive focus');
      const r = controller.editor.panel.getBoundingClientRect();
      assert(r.width > 150 && r.height > 30, 'Editor has no layout');
    });
    await check('Escape cancels without modifying the database', async () => {
      controller.editor.input.value = '不应该保存'; key('Escape');
      assert(!controller.editor, 'Escape did not close');
      assert(await persisted(a) === '原有内容\n第二行', 'Escape persisted draft');
    });
    await check('Enter saves Chinese multiline text through Zotero and refreshes the table', async () => {
      await click(a); controller.editor.input.value = '研究备注：待阅读\nCitation Key: example2026';
      key('Enter'); await closed();
      assert(await persisted(a) === '研究备注：待阅读\nCitation Key: example2026', 'Value not persisted');
      assert(cell(a).textContent.includes('研究备注'), 'Table not refreshed');
      assert(a.getField('DOI') === '10.1000/inline-test', 'Unrelated DOI changed');
    });
    await check('Saved edits participate in Zotero native undo and redo', async () => {
      assert(Zotero.UndoHistory.canUndo(), 'Undo unavailable');
      await Zotero.UndoHistory.undo();
      assert(await persisted(a) === '原有内容\n第二行', 'Undo failed');
      await Zotero.UndoHistory.redo();
      assert((await persisted(a)).includes('研究备注'), 'Redo failed');
    });
    await check('Empty Extra cells can be filled and cleared', async () => {
      await click(b); controller.editor.input.value = '空白也能编辑';
      assert(await controller.finish(false), 'Save failed');
      assert(await persisted(b) === '空白也能编辑', 'Empty cell not saved');
      await click(b); controller.editor.input.value = '';
      assert(await controller.finish(false), 'Clear failed');
      assert(await persisted(b) === '', 'Field not cleared');
    });
    await check('Shift+Enter and IME confirmation Enter do not submit', async () => {
      await click(a);
      const e = controller.editor;
      const shift = new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
      e.input.dispatchEvent(shift);
      assert(!shift.defaultPrevented && controller.editor === e, 'Shift+Enter submitted');
      key('Enter', { isComposing: true });
      assert(controller.editor === e, 'IME Enter submitted');
      key('Enter', { keyCode: 229 });
      assert(controller.editor === e, 'Legacy IME Enter submitted');
      controller.cancel();
    });
    await check('Tab saves and opens the next item; Shift+Tab returns', async () => {
      await click(a); controller.editor.input.value = 'Tab 保存'; key('Tab');
      await controller.queue;
      assert(controller.editor?.item.id === b.id, 'Tab did not reach next item');
      assert(await persisted(a) === 'Tab 保存', 'Tab did not save');
      key('Tab', { shiftKey: true }); await controller.queue;
      assert(controller.editor?.item.id === a.id, 'Shift+Tab did not return');
      controller.cancel();
    });
    await check('Clicking another cell commits only the previous item before switching', async () => {
      await click(a); controller.editor.input.value = '切换时保存'; await click(b);
      assert(await persisted(a) === '切换时保存', 'Previous draft not saved');
      assert(controller.editor?.item.id === b.id, 'Wrong target after switch');
      assert(await persisted(b) === '', 'New target overwritten'); controller.cancel();
    });
    await check('Clicking outside and losing focus save drafts', async () => {
      await click(b); controller.editor.input.value = '外部点击保存';
      doc.documentElement.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
      await closed(); assert(await persisted(b) === '外部点击保存', 'Outside click lost draft');
      await click(b); controller.editor.input.value = '失焦保存';
      controller.editor.input.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
      doc.getElementById(view.id).focus();
      await closed(); assert(await persisted(b) === '失焦保存', 'Blur lost draft');
    });
    await check('Concurrent changes are rejected and the draft remains available', async () => {
      await click(a); const e = controller.editor; e.input.value = '本地草稿';
      a.setField('extra', '外部新值'); await a.saveTx();
      assert(!await controller.finish(false), 'Conflict overwritten');
      assert(controller.editor === e && e.input.value === '本地草稿', 'Draft lost');
      assert(!e.error.hidden && await persisted(a) === '外部新值', 'Conflict not retained'); controller.cancel();
    });
    await check('Database write failure retains input and can be retried', async () => {
      await click(b); const original = b.getField('extra');
      controller.editor.input.value = '重试成功';
      const originalSave = b.save;
      try {
        b.save = async () => { throw new Error('injected database failure'); };
        assert(!await controller.finish(false), 'Injected failure ignored');
      } finally { b.save = originalSave; }
      assert(await persisted(b) === original, 'Failed write altered database');
      assert(controller.editor?.input.value === '重试成功', 'Failed write lost draft');
      assert(await controller.finish(false), 'Retry failed');
      assert(await persisted(b) === '重试成功', 'Retry not persisted');
    });
    await check('Read-only items, attachments, notes, and trash cannot be edited', async () => {
      const editable = a.isEditable;
      try { a.isEditable = () => false; assert(!await controller.open(a, view), 'Read-only item opened'); }
      finally { a.isEditable = editable; }
      const note = new Zotero.Item('note'); note.libraryID = a.libraryID;
      note.setNote('<p>test</p>'); await note.saveTx();
      assert(!InlineExtra.canEdit(note), 'Note editable');
      const attachment = new Zotero.Item('attachment');
      assert(!InlineExtra.canEdit(attachment), 'Attachment editable');
      c.deleted = true; await c.saveTx();
      assert(!InlineExtra.canEdit(c), 'Trash editable');
      c.deleted = false; await c.saveTx();
    });
    await check('Modified clicks preserve selection gestures; other columns do not open the editor', async () => {
      await click(a, { ctrlKey: true }); assert(!controller.editor, 'Ctrl+click opened');
      await click(a, { shiftKey: true }); assert(!controller.editor, 'Shift+click opened');
      const titleCell = doc.getElementById(view.id + '-row-' + view.getRowIndexByID(a.treeViewID)).querySelector('.cell.title');
      titleCell.dispatchEvent(new w.MouseEvent('click', { bubbles: true, button: 0 }));
      assert(!controller.editor, 'Title click opened Extra');
    });
    await check('F2 opens the selected item Extra field', async () => {
      await view.selectItems([a.id]);
      doc.getElementById(view.id).dispatchEvent(new w.KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
      await controller.queue; assert(controller.editor?.item.id === a.id, 'F2 failed'); controller.cancel();
    });
    await check('Native Short Title click opens a single-line editor with the original value', async () => {
      await nativeClick(a, false, 'shortTitle');
      assert(controller.editor?.field === 'shortTitle' && controller.editor.item.id === a.id, 'Wrong field');
      assert(controller.editor.input.localName === 'input' && controller.editor.input.value === '原有短标题', 'Wrong input');
      assert(controller.editor.input.getAttribute('aria-label') === '短标题', 'Wrong accessible label');
      controller.cancel();
    });
    await check('Native empty Short Title click survives cell replacement', async () => {
      await nativeClick(b, true, 'shortTitle');
      assert(controller.editor?.field === 'shortTitle' && controller.editor.input.value === '', 'Empty short title failed');
      assert(controller.editor.panel.style.left && controller.editor.panel.style.top, 'Short title editor not anchored');
      controller.cancel();
    });
    await check('Short Title saves, cancels, and clears without modifying title or Extra', async () => {
      const title = a.getField('title'), extra = a.getField('extra');
      await click(a, {}, 'shortTitle'); controller.editor.input.value = 'AlphaGenome 简称';
      key('Enter'); await closed();
      assert(await persisted(a, 'shortTitle') === 'AlphaGenome 简称', 'Short title not saved');
      assert(cell(a, 'shortTitle').textContent.includes('AlphaGenome'), 'Short title table not refreshed');
      await click(a, {}, 'shortTitle'); controller.editor.input.value = '取消的短标题'; key('Escape');
      assert(await persisted(a, 'shortTitle') === 'AlphaGenome 简称', 'Escape persisted short title');
      await click(a, {}, 'shortTitle'); controller.editor.input.value = ''; await controller.finish(false);
      assert(await persisted(a, 'shortTitle') === '', 'Short title not cleared');
      assert(a.getField('title') === title && a.getField('extra') === extra, 'Another field was changed');
    });
    await check('Switching columns on the same item saves each field separately', async () => {
      await click(a, {}, 'shortTitle'); controller.editor.input.value = '同一行短标题';
      await click(a);
      assert(controller.editor?.field === 'extra' && await persisted(a, 'shortTitle') === '同一行短标题', 'Column switch failed');
      controller.editor.input.value = '同一行其他备注';
      await click(a, {}, 'shortTitle');
      assert(controller.editor?.field === 'shortTitle' && controller.editor.input.value === '同一行短标题', 'Field identity lost');
      assert(await persisted(a) === '同一行其他备注', 'Extra not saved on column switch');
      controller.cancel();
    });
    await check('Short Title Tab and Shift+Tab stay in the Short Title column', async () => {
      await click(a, {}, 'shortTitle'); controller.editor.input.value = 'Tab 短标题';
      key('Tab'); await controller.queue;
      assert(controller.editor?.item.id === b.id && controller.editor.field === 'shortTitle', 'Tab changed column');
      assert(await persisted(a, 'shortTitle') === 'Tab 短标题', 'Tab did not save short title');
      key('Tab', { shiftKey: true }); await controller.queue;
      assert(controller.editor?.item.id === a.id && controller.editor.field === 'shortTitle', 'Shift+Tab changed column');
      controller.cancel();
    });
    await check('Short Title conflicts retain the draft and the current Extra value', async () => {
      const extra = a.getField('extra');
      await click(a, {}, 'shortTitle'); controller.editor.input.value = '短标题草稿';
      a.setField('shortTitle', '外部短标题'); await a.saveTx();
      assert(!await controller.finish(false), 'Short title conflict overwritten');
      assert(controller.editor?.input.value === '短标题草稿', 'Short title draft lost');
      assert(await persisted(a, 'shortTitle') === '外部短标题' && a.getField('extra') === extra, 'Conflict changed data');
      controller.cancel();
    });
    await check('Saved Short Title participates in native undo and redo', async () => {
      await click(a, {}, 'shortTitle'); controller.editor.input.value = '可撤销短标题';
      assert(await controller.finish(false), 'Short title save failed');
      await Zotero.UndoHistory.undo();
      assert(await persisted(a, 'shortTitle') === '外部短标题', 'Short title undo failed');
      await Zotero.UndoHistory.redo();
      assert(await persisted(a, 'shortTitle') === '可撤销短标题', 'Short title redo failed');
    });
    await check('Short Title IME confirmation does not save; blur saves only Short Title', async () => {
      const extra = b.getField('extra');
      await click(b, {}, 'shortTitle'); controller.editor.input.value = '中文短标题';
      key('Enter', { isComposing: true });
      assert(controller.editor?.field === 'shortTitle', 'IME submitted short title');
      doc.documentElement.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true })); await closed();
      assert(await persisted(b, 'shortTitle') === '中文短标题' && b.getField('extra') === extra, 'Blur saved wrong field');
    });
    await check('Disable removes listeners and overlay; re-enable creates a single controller', async () => {
      InlineExtra.removeFromWindow(w);
      assert(!doc.getElementById('inline-extra-editor'), 'Overlay not removed');
      assert(!InlineExtra.controllers.has(w), 'Controller not removed');
      InlineExtra.addToWindow(w); InlineExtra.addToWindow(w);
      assert(InlineExtra.controllers.size === 1, 'Duplicate controllers');
    });
    // Leave an unchanged demo open for the visual / native-input smoke test.
    const live = InlineExtra.controllers.get(w);
    await live.open(a, view);
    results.demo = { title: collection.name, itemID: a.id, collectionID: collection.id };
  }
  catch (error) { results.failures.push({ name: 'test runner', message: String(error), stack: error.stack }); }
  results.done = true;
  await IOUtils.writeJSON(TEST_RESULT_PATH, results);
})();
