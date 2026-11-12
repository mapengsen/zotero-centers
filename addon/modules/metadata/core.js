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
    return { kind: "title", value: text };
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

  function titleKey(value) {
    return plain(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
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

  function equivalent(field, a, b) {
    if (field === "creators") return JSON.stringify(a) === JSON.stringify(b);
    if (field === "title") return titleKey(a) === titleKey(b);
    if (field === "DOI") return normalizeDOI(a) === normalizeDOI(b);
    if (field === "pages") return plain(a).replace(/[\s\u2010-\u2015]/g, "-").replace(/-+/g, "-")
      === plain(b).replace(/[\s\u2010-\u2015]/g, "-").replace(/-+/g, "-");
    return plain(a).toLowerCase() === plain(b).toLowerCase();
  }

  function recommend(records, mode = "formal") {
    const ordered = records.slice().sort((a, b) => sourcePriority[b.source] - sourcePriority[a.source]);
    const workType = ordered.find(record => record.type && record.type !== "document")?.type || "document";
    const options = {};
    function add(field, value, record, rank, basis = "") {
      if (field === "creators" ? !value?.length : !plain(value)) return;
      const choices = options[field] ||= [];
      const citation = basis ? `${record.source} · ${basis}` : record.source;
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
        const basis = medlineAbbreviation ? "MEDLINE" : possibleDOISuffix ? "登记编号与 DOI 后缀相同，待核对" : articleNumber ? "文章编号" : "";
        const evidenceRank = (citationField && hasIssue) || medlineAbbreviation ? 60 : 0;
        add(field, value, record, rank + evidenceRank - (possibleDOISuffix ? 150 : 0), basis);
      }
      add("DOI", record.doi, record, rank);
      for (const date of record.dates) {
        // Prefer a source's evidence category, then its authority, never the largest year.
        add("date", date.value, record, dateRank[date.kind] + rank, dateLabel[date.kind]);
      }
    }
    for (const choices of Object.values(options)) choices.sort((a, b) => b.rank - a.rank);
    return { workType, options };
  }

  return { normalizeDOI, input, parseInputs, plain, titleKey, similarTitle, dateParts, isoDate, creator, equivalent, recommend, fields, types };
})();

if (typeof module !== "undefined") module.exports = CentersMetadataCore;
