/* global Zotero */
var InlineExtraPlugin = (() => {
  const HTML = "http://www.w3.org/1999/xhtml";
  const fields = { extra: { multiline: true }, shortTitle: { multiline: false } };
  const cellSelector = () => Object.keys(fields).map(field => `.cell.${field}`).join(', ');
  const controllers = new Map();
  const copy = {
    zh: {
      labels: { extra: "其他", shortTitle: "短标题" },
      help: "Enter 保存 · Shift+Enter 换行 · Esc 取消", singleLineHelp: "Enter 保存 · Esc 取消",
      save: "保存", cancel: "取消", saving: "正在保存…",
      readonly: "此条目不可编辑（只读文库、订阅或回收站）。",
      conflict: "此字段已在别处修改。内容尚未保存；请复制输入，按 Esc 后重新编辑。",
      failure: "保存失败，输入仍保留。可重试或复制内容：",
    },
    en: {
      labels: { extra: "Extra", shortTitle: "Short Title" },
      help: "Enter save · Shift+Enter new line · Esc cancel", singleLineHelp: "Enter save · Esc cancel",
      save: "Save", cancel: "Cancel", saving: "Saving…",
      readonly: "This item is not editable (read-only library, feed, or trash).",
      conflict: "This field changed elsewhere. Copy your draft, press Esc, and reopen the editor.",
      failure: "Could not save. Your draft is retained; retry or copy it: ",
    },
  };

  function canEdit(item, field = "extra") {
    return !!(item?.id && item.isRegularItem?.() && !item.deleted
      && !item.isFeedItem && fields[field] && item.isEditable()
      && (fields[field].adapter || Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), item.itemTypeID)));
  }

  class Controller {
    constructor(window) {
      this.window = window;
      this.document = window.document;
      this.text = copy[String(Zotero.locale).startsWith("zh") ? "zh" : "en"];
      this.listeners = [];
      this.queue = Promise.resolve();
      this.disposed = false;
      const on = (target, type, fn, capture = false) => {
        target.addEventListener(type, fn, capture);
        this.listeners.push(() => target.removeEventListener(type, fn, capture));
      };
      this.style = this.create("style");
      this.style.textContent = `
        #zotero-items-tree .row:not(.context-row) :is(${cellSelector()}) { cursor: text; align-self: stretch; }
        #zotero-items-tree .row :is(${cellSelector()}):hover { box-shadow: inset 0 0 0 1px #4a82e6; }
        #inline-extra-editor {
          position: fixed; z-index: 2147483000; box-sizing: border-box;
          display: flex; flex-direction: column; gap: 5px; padding: 5px;
          background: var(--material-background, Canvas); color: var(--fill-primary, CanvasText);
          border: 2px solid #4a82e6; border-radius: 4px;
          box-shadow: 0 3px 14px #0004; font: menu;
        }
        #inline-extra-editor :is(textarea, input) {
          display: block; box-sizing: border-box; width: 100%; margin: 0;
          min-height: 30px; max-height: 200px; resize: vertical;
          border: 0; outline: 0; padding: 3px; font: inherit;
          background: transparent; color: inherit; line-height: 1.45;
          white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
        }
        #inline-extra-editor .inline-extra-footer {
          display: flex; align-items: center; justify-content: flex-end; gap: 6px;
        }
        #inline-extra-editor .inline-extra-help { flex: 1; font-size: 10px; opacity: .72; }
        #inline-extra-editor button { font: inherit; font-size: 11px; cursor: pointer; }
        #inline-extra-editor .inline-extra-error { font-size: 12px; color: #c33; white-space: pre-wrap; }
        @media (prefers-color-scheme: dark) {
          #inline-extra-editor .inline-extra-error { color: #ff9494; }
        }
      `;
      this.document.documentElement.append(this.style);
      on(this.document, "click", event => this.onClick(event), true);
      on(this.document, "dblclick", event => {
        if (this.hit(event.target, event)) { event.preventDefault(); event.stopPropagation(); }
      }, true);
      on(this.document, "mousedown", event => this.onMouseDown(event), true);
      on(this.document, "mouseup", event => this.onMouseUp(event), true);
      on(this.document, "dragstart", () => { this.mouseDown = null; }, true);
      on(window, "blur", () => { this.mouseDown = null; });
      on(this.document, "keydown", event => this.onTreeKey(event), true);
      on(this.document, "scroll", event => {
        if (this.editor && !this.editor.panel.contains(event.target)) this.position();
      }, true);
      on(window, "resize", () => this.position());
      on(window, "beforeunload", event => {
        if (this.editor && this.editor.input.value !== this.editor.original) {
          event.preventDefault();
          event.returnValue = "";
        }
      });
    }

    create(tag) { return this.document.createElementNS(HTML, tag); }
    get view() { return this.window.ZoteroPane?.itemsView; }

    bounds(cell) {
      if (!cell?.isConnected) return null;
      const rect = cell.getBoundingClientRect();
      const row = cell.closest('.row')?.getBoundingClientRect();
      // An empty inline span can have zero height. Its editable area is the full row.
      if (!row || !rect.width || !row.height) return null;
      return { left: rect.left, right: rect.right, width: rect.width,
        top: row.top, bottom: row.bottom, height: row.height };
    }

    hit(target, point) {
      let cell = target?.closest?.(cellSelector());
      const row = target?.closest?.(".row");
      const view = this.view;
      if (!row || !view || !row.id.startsWith(view.id + "-row-")) return null;
      if (!cell && point && !target.closest('.cell')) {
        // Native hit-testing can land on the row when a field value is blank.
        for (const field of Object.keys(fields)) {
          const candidate = row.querySelector(`.cell.${field}`);
          const rect = this.bounds(candidate);
          if (rect && point.clientX >= rect.left && point.clientX < rect.right
            && point.clientY >= rect.top && point.clientY < rect.bottom) { cell = candidate; break; }
        }
      }
      if (!cell) return null;
      const index = Number(row.id.slice((view.id + "-row-").length));
      if (!Number.isInteger(index)) return null;
      const treeRow = view.getRow(index);
      if (treeRow?.type !== "item" || row.classList.contains("context-row")) return null;
      const item = treeRow.ref;
      if (!item?.isRegularItem?.()) return null;
      const field = Object.keys(fields).find(field => cell.classList.contains(field));
      return { cell, item, index, view, field };
    }

    onClick(event) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const hit = this.hit(event.target, event);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      this.enqueueOpen(hit.item, hit.view, hit.field);
    }

    enqueueOpen(item, view, field = "extra") {
      // Mouseup and a surviving click can request the same open in one dispatch cycle.
      if (this.queuedOpen?.itemID === item.id && this.queuedOpen.view === view && this.queuedOpen.field === field) return;
      const request = { itemID: item.id, view, field };
      this.queuedOpen = request;
      this.queue = this.queue.then(() => this.open(item, view, field)).catch(error => Zotero.logError(error))
        .finally(() => { if (this.queuedOpen === request) this.queuedOpen = null; });
    }

    onMouseDown(event) {
      this.mouseDown = null;
      if (this.editor && !this.editor.panel.contains(event.target)) void this.finish(false);
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const hit = this.hit(event.target, event);
      if (hit && canEdit(hit.item, hit.field)) {
        // Open selects the item through Zotero's awaited API on mouseup. Letting
        // the row also handle mousedown queues a focus() timer that can steal
        // focus from the new editor, particularly when leaving quick search.
        event.preventDefault();
        event.stopPropagation();
        // Retain the item rather than a transient cell or its current row index.
        this.mouseDown = { item: hit.item, view: hit.view, field: hit.field, x: event.clientX, y: event.clientY };
      }
    }

    onMouseUp(event) {
      const down = this.mouseDown;
      this.mouseDown = null;
      if (!down || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (this.view !== down.view || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
      const cell = this.cellFor(down.item, down.view, down.field);
      const rect = this.bounds(cell);
      if (!rect || !rect.width || !rect.height || event.clientX < rect.left || event.clientX >= rect.right
        || event.clientY < rect.top || event.clientY >= rect.bottom) return;
      // Capture before Zotero's row mouseup focuses and rerenders the table again.
      event.preventDefault();
      event.stopPropagation();
      this.enqueueOpen(down.item, down.view, down.field);
    }

    onTreeKey(event) {
      if (this.editor || event.key !== "F2" || event.ctrlKey || event.metaKey || event.altKey) return;
      const view = this.view;
      const root = view && this.document.getElementById(view.id);
      if (!root?.contains(event.target)) return;
      const items = view.getSelectedItems();
      if (items.length !== 1) return;
      event.preventDefault(); event.stopPropagation();
      this.queue = this.queue.then(() => this.open(items[0], view)).catch(error => Zotero.logError(error));
    }

    cellFor(item, view, field = "extra") {
      if (!fields[field]) return null;
      const index = view.getRowIndexByID(item.treeViewID);
      if (index === false || index == null) return null;
      return this.document.getElementById(view.id + "-row-" + index)?.querySelector(`.cell.${field}`);
    }

    async open(item, view = this.view, field = "extra") {
      if (this.disposed) return false;
      if (this.editor?.item.id === item.id && this.editor.field === field) { this.editor.input.focus(); return true; }
      if (this.editor && !await this.finish(false)) return false;
      if (this.disposed || this.view !== view || !canEdit(item, field)) return false;
      await view.selectItems([item.id]);
      if (this.disposed || this.view !== view || !canEdit(item, field)) return false;
      const index = view.getRowIndexByID(item.treeViewID);
      if (index === false || index == null) return false;
      view.ensureRowIsVisible(index);
      const cell = this.cellFor(item, view, field);
      if (!cell) return false; // The requested column must be visible.
      const initial = fields[field].adapter ? await fields[field].adapter.read(item, this.window)
        : { value: item.getField(field) || "" };
      if (this.disposed || this.view !== view || !canEdit(item, field)) return false;
      const label = this.text.labels[field];
      const hint = fields[field].multiline ? this.text.help : this.text.singleLineHelp;
      const panel = this.create("div");
      panel.id = "inline-extra-editor";
      panel.setAttribute("role", "group");
      panel.setAttribute("aria-label", label);
      const input = this.create(fields[field].multiline ? "textarea" : "input");
      if (!fields[field].multiline) input.type = "text";
      input.setAttribute("aria-label", label);
      input.setAttribute("spellcheck", "false");
      input.value = initial.value;
      const footer = this.create("div");
      footer.className = "inline-extra-footer";
      const help = this.create("span");
      help.className = "inline-extra-help";
      help.textContent = hint;
      const save = this.create("button"); save.textContent = this.text.save;
      const cancel = this.create("button"); cancel.textContent = this.text.cancel;
      const error = this.create("div");
      error.className = "inline-extra-error";
      error.setAttribute("role", "alert"); error.hidden = true;
      footer.append(help, save, cancel);
      panel.append(input, footer, error);
      this.editor = { panel, input, item, view, field, hint, original: input.value, snapshot: initial.snapshot, error, help, save, cancel };
      // Appending within the window keeps text input native and out of the virtualized rows.
      this.document.documentElement.append(panel);
      panel.addEventListener("keydown", event => this.onEditorKey(event));
      for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
        panel.addEventListener(type, event => event.stopPropagation());
      }
      panel.addEventListener("focusout", () => {
        this.window.setTimeout(() => {
          if (this.editor?.panel === panel && !panel.contains(this.document.activeElement)) void this.finish(false);
        }, 0);
      });
      input.addEventListener("input", () => this.resizeInput());
      save.addEventListener("click", () => void this.finish(true));
      cancel.addEventListener("click", () => this.cancel());
      this.resizeInput();
      input.focus();
      input.select();
      return true;
    }

    resizeInput() {
      if (!this.editor) return;
      const { input, field } = this.editor;
      input.style.height = "auto";
      input.style.height = (fields[field].multiline ? Math.min(180, Math.max(36, input.scrollHeight + 2)) : 32) + "px";
      this.position();
    }

    position() {
      const e = this.editor;
      if (!e) return;
      const cell = this.view === e.view ? this.cellFor(e.item, e.view, e.field) : null;
      // Retain drafts even when a view change or virtualization removes the anchor.
      if (cell) {
        const rect = this.bounds(cell);
        if (rect) e.rect = rect;
      }
      if (!e.rect) return;
      const margin = 8;
      const width = Math.max(180, Math.min(Math.max(340, e.rect.width), this.window.innerWidth - margin * 2));
      e.panel.style.width = width + "px";
      e.panel.style.left = Math.max(margin, Math.min(e.rect.left, this.window.innerWidth - width - margin)) + "px";
      e.panel.style.top = Math.max(margin, Math.min(e.rect.top, this.window.innerHeight - e.panel.getBoundingClientRect().height - margin)) + "px";
    }

    onEditorKey(event) {
      // Keep Zotero shortcuts from deleting rows or navigating the tree while typing.
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); this.cancel(); }
      else if (event.key === "Enter" && (!event.shiftKey || !fields[this.editor.field].multiline)) {
        event.preventDefault(); void this.finish(true);
      }
      else if (event.key === "Tab") {
        event.preventDefault();
        const e = this.editor;
        const direction = event.shiftKey ? -1 : 1;
        this.queue = this.queue.then(async () => {
          const next = this.nextItem(e, direction);
          if (await this.finish(!next) && next) await this.open(next, e.view, e.field);
        }).catch(error => Zotero.logError(error));
      }
    }

    nextItem(e, direction) {
      if (!e || this.view !== e.view) return null;
      const index = e.view.getRowIndexByID(e.item.treeViewID);
      if (index === false || index == null) return null;
      for (let i = index + direction; i >= 0 && i < e.view.getRowCount(); i += direction) {
        const row = e.view.getRow(i);
        if (row?.type === "item" && canEdit(row.ref, e.field)) return row.ref;
      }
      return null;
    }

    async finish(focusTree = false) {
      const e = this.editor;
      if (!e) return true;
      if (e.pending) return e.pending;
      e.pending = this.save(e, focusTree);
      const ok = await e.pending;
      e.pending = null;
      return ok;
    }

    async save(e, focusTree) {
      const value = e.input.value;
      if (value === e.original) { this.close(e, focusTree); return true; }
      e.input.readOnly = true; e.save.disabled = true; e.cancel.disabled = true;
      e.help.textContent = this.text.saving;
      let modified = false;
      try {
        await Zotero.DB.executeTransaction(async () => {
          if (!canEdit(e.item, e.field)) throw new Error(this.text.readonly);
          if (fields[e.field].adapter) {
            await fields[e.field].adapter.write(e.item, value, e.snapshot, this.window);
            return;
          }
          const current = e.item.getField(e.field) || "";
          if (current !== e.original && current !== value) throw new Error(this.text.conflict);
          if (current === value) return;
          e.item.setField(e.field, value);
          modified = true;
          await e.item.save({
            undoAction: "undo-action-edit-field",
            undoActionArgs: { field: Zotero.ItemFields.getLocalizedString(e.field), count: 1 },
          });
        });
        if (fields[e.field].adapter) {
          try { await fields[e.field].adapter.refresh(); } catch (error) { Zotero.logError(error); }
        }
        this.close(e, focusTree);
        return true;
      }
      catch (error) {
        Zotero.logError(error);
        if (fields[e.field].adapter) {
          try { await fields[e.field].adapter.rollback(e.item); } catch (reloadError) { Zotero.logError(reloadError); }
        }
        // The DB rolls back failed saves. Restore the cached item data too.
        if (modified) {
          try { await e.item.reload(["itemData"], true); } catch (reloadError) { Zotero.logError(reloadError); }
        }
        if (this.editor === e) {
          e.error.textContent = this.text.failure + String(error.message || error);
          e.error.hidden = false;
          e.input.readOnly = false; e.save.disabled = false; e.cancel.disabled = false;
          e.help.textContent = e.hint;
          this.position(); e.input.focus();
        }
        return false;
      }
    }

    cancel() {
      if (this.editor && !this.editor.pending) this.close(this.editor, true);
    }

    close(e, focusTree) {
      if (this.editor !== e) return;
      this.editor = null;
      e.panel.remove();
      if (focusTree && this.view === e.view) this.document.getElementById(e.view.id)?.focus();
    }

    dispose() {
      this.disposed = true;
      if (this.editor) this.close(this.editor, false);
      for (const off of this.listeners) off();
      this.style.remove();
    }
  }

  return {
    controllers,
    canEdit,
    registerField(field, options) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field) || fields[field]) throw new Error("Duplicate or invalid inline field");
      fields[field] = options;
      copy.zh.labels[field] = options.labels.zh;
      copy.en.labels[field] = options.labels.en;
      return () => { delete fields[field]; delete copy.zh.labels[field]; delete copy.en.labels[field]; };
    },
    addToWindow(window) {
      if (!controllers.has(window)) controllers.set(window, new Controller(window));
    },
    removeFromWindow(window) {
      controllers.get(window)?.dispose();
      controllers.delete(window);
    },
    async shutdown() {
      for (const [window, controller] of controllers) {
        await controller.queue;
        await controller.finish(false);
        this.removeFromWindow(window);
      }
    },
  };
})();
