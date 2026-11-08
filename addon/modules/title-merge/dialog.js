"use strict";
var controller;
window.addEventListener("DOMContentLoaded", () => {
  const { plugin, pane, preview = {} } = window.arguments[0];
  let initialItems;
  const Z = pane._window?.Zotero || window.opener.Zotero;
  const $ = id => document.getElementById(id);
  controller = { plugin, pane, groups: [], running: false, scanning: false };
  for (const library of Z.Libraries.getAll()) {
    if (!library.editable || library.libraryType === "feed") continue;
    const option = document.createElement("option");
    option.value = `library:${library.libraryID}`;
    option.textContent = `整个文库：${library.name}`;
    $("scope").appendChild(option);
  }
  if (pane.getSelectedItems().length < 2) $("scope").value = "view";

  function updateSelection() {
    const n = controller.groups.filter(group => group.selected).length;
    $("merge").disabled = !n || controller.running || controller.scanning;
    $("merge").textContent = `合并选中的 ${n} 组`;
    $("all").checked = n > 0 && n === controller.groups.length;
    $("all").indeterminate = n > 0 && n < controller.groups.length;
  }

  function render() {
    $("groups").replaceChildren();
    for (const [index, group] of controller.groups.entries()) {
      const card = document.createElement("section"); card.className = "group";
      const header = document.createElement("div"); header.className = "group-header";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = group.selected;
      check.setAttribute("aria-label", `选择 ${group.records[0].data.title}`);
      check.addEventListener("change", () => { group.selected = check.checked; updateSelection(); });
      const title = document.createElement("h2"); title.textContent = group.records[0].data.title;
      const badge = document.createElement("span"); badge.className = "badge";
      badge.textContent = `${group.records.length} 条 · ${new Set(group.records.map(r => r.data.itemType)).size} 种类型`;
      header.append(check, title, badge); card.appendChild(header);
      for (const record of group.records) {
        const row = document.createElement("div"); row.className = "record";
        const radio = document.createElement("input"); radio.type = "radio"; radio.name = `master-${index}`;
        radio.id = `master-${index}-${record.id}`; radio.checked = group.masterID === record.id;
        const label = document.createElement("label"); label.htmlFor = radio.id;
        const strong = document.createElement("strong");
        strong.textContent = Z.ItemTypes.getLocalizedString(record.data.itemType);
        const tag = document.createElement("span"); tag.className = "master-tag";
        tag.textContent = radio.checked ? "主条目" : "";
        const small = document.createElement("small");
        const creators = (record.data.creators || []).map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")).join("; ");
        small.textContent = [record.data.date, record.data.publicationTitle || record.data.proceedingsTitle,
          record.data.DOI && `DOI: ${record.data.DOI}`, creators, `Key: ${record.data.key}`].filter(Boolean).join(" · ");
        label.append(strong, tag, small); row.append(radio, label); card.appendChild(row);
        radio.addEventListener("change", () => {
          group.masterID = record.id;
          for (const sibling of card.querySelectorAll(".record")) {
            sibling.querySelector(".master-tag").textContent = sibling.querySelector("input").checked ? "主条目" : "";
          }
        });
      }
      const details = document.createElement("details"); const summary = document.createElement("summary");
      summary.textContent = "查看原始字段（冲突字段以主条目为准，空字段自动补全）";
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(group.records.map(r => r.data), null, 2);
      details.append(summary, pre); card.appendChild(details); $("groups").appendChild(card);
    }
    if (!controller.groups.length) {
      const empty = document.createElement("div"); empty.className = "empty";
      empty.textContent = "此范围内没有同标题的重复文献。"; $("groups").appendChild(empty);
    }
    updateSelection();
  }

  $("all").addEventListener("change", () => {
    for (const group of controller.groups) group.selected = $("all").checked;
    render();
  });
  $("scope").addEventListener("change", () => {
    controller.groups = []; render();
    $("status").textContent = "范围已更改，请重新扫描。";
  });

  $("scan").addEventListener("click", async () => {
    if (plugin.sidebarOperation) { $("result").textContent = "右侧合并任务正在运行，请完成或停止后再操作。"; return; }
    controller.scanning = true; $("scan").disabled = true; $("scope").disabled = true;
    $("result").textContent = ""; $("status").textContent = "正在扫描…"; updateSelection();
    try {
      const items = initialItems && $("scope").value === "selected"
        ? initialItems : await plugin.getItems($("scope").value, pane);
      initialItems = undefined;
      controller.groups = (await plugin.engine.scan(items)).map(group => ({ ...group, selected: true }));
      const count = controller.groups.reduce((sum, group) => sum + group.records.length, 0);
      $("status").textContent = `找到 ${controller.groups.length} 组，共 ${count} 条记录。可点击单选框更换主条目。`;
      render();
    }
    catch (error) { $("status").textContent = String(error); }
    finally { controller.scanning = false; $("scan").disabled = false; $("scope").disabled = false; updateSelection(); }
  });

  $("merge").addEventListener("click", async () => {
    if (plugin.sidebarOperation) { $("result").textContent = "右侧合并任务正在运行，请完成或停止后再操作。"; return; }
    const groups = controller.groups.filter(group => group.selected);
    controller.running = true; $("scan").disabled = true; $("scope").disabled = true; $("all").disabled = true;
    $("stop").hidden = false; $("stop").disabled = false; $("result").textContent = ""; updateSelection();
    for (const input of $("groups").querySelectorAll("input")) input.disabled = true;
    try {
      const report = await plugin.engine.run(groups, state => {
        $("status").textContent = `正在合并 ${state.completed + 1}/${state.total}：${state.title}`;
      });
      const done = new Set(report.completed.flatMap(result => [result.masterID, ...result.mergedIDs]));
      controller.groups = controller.groups.filter(group => !group.records.some(record => done.has(record.id)));
      $("status").textContent = `已完成 ${report.completed.length} 组${report.cancelled ? "，已停止" : ""}。`;
      $("result").textContent = (report.errors.length ? report.errors.map(error => error.message).join("\n") + "\n请重新扫描后继续。\n" : "")
        + (report.directory ? `合并记录：${report.directory}` : "");
      render();
    }
    catch (error) { $("result").textContent = String(error); }
    finally {
      controller.running = false; $("scan").disabled = false; $("scope").disabled = false; $("all").disabled = false;
      $("stop").hidden = true; updateSelection();
      for (const input of $("groups").querySelectorAll("input")) input.disabled = false;
    }
  });

  $("stop").addEventListener("click", () => { plugin.engine.cancelRequested = true; $("stop").disabled = true; });
  $("archives").addEventListener("click", async () => {
    const path = Z.DataDirectory.dir + "/title-merge-archives";
    const file = Z.File.pathToFile(path);
    if (file.exists()) Z.launchFile(file);
    else $("result").textContent = "执行首次合并后会生成记录目录。";
  });
  window.addEventListener("close", event => {
    if (controller.running) {
      event.preventDefault(); plugin.engine.cancelRequested = true;
      $("status").textContent = "正在完成当前组，请稍后关闭。";
    }
  });
  window.titleMergePreview = options => {
    if (controller.running || controller.scanning) return;
    $("scope").value = options.scope || "selected";
    initialItems = options.items;
    $("scan").click();
  };
  if (preview.autoScan) window.titleMergePreview(preview);
});
