const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const core = require("../addon/modules/metadata/core.js");

function loadSources(request) {
  const scope = { CentersMetadataCore: core, Zotero: { HTTP: { request } } };
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
  assert.equal(seen.filter(url => url.includes("semanticscholar")).length, 1);
  assert.ok(seen.some(url => url.includes("10.5555%2Ffinal")));
});
