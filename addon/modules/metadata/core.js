var CentersMetadataCore = (() => {
  const doiPattern = /^10\.\d{4,9}\/[^\s"\u0000-\u001f]+$/i;
  const types = {
    "journal-article": "journalArticle", "proceedings-article": "conferencePaper",
    "posted-content": "preprint", book: "book", monograph: "book", "edited-book": "book",
    "book-chapter": "bookSection", dissertation: "thesis", report: "report", dataset: "dataset",
  };
  const fields = {
    title: "标题", creators: "作者与编者", DOI: "DOI", container: "期刊／会议录／书名／存档库", journalAbbreviation: "期刊简称",
    date: "发表日期", volume: "卷", issue: "期", pages: "页码／文章编号", publisher: "出版商",
    conferenceName: "会议名称", ISSN: "ISSN", ISBN: "ISBN", PMID: "PMID", PMCID: "PMCID", url: "网址",
  };
  const sourcePriority = { Crossref: 50, "Europe PMC": 40, DataCite: 30, DBLP: 20, OpenAlex: 18, "Semantic Scholar": 10 };

  function normalizeDOI(value) {
    let text = String(value || "").trim().replace(/^doi:\s*/i, "");
    const url = text.match(/^https?:\/\/(?:dx\.)?doi\.org\/([^?#]+)(?:[?#].*)?$/i);
    if (url) text = url[1];
    try { text = decodeURIComponent(text); } catch { /* Keep a literal percent escape. */ }
    return doiPattern.test(text) ? text.toLowerCase() : "";
  }

  function input(value) {
    const text = String(value || "").trim();
    const doi = normalizeDOI(text);
    if (doi) return { kind: "doi", value: doi };
    const pmid = text.match(/^(?:pmid[:\s]+|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)?([1-9]\d{0,8})\/?$/i);
    if (pmid) return { kind: "pmid", value: pmid[1] };
    const arxiv = text.match(/^(?:arxiv:\s*|https?:\/\/arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i);
    if (arxiv) return { kind: "doi", value: "10.48550/arxiv." + arxiv[1].toLowerCase() };
    const embedded = text.match(/(?:\bdoi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s"]+)/i);
    const citationDOI = embedded && normalizeDOI(embedded[1].replace(/[.,;]+$/, ""));
    if (citationDOI) return { kind: "doi", value: citationDOI };
    return { kind: "title", value: cleanTitleMarkup(text) };
  }

  function parseInputs(text) {
    const parsed = new Map();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entries = trimmed.split(/[,;，；\s]+/).filter(Boolean).map(input);
      // Split DOI lists only when each token is an identifier. A citation stays intact.
      const queries = entries.length > 1 && entries.every(entry => entry.kind === "doi")
        ? entries : [input(trimmed)];
      for (const query of queries) {
        parsed.set(query.kind + ":" + query.value.toLowerCase(), query);
      }
    }
    return [...parsed.values()];
  }

  function plain(value) {
    return (typeof value === "string" || typeof value === "number" ? String(value) : "")
      .replace(/<\/?(?:i|b|em|strong|sub|sup|jats:[\w-]+)\b[^>]*>/gi, "")
      .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, entity) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " })[entity])
      .replace(/\s+/g, " ").trim();
  }

  function cleanTitleMarkup(value) {
    const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
    const title = text.replace(/<\/?(?:tt|code|monospace)(?:\s+[^<>]*)?>|(?:&lt;|&#0*60;|&#x0*3c;)\/?(?:tt|code|monospace)\s*(?:&gt;|&#0*62;|&#x0*3e;)/gi, "");
    return title === text ? text : title.replace(/\s+/g, " ").replace(/\s+:/g, ":").trim();
  }

  function sourceTitle(value) {
    return plain(cleanTitleMarkup(value));
  }

  function titleKey(value) {
    return sourceTitle(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  }

  function similarTitle(a, b) {
    const x = titleKey(a), y = titleKey(b);
    if (!x || !y || x === y) return true;
    const grams = text => new Set(Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2)));
    const left = grams(x), right = grams(y);
    const shared = [...left].filter(gram => right.has(gram)).length;
    return 2 * shared / (left.size + right.size || 1) >= 0.72;
  }

  function dateParts(parts) {
    const [y, m, d] = parts || [];
    if (!Number.isInteger(y) || y < 1000 || y > 9999) return "";
    if (!Number.isInteger(m) || m < 1 || m > 12) return String(y);
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    if (!Number.isInteger(d) || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return ym;
    return ym + "-" + String(d).padStart(2, "0");
  }

  function isoDate(value) {
    const parts = plain(value).match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T.*)?$/);
    return parts ? dateParts(parts.slice(1).map(Number)) : "";
  }

  function creator(first, last, name, creatorType = "author") {
    first = plain(first); last = plain(last); name = plain(name);
    if (last) return { firstName: first, lastName: last, creatorType };
    if (name) return { name, creatorType };
    return null;
  }

  function expandMedlinePages(value) {
    const pages = plain(value);
    const range = pages.match(/^([a-z]{0,3})([1-9]\d{0,7})\s*[-\u2010-\u2015]\s*([a-z]{0,3})(\d{1,8})$/i);
    if (!range) return pages;
    const [, prefix, first, endPrefix, last] = range;
    if (endPrefix && prefix.toLowerCase() !== endPrefix.toLowerCase()) return pages;
    const expanded = first.slice(0, Math.max(0, first.length - last.length)) + last;
    if (Number(expanded) <= Number(first)) return pages;
    if (expanded === last && (endPrefix || !prefix)) return pages;
    return `${prefix}${first}-${prefix}${expanded}`;
  }

  function equivalent(field, a, b) {
    if (field === "creators") return JSON.stringify(a) === JSON.stringify(b);
    if (field === "title") return titleKey(a) === titleKey(b);
    if (field === "DOI") return normalizeDOI(a) === normalizeDOI(b);
    if (field === "pages") return plain(a).replace(/[\s\u2010-\u2015]/g, "-").replace(/-+/g, "-")
      === plain(b).replace(/[\s\u2010-\u2015]/g, "-").replace(/-+/g, "-");
    return plain(a).toLowerCase() === plain(b).toLowerCase();
  }

  function nameKey(name) {
    return titleKey(plain(name).normalize("NFKD").replace(/\p{M}/gu, ""));
  }

  function sameAuthor(a, b) {
    if (!a || !b) return false;
    if (a.name || b.name) {
      return nameKey(a.name || `${a.firstName} ${a.lastName}`) === nameKey(b.name || `${b.firstName} ${b.lastName}`);
    }
    if (nameKey(a.lastName) !== nameKey(b.lastName)) return false;
    const firstA = nameKey(plain(a.firstName).split(" ")[0]);
    const firstB = nameKey(plain(b.firstName).split(" ")[0]);
    return firstA === firstB || ((firstA.length === 1 || firstB.length === 1) && firstA[0] === firstB[0]);
  }

  function authorsOf(creators = []) {
    return creators.filter(person => person.creatorType === "author");
  }

  function addsCollectives(base, candidate) {
    const groups = new Set((candidate.collectiveAuthors || []).map(nameKey));
    if (!groups.size) return false;
    const current = authorsOf(base.fields.creators);
    const incoming = authorsOf(candidate.fields.creators);
    if (incoming.length <= current.length) return false;
    let index = 0;
    const additions = new Set();
    for (const author of incoming) {
      if (sameAuthor(current[index], author)) index++;
      else {
        const key = nameKey(author.name);
        if (!groups.has(key) || additions.has(key) || current.some(person => sameAuthor(person, author))) return false;
        additions.add(key);
      }
    }
    return index === current.length;
  }

  function reviewAuthors(ordered) {
    const candidates = ordered.filter(record => authorsOf(record.fields.creators).length);
    let preferred = candidates[0];
    if (!preferred) return { preferred, conflict: false };
    for (const record of candidates.slice(1)) {
      if (addsCollectives(preferred, record)) preferred = record;
    }
    const first = authorsOf(preferred.fields.creators)[0];
    const conflict = candidates.some(record => !sameAuthor(first, authorsOf(record.fields.creators)[0])
      && !addsCollectives(record, preferred));
    return { preferred, conflict };
  }

  function omitsSingleFieldAuthor(current, proposed) {
    const incoming = authorsOf(proposed);
    return authorsOf(current).some(author => author.name && !incoming.some(person => sameAuthor(author, person)));
  }

  function journalAbbreviation(records, title, database) {
    if (!database) return "";
    const matches = new Map();
    for (const record of records) {
      if (record.type !== "journalArticle") continue;
      for (const issn of record.issns || [record.fields.ISSN]) {
        const key = plain(issn).toUpperCase();
        if (!Object.hasOwn(database.byISSN, key)) continue;
        const value = database.byISSN[key];
        const normalized = value.toLowerCase();
        if (!matches.has(normalized)) matches.set(normalized, value);
      }
    }
    if (matches.size) return matches.size === 1 ? matches.values().next().value : "";
    const key = plain(title).normalize("NFKC").toLowerCase();
    return Object.hasOwn(database.byTitle, key) ? database.byTitle[key] : "";
  }

  function recommend(records, mode = "formal", abbreviations) {
    const ordered = records.slice().sort((a, b) => sourcePriority[b.source] - sourcePriority[a.source]);
    const workType = ordered.find(record => record.type && record.type !== "document")?.type || "document";
    const authorReview = reviewAuthors(ordered);
    const options = {};
    function add(field, value, source, rank, basis = "") {
      if (field === "creators" ? !value?.length : !plain(value)) return;
      const choices = options[field] ||= [];
      const citation = basis ? `${source} · ${basis}` : source;
      const existing = choices.find(choice => equivalent(field, choice.value, value));
      if (existing) {
        if (!existing.sources.includes(citation)) existing.sources.push(citation);
        existing.rank = Math.max(existing.rank, rank);
      } else {
        choices.push({ value, sources: [citation], rank });
      }
    }
    const dateRank = mode === "online"
      ? { online: 500, issue: 400, print: 350, published: 200, indexed: 100 }
      : { issue: 500, print: 450, published: 300, online: 250, indexed: 100 };
    const dateLabel = { issue: "卷期", print: "纸本", published: "出版日期", online: "在线发表", indexed: "索引日期" };
    for (const record of ordered) {
      const rank = sourcePriority[record.source];
      const hasIssue = record.dates.some(date => date.kind === "issue" || date.kind === "print");
      for (const [field, value] of Object.entries(record.fields)) {
        const citationField = ["volume", "issue", "pages"].includes(field);
        const articleNumber = field === "pages" && record.articleNumber;
        const suffix = record.doi.slice(record.doi.indexOf("/") + 1);
        const possibleDOISuffix = articleNumber && plain(value).toLowerCase() === suffix && !/^[a-z]{0,3}\d+$/i.test(value);
        const medlineAbbreviation = field === "journalAbbreviation" && record.medlineAbbreviation;
        const expandedPages = field === "pages" && record.medlinePagesExpanded;
        const preferredAuthors = field === "creators" && record === authorReview.preferred;
        const collectiveEvidence = field === "creators" && record.collectiveAuthors?.length;
        const basis = medlineAbbreviation ? "MEDLINE" : possibleDOISuffix ? "登记编号与 DOI 后缀相同，待核对"
          : articleNumber ? "文章编号" : expandedPages ? "MEDLINE 页码展开" : collectiveEvidence ? "含团体作者" : "";
        const evidenceRank = (citationField && hasIssue) || medlineAbbreviation || preferredAuthors ? 60 : 0;
        add(field, value, record.source, rank + evidenceRank - (possibleDOISuffix ? 150 : 0), basis);
      }
      add("DOI", record.doi, record.source, rank);
      for (const date of record.dates) {
        // Prefer a source's evidence category, then its authority, never the largest year.
        add("date", date.value, record.source, dateRank[date.kind] + rank, dateLabel[date.kind]);
      }
    }
    if (workType === "journalArticle") {
      const abbreviation = journalAbbreviation(ordered, options.container?.[0]?.value, abbreviations);
      add("journalAbbreviation", abbreviation, "本地期刊简称库", 120, "ISO 4");
    }
    for (const choices of Object.values(options)) choices.sort((a, b) => b.rank - a.rank);
    return { workType, options, authorConflict: authorReview.conflict };
  }

  return { normalizeDOI, input, parseInputs, plain, cleanTitleMarkup, sourceTitle, titleKey, similarTitle, dateParts, isoDate, creator, expandMedlinePages,
    equivalent, omitsSingleFieldAuthor, recommend, fields, types };
})();

if (typeof module !== "undefined") module.exports = CentersMetadataCore;
