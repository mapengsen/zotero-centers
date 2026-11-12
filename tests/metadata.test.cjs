const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const core = require("../addon/modules/metadata/core.js");
const abbreviations = require("../addon/modules/metadata/journal-abbreviations.json");

function loadSources(request) {
  const scope = { CentersMetadataCore: core, Zotero: { HTTP: { request }, Promise: {
    delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
  } } };
  const file = path.join(__dirname, "../addon/modules/metadata/sources.js");
  vm.runInNewContext(fs.readFileSync(file, "utf8"), scope, { filename: file });
  return scope.CentersMetadataSources;
}

test("identifier lists preserve DOI suffixes, deduplicate links, and accept citation text", () => {
  assert.deepEqual(core.parseInputs(`10.1371/journal.pgen.1001412, 10.1086/519795\nhttps://doi.org/10.1086%2F519795?via=ihub\nPMID: 31680159\narXiv:1706.03762v7\nA citation. doi:10.1093/nar/gkz1014.\nA paper title`), [
    { kind: "doi", value: "10.1371/journal.pgen.1001412" }, { kind: "doi", value: "10.1086/519795" },
    { kind: "pmid", value: "31680159" }, { kind: "doi", value: "10.48550/arxiv.1706.03762" },
    { kind: "doi", value: "10.1093/nar/gkz1014" }, { kind: "title", value: "A paper title" },
  ]);
});

test("seqme titles drop raw or escaped teletype markup without discarding the text", () => {
  const sources = loadSources();
  const end = ": a Python library for evaluating biological sequence design from generative models";
  const title = "seqme" + end;
  for (const marked of ["<tt>seqme</tt>\n                    " + end, "&lt;TT&gt;seqme&lt;/TT&gt; " + end,
    "&#60;tt&#62;seqme&#x3c;/tt&#x3e; " + end]) {
    const record = sources.crossref({ DOI: "10.1093/bioadv/vbag212", title: [marked], type: "journal-article" });
    assert.equal(record.fields.title, title);
    assert.equal(core.equivalent("title", marked, title), true);
    assert.equal(core.input(marked).value, title);
  }
  assert.equal(core.cleanTitleMarkup("<tt>seqme</tt> : a <i>Python</i> library"), "seqme: a <i>Python</i> library");
  assert.equal(core.sourceTitle("Threshold A < 5 and B > 2"), "Threshold A < 5 and B > 2");
});

test("conference sources preserve the NeurIPS proceedings title and separate its volume", () => {
  const sources = loadSources();
  const doi = "10.52202/068431-0142";
  const title = "Few-Shot Parameter-Efficient Fine-Tuning is Better and Cheaper than In-Context Learning";
  const series = "Advances in Neural Information Processing Systems";
  const crossref = { DOI: doi, title: [title], type: "proceedings-article", "container-title": [`${series} 35`] };
  const openAlex = { doi, title, type: "conference-paper", primary_location: {
    raw_source_name: `${series} 35`, source: { display_name: "neural information processing systems" },
  } };
  for (const record of [sources.crossref(crossref), sources.openalex(openAlex)]) {
    assert.equal(record.type, "conferencePaper");
    assert.equal(record.fields.container, series);
    assert.equal(record.fields.volume, "35");
  }
  assert.equal(sources.openalex({ ...openAlex, primary_location: { source: openAlex.primary_location.source } }).fields.container, "");
  assert.equal(sources.crossref({ ...crossref, "container-title": ["Other Conference 2022"] }).fields.container, "Other Conference 2022");
  const conflict = sources.crossref({ ...crossref, volume: "36" });
  assert.equal(conflict.fields.container, `${series} 35`);
  assert.equal(conflict.fields.volume, "36");
});

test("EPD formal date follows issue evidence and online preference selects online date", () => {
  const sources = loadSources();
  const doi = "10.1093/nar/gkz1014", title = "EPD in 2020";
  const records = [sources.crossref({ DOI: doi, title: [title], type: "journal-article", "published-online": { "date-parts": [[2019, 11, 4]] } }),
    sources.europePMC({ doi, title, source: "MED", id: "31680159", pageInfo: "D65-D69", journalInfo: { volume: "48", issue: "D1", yearOfPublication: 2020, monthOfPublication: 1, dateOfPublication: "2020 Jan", printPublicationDate: "2020-01-01", journal: { title: "Nucleic Acids Research" } } }),
    sources.openalex({ doi, title, publication_date: "2019-10-21", biblio: { volume: "48", issue: "D1", first_page: "D65", last_page: "D69" } })];
  const formal = core.recommend(records).options;
  assert.equal(formal.date[0].value, "2020-01");
  assert.equal(formal.pages[0].value, "D65-D69");
  assert.equal(formal.pages.length, 1);
  assert.equal(formal.volume[0].value, "48");
  assert.equal(core.recommend(records, "online").options.date[0].value, "2019-11-04");
});

test("an article number comes from the metadata, independently of the DOI suffix", () => {
  const sources = loadSources();
  const record = sources.crossref({ DOI: "10.1371/journal.pgen.1001412", title: ["Example"], type: "journal-article", "article-number": "e1001412" });
  const proposed = core.recommend([record]).options;
  assert.equal(proposed.DOI[0].value, "10.1371/journal.pgen.1001412");
  assert.equal(proposed.pages[0].value, "e1001412");
  assert.match(proposed.pages[0].sources[0], /文章编号/);
  assert.equal(core.recommend([sources.crossref({ DOI: record.doi, title: ["Example"] })]).options.pages, undefined);
});

test("MEDLINE page ranges expand without a Crossref result, preserving article identifiers", () => {
  const sources = loadSources();
  const doi = "10.1093/nar/gkw257", title = "deepTools2: a next generation web server for deep-sequencing data analysis";
  const medline = sources.europePMC({ doi, title, source: "MED", id: "27079975", pageInfo: "W160-5",
    journalInfo: { journal: { title: "Nucleic Acids Research" }, volume: "44", issue: "W1", yearOfPublication: 2016 } });
  const pages = core.recommend([medline]).options.pages;
  assert.equal(pages[0].value, "W160-W165");
  assert.match(pages[0].sources[0], /MEDLINE/);
  assert.equal(core.expandMedlinePages("1166-7"), "1166-1167");
  assert.equal(core.expandMedlinePages("S281-8"), "S281-S288");
  assert.equal(core.expandMedlinePages("W160-S5"), "W160-S5");
  assert.equal(core.expandMedlinePages("198-2"), "198-2");
  assert.equal(core.expandMedlinePages("e1001412"), "e1001412");
  const crossref = sources.crossref({ DOI: doi, title: [title], type: "journal-article", page: "W160-W165" });
  assert.equal(core.recommend([medline, crossref]).options.pages.length, 1);
  const articleNumber = sources.crossref({ DOI: doi, title: [title], type: "journal-article", "article-number": "e100-5" });
  assert.equal(core.recommend([articleNumber]).options.pages[0].value, "e100-5");
});

test("UGENE keeps the publisher's journal title and uses the explicit MEDLINE abbreviation", () => {
  const sources = loadSources();
  const doi = "10.1093/bioinformatics/bts091", title = "Unipro UGENE: a unified bioinformatics toolkit";
  const crossref = sources.crossref({ DOI: doi, title: [title], type: "journal-article", "container-title": ["Bioinformatics"] });
  const pubmed = sources.europePMC({ doi, title, source: "MED", id: "22368248", journalInfo: {
    journal: { title: "Bioinformatics (Oxford, England)", medlineAbbreviation: "Bioinformatics", isoabbreviation: "Bioinformatics" },
  } });
  const result = core.recommend([crossref, pubmed]).options;
  assert.equal(result.container[0].value, "Bioinformatics");
  assert.equal(result.journalAbbreviation[0].value, "Bioinformatics");
  assert.equal(result.journalAbbreviation[0].sources[0], "Europe PMC · MEDLINE");
  assert.equal(core.recommend([crossref]).options.journalAbbreviation, undefined);
  const alternate = sources.crossref({ DOI: doi, title: [title], type: "journal-article", "short-container-title": ["Bioinform."] });
  assert.equal(core.recommend([alternate, pubmed]).options.journalAbbreviation[0].value, "Bioinformatics");
});

test("sourmash v4 recommends the ISSN-verified ISO 4 abbreviation over the JOSS acronym", () => {
  const sources = loadSources();
  const deposited = {
    DOI: "10.21105/joss.06830", type: "journal-article", ISSN: ["2475-9066"],
    title: ["sourmash v4: A multitool to quickly search, compare, and analyze genomic and metagenomic data sets"],
    "container-title": ["Journal of Open Source Software"], "short-container-title": ["JOSS"],
  };
  const options = core.recommend([sources.crossref(deposited)], "formal", abbreviations).options;
  assert.equal(options.container[0].value, "Journal of Open Source Software");
  assert.deepEqual(options.journalAbbreviation.map(option => option.value), ["J. Open Source Softw.", "JOSS"]);
  assert.deepEqual(options.journalAbbreviation[0].sources, ["本地期刊简称库 · ISO 4"]);
  assert.equal(core.recommend([sources.crossref({ ...deposited, ISSN: [] })], "formal", abbreviations).options.journalAbbreviation[0].value, "JOSS");
});

test("the offline library matches additional ISSNs and exact journal titles across publishers", () => {
  const sources = loadSources();
  const deposited = { DOI: "10.1093/nar/gkw257", title: ["deepTools2"], type: "journal-article",
    "short-container-title": ["NAR"] };
  const lookup = record => core.recommend([sources.crossref({ ...deposited, ...record })], "formal", abbreviations)
    .options.journalAbbreviation[0].value;
  assert.equal(lookup({ ISSN: ["1111-1111", "1362-4962"], "container-title": ["NAR"] }), "Nucleic Acids Res.");
  assert.equal(lookup({ "container-title": ["  Nature   Methods  "] }), "Nat. Methods");
  assert.equal(lookup({ ISSN: ["1367-4811"], "container-title": ["Bioinformatics (Oxford, England)"] }), "Bioinformatics");
  assert.equal(lookup({ "container-title": ["Nucleic Acids Research Letters"] }), "NAR");
  assert.equal(lookup({ ISSN: ["1367-4811", "1362-4962"], "container-title": ["Nucleic Acids Research"] }), "NAR");
});

test("Cooltools preserves explicitly recorded collective authors and flags different personal first authors", () => {
  const sources = loadSources();
  const doi = "10.1371/journal.pcbi.1012067", title = "Cooltools: Enabling high-resolution Hi-C analysis in Python";
  const individuals = [{ given: "Nezar", family: "Abdennur" }, { given: "Sameer", family: "Abraham" }];
  const crossref = author => sources.crossref({ DOI: doi, title: [title], type: "journal-article", author });
  const pubmed = sources.europePMC({ doi, title, source: "MED", id: "38709825", authorList: { author: [
    { collectiveName: "Open2C" }, ...individuals.map(person => ({ firstName: person.given, lastName: person.family })),
  ] } });
  const published = crossref([{ name: "Open2C" }, ...individuals]);
  const personalOnly = crossref(individuals);
  for (const records of [[published, pubmed], [pubmed], [personalOnly, pubmed]]) {
    const recommendation = core.recommend(records);
    assert.equal(recommendation.authorConflict, false);
    const [first, second] = recommendation.options.creators[0].value;
    assert.deepEqual(first, { name: "Open2C", creatorType: "author" });
    assert.equal(second.lastName, "Abdennur");
  }
  assert.equal(core.omitsSingleFieldAuthor(published.fields.creators, personalOnly.fields.creators), true);
  assert.equal(core.recommend([crossref(individuals.slice().reverse()), pubmed]).authorConflict, true);
});

test("PLINK 2 prefers the confirmed citation locator to a deposited DOI suffix", () => {
  const sources = loadSources();
  const doi = "10.1186/s13742-015-0047-8", title = "Second-generation PLINK";
  const crossref = sources.crossref({ DOI: doi, title: [title], type: "journal-article",
    "article-number": "s13742-015-0047-8", "published-print": { "date-parts": [[2015, 12, 1]] } });
  const pubmed = sources.europePMC({ doi, title, source: "MED", id: "25722852", pageInfo: "7",
    journalInfo: { volume: "4", yearOfPublication: 2015, journal: { title: "GigaScience" } } });
  const proposal = core.recommend([crossref, pubmed]).options;
  assert.equal(proposal.pages[0].value, "7");
  assert.equal(proposal.DOI[0].value, doi);
  assert.ok(core.recommend([crossref]).options.pages[0].rank < 0, "Suspicious DOI suffix must require a manual field choice");
});

test("only an explicitly linked published DOI can be recommended and failures leave other sources usable", async () => {
  const preprint = "10.5555/preprint", journal = "10.5555/final";
  const seen = [];
  const sources = loadSources(async (_, url) => {
    seen.push(url);
    if (url.startsWith("https://api.crossref.org/works/")) {
      const doi = decodeURIComponent(url.split("/works/")[1]);
      return { status: 200, response: { message: {
        DOI: doi, title: ["Same scholarly title"], type: doi === preprint ? "posted-content" : "journal-article",
        relation: doi === preprint ? { "is-preprint-of": [{ "id-type": "doi", id: journal }] } : {},
      } } };
    }
    if (url.includes("semanticscholar")) return { status: 429 };
    if (url.includes("openalex")) return { status: 200, response: { doi: "10.5555/unrelated", title: "Wrong record" } };
    return { status: 404 };
  });
  const session = new sources.Session();
  const result = await session.lookup(core.input(preprint));
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[result.preferred].doi, journal);
  assert.equal(result.candidates[0].records.length, 1);
  assert.equal(result.statuses.find(status => status.source === "OpenAlex").status, "DOI 不一致");
  assert.equal(seen.filter(url => url.includes("semanticscholar")).length, 2);
  assert.equal(result.candidates[1].statuses.find(status => status.source === "Semantic Scholar").status, "已限流");
  assert.ok(seen.some(url => url.includes("10.5555%2Ffinal")));
});

test("Crossref queues concurrent lookups and retries one rate-limited DOI without dropping the source", async () => {
  const doi = "10.1038/s41592-024-02523-z";
  const starts = [];
  let active = 0, peak = 0, attempts = 0;
  const sources = loadSources(async (_, url) => {
    if (!url.startsWith("https://api.crossref.org/works/")) return { status: 404 };
    const requested = decodeURIComponent(url.split("/works/")[1]);
    starts.push({ doi: requested, time: Date.now() });
    peak = Math.max(peak, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (requested !== doi) return { status: 404 };
      if (++attempts === 1) return { status: 429, getResponseHeader: () => "1" };
      return { status: 200, response: { message: { DOI: doi, title: ["Nucleotide Transformer"],
        type: "journal-article", publisher: "Springer Science and Business Media LLC", issue: "2",
        "published-print": { "date-parts": [[2025, 2]] }, "published-online": { "date-parts": [[2024, 11, 28]] } } } };
    } finally { active--; }
  });
  const session = new sources.Session();
  const [result] = await Promise.all([session.lookup(core.input(doi)),
    new sources.Session().lookup(core.input("10.5555/another"))]);
  assert.equal(peak, 1);
  assert.deepEqual(starts.map(entry => entry.doi), [doi, doi, "10.5555/another"]);
  assert.ok(starts[1].time - starts[0].time >= 1000);
  assert.equal(result.statuses.find(entry => entry.source === "Crossref").status, "已命中");
  const records = result.candidates[0].records;
  assert.equal(core.recommend(records).options.date[0].value, "2025-02");
  assert.equal(core.recommend(records, "online").options.date[0].value, "2024-11-28");
  assert.equal(core.recommend(records).options.publisher[0].value, "Springer Science and Business Media LLC");
});

test("all other providers retry transient responses and remain available for subsequent rows", async () => {
  const providers = ["Europe PMC", "DataCite", "OpenAlex", "Semantic Scholar", "DBLP"];
  const attempts = new Map();
  const sources = loadSources(async (_, url) => {
    const count = (attempts.get(url) || 0) + 1;
    attempts.set(url, count);
    if (url.endsWith("/first") && count === 1) return { status: url.includes("DataCite") ? 503 : 429 };
    return { status: 200, response: { url } };
  });
  const session = new sources.Session();
  await Promise.all(providers.map(async provider => {
    const base = `https://fixture.invalid/${provider}`;
    const [first, second] = await Promise.all([session.json(provider, `${base}/first`), session.json(provider, `${base}/second`)]);
    assert.equal(first.url, `${base}/first`);
    assert.equal(second.url, `${base}/second`);
    assert.equal(attempts.get(first.url), 2);
    assert.equal(attempts.get(second.url), 1);
  }));
});
