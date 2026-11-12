/* Runs ONLY in the disposable profile created by scripts/test-zotero.py. */
var SuitePromise = (async () => {
  const results = { zotero: Zotero.version, checks: [], failures: [] };
  const engine = TitleMerge.engine;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const check = async (name, fn) => {
    results.running = name;
    await IOUtils.writeJSON(PathUtils.join(TEST_ROOT, 'test-results', 'title-merge.json'), results);
    try { await fn(); results.checks.push(name); }
    catch (error) { results.failures.push({ name, message: String(error), stack: error.stack }); }
    await IOUtils.writeJSON(PathUtils.join(TEST_ROOT, 'test-results', 'title-merge.json'), results);
  };
  const item = async (type, title, fields = {}) => {
    const entry = new Zotero.Item(type);
    entry.libraryID = Zotero.Libraries.userLibraryID;
    entry.setField('title', title);
    for (const [key, value] of Object.entries(fields)) entry.setField(key, value);
    await entry.saveTx();
    return entry;
  };
  let originalMergeGroup;
  try {
    await Zotero.uiReadyPromise;
    const w = Zotero.getMainWindow();
    for (let i=0; i<200 && !w.ZoteroPane.itemsView; i++) await Zotero.Promise.delay(100);
    // Fixture writes must not race the initial whole-library cache load.
    await Zotero.Libraries.userLibrary.waitForDataLoad('item');
    await w.ZoteroPane.itemsView.waitForLoad();
    await Zotero.Promise.delay(300);
    for (const [name, view] of [['collections',w.ZoteroPane.collectionsView], ['items',w.ZoteroPane.itemsView]]) {
      const realNotify = view.notify;
      view.notify = async function(...args) {
        // A Windows-hidden test window cannot deliver the selection repaint that the
        // trash-tree observer waits for. Suppress only that visual refresh in the test
        // harness. The production plugin and all data/notifier observers are unchanged.
        if (name === 'collections' && args[0] === 'refresh' && args[1] === 'trash') return;
        return realNotify.apply(this,args);
      };
    }
    await check('Tools and context menus registered', async () => {
      assert(w.document.getElementById('title-merge-tools'), 'Tools menu missing');
      assert(w.document.getElementById('title-merge-context'), 'Context menu missing');
    });
    const journal = await item('journalArticle', '  Same Title  ', {DOI: '10.1000/journal', date: '2026'});
    const conference = await item('conferencePaper', 'SAME TITLE', {DOI: '10.1000/conference', proceedingsTitle: 'Conference Proceedings', abstractNote: 'Fill me', date: '2024'});
    const preprint = await item('preprint', 'Same\tTitle', {DOI: '10.1000/preprint', repository: 'arXiv', archiveID: '2601.12345'});
    journal.setCreators([{firstName: 'Master', lastName: 'Author', creatorType: 'author'}]);
    conference.setCreators([{firstName: 'Other', lastName: 'Author', creatorType: 'author'}]);
    journal.addTag('journal-tag'); conference.addTag('conference-tag');
    const collections = [];
    for (const [entry, name] of [[journal, 'Journal collection'], [conference, 'Conference collection']]) {
      const c = new Zotero.Collection(); c.libraryID = entry.libraryID; c.name = name; await c.saveTx();
      await w.ZoteroPane.itemsView.waitForLoad();
      collections.push(c); entry.addToCollection(c.id); await entry.saveTx();
    }
    const note = new Zotero.Item('note'); note.libraryID = conference.libraryID; note.parentItemID = conference.id;
    note.setNote('<p>Original research note</p>'); await note.saveTx();
    const pdf = await Zotero.Attachments.importFromFile({
      file: PathUtils.join(TEST_ROOT, 'tests', 'fixtures', 'paper.pdf'), parentItemID: conference.id
    });
    const annotation = new Zotero.Item('annotation'); annotation.libraryID = journal.libraryID;
    annotation.parentItemID = pdf.id; annotation.annotationType = 'highlight';
    annotation.annotationText = 'Preserve highlight'; annotation.annotationComment = 'Research comment';
    annotation.annotationColor = '#ffd400'; annotation.annotationPageLabel = '1';
    annotation.annotationSortIndex = '00000|000000|00000';
    annotation.annotationPosition = JSON.stringify({pageIndex: 0, rects: [[20,20,100,35]]});
    await annotation.saveTx();
    const webpage = await Zotero.Attachments.linkFromURL({url: 'https://example.org/paper', parentItemID: preprint.id, title: 'Publisher page'});
    const standalone = await Zotero.Attachments.linkFromURL({url: 'https://example.org/standalone', title: 'Same Title', libraryID: journal.libraryID});
    const unrelated = await item('journalArticle', 'Same Title: extended');
    let group;
    await check('Scan ignores DOI/year/author/type, excludes standalone attachments and distinct titles', async () => {
      const groups = await engine.scan([journal, conference, preprint, standalone, unrelated, journal]);
      assert(groups.length === 1 && groups[0].records.length === 3, 'Unexpected grouping');
      group = groups[0]; assert(group.masterID === journal.id, 'Priority wrong');
    });
    let report;
    await check('Real cross-type merge commits', async () => {
      assert(group, 'No duplicate group');
      report = await engine.run([group]);
      assert(report.errors.length === 0, JSON.stringify(report.errors));
      assert(report.completed.length === 1, 'Merge not completed');
      assert(!journal.deleted && conference.deleted && preprint.deleted, 'Wrong surviving items');
      assert(Zotero.ItemTypes.getName(conference.itemTypeID) === 'conferencePaper', 'Trashed source type was unnecessarily changed');
    });
    await check('Master conflict values, creators and empty-field filling', async () => {
      assert(journal.getField('DOI') === '10.1000/journal', 'Master DOI overwritten');
      assert(journal.getCreators()[0].firstName === 'Master', 'Creators overwritten');
      assert(journal.getField('abstractNote') === 'Fill me', 'Empty field not filled');
    });
    await check('PDF file, annotation and linked URL preserved', async () => {
      assert(pdf.parentItemID === journal.id && await pdf.fileExists(), 'PDF not preserved');
      assert(annotation.parentItemID === pdf.id && !annotation.deleted, 'Annotation lost');
      assert(annotation.annotationComment === 'Research comment', 'Annotation changed');
      assert(webpage.parentItemID === journal.id, 'Linked URL lost');
    });
    await check('Notes, tags and both collections preserved', async () => {
      assert(note.parentItemID === journal.id && note.getNote().includes('Original research note'), 'Note lost');
      assert(journal.hasTag('journal-tag') && journal.hasTag('conference-tag'), 'Tags lost');
      assert(collections.every(c => journal.getCollections().includes(c.id)), 'Collection membership lost');
    });
    await check('Original types and conflicting fields archived on disk and in a child note', async () => {
      const archive = await IOUtils.readJSON(report.completed[0].archive);
      assert(archive.items.some(i => i.data.itemType === 'preprint' && i.data.archiveID === '2601.12345'), 'Original preprint fields lost');
      assert(archive.children.some(i => i.id === annotation.id), 'Annotation metadata not archived');
      const notes = await Zotero.Items.getAsync(journal.getNotes());
      assert(notes.some(n => n.getNote().includes('10.1000/conference') && n.getNote().includes('conferencePaper')), 'Archive note missing conflicts');
      assert((await IOUtils.readJSON(PathUtils.join(report.directory, 'report.json'))).completed.length === 1, 'Report not persisted');
    });
    await check('Citation replacement relations retained', async () => {
      const replacements = journal.getRelationsByPredicate(Zotero.Relations.replacedItemPredicate);
      assert(replacements.includes(Zotero.URI.getItemURI(conference)), 'Conference replacement relation missing');
      assert(replacements.includes(Zotero.URI.getItemURI(preprint)), 'Preprint replacement relation missing');
    });
    await check('Changed previews are rejected before conversion', async () => {
      const a = await item('journalArticle', 'Stale preview'); const b = await item('preprint', 'Stale preview');
      const groups = await engine.scan([a,b]); b.setField('DOI','10.1000/changed'); await b.saveTx();
      const r = await engine.run(groups);
      assert(r.completed.length === 0 && r.errors.length === 1, 'Stale preview accepted');
      assert(!b.deleted && Zotero.ItemTypes.getName(b.itemTypeID) === 'preprint', 'Stale item was changed');
    });
    await check('Native merge failure rolls back fields and moved notes without changing source types', async () => {
      const a = await item('journalArticle', 'Rollback');
      const b = await item('conferencePaper', 'Rollback', {proceedingsTitle: 'Keep proceedings', abstractNote:'Rollback this fill'});
      const n = new Zotero.Item('note'); n.libraryID = b.libraryID; n.parentItemID = b.id; n.setNote('<p>Rollback note</p>'); await n.saveTx();
      const groups = await engine.scan([a,b]);
      const realSave = n.save;
      n.save = async function() { throw new Error('Injected native transaction failure'); };
      let r;
      try { r = await engine.run(groups); } finally { n.save = realSave; }
      assert(r.errors.length === 1 && r.completed.length === 0, 'Expected failure missing');
      assert(!b.deleted && Zotero.ItemTypes.getName(b.itemTypeID) === 'conferencePaper', 'Type not rolled back');
      assert(b.getField('proceedingsTitle') === 'Keep proceedings', 'Fields not rolled back');
      assert(n.parentItemID === b.id, 'Note moved on failure');
      assert(!a.getField('abstractNote'), 'Filled field was not rolled back');
    });
    await check('Batch cancellation stops before next group and busy lock rejects second writer', async () => {
      const entries = [];
      for (const title of ['Cancel A','Cancel B']) entries.push(await item('journalArticle',title), await item('preprint',title));
      const groups = await engine.scan(entries);
      let locked = false;
      originalMergeGroup = engine.mergeGroup;
      engine.mergeGroup = async function(...args) {
        try { await engine.run(groups); } catch (e) { locked = /already running/.test(String(e)); }
        const r = await originalMergeGroup.apply(this,args); this.cancelRequested = true; return r;
      };
      let r;
      try { r = await engine.run(groups); } finally { engine.mergeGroup = originalMergeGroup; }
      assert(locked && r.cancelled && r.completed.length === 1, 'Lock/cancellation failed');
      assert(!entries[3].deleted, 'Second group was merged');
    });
    await check('Zoplicate 5.1.1 is disabled during a batch and restored afterwards', async () => {
      const a = await item('journalArticle', 'Coexistence'); const b = await item('preprint', 'Coexistence');
      const groups = await engine.scan([a,b]);
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const installer = await AddonManager.getInstallForFile(Zotero.File.pathToFile(PathUtils.join(TEST_ROOT,'.cache','zoplicate.xpi')));
      await installer.install();
      let addon = await AddonManager.getAddonByID('zoplicate@chenglongma.com');
      assert(addon.isActive, 'Zoplicate did not activate');
      results.zoplicate = addon.version;
      const realMerge = engine.mergeGroup;
      let paused = false;
      engine.mergeGroup = async function(...args) {
        paused = !(await AddonManager.getAddonByID(addon.id)).isActive;
        return realMerge.apply(this,args);
      };
      let r;
      try { r = await engine.run(groups); } finally { engine.mergeGroup = realMerge; }
      addon = await AddonManager.getAddonByID(addon.id);
      assert(paused && addon.isActive && r.completed.length === 1 && !r.errors.length, 'Zoplicate coexistence failed: '+JSON.stringify(r.errors));
      await addon.disable();
      Zotero.Prefs.set(engine.restorePref,addon.id,true);
      await engine.recoverZoplicate();
      assert((await AddonManager.getAddonByID(addon.id)).isActive, 'Recovery did not restore Zoplicate');
      await addon.disable();
      const c = await item('journalArticle','Disabled coexistence'); const d = await item('preprint','Disabled coexistence');
      r = await engine.run(await engine.scan([c,d]));
      assert(r.completed.length === 1 && !(await AddonManager.getAddonByID(addon.id)).isActive, 'Previously disabled Zoplicate was enabled');
    });
    await check('Dialog renders without script errors and scan button works', async () => {
      const dialog = TitleMerge.open(w);
      await new Promise(resolve => { if (dialog.document.readyState === 'complete') resolve(); else dialog.addEventListener('load',resolve,{once:true}); });
      await Zotero.Promise.delay(300);
      assert(dialog.document.getElementById('scope').options.length > 2, 'Library options missing');
      dialog.document.getElementById('scope').value = 'library:' + Zotero.Libraries.userLibraryID;
      dialog.document.getElementById('scan').click();
      for (let i=0;i<100 && dialog.document.getElementById('scan').disabled;i++) await Zotero.Promise.delay(100);
      assert(dialog.document.querySelectorAll('.group').length >= 2, 'Scan UI failed');
      assert(TitleMerge.dialogs.has(dialog) && TitleMerge.open(w) === dialog, 'Dialog lifetime tracking failed');
      results.dialogReady = true;
    });
    await check('Dialog group selection and merge button execute the batch', async () => {
      const dialog = [...TitleMerge.dialogs].find(d=>!d.closed);
      const doc = dialog.document;
      const all = doc.getElementById('all'); all.click();
      assert(doc.getElementById('merge').disabled, 'Unselect all did not disable merging');
      const first = doc.querySelector('.group input[type="checkbox"]'); first.click();
      assert(!doc.getElementById('merge').disabled, 'Selected group did not enable merging');
      doc.getElementById('merge').click();
      for(let i=0;i<300 && dialog.controller.running;i++) await Zotero.Promise.delay(100);
      assert(!dialog.controller.running && doc.getElementById('status').textContent.includes('已完成 1 组'), 'Merge button did not complete: '+doc.getElementById('result').textContent);
    });
    const waitUntil = async (predicate, message) => {
      for(let i=0;i<200;i++) {
        if(await predicate()) return;
        await Zotero.Promise.delay(100);
      }
      throw new Error(message);
    };
    const sidebar = () => TitleMerge.windowStates.get(w);
    await check('Sidebar stays hidden outside Duplicate Items', async () => {
      await TitleMerge.refreshSidebar(w);
      assert(sidebar().panels.size === 2, 'Missing native message/merge pane integration');
      assert([...sidebar().panels.values()].every(panel=>panel.root.hidden), 'Sidebar appeared outside duplicates');
    });
    const quickA = await item('journalArticle','Sidebar quick merge',{DOI:'10.1000/sidebar',shortTitle:'Sidebar master'});
    const quickB = await item('preprint','Sidebar quick merge',{DOI:'10.1000/sidebar'});
    const nextA = await item('journalArticle','Sidebar second group',{DOI:'10.1000/sidebar-next'});
    const nextB = await item('conferencePaper','Sidebar second group',{DOI:'10.1000/sidebar-next'});
    const quickNote = new Zotero.Item('note'); quickNote.libraryID=quickB.libraryID;
    quickNote.parentItemID=quickB.id;quickNote.setNote('<p>Sidebar source note</p>');await quickNote.saveTx();
    await check('Sidebar appears automatically for mixed-type duplicates with a usable narrow layout', async () => {
      await w.ZoteroPane.collectionsView.selectByID('D'+quickA.libraryID);
      await w.ZoteroPane.itemsView.waitForLoad();
      await w.ZoteroPane.itemsView.selectItems([quickA.id,quickB.id]);
      await waitUntil(()=>sidebar().groups.some(g=>g.masterID===quickA.id)&&!sidebar().scanning,'Sidebar did not react to the actual duplicates selection');
      assert(w.ZoteroPane.itemsView.viewMode==='duplicates','Wrong view mode');
      assert(w.ZoteroPane.itemPane.mode==='message','Fixture did not trigger the native mixed-type message');
      const panel=sidebar().panels.get('zotero-item-message');
      assert(!panel.root.hidden&&!panel.merge.disabled,'Mixed-type merge button missing/disabled');
      assert(panel.master.textContent.includes('Sidebar master'),'Default master missing');
      const rect=panel.root.getBoundingClientRect();const button=panel.merge.getBoundingClientRect();
      assert(rect.width>100&&rect.height>20&&button.right<=rect.right+1,'Sidebar layout overflows or has no size');
      results.sidebarLayout={width:Math.round(rect.width),height:Math.round(rect.height)};
    });
    await check('Sidebar preview automatically scans only the selected duplicate group', async () => {
      sidebar().panels.get('zotero-item-message').preview.click();
      const dialog=[...TitleMerge.dialogs].find(d=>!d.closed);
      await waitUntil(()=>dialog.controller?.groups.length===1&&!dialog.controller.scanning,'Preview required a separate scan');
      assert(dialog.controller.groups[0].records.length===2&&dialog.controller.groups[0].masterID===quickA.id,'Preview used the wrong scope');
      assert(!dialog.document.getElementById('merge').disabled,'Preview merge button is disabled');
      dialog.close();
      await Zotero.Promise.delay(100);
    });
    await check('A slow sidebar scan cannot restore an older selection', async () => {
      const realScan=engine.scan;let release;
      const gate=new Promise(resolve=>{release=resolve;});
      engine.scan=async function(items){
        if(items.some(item=>item.id===quickA.id)) await gate;
        return realScan.call(this,items);
      };
      let oldScan;
      try {
        oldScan=TitleMerge.refreshSidebar(w);
        await w.ZoteroPane.itemsView.selectItems([nextA.id,nextB.id]);
        await waitUntil(()=>sidebar().groups.some(g=>g.masterID===nextA.id)&&!sidebar().scanning,'New selection did not finish');
        release();await oldScan;
        assert(sidebar().groups.length===1&&sidebar().groups[0].masterID===nextA.id,'Slow scan overwrote the new selection');
      }
      finally{release();engine.scan=realScan;}
    });
    await check('Sidebar click merges immediately with Zoplicate present and no dialog', async () => {
      const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const addon=await AddonManager.getAddonByID('zoplicate@chenglongma.com');
      await addon.enable();
      await w.ZoteroPane.itemsView.selectItems([quickA.id,quickB.id]);
      await waitUntil(()=>sidebar().groups.some(g=>g.masterID===quickA.id)&&!sidebar().scanning,'Quick group not ready');
      const panel=sidebar().panels.get('zotero-item-message');panel.merge.click();
      await waitUntil(()=>!sidebar().running&&sidebar().lastReport,'Sidebar merge did not complete');
      assert(sidebar().lastReport.completed.length===1&&!sidebar().lastReport.errors.length,JSON.stringify(sidebar().lastReport.errors));
      assert(!quickA.deleted&&quickB.deleted&&quickNote.parentItemID===quickA.id,'Direct merge changed the wrong records');
      assert(quickA.getField('shortTitle')==='Sidebar master','Direct merge lost the master short title');
      assert([...TitleMerge.dialogs].every(d=>d.closed),'Direct merge opened a dialog');
      assert((await AddonManager.getAddonByID(addon.id)).isActive,'Zoplicate not restored');
    });
    await check('Sidebar hides when leaving duplicates and removes its UI on unload', async () => {
      await w.ZoteroPane.collectionsView.selectByID('L'+quickA.libraryID);
      await waitUntil(()=>[...sidebar().panels.values()].every(panel=>panel.root.hidden),'Sidebar remained visible outside duplicates');
      TitleMerge.removeFromWindow(w);
      assert(!w.document.querySelector('[data-title-merge-sidebar]')&&!w.document.getElementById('title-merge-sidebar-styles'),'Sidebar UI was not removed');
      TitleMerge.addToWindow(w);await TitleMerge.refreshSidebar(w);
      assert(w.document.querySelectorAll('[data-title-merge-sidebar]').length===2,'Sidebar duplicated after reloading');
      results.sidebarReady=true;
    });
    const {AddonManager: batchAddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const batchAddon=await batchAddonManager.getAddonByID('zoplicate@chenglongma.com');
    await batchAddon.disable();await Zotero.Promise.delay(100);
    const batchPairs=[];
    for(let i=0;i<4;i++) {
      const fields={DOI:'10.1000/batch-'+i};
      batchPairs.push([await item('journalArticle','Batch current '+i,fields),await item('preprint','Batch current '+i,fields)]);
    }
    const outsidePair=[await item('journalArticle','Batch outside',{DOI:'10.1000/outside'}),await item('preprint','Batch outside',{DOI:'10.1000/outside'})];
    const noMatchPair=[await item('journalArticle','No match One',{DOI:'10.1000/no-title'}),await item('preprint','No match Two',{DOI:'10.1000/no-title'})];
    await batchAddon.enable();
    await w.ZoteroPane.collectionsView.selectByID('D'+Zotero.Libraries.userLibraryID);
    await w.ZoteroPane.itemsView.waitForLoad();
    const filterBatch = async (text, records, requiredRecords = records) => {
      const ids = new Set(records.filter(item => !item.deleted).map(item => item.id));
      const pane = w.ZoteroPane;
      const search = w.document.getElementById('zotero-tb-search').searchTextbox;
      await waitUntil(async () => {
        // The Zoplicate enable/refresh can replace the duplicate view after the search call.
        if (pane.itemsView?.viewMode !== 'duplicates') return false;
        search.value = text;
        await pane.search();
        const visible = new Set(pane.getSortedItems().filter(item => item.isRegularItem()).map(item => item.id));
        return [...visible].every(id => ids.has(id)) && requiredRecords.every(item => visible.has(item.id));
      }, 'Filtered duplicate rows did not settle for ' + text);
    };
    await filterBatch('Batch current', batchPairs.flat());
    await w.ZoteroPane.itemsView.selectItems(batchPairs[0].map(item=>item.id));
    await waitUntil(()=>sidebar().visible&&!sidebar().scanning,'Batch sidebar not ready');
    const batchPanel=()=>sidebar().panels.get('zotero-item-message');
    await check('Bulk scan can be stopped without merging a partial scan',async()=>{
      const realScan=engine.scan;
      engine.scan=function(items,options){
        if(!options?.shouldCancel) return realScan.call(this,items,options);
        return realScan.call(this,items,{...options,onProgress:progress=>{
          options.onProgress(progress);
          if(progress.completed===1) batchPanel().stop.click();
        }});
      };
      try {
        assert(!batchPanel().bulk.disabled,'Bulk button is disabled');
        batchPanel().bulk.click();
        await waitUntil(()=>!sidebar().running&&sidebar().lastReport,'Bulk scan did not stop');
        assert(sidebar().lastReport.scanCancelled&&sidebar().lastReport.completed.length===0,'Partial scan was merged');
        assert(batchPairs.flat().every(item=>!item.deleted),'Stopping scan changed references');
      }finally{engine.scan=realScan;}
    });
    await check('Bulk merging stops after the current group and restores Zoplicate',async()=>{
      await filterBatch('Batch current', batchPairs.flat());
      assert((await engine.scan(w.ZoteroPane.getSortedItems())).length===4,'Initial filtered batch scope was incorrect');
      const realMerge=engine.mergeGroup;let merged=0;
      engine.mergeGroup=async function(...args){
        const result=await realMerge.apply(this,args);
        if(++merged===1) batchPanel().stop.click();
        return result;
      };
      try {
        batchPanel().bulk.click();
        await waitUntil(()=>!sidebar().running&&sidebar().lastReport,'Bulk merge did not stop');
        const report=sidebar().lastReport;
        assert(report.cancelled&&report.completed.length===1&&!report.errors.length,JSON.stringify(report));
        assert(batchPairs.flat().filter(item=>item.deleted).length===1,'Stop did not preserve remaining groups');
        assert((await batchAddonManager.getAddonByID(batchAddon.id)).isActive,'Zoplicate not restored after stopping');
      }finally{engine.mergeGroup=realMerge;}
    });
    await check('One bulk click completes every group in the filtered list with progress and no extra clicks',async()=>{
      // Zoplicate's restore refresh can clear the native quick search. Reapply the
      // user's filter before the new click; this tests that click's frozen scope.
      await filterBatch('Batch current', batchPairs.flat(), batchPairs.filter(pair => pair.every(item => !item.deleted)).flat());
      w.ZoteroPane.itemsView.selection.clearSelection();
      await w.ZoteroPane.itemSelected();
      await waitUntil(()=>!sidebar().scanning&&!batchPanel().bulk.disabled,'Bulk action required a selection');
      assert(!w.ZoteroPane.getSelectedItems().length,'The fixture still had selected items');
      const visible=w.ZoteroPane.getSortedItems();
      const groups=await engine.scan(visible);
      assert(groups.length===3,'Unexpected groups remaining in the filtered list: '+groups.map(group=>group.title).join(', '));
      assert(!visible.some(item=>outsidePair.some(outside=>outside.id===item.id)),'Filter did not exclude the outside group');
      const realMerge=engine.mergeGroup;const progress=[];
      engine.mergeGroup=async function(...args){
        progress.push({done:TitleMerge.sidebarOperation.completed,total:TitleMerge.sidebarOperation.total});
        assert(!batchPanel().progress.hidden&&!batchPanel().stop.hidden,'Batch progress/stop UI missing');
        assert(batchPanel().bulk.disabled&&batchPanel().merge.disabled,'Concurrent sidebar writes allowed');
        return realMerge.apply(this,args);
      };
      try {
        batchPanel().bulk.click();
        await waitUntil(()=>!sidebar().running&&sidebar().lastReport,'Bulk merge did not finish');
        const report=sidebar().lastReport;
        assert(report.completed.length===3&&!report.cancelled&&!report.errors.length,JSON.stringify(report));
        assert(progress.length===3&&progress.every((p,i)=>p.done===i&&p.total===3),'Incorrect batch progress');
        assert(batchPairs.every(([master,source])=>!master.deleted&&source.deleted),'Some unselected duplicate groups were not merged');
        assert(outsidePair.every(item=>!item.deleted),'Bulk merge escaped the filtered list');
        assert([...TitleMerge.dialogs].every(dialog=>dialog.closed),'Bulk action required a dialog');
        assert(batchPanel().progress.hidden&&batchPanel().stop.hidden&&!TitleMerge.sidebarOperation,'Batch UI/lock not released');
      }finally{engine.mergeGroup=realMerge;}
    });
    await check('Bulk action reports no title matches without merging same-DOI different-title records',async()=>{
      await filterBatch('No match', noMatchPair);
      await w.ZoteroPane.itemsView.selectItems(noMatchPair.map(item=>item.id));
      await waitUntil(()=>sidebar().viewCount>=2&&!sidebar().scanning,'No-match view not ready');
      batchPanel().bulk.click();
      await waitUntil(()=>!sidebar().running&&sidebar().lastReport,'No-match bulk action did not finish');
      assert(!sidebar().lastReport.completed.length&&!sidebar().lastReport.errors.length,'Unexpected no-match report');
      assert(noMatchPair.every(item=>!item.deleted),'Different titles were merged');
      results.bulkReady=true;
    });
  }
  catch (error) { results.failures.push({name:'Test setup',message:String(error),stack:error.stack}); }
  finally {
    results.done = true;
    delete results.running;
    await IOUtils.writeJSON(PathUtils.join(TEST_ROOT,'test-results','title-merge.json'), results);
  }
})();
