var SuitePromise = (async () => {
  const result = { checks: [], failures: [] };
  const window = Zotero.getMainWindow(), pane = window.ZoteroPane;
  const engine = Metadata.engine;
  const epd = "10.1093/nar/gkz1014", plink = "10.1086/519795";
  const deepTools = "10.1093/nar/gkw257";
  const cooltools = "10.1371/journal.pcbi.1012067";
  const neurips = "10.52202/068431-0142";
  const sourmash = "10.21105/joss.06830";
  const nucleotideTransformer = "10.1038/s41592-024-02523-z";
  const conflictingDate = "10.5555/centers-date-conflict";
  const seqme = "10.1093/bioadv/vbag212";
  const preprint = "10.5555/centers-preprint", published = "10.5555/centers-published";
  const titleEPD = "EPD in 2020: enhanced data visualization and extension to ncRNA promoters";
  const titlePlink = "PLINK: A Tool Set for Whole-Genome Association and Population-Based Linkage Analyses";
  const titleDeepTools = "deepTools2: a next generation web server for deep-sequencing data analysis";
  const titleCooltools = "Cooltools: Enabling high-resolution Hi-C analysis in Python";
  const titleNeurips = "Few-Shot Parameter-Efficient Fine-Tuning is Better and Cheaper than In-Context Learning";
  const titleSourmash = "sourmash v4: A multitool to quickly search, compare, and analyze genomic and metagenomic data sets";
  const titleNucleotideTransformer = "Nucleotide Transformer: building and evaluating robust foundation models for human genomics";
  const naturePublisher = "Springer Science and Business Media LLC";
  const titleDateConflict = "Journal metadata with conflicting publication years";
  const titleSeqme = "seqme: a Python library for evaluating biological sequence design from generative models";
  const taggedTitleSeqme = titleSeqme.replace("seqme:", "<tt>seqme</tt>\n                    :");
  const proceedingsTitle = "Advances in Neural Information Processing Systems";
  const proceedingsPublisher = "Curran Associates, Inc.";
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
    [neurips]: { DOI: neurips, title: [titleNeurips], type: "proceedings-article", "container-title": [`${proceedingsTitle} 35`],
      publisher: "Neural Information Processing Systems Foundation, Inc. (NeurIPS)", page: "1950-1965" },
    [sourmash]: { DOI: sourmash, title: [titleSourmash], type: "journal-article", ISSN: ["2475-9066"],
      "container-title": ["Journal of Open Source Software"], "short-container-title": ["JOSS"] },
    [nucleotideTransformer]: { DOI: nucleotideTransformer, title: [titleNucleotideTransformer], type: "journal-article",
      "container-title": ["Nature Methods"], publisher: naturePublisher, volume: "22", issue: "2", page: "287-297",
      "journal-issue": { issue: "2", "published-print": { "date-parts": [[2025, 2]] } },
      "published-online": { "date-parts": [[2024, 11, 28]] } },
    [conflictingDate]: { DOI: conflictingDate, title: [titleDateConflict], type: "journal-article",
      "container-title": ["Nature Methods"], ISSN: ["1548-7091"], publisher: naturePublisher,
      author: [{ given: "Ada", family: "Example" }], volume: "22", issue: "2", page: "287-297",
      published: { "date-parts": [[2024, 11, 28]] } },
    [seqme]: { DOI: seqme, title: [taggedTitleSeqme], type: "journal-article", "container-title": ["Bioinformatics Advances"] },
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
  let omitCooltoolsCollective = false;
  let omitNeuripsCrossref = true;
  let nucleotideAttempts = 0;
  let conflictingDatePMCAttempts = 0;
  Zotero.HTTP.request = async function (method, uri, options) {
    const url = new window.URL(uri);
    if (url.hostname === "api.crossref.org") {
      if (url.pathname === "/works") return { status: 200, response: { message: { items: [articles[plink]] } } };
      const article = articles[decodeURIComponent(url.pathname.slice("/works/".length))];
      if (article?.DOI === nucleotideTransformer && ++nucleotideAttempts === 1) return { status: 429 };
      if (article?.DOI === neurips && omitNeuripsCrossref) return { status: 404 };
      return article ? { status: 200, response: { message: article } } : { status: 404 };
    }
    if (url.hostname === "api.openalex.org" && url.pathname.endsWith(neurips)) {
      return { status: 200, response: { doi: neurips, title: titleNeurips, type: "conference-paper",
        primary_location: { raw_source_name: `${proceedingsTitle} 35`, source: { display_name: "neural information processing systems" } },
        biblio: { first_page: "1950", last_page: "1965" } } };
    }
    if (url.hostname === "www.ebi.ac.uk") {
      const query = url.searchParams.get("query");
      if (query?.includes(conflictingDate)) {
        if (++conflictingDatePMCAttempts === 1) return { status: 503 };
        return { status: 200, response: { resultList: { result: [{ doi: conflictingDate,
          title: titleDateConflict, source: "MED", id: "99999999", pmcid: "PMC99999999", pubYear: "2025",
          journalInfo: { journal: { title: "Nature Methods" } } }] } } };
      }
      const hits = query?.includes(epd) || query?.includes("31680159") ? [{ doi: epd, title: titleEPD,
        source: "MED", id: "31680159", pageInfo: "D65-D69", pubYear: "2020",
        journalInfo: { journal: { title: "Nucleic Acids Research", medlineAbbreviation: "Nucleic Acids Res" }, volume: "48", issue: "D1", yearOfPublication: 2020, monthOfPublication: 1 },
      }] : [];
      if (query?.includes(deepTools)) hits.push({ doi: deepTools, title: titleDeepTools, source: "MED", id: "27079975",
        pageInfo: "W160-5", pubYear: "2016", journalInfo: { journal: { title: "Nucleic Acids Research" },
          volume: "44", issue: "W1", yearOfPublication: 2016, monthOfPublication: 7, dateOfPublication: "2016 Jul 8" } });
      if (query?.includes(cooltools)) hits.push({ doi: cooltools, title: titleCooltools, source: "MED", id: "38709825",
        pageInfo: "e1012067", pubYear: "2024", journalInfo: { journal: { title: "PLOS Computational Biology" },
          volume: "20", issue: "5", yearOfPublication: 2024, monthOfPublication: 5 },
        authorList: { author: [...(omitCooltoolsCollective ? [] : [{ collectiveName: "Open2C" }]),
          { firstName: "Nezar", lastName: "Abdennur" }, { firstName: "Sameer", lastName: "Abraham" }] } });
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
      assert(field("journalAbbreviation")?.selectedOptions[0].textContent.includes("Nucleic Acids Res. 〔本地期刊简称库 · ISO 4〕"), "Journal abbreviation correction missing from preview");
      await write();
      const current = await Zotero.Items.getAsync(epdItem.id), second = await Zotero.Items.getAsync(plinkItem.id);
      assert(current.key === key && second.key === otherKey && current.inCollection(collection.id), "Original record identity changed");
      assert(current.getField("date").startsWith("2020") && second.getField("pages") === "559-575", "Batch did not update metadata");
      assert(current.getField("journalAbbreviation") === "Nucleic Acids Res.", "Old journal abbreviation was not corrected in place");
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
      await lookup(); await write();
      const updated = await Zotero.Items.getAsync(epdItem.id);
      assert(updated.getField("date").startsWith("2019") && updated.getField("shortTitle") === "Edited elsewhere", "Fresh preview did not save the selected date");
    });
    await check("Batch updates expand MEDLINE pages and omit unchanged entries on repeat lookup", async () => {
      const paper = new Zotero.Item("journalArticle");
      paper.libraryID = collection.libraryID;
      paper.setField("title", titleDeepTools);
      paper.setField("DOI", deepTools);
      paper.setField("pages", "W160-5");
      paper.addToCollection(collection.id);
      await paper.saveTx();
      await select(paper, plinkItem); await open("update"); await lookup();
      const deepToolsCard = () => cards().find(card => card.querySelector("h2").textContent === titleDeepTools);
      assert(cards().length === 2 && get("apply").textContent === "写入 1 条", "Unchanged article was counted as pending");
      assert(deepToolsCard().querySelector('[data-field="pages"]').selectedOptions[0].textContent.includes("W160-W165"), "Short MEDLINE range was not expanded in a batch");
      await write();
      assert((await Zotero.Items.getAsync(paper.id)).getField("pages") === "W160-W165", "Batch kept the shortened page range");
      await lookup();
      assert(cards().length === 2 && get("apply").disabled && get("apply").textContent === "无待写入条目", "Repeat query still showed already saved items as pending");
      assert(cards().every(card => !card.querySelector(".no-changes").hidden), "Unchanged items were not identified");
      updateChoice(deepToolsCard().querySelector('[data-field="pages"]'), "0");
      assert(get("apply").disabled, "Explicitly selecting the same stored page range counted as a change");
    });
    await check("Collective author is saved first as a single field and survives partial source responses", async () => {
      const paper = new Zotero.Item("journalArticle");
      paper.libraryID = collection.libraryID;
      paper.setField("title", titleCooltools);
      paper.setField("DOI", cooltools);
      paper.setCreators([{ firstName: "Nezar", lastName: "Abdennur", creatorType: "author" },
        { firstName: "Sameer", lastName: "Abraham", creatorType: "author" }]);
      paper.addToCollection(collection.id);
      await paper.saveTx();
      await select(paper); await open("update"); await lookup();
      assert(field("creators").selectedOptions[0].textContent.includes("Open2C；Nezar Abdennur"), "Preview omitted or reordered the collective author");
      await write();
      const authors = (await Zotero.Items.getAsync(paper.id)).getCreatorsJSON();
      assert(authors[0].name === "Open2C" && authors[0].creatorType === "author" && authors[1].lastName === "Abdennur",
        "Collective author was not stored as a single name in the first position");
      try {
        omitCooltoolsCollective = true;
        await lookup();
        assert(field("creators").value === "-1" && cards()[0].textContent.includes("缺少当前的单栏作者") && get("apply").disabled,
          "Partial response would replace the saved collective author");
      } finally { omitCooltoolsCollective = false; }
    });
    await check("Proceedings title and volume survive Crossref fallback and conflicting publisher is preserved", async () => {
      const paper = new Zotero.Item("conferencePaper");
      paper.libraryID = collection.libraryID;
      paper.setField("title", titleNeurips);
      paper.setField("DOI", neurips);
      paper.setField("proceedingsTitle", "neural information processing systems");
      paper.setField("publisher", proceedingsPublisher);
      paper.addToCollection(collection.id);
      await paper.saveTx();
      await select(paper); await open("update"); await lookup();
      const selectedTitle = field("container").selectedOptions[0].textContent;
      assert(selectedTitle.includes(`${proceedingsTitle} 〔OpenAlex〕`), `Unexpected OpenAlex proceedings choice: ${selectedTitle}`);
      await write();
      const saved = await Zotero.Items.getAsync(paper.id);
      assert(saved.getField("proceedingsTitle") === proceedingsTitle && saved.getField("volume") === "35"
        && saved.getField("pages") === "1950-1965", "Proceedings title, volume or pages were not written separately");
      omitNeuripsCrossref = false;
      await lookup();
      assert(field("publisher").value === "-1" && field("publisher").options[1].textContent.includes("Foundation")
        && cards()[0].textContent.includes("出版社与来源记录不同") && get("apply").disabled
        && saved.getField("publisher") === proceedingsPublisher, "Conflicting publisher was selected for writing by default");
    });
    await check("Offline journal abbreviations update multiple articles by ISSN and title in one batch", async () => {
      const fixtures = [[sourmash, titleSourmash, "Journal of Open Source Software", "JOSS", "J. Open Source Softw."],
        [epd, titleEPD, "Nucleic Acids Research", "NAR", "Nucleic Acids Res."]];
      const items = [];
      for (const [doi, title, journal, previous] of fixtures) {
        const paper = new Zotero.Item("journalArticle");
        paper.libraryID = collection.libraryID;
        paper.setField("title", title);
        paper.setField("DOI", doi);
        paper.setField("publicationTitle", journal);
        paper.setField("journalAbbreviation", previous);
        paper.addToCollection(collection.id);
        await paper.saveTx();
        items.push(paper);
      }
      await select(...items); await open("update"); await lookup();
      for (const [, title, , , expected] of fixtures) {
        const card = cards().find(row => row.querySelector("h2").textContent === title);
        const option = card.querySelector('[data-field="journalAbbreviation"]').selectedOptions[0];
        assert(option.textContent.includes(`${expected} 〔本地期刊简称库 · ISO 4〕`), `Unexpected preview: ${option.textContent}`);
      }
      assert(get("apply").textContent === "写入 2 条", "Both journal records should be pending");
      await write();
      for (const [index, item] of items.entries()) {
        const saved = await Zotero.Items.getAsync(item.id);
        assert(saved.getField("journalAbbreviation") === fixtures[index][4]
          && saved.getField("publicationTitle") === fixtures[index][2], "Journal name or abbreviation was not saved correctly");
      }
    });
    await check("Crossref batch retry preserves the formal date and publisher through writeback", async () => {
      const items = [];
      for (const [doi, title] of [[nucleotideTransformer, titleNucleotideTransformer], [sourmash, titleSourmash]]) {
        const paper = new Zotero.Item("journalArticle");
        paper.libraryID = collection.libraryID;
        paper.setField("title", title);
        paper.setField("DOI", doi);
        paper.addToCollection(collection.id);
        await paper.saveTx();
        items.push(paper);
      }
      const [paper] = items;
      await select(...items); await open("update"); await lookup();
      const card = cards().find(row => row.querySelector("h2").textContent === titleNucleotideTransformer);
      const chosen = name => card.querySelector(`select[data-field="${name}"]`).selectedOptions[0].textContent;
      assert(nucleotideAttempts === 2 && get("apply").textContent === "写入 2 条", "Crossref retry failed or the second article was skipped");
      assert(chosen("date").includes("2025-02") && chosen("publisher").includes(naturePublisher), "Batch preview lost date or publisher");
      await write();
      const saved = await Zotero.Items.getAsync(paper.id);
      assert(saved.getField("date") === "2025-02" && saved.getField("publisher") === naturePublisher,
        "Batch write did not store the formal issue date and publisher");
    });
    await check("Batch date conflicts preserve dates while verified fields are written", async () => {
      const items = [];
      for (const [doi, title] of [[conflictingDate, titleDateConflict], [sourmash, titleSourmash]]) {
        const paper = new Zotero.Item("journalArticle");
        paper.libraryID = collection.libraryID;
        paper.setField("title", title);
        paper.setField("DOI", doi);
        if (doi === conflictingDate) paper.setField("date", "2025-02");
        paper.addToCollection(collection.id);
        await paper.saveTx();
        items.push(paper);
      }
      const [paper] = items;
      await select(...items); await open("update"); await lookup();
      const card = cards().find(row => row.querySelector("h2").textContent === titleDateConflict);
      assert(card.querySelector('[data-field="date"]').value === "-1" && card.textContent.includes("年份有冲突"), "Date conflict was not held for review");
      assert(conflictingDatePMCAttempts === 2 && get("apply").textContent === "写入 2 条", "Source recovery or automatic inclusion failed");
      await write();
      const saved = await Zotero.Items.getAsync(paper.id);
      const expected = { date: "2025-02", publicationTitle: "Nature Methods", publisher: naturePublisher,
        journalAbbreviation: "Nat. Methods", volume: "22", issue: "2", pages: "287-297", ISSN: "1548-7091",
        PMID: "99999999", PMCID: "PMC99999999", url: `https://doi.org/${conflictingDate}` };
      for (const [name, value] of Object.entries(expected)) {
        assert(saved.getField(name) === value, `Unexpected stored ${name}: ${saved.getField(name)}`);
      }
      assert(saved.getCreatorsJSON()[0]?.lastName === "Example", "Author did not survive the batch write");
    });
    await check("Seqme import and in-place update remove teletype title markup", async () => {
      await open("import");
      get("entries").value = seqme;
      await lookup();
      assert(cards()[0].querySelector("h2").textContent === titleSeqme, "Import preview retained teletype markup");
      await write();
      const [id] = await engine.findDuplicates(collection.libraryID, seqme);
      const paper = await Zotero.Items.getAsync(id);
      const key = paper.key;
      assert(paper.getField("title") === titleSeqme, "Imported title retained teletype markup");
      paper.setField("title", taggedTitleSeqme.replace("Python", "<i>Python</i>"));
      await paper.saveTx();
      await select(paper); await open("update"); await lookup();
      assert(field("title").value === "0" && get("apply").textContent === "写入 1 条", "Stored markup was treated as unchanged");
      await write();
      const updated = await Zotero.Items.getAsync(id);
      assert(updated.key === key && updated.getField("title") === titleSeqme.replace("Python", "<i>Python</i>"),
        "Update did not remove teletype markup while preserving supported italics and the item key");
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
