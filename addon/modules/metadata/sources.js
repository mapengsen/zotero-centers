var CentersMetadataSources = (() => {
  const core = CentersMetadataCore;
  const { plain, sourceTitle, creator, isoDate, dateParts, normalizeDOI } = core;
  const crossrefURL = "https://api.crossref.org/works";
  // Public pool permits one active request, 5 DOI requests/s and 1 list request/s.
  const crossrefNext = { doi: 0, search: 0 };
  const providerQueues = new Map(), providerCooldowns = new Map();
  const maxRetryWait = 5000;
  const repeatedFailureWait = 30000;
  const europePMCURL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
  const semanticFields = "title,externalIds,journal,publicationTypes,year,publicationDate,venue";
  const array = value => Array.isArray(value) ? value : [];
  const dates = pairs => pairs.filter(([, value]) => value).map(([kind, value]) => ({ kind, value }));
  const crossrefDate = value => dateParts(value?.["date-parts"]?.[0]);
  const doiURL = doi => "https://doi.org/" + doi.split("/").map(encodeURIComponent).join("/");

  function proceedingsFields(container, volume) {
    // NeurIPS deposits its series name and volume together. The official BibTeX separates them.
    const series = "Advances in Neural Information Processing Systems";
    const match = container.match(/^Advances in Neural Information Processing Systems(?: (\d+))?$/i);
    if (!match || (match[1] && volume && volume !== match[1])) return { container, volume };
    return { container: series, volume: volume || match[1] || "" };
  }

  function crossref(record) {
    if (!record) return null;
    const doi = normalizeDOI(record.DOI);
    const title = sourceTitle(record.title?.[0]);
    if (!doi || !title) return null;
    const type = core.types[record.type] || "document";
    const container = plain(record["container-title"]?.[0]) || (type === "preprint" ? plain(record.publisher) : "");
    const volume = plain(record.volume);
    const venue = type === "conferencePaper" ? proceedingsFields(container, volume) : { container, volume };
    const authors = array(record.author).map(person => creator(person.given, person.family, person.name));
    const editors = array(record.editor).map(person => creator(person.given, person.family, person.name, "editor"));
    const issue = record["journal-issue"];
    const issueDate = issue && record.issue && String(issue.issue) === String(record.issue)
      ? crossrefDate(issue["published-print"]) || crossrefDate(issue["published-online"]) : "";
    return {
      source: "Crossref", doi, type, articleNumber: !record.page && Boolean(record["article-number"]),
      issns: array(record.ISSN),
      collectiveAuthors: array(record.author).filter(person => !person.given && !person.family)
        .map(person => plain(person.name)).filter(Boolean),
      fields: {
        title, creators: [...authors, ...editors].filter(Boolean),
        ...venue,
        journalAbbreviation: type === "journalArticle" ? plain(record["short-container-title"]?.[0]) : "",
        issue: plain(record.issue), pages: plain(record.page || record["article-number"]),
        publisher: plain(record.publisher), conferenceName: plain(record.event?.name),
        ISSN: plain(record.ISSN?.[0]), ISBN: plain(record.ISBN?.[0]), url: doiURL(doi),
      },
      dates: dates([
        ["issue", issueDate], ["print", crossrefDate(record["published-print"])],
        ["online", crossrefDate(record["published-online"])],
        ["published", crossrefDate(record.published) || crossrefDate(record.issued) || crossrefDate(record.posted)],
      ]),
      publishedVersions: array(record.relation?.["is-preprint-of"])
        .filter(link => link["id-type"] === "doi").map(link => normalizeDOI(link.id)).filter(Boolean),
      ref: crossrefURL + "/" + encodeURIComponent(doi),
    };
  }

  function europePMC(record) {
    const doi = normalizeDOI(record?.doi);
    const title = sourceTitle(record?.title);
    if (!title || !doi) return null;
    const journal = record.journalInfo || {};
    const preprint = record.source === "PPR" || array(record.pubTypeList?.pubType).some(type => /preprint/i.test(type));
    const medlineAbbreviation = !preprint && plain(journal.journal?.medlineAbbreviation);
    const originalPages = plain(record.pageInfo);
    const pages = !preprint && record.source === "MED" ? core.expandMedlinePages(originalPages) : originalPages;
    const authors = array(record.authorList?.author);
    // Europe PMC can fill missing day/month with 01. Keep only the supplied issue precision.
    const issueText = plain(journal.dateOfPublication).match(/^\d{4}\s+[A-Za-z]{3}\s+(\d{1,2})$/);
    const issueDate = dateParts([Number(journal.yearOfPublication), Number(journal.monthOfPublication), Number(issueText?.[1])]);
    return {
      source: "Europe PMC", doi, type: preprint ? "preprint" : journal.journal?.title ? "journalArticle" : "",
      issns: [journal.journal?.issn, journal.journal?.essn],
      medlineAbbreviation: Boolean(medlineAbbreviation),
      medlinePagesExpanded: pages !== originalPages,
      collectiveAuthors: authors.map(person => plain(person.collectiveName)).filter(Boolean),
      fields: {
        title, creators: authors.map(person => plain(person.collectiveName)
          ? creator("", "", person.collectiveName) : creator(person.firstName, person.lastName, person.fullName)).filter(Boolean),
        container: plain(journal.journal?.title), volume: plain(journal.volume), issue: plain(journal.issue),
        journalAbbreviation: !preprint ? medlineAbbreviation || plain(journal.journal?.isoabbreviation) : "",
        pages, ISSN: plain(journal.journal?.issn || journal.journal?.essn),
        PMID: plain(record.pmid || (record.source === "MED" ? record.id : "")), PMCID: plain(record.pmcid),
        url: doiURL(doi),
      },
      dates: dates([
        ["issue", !preprint && (journal.issue || journal.volume) ? issueDate : ""],
        ["online", isoDate(record.electronicPublicationDate || journal.electronicPublicationDate)],
        ["indexed", isoDate(record.pubYear) || isoDate(record.firstPublicationDate)],
      ]),
      ref: record.source === "MED" && /^\d+$/.test(record.id)
        ? `https://pubmed.ncbi.nlm.nih.gov/${record.id}/` : europePMCURL + "?query=" + encodeURIComponent(`DOI:"${doi}"`),
    };
  }

  function datacite(record) {
    const doi = normalizeDOI(record?.doi);
    const title = sourceTitle(record?.titles?.[0]?.title);
    if (!doi || !title) return null;
    const type = ({ Preprint: "preprint", JournalArticle: "journalArticle", ConferencePaper: "conferencePaper",
      Book: "book", BookChapter: "bookSection", Dissertation: "thesis", Report: "report", Dataset: "dataset" })[record.types?.resourceTypeGeneral] || "document";
    const listed = array(record.dates);
    return {
      source: "DataCite", doi, type,
      fields: {
        title, creators: array(record.creators).map(person => creator(person.givenName, person.familyName, person.name)).filter(Boolean),
        publisher: plain(record.publisher?.name || record.publisher),
        container: type === "preprint" ? plain(record.publisher?.name || record.publisher) : "",
        url: doiURL(doi),
      },
      dates: dates([["published", isoDate(listed.find(date => date.dateType === "Issued")?.date) || isoDate(record.publicationYear)]]),
      publishedVersions: array(record.relatedIdentifiers).filter(link => link.relationType === "IsPreprintOf" && link.relatedIdentifierType === "DOI")
        .map(link => normalizeDOI(link.relatedIdentifier)).filter(Boolean),
      ref: "https://api.datacite.org/dois/" + encodeURIComponent(doi),
    };
  }

  function semantic(record) {
    const doi = normalizeDOI(record?.externalIds?.DOI);
    const title = sourceTitle(record?.title);
    if (!doi || !title) return null;
    const publicationTypes = array(record.publicationTypes);
    const type = publicationTypes.includes("JournalArticle") ? "journalArticle"
      : publicationTypes.includes("Conference") ? "conferencePaper" : "";
    return {
      source: "Semantic Scholar", doi, type,
      fields: { title, container: plain(record.journal?.name || record.venue), volume: plain(record.journal?.volume),
        pages: plain(record.journal?.pages), url: doiURL(doi) },
      dates: dates([["indexed", isoDate(record.publicationDate) || isoDate(record.year)]]),
      ref: /^\w+$/.test(record.paperId || "") ? "https://www.semanticscholar.org/paper/" + record.paperId : doiURL(doi),
    };
  }

  function openalex(record) {
    const doi = normalizeDOI(record?.doi);
    const title = sourceTitle(record?.title);
    if (!doi || !title) return null;
    const location = record.primary_location;
    const biblio = record.biblio || {};
    const first = plain(biblio.first_page), last = plain(biblio.last_page);
    const type = record.type === "preprint" ? "preprint"
      : record.type === "conference-paper" || location?.raw_type === "proceedings-article" ? "conferencePaper"
      : location?.source?.type === "journal" ? "journalArticle" : "";
    const volume = plain(biblio.volume);
    const venue = type === "conferencePaper" ? proceedingsFields(plain(location?.raw_source_name), volume)
      : { container: plain(location?.source?.display_name), volume };
    return {
      source: "OpenAlex", doi, type,
      issns: [location?.source?.issn_l, ...array(location?.source?.issn)],
      fields: { title, ...venue,
        issue: plain(biblio.issue), pages: first && last && first !== last ? `${first}-${last}` : first || last,
        ISSN: plain(location?.source?.issn_l), url: doiURL(doi) },
      dates: dates([["indexed", isoDate(record.publication_date) || isoDate(record.publication_year)]]),
      ref: /^https:\/\/openalex\.org\/W\d+$/.test(record.id || "") ? record.id : doiURL(doi),
    };
  }

  function dblp(record) {
    const doi = normalizeDOI(record?.doi);
    const title = sourceTitle(record?.title);
    if (!doi || !title) return null;
    const type = record.type === "Journal Articles" ? "journalArticle"
      : record.type === "Conference and Workshop Papers" ? "conferencePaper" : "";
    return {
      source: "DBLP", doi, type,
      fields: { title, container: plain(record.venue), volume: plain(record.volume), issue: plain(record.number), pages: plain(record.pages), url: doiURL(doi) },
      dates: dates([["indexed", isoDate(record.year)]]),
      ref: typeof record.url === "string" && record.url.startsWith("https://dblp.org/") ? record.url : doiURL(doi),
    };
  }

  class Session {
    constructor() {
      this.requests = new Map();
      this.cancellers = new Set();
      this.stopped = false;
    }

    stop() {
      this.stopped = true;
      for (const cancel of this.cancellers) cancel();
    }

    async json(source, url) {
      if (this.stopped) throw new Error("查询已取消");
      if (this.requests.has(url)) return this.requests.get(url);
      const request = (providerQueues.get(source) || Promise.resolve()).then(() => this.fetchJSON(source, url));
      const tail = request.catch(() => {});
      providerQueues.set(source, tail);
      this.requests.set(url, request);
      try { return await request; }
      catch (error) {
        this.requests.delete(url);
        throw error;
      } finally {
        if (providerQueues.get(source) === tail) providerQueues.delete(source);
      }
    }

    async pause(ms) {
      if (ms <= 0 || this.stopped) return;
      let cancel;
      const stopped = new Promise(resolve => { cancel = resolve; this.cancellers.add(resolve); });
      try { await Promise.race([Zotero.Promise.delay(ms), stopped]); }
      finally { this.cancellers.delete(cancel); }
    }

    async fetchJSON(source, url) {
      const kind = source === "Crossref" && (url.startsWith(crossrefURL + "?") ? "search" : "doi");
      for (let attempt = 0; attempt < 2; attempt++) {
        const now = Date.now();
        const cooldown = providerCooldowns.get(source);
        if (cooldown && cooldown.until - now > maxRetryWait) throw new Error(cooldown.message);
        await this.pause(Math.max(kind ? crossrefNext[kind] : 0, cooldown?.until || 0) - now);
        if (this.stopped) throw new Error("查询已取消");
        if (kind) crossrefNext[kind] = Date.now() + (kind === "search" ? 1050 : 210);
        const xhr = await this.requestJSON(url);
        if (xhr.status === 404) return null;
        if (xhr.status === 200) {
          if (!xhr.response) throw new Error("返回格式异常");
          return xhr.response;
        }
        const header = xhr.getResponseHeader?.("Retry-After")?.trim() || "";
        const wait = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        const delay = Math.max(attempt ? repeatedFailureWait : 1000, Number.isFinite(wait) ? wait : 0);
        const message = xhr.status === 429 ? "已限流" : "查询失败";
        providerCooldowns.set(source, { until: Date.now() + delay, message });
        if (attempt || delay > maxRetryWait) throw new Error(message);
      }
    }

    async requestJSON(url) {
      let cancel;
      try {
        return await Zotero.HTTP.request("GET", url, {
          responseType: "json", headers: { Accept: "application/json" }, timeout: 9000,
          errorDelayMax: 0, successCodes: [200, 404, 429, 502, 503, 504],
          cancellerReceiver: fn => { cancel = fn; this.cancellers.add(fn); },
        });
      } finally {
        this.cancellers.delete(cancel);
      }
    }

    async query(source, fn) {
      try {
        const records = (await fn()).filter(Boolean);
        return { source, records, status: records.length ? "已命中" : "无匹配" };
      } catch (error) {
        // HTTP errors can contain a request URL. Keep user queries out of diagnostics.
        const status = this.stopped ? "已取消" : error?.message === "已限流" ? "已限流" : "查询失败";
        return { source, records: [], status };
      }
    }

    async pmc(query) {
      const url = `${europePMCURL}?format=json&resultType=core&pageSize=8&query=${encodeURIComponent(query)}`;
      const data = await this.json("Europe PMC", url);
      return array(data?.resultList?.result).map(europePMC).filter(Boolean);
    }

    async doi(doi) {
      const escaped = encodeURIComponent(doi);
      const results = await Promise.all([
        this.query("Crossref", async () => [crossref((await this.json("Crossref", crossrefURL + "/" + escaped))?.message)]),
        this.query("Europe PMC", () => this.pmc(`DOI:"${doi}"`)),
        this.query("DataCite", async () => [datacite((await this.json("DataCite", "https://api.datacite.org/dois/" + escaped))?.data?.attributes)]),
        this.query("OpenAlex", async () => [openalex(await this.json("OpenAlex",
          `https://api.openalex.org/works/${doiURL(doi)}?select=id,doi,title,type,publication_date,publication_year,biblio,primary_location`))]),
        this.query("Semantic Scholar", async () => [semantic(await this.json("Semantic Scholar",
          `https://api.semanticscholar.org/graph/v1/paper/DOI:${escaped}?fields=${semanticFields}`))]),
      ]);
      for (const result of results) {
        result.records = result.records.filter(record => record.doi === doi);
        if (result.status === "已命中" && !result.records.length) result.status = "DOI 不一致";
      }
      const title = results.flatMap(result => result.records)[0]?.fields.title;
      if (title && !this.stopped) {
        results.push(await this.query("DBLP", async () => {
          const words = title.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 10).join(" ");
          if (!words) return [];
          const data = await this.json("DBLP", `https://dblp.org/search/publ/api?format=json&h=15&q=${encodeURIComponent(words)}`);
          return array(data?.result?.hits?.hit).map(hit => dblp(hit.info)).filter(record => record?.doi === doi);
        }));
      }
      return results;
    }

    async lookup(query) {
      if (query.kind === "title") {
        const response = await this.query("Crossref", async () => {
          const url = `${crossrefURL}?rows=6&query.bibliographic=${encodeURIComponent(query.value)}`;
          return array((await this.json("Crossref", url))?.message?.items).map(crossref);
        });
        const hits = [...new Map(response.records.map(record => [record.doi, record])).values()];
        return { hits, candidates: [], statuses: [response] };
      }
      let doi = query.value;
      let seed;
      if (query.kind === "pmid") {
        const result = await this.query("Europe PMC", () => this.pmc(`EXT_ID:${query.value} AND SRC:MED`));
        seed = result.records.find(record => record.fields.PMID === query.value);
        if (!seed) return { hits: [], candidates: [], statuses: [result] };
        doi = seed.doi;
      }
      const statuses = await this.doi(doi);
      const records = statuses.flatMap(result => result.records);
      if (seed && !records.some(record => record.source === "Europe PMC" && record.fields.PMID === query.value)) records.push(seed);
      if (!records.length) return { hits: [], candidates: [], statuses };
      const candidates = [{ doi, records, relation: "" }];
      const versions = new Map();
      for (const record of records) {
        for (const version of record.publishedVersions || []) {
          if (version !== doi && !versions.has(version)) versions.set(version, record.source);
        }
      }
      // Query only an explicitly declared relation. Multiple claimed versions require a human choice.
      for (const [version, source] of [...versions].slice(0, 3)) {
        if (this.stopped) break;
        const evidence = await this.doi(version);
        const related = evidence.flatMap(result => result.records);
        if (related.some(record => ["journalArticle", "conferencePaper", "bookSection"].includes(record.type))) {
          candidates.push({ doi: version, records: related, relation: `${source} · isPreprintOf`, statuses: evidence });
        }
      }
      return { hits: [], candidates, statuses, preferred: versions.size === 1 && candidates.length === 2 ? 1 : 0,
        unresolvedVersion: versions.size > 0 && candidates.length === 1 || versions.size > 1 };
    }
  }

  return { Session, crossref, europePMC, datacite, semantic, openalex, dblp, doiURL };
})();
