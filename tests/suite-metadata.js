var SuitePromise = (async () => {
  const result = { checks: [], failures: [] };
  const window = Zotero.getMainWindow(), pane = window.ZoteroPane;
  const engine = Metadata.engine;
  const epd = "10.1093/nar/gkz1014", plink = "10.1086/519795";
  const preprint = "10.5555/centers-preprint", published = "10.5555/centers-published";
  const titleEPD = "EPD in 2020: enhanced data visualization and extension to ncRNA promoters";
  const titlePlink = "PLINK: A Tool Set for Whole-Genome Association and Population-Based Linkage Analyses";
  const titleVersion = "Metadata resolver version fixture";
  const articles = {
    [epd]: { DOI: epd, title: [titleEPD], type: "journal-article", "container-title": ["Nucleic Acids Research"],
      author: [{ given: "Patrick", family: "Meylan" }], "published-online": { "date-parts": [[2019, 11, 4]] } },
    [plink]: { DOI: plink, title: [titlePlink], type: "journal-article", "container-title": ["The American Journal of Human Genetics"],
      page: "559-575", volume: "81", issue: "3", "published-print": { "date-parts": [[2007, 9]] } },
    [preprint]: { DOI: preprint, title: [titleVersion], type: "posted-content", publisher: "Fixture archive",
      relation: { "is-preprint-of": [{ "id-type": "doi", id: published }] } },
    [published]: { DOI: published, title: [titleVersion], type: "journal-article", "container-title": ["Fixture Journal"],
      volume: "3", issue: "2", "article-number": "e1234", "published-print": { "date-parts": [[2025, 6]] } },
  };
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async (fn, message) => {
    for (let i = 0; i < 150; i++) {
      const value = await fn();
      if (value) return value;
      await Zotero.Promise.delay(100);
    }
    throw new Error(message);
  };
  const check = async (name, fn) => {
    result.running = name; await IOUtils.writeJSON(TEST_RESULT_PATH, result);
    try { await fn(); result.checks.push(name); }
    catch (error) { result.failures.push({ name, message: String(error), stack: error.stack }); }
    await IOUtils.writeJSON(TEST_RESULT_PATH, result);
  };
  const originalRequest = Zotero.HTTP.request;
  Zotero.HTTP.request = async function (method, uri, options) {
    const url = new window.URL(uri);
    if (url.hostname === "api.crossref.org") {
      if (url.pathname === "/works") return { status: 200, response: { message: { items: [articles[plink]] } } };
      const article = articles[decodeURIComponent(url.pathname.slice("/works/".length))];
      return article ? { status: 200, response: { message: article } } : { status: 404 };
    }
    if (url.hostname === "www.ebi.ac.uk") {
      const query = url.searchParams.get("query");
      const hits = query?.includes(epd) || query?.includes("31680159") ? [{ doi: epd, title: titleEPD,
        source: "MED", id: "31680159", pageInfo: "D65-D69", pubYear: "2020",
        journalInfo: { journal: { title: "Nucleic Acids Research", medlineAbbreviation: "Nucleic Acids Res" }, volume: "48", issue: "D1", yearOfPublication: 2020, monthOfPublication: 1 },
      }] : [];
      return { status: 200, response: { resultList: { result: hits } } };
    }
    if (["api.datacite.org", "api.openalex.org", "api.semanticscholar.org", "dblp.org"].includes(url.hostname)) return { status: 404 };
    return originalRequest.call(this, method, uri, options);
  };
  let collection, dialog, epdItem, plinkItem;
  const get = id => dialog.document.getElementById(id);
  const field = (name, index = 0) => dialog.document.querySelectorAll(`select[data-field="${name}"]`)[index];
  const cards = () => [...get("results").querySelectorAll(".result")];
  const close = () => { if (dialog && !dialog.closed) dialog.close(); dialog = null; };
  const ready = async () => wait(() => dialog?.document.documentURI === Metadata.dialogURL && get("lookup") && get("status").textContent, "Metadata dialog did not initialize");
  const open = async mode => { close(); dialog = await Metadata.open(window, mode); await ready(); };
  const lookup = async () => {
    get("lookup").click();
    await wait(() => !get("lookup").disabled && cards().length, "Lookup did not finish");
  };
  const write = async () => {
    assert(!get("apply").disabled, "Write button is disabled");
    get("apply").click();
    await wait(() => !get("lookup").disabled && get("status").textContent.startsWith("完成"), "Write did not finish");
  };
  const select = async (...items) => {
    close();
    await pane.itemsView.selectItems(items.map(item => item.id));
    await wait(() => Metadata.engine.selected(pane).length > 0, "No eligible selection");
  };
  const updateChoice = (control, value) => {
    control.value = value;
    control.dispatchEvent(new dialog.Event("change", { bubbles: true }));
  };
  try {
    collection = new Zotero.Collection();
    collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = "Centers metadata fixtures";
    await collection.saveTx();
    await pane.collectionsView.selectByID("C" + collection.id);
    await check("Toolbar opens the real import dialog; preview uses issue and online dates without writing", async () => {
      window.document.getElementById("centers-metadata-toolbar").dispatchEvent(new window.Event("command"));
      dialog = await wait(() => [...Metadata.dialogs.keys()].find(open => !open.closed), "Toolbar did not open a dialog");
      await ready();
      get("entries").value = `${epd}\n${plink}`;
      await lookup();
      assert(cards().length === 2, "Batch input did not yield two results");
      assert(field("date")?.selectedOptions[0].textContent.includes("2020-01"), "EPD issue date missing");
      assert(field("pages")?.selectedOptions[0].textContent.includes("D65-D69"), "EPD page range missing");
      updateChoice(get("date-mode"), "online");
      assert(field("date")?.selectedOptions[0].textContent.includes("2019-11-04"), "Online date preference ignored");
      updateChoice(get("date-mode"), "formal");
      assert(!(await engine.findDuplicates(collection.libraryID, epd)).length, "Preview wrote items");
    });
    await check("One write adds both records to the chosen collection with complete identifiers", async () => {
      await write();
      const [epdID] = await engine.findDuplicates(collection.libraryID, epd);
      const [plinkID] = await engine.findDuplicates(collection.libraryID, plink);
      epdItem = await Zotero.Items.getAsync(epdID); plinkItem = await Zotero.Items.getAsync(plinkID);
      assert(epdItem.inCollection(collection.id) && plinkItem.inCollection(collection.id), "Items saved to wrong collection");
      assert(epdItem.getField("volume") === "48" && epdItem.getField("issue") === "D1" && epdItem.getField("pages") === "D65-D69", "Formal citation fields missing");
      assert(epdItem.getCreatorsJSON()[0].lastName === "Meylan", "Structured creator missing");
      assert(plinkItem.getField("DOI") === plink, "PLINK DOI changed");
    });
    await check("PMID aliases and explicitly chosen title candidates cannot duplicate an existing DOI", async () => {
      await open("import");
      get("entries").value = `PMID:31680159\n${titlePlink}`;
      await lookup();
      assert(cards()[0].textContent.includes("已有此 DOI"), "PMID duplicate missing");
      const matches = cards()[1].querySelector(".title-candidates");
      assert(matches && get("apply").disabled, "Title result was accepted without choice");
      updateChoice(matches, plink);
      await wait(() => !get("lookup").disabled && cards()[1].textContent.includes("已有此 DOI"), "Title candidate did not recheck duplicates");
      assert(get("apply").disabled, "Duplicate was eligible for import");
    });
    await check("Right-click batch updates existing keys and keeps PDFs, collection, short title and Extra", async () => {
      const key = epdItem.key, otherKey = plinkItem.key;
      epdItem.setField("date", "2019-11-04"); epdItem.setField("shortTitle", "My EPD"); epdItem.setField("extra", "My local annotation");
      epdItem.setField("journalAbbreviation", "Old abbreviation");
      await epdItem.saveTx();
      plinkItem.setField("pages", "1"); await plinkItem.saveTx();
      const pdf = await Zotero.Attachments.importFromFile({ file: PathUtils.join(TEST_ROOT, "tests", "paper.pdf"), parentItemID: epdItem.id });
      await select(epdItem, plinkItem);
      window.document.getElementById("centers-metadata-refresh").dispatchEvent(new window.Event("command"));
      dialog = await wait(() => [...Metadata.dialogs.keys()].find(open => !open.closed), "Context menu did not open a dialog");
      await ready(); await lookup();
      assert(cards().length === 2, "Multi-selection was not preserved");
      assert(field("journalAbbreviation")?.selectedOptions[0].textContent.includes("Nucleic Acids Res 〔Europe PMC · MEDLINE〕"), "Journal abbreviation correction missing from preview");
      await write();
      const current = await Zotero.Items.getAsync(epdItem.id), second = await Zotero.Items.getAsync(plinkItem.id);
      assert(current.key === key && second.key === otherKey && current.inCollection(collection.id), "Original record identity changed");
      assert(current.getField("date").startsWith("2020") && second.getField("pages") === "559-575", "Batch did not update metadata");
      assert(current.getField("journalAbbreviation") === "Nucleic Acids Res", "Old journal abbreviation was not corrected in place");
      assert(current.getField("shortTitle") === "My EPD" && current.getField("extra") === "My local annotation" && current.getAttachments().includes(pdf.id), "Non-bibliographic data was modified");
      const backups = await IOUtils.getChildren(PathUtils.join(Zotero.DataDirectory.dir, "centers-metadata-backups"));
      assert(backups.length >= 2, "Missing pre-update backups");
      assert(engine.selected({ getSelectedItems: () => [pdf, current] }).length === 1, "Child selection did not resolve to one parent");
      await Zotero.UndoHistory.undo();
      assert(Zotero.Items.get(current.id).getField("date").startsWith("2019") || Zotero.Items.get(second.id).getField("pages") === "1", "Native undo did not restore an update");
      await Zotero.UndoHistory.redo();
      assert(Zotero.Items.get(current.id).getField("date").startsWith("2020") && Zotero.Items.get(second.id).getField("pages") === "559-575", "Native redo did not reapply an update");
    });
    await check("A standalone PDF is attached to a new parent without replacing the file", async () => {
      const pdf = await Zotero.Attachments.importFromFile({ file: PathUtils.join(TEST_ROOT, "tests", "paper.pdf"),
        libraryID: collection.libraryID, collections: [collection.id] });
      const key = pdf.key, file = pdf.getFilePath();
      await select(pdf);
      await open("update");
      get("update-inputs").querySelector("input").value = published;
      await lookup();
      assert(get("apply").disabled, "Standalone attachment did not require review");
      cards()[0].querySelector(".include").click();
      await write();
      const current = await Zotero.Items.getAsync(pdf.id);
      const parent = await Zotero.Items.getAsync(current.parentItemID);
      assert(current.key === key && current.getFilePath() === file && parent.getField("DOI") === published && parent.inCollection(collection.id), "PDF association changed its file or collection");
    });
    await check("Explicit preprint relation previews a linked version and avoids an existing published DOI", async () => {
      const item = new Zotero.Item("preprint"); item.libraryID = collection.libraryID;
      item.setField("title", titleVersion); item.setField("DOI", preprint); item.addToCollection(collection.id);
      await item.saveTx();
      await select(item); await open("update"); await lookup();
      assert(cards()[0].querySelector(".versions")?.value === "1" && cards()[0].textContent.includes("已有此 DOI"), "Published DOI collision was not shown");
      assert(get("apply").disabled && item.getField("DOI") === preprint, "Collision is writable");
      const [existing] = await engine.findDuplicates(collection.libraryID, published);
      const existingItem = await Zotero.Items.getAsync(existing);
      existingItem.setField("DOI", ""); await existingItem.saveTx();
      await lookup();
      const key = item.key;
      cards()[0].querySelector(".include").click(); await write();
      const upgraded = await Zotero.Items.getAsync(item.id);
      assert(upgraded.key === key && upgraded.itemTypeID === Zotero.ItemTypes.getID("journalArticle") && upgraded.getField("DOI") === published && upgraded.getField("pages") === "e1234", "Verified version did not update in place");
    });
    await check("Stale preview rejects an update while a new preview can save", async () => {
      await select(epdItem); await open("update");
      updateChoice(get("date-mode"), "online");
      await lookup();
      const current = await Zotero.Items.getAsync(epdItem.id);
      current.setField("shortTitle", "Edited elsewhere"); await current.saveTx();
      await write();
      assert(cards()[0].textContent.includes("已变化") && current.getField("date").startsWith("2020"), "A stale preview overwrote the item");
      await open("update"); updateChoice(get("date-mode"), "online"); await lookup(); await write();
      const updated = await Zotero.Items.getAsync(epdItem.id);
      assert(updated.getField("date").startsWith("2019") && updated.getField("shortTitle") === "Edited elsewhere", "Fresh preview did not save the selected date");
    });
    await check("File import opens Zotero's wizard and imports RIS into the selected collection", async () => {
      await open("import");
      get("entries").value = epd;
      const title = "Centers native RIS import fixture";
      const path = PathUtils.join(Zotero.DataDirectory.dir, "centers-import-test.ris");
      await IOUtils.writeUTF8(path, `TY  - JOUR\r\nTI  - ${title}\r\nAU  - Example, Ada\r\nPY  - 2024\r\nER  - \r\n`);
      const file = Zotero.File.pathToFile(path);
      let nativeWindow;
      try {
        window.setTimeout(() => get("import-file").click(), 0);
        nativeWindow = await wait(() => Array.from(Services.wm.getEnumerator(null)).find(w =>
          w.document.documentURI === "chrome://zotero/content/import/importWizard.xhtml"), "Native import wizard did not open");
        const doc = nativeWindow.document;
        await wait(() => {
          const control = doc.getElementById("import-wizard");
          return doc.readyState === "complete" && control?.canAdvance && control.currentPage?.getAttribute("pageid") === "page-start" && control;
        }, "Native import wizard did not finish loading");
        assert(doc.getElementById("import-source-group").selectedItem.value === "file", "File is not the default import source");
      } finally {
        if (nativeWindow && !nativeWindow.closed) nativeWindow.close();
      }
      assert(get("entries").value === epd, "Opening file import cleared the lookup draft");
      // Use the same native importer with the fixture path in place of the OS file picker.
      await window.Zotero_File_Interface.importFile({ file, createNewCollection: false, onBeforeImport: () => {} });
      assert(collection.getChildItems().some(item => item.getField("title") === title), "RIS record is missing from the selected collection");
    });
  } catch (error) {
    result.failures.push({ name: "runner", message: String(error), stack: error.stack });
  } finally {
    close();
    Zotero.HTTP.request = originalRequest;
    result.done = true; delete result.running;
    await IOUtils.writeJSON(TEST_RESULT_PATH, result);
  }
})();
