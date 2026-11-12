window.addEventListener("DOMContentLoaded", () => {
  const { plugin, mode, destination, originals, importFile } = window.arguments[0];
  const { engine, sources } = plugin;
  const core = engine.core;
  const importing = mode === "import";
  const byID = id => document.getElementById(id);
  const rowsNode = byID("results");
  const entries = byID("entries");
  const dateMode = byID("date-mode");
  const applyButton = byID("apply");
  const lookupButton = byID("lookup");
  const importButton = byID("import-file");
  const stopButton = byID("stop");
  const inputRows = [];
  let rows = [], session, busy = "", stopped = false;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function status(text) { byID("status").textContent = text; }

  function setBusy(value) {
    busy = value;
    for (const control of [lookupButton, importButton, entries, dateMode, ...inputRows.map(row => row.input)]) control.disabled = Boolean(busy);
    stopButton.hidden = !busy;
    stopButton.textContent = busy === "save" ? "写完当前条目后停止" : "停止查询";
    updateApply();
  }

  function valueLabel(value) {
    if (Array.isArray(value)) return value.map(person => `${person.name || [person.firstName, person.lastName].filter(Boolean).join(" ")}${person.creatorType === "editor" ? "（编）" : ""}`).join("；");
    return value || "";
  }

  function sourceLink(label, url) {
    const button = node("button", label, "link");
    button.addEventListener("click", () => plugin.launch(url));
    return button;
  }

  function addOption(select, label, value) {
    const option = node("option", label);
    option.value = value;
    select.append(option);
  }

  function showSources(parent, row) {
    const queried = row.candidate?.statuses || row.lookup?.statuses || [];
    const refs = new Map(row.candidate?.records.map(record => [record.source, record.ref]) || []);
    const detail = node("details");
    const unavailable = queried.filter(entry => entry.status === "已限流" || entry.status === "查询失败").length;
    detail.append(node("summary", unavailable ? `查询来源（${unavailable} 个暂不可用）` : "查询来源"));
    const list = node("p", undefined, "muted");
    for (const { source, status } of queried) {
      if (list.childNodes.length) list.append(" · ");
      if (refs.has(source)) list.append(sourceLink(source, refs.get(source)));
      else list.append(source);
      list.append(`（${status}）`);
    }
    if (row.candidate) list.append(" · ", sourceLink("DOI 出版页面", sources.doiURL(row.candidate.doi)));
    detail.append(list);
    parent.append(detail);
  }

  function requiresValue(preview, name) {
    return (!preview.original && (name === "title" || name === "DOI")) || (preview.doiChanged && name === "DOI");
  }

  function selectedOptionIndex(row, field) {
    let index = field.preferred;
    if (Object.hasOwn(row.choices, field.name)) {
      const stored = row.choices[field.name];
      if (stored === null) index = -1;
      else {
        const chosen = field.options.findIndex(option => core.equivalent(field.name, stored, option.value));
        if (chosen >= 0) index = chosen;
      }
    }
    return index < 0 && requiresValue(row.preview, field.name) ? 0 : index;
  }

  function plannedValue(row, field) {
    const choice = field.options[selectedOptionIndex(row, field)]?.value;
    return choice != null && engine.fieldChanges(row.preview, field, choice) ? choice : undefined;
  }

  function hasChanges(row) {
    const { preview } = row;
    return Boolean(preview && (preview.type !== preview.original?.type
      || preview.fields.some(field => plannedValue(row, field) !== undefined)));
  }

  function renderFields(card, row, updateSelection) {
    const { preview } = row;
    const detail = node("details", undefined, "fields");
    detail.open = row.expanded;
    detail.addEventListener("toggle", () => { row.expanded = detail.open; });
    const conflicts = preview.fields.filter(field => field.options.length > 1).length;
    detail.append(node("summary", conflicts ? `字段对照（${conflicts} 项有多个来源值）` : "字段对照"));
    const table = node("table");
    const header = node("tr");
    for (const label of ["字段", "当前值", "写入值与来源"]) header.append(node("th", label));
    table.append(header);
    for (const field of preview.fields) {
      const line = node("tr");
      line.append(node("td", field.label), node("td", valueLabel(field.current) || "—", "muted"));
      const cell = node("td");
      const select = node("select");
      select.dataset.field = field.name;
      select.setAttribute("aria-label", field.label);
      if (!requiresValue(preview, field.name)) addOption(select, preview.original ? "保留当前值" : "留空", -1);
      for (const [index, option] of field.options.entries()) {
        addOption(select, `${index === 0 && option.rank >= 0 ? "推荐 · " : ""}${valueLabel(option.value)} 〔${option.sources.join("、")}〕`, index);
      }
      select.value = selectedOptionIndex(row, field);
      select.title = select.selectedOptions[0]?.textContent || "";
      select.disabled = Boolean(busy || row.saved || row.duplicate);
      select.addEventListener("change", () => {
        row.choices[field.name] = Number(select.value) < 0 ? null : field.options[Number(select.value)].value;
        select.title = select.selectedOptions[0]?.textContent || "";
        updateSelection();
        updateApply();
      });
      cell.append(select);
      line.append(cell);
      table.append(line);
    }
    detail.append(table);
    card.append(detail);
  }

  function renderRow(row) {
    const card = node("article", undefined, "result");
    const heading = node("div", undefined, "row-heading");
    const include = node("input");
    include.type = "checkbox";
    include.className = "include";
    const unchanged = node("p", "没有待写入的改动", "muted no-changes");
    const updateSelection = () => {
      const pending = hasChanges(row);
      include.checked = Boolean(row.included && pending);
      include.disabled = Boolean(busy || row.duplicate || row.saved || !pending);
      unchanged.hidden = !row.preview || row.duplicate || row.saved || pending;
    };
    updateSelection();
    include.setAttribute("aria-label", "写入此条目");
    include.addEventListener("change", () => { row.included = include.checked; updateApply(); });
    heading.append(include, node("h2", row.original?.title || row.preview?.fields.find(field => field.name === "title")?.options[0].value || row.query.value));
    card.append(heading);
    if (row.lookup?.hits.length) {
      const select = node("select");
      select.className = "title-candidates";
      select.setAttribute("aria-label", "选择匹配的文献");
      addOption(select, "选择匹配的文献以核验 DOI", "");
      for (const hit of row.lookup.hits) {
        addOption(select, `${hit.fields.title} · ${hit.fields.container || plugin.typeLabel(hit.type)} · ${hit.dates[0]?.value || ""} · ${hit.doi}`, hit.doi);
      }
      select.value = row.chosenHit || "";
      select.disabled = Boolean(busy || row.saved);
      select.addEventListener("change", () => pickTitle(row, select.value));
      card.append(select);
    }
    if (!row.preview) {
      card.append(node("p", row.message || (row.lookup?.hits.length ? "选择正确的标题与 DOI 后继续。" : "查询中…"), "muted"));
      if (row.lookup?.statuses.length) showSources(card, row);
      return card;
    }
    if (row.resolved.candidates.length > 1) {
      const select = node("select");
      select.className = "versions";
      select.setAttribute("aria-label", "文献版本");
      for (const [i, candidate] of row.resolved.candidates.entries()) {
        const title = core.recommend(candidate.records).options.title[0].value;
        addOption(select, `${candidate.relation ? "关联出版版" : "查询版本"} · ${title} · ${candidate.doi}`, i);
      }
      select.value = row.resolved.candidates.indexOf(row.candidate);
      select.disabled = Boolean(busy || row.saved);
      select.addEventListener("change", () => selectVersion(row, Number(select.value)));
      card.append(select);
    }
    const summary = row.preview.fields.find(field => field.name === "date")?.options[0].value;
    card.append(node("p", [row.candidate.doi, plugin.typeLabel(row.preview.type), summary, row.candidate.relation].filter(Boolean).join(" · "), "muted"));
    if (row.preview.original && row.preview.original.type !== row.preview.suggestedType && row.preview.suggestedType !== "document") {
      const label = node("label");
      const changeType = node("input");
      changeType.type = "checkbox";
      changeType.className = "change-type";
      changeType.checked = row.changeType;
      changeType.disabled = Boolean(busy || row.saved || row.duplicate);
      changeType.addEventListener("change", () => {
        row.changeType = changeType.checked;
        row.included = false;
        row.choices = {};
        row.preview = engine.preview(row, row.candidate, dateMode.value, row.changeType);
        render();
      });
      label.append(changeType, ` 转为${plugin.typeLabel(row.preview.suggestedType)}`);
      card.append(label);
    }
    const warnings = [];
    if (row.resolved.unresolvedVersion) warnings.push("出版版本关系需要人工确认");
    if (row.preview.titleMismatch) warnings.push("推荐标题与当前标题差异较大，请核对后勾选");
    if (row.preview.doiChanged) warnings.push(`当前 DOI 为 ${row.original.doi}，请核对版本后勾选`);
    if (row.preview.authorConflict) warnings.push(row.preview.original
      ? "来源第一作者有冲突，已默认保留当前作者，请核对作者栏"
      : "来源第一作者有冲突，请核对作者栏后勾选");
    if (row.preview.omitsSingleFieldAuthor) warnings.push("推荐记录缺少当前的单栏作者，已默认保留当前作者");
    if (row.preview.conferencePublisherConflict) warnings.push("会议论文的出版社与来源记录不同，已默认保留当前值");
    if (row.preview.dateConflict) warnings.push("来源年份有冲突，卷期日期待人工确认");
    else if (row.preview.preserveIssueDate) warnings.push("暂未查到卷期日期，已默认保留当前日期");
    else if (row.preview.lacksIssueDate) warnings.push("暂未查到卷期或纸本日期");
    if (row.preview.missingTypeFields.length) warnings.push(`类型转换可能移除专属字段（${row.preview.missingTypeFields.join("、")}），原值保存在本地备份`);
    if (row.original?.attachment) warnings.push("会创建文献条目并关联原 PDF，请核对后勾选");
    if (row.duplicate) warnings.push("目标文库已有此 DOI");
    if (row.message) warnings.push(row.message);
    if (warnings.length) card.append(node("p", warnings.join("。"), row.saved ? "muted" : "warning"));
    card.append(unchanged);
    renderFields(card, row, updateSelection);
    showSources(card, { ...row, lookup: row.resolved });
    return card;
  }

  function render() {
    rowsNode.replaceChildren(...rows.map(renderRow));
    updateApply();
  }

  function eligible(row) { return row.included && !row.duplicate && !row.saved && hasChanges(row); }

  function updateApply() {
    const count = rows.filter(eligible).length;
    applyButton.disabled = Boolean(busy) || !count;
    applyButton.textContent = count ? `写入 ${count} 条` : "无待写入条目";
  }

  async function chooseVersion(row, index) {
    row.candidate = row.resolved.candidates[index];
    row.changeType = Boolean(row.candidate.relation && row.original?.type === "preprint");
    row.preview = engine.preview(row, row.candidate, dateMode.value, row.changeType);
    row.choices = {};
    row.message = "";
    const changedDOI = row.candidate.doi !== row.original?.doi;
    row.duplicate = changedDOI && (await engine.findDuplicates(row.original?.libraryID || destination.libraryID, row.candidate.doi, row.original?.id)).length > 0;
    const unreviewedNewAuthors = !row.preview.original && row.preview.authorConflict;
    row.included = !row.duplicate && !row.preview.titleMismatch && !row.preview.doiChanged && !row.original?.attachment
      && !row.resolved.unresolvedVersion && !row.changeType && !unreviewedNewAuthors;
  }

  async function selectVersion(row, index) {
    setBusy("preview");
    try { await chooseVersion(row, index); }
    catch (error) { row.included = false; row.message = error.message; }
    finally { setBusy(""); render(); }
  }

  async function searchRow(row, query) {
    row.resolved = await session.lookup(query);
    if (!row.lookup) row.lookup = row.resolved;
    if (row.resolved.candidates.length) await chooseVersion(row, row.resolved.preferred || 0);
    else row.message = row.resolved.hits.length ? "" : "未查到可核对的文献，检查标识符或标题后重试。";
  }

  async function pickTitle(row, doi) {
    if (busy) return;
    row.chosenHit = doi;
    row.preview = null;
    row.candidate = null;
    row.included = false;
    row.message = "";
    if (!doi) { render(); return; }
    if (!session || session.stopped) session = new sources.Session();
    stopped = false;
    setBusy("lookup");
    status("正在核验所选 DOI…");
    render();
    try { await searchRow(row, { kind: "doi", value: doi }); }
    catch (error) { row.message = error.message; }
    finally {
      if (!window.closed) {
        setBusy("");
        status(stopped ? "已停止查询" : "核对字段与来源后，写入勾选的条目。");
        render();
      }
    }
  }

  async function lookup() {
    if (busy) return;
    const queries = importing ? core.parseInputs(entries.value).map(query => ({ query }))
      : inputRows.map(row => ({ query: core.input(row.input.value), original: row.original }));
    if (!queries.length || queries.some(row => !row.query.value)) { status("请输入标识符或标题。"); return; }
    if (queries.some(row => row.query.value.length > 500)) { status("单条查询过长，请使用标识符、标题或简短参考文献。"); return; }
    rows = queries.map((row, i) => ({ ...row, expanded: i === 0, message: "等待查询…" }));
    session = new sources.Session();
    stopped = false;
    setBusy("lookup");
    status(`正在查询 ${rows.length} 条…`);
    render();
    let next = 0, done = 0;
    async function worker() {
      while (!stopped && next < rows.length) {
        const row = rows[next++];
        try {
          if (row.original) row.original = await engine.snapshotForQuery(row.original);
          await searchRow(row, row.query);
        }
        catch (error) { row.included = false; row.message = error.message; }
        if (!window.closed) status(`已查询 ${++done} / ${rows.length}`);
      }
    }
    await Promise.all([worker(), worker()]);
    if (window.closed) return;
    if (stopped) for (const row of rows.slice(next)) row.message = "查询已停止";
    setBusy("");
    status(stopped ? `已停止查询，完成 ${done} / ${rows.length}` : "核对字段与来源后，写入勾选的条目。");
    render();
  }

  function planFor(row) {
    const fields = {};
    for (const field of row.preview.fields) {
      const choice = plannedValue(row, field);
      if (choice !== undefined) fields[field.name] = choice;
    }
    return { row, original: row.original, destination, candidate: row.candidate, preview: row.preview, fields };
  }

  async function apply() {
    if (busy) return;
    const plans = rows.filter(eligible).map(planFor);
    if (!plans.length) return;
    stopped = false;
    setBusy("save");
    render();
    let success = 0, unchanged = 0, failure = 0;
    status(`正在写入 ${plans.length} 条…`);
    try {
      await plugin.apply(plans, (plan, result) => {
        if (result.error) failure++;
        else if (result.action === "无差异") unchanged++;
        else success++;
        plan.row.saved = !result.error;
        plan.row.included = false;
        plan.row.message = result.error || result.action;
        if (!window.closed) status(`已处理 ${success + unchanged + failure} / ${plans.length}`);
      }, () => stopped || window.closed);
      if (!window.closed) status(`完成 ${success} 条${unchanged ? `，无差异 ${unchanged} 条` : ""}，失败或跳过 ${failure} 条${stopped ? "，已停止" : ""}。`);
    } catch (error) { if (!window.closed) status(error.message); }
    finally { if (!window.closed) { setBusy(""); render(); } }
  }

  byID("heading").textContent = importing ? "批量添加文献" : "查询并更新元数据";
  byID("destination").textContent = importing ? `查询到的条目将添加到 ${destination.name}` : `已选择 ${originals.length} 条文献或独立 PDF`;
  byID("import-input").hidden = !importing;
  for (const original of originals) {
    const label = node("label");
    const title = node("span", original.title || original.key);
    title.title = title.textContent;
    const input = node("input");
    input.type = "text";
    input.value = original.doi || (original.data.PMID ? `PMID:${original.data.PMID}` : original.title.replace(/\.pdf$/i, ""));
    input.placeholder = "DOI、PMID、arXiv ID 或标题";
    label.append(title, input);
    byID("update-inputs").append(label);
    inputRows.push({ input, original });
  }
  status(importing ? "从文件导入，或粘贴标识符和标题后开始查询。" : "可修改查询值。原位更新会保留条目键，并备份原始记录。");
  if (importFile) importButton.addEventListener("click", () => {
    try { importFile(); }
    catch (error) { status(`打开 Zotero 导入向导失败。${error.message}`); }
  });
  lookupButton.addEventListener("click", lookup);
  applyButton.addEventListener("click", apply);
  stopButton.addEventListener("click", () => {
    stopped = true;
    if (busy === "lookup") session?.stop();
  });
  dateMode.addEventListener("change", () => {
    for (const row of rows.filter(row => row.preview && !row.saved)) {
      row.preview = engine.preview(row, row.candidate, dateMode.value, row.changeType);
      delete row.choices.date;
    }
    render();
  });
  window.addEventListener("unload", () => { stopped = true; session?.stop(); });
  (importing ? entries : inputRows[0]?.input)?.focus();
}, { once: true });
