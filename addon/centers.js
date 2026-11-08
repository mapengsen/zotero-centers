var CentersPlugin = {
  windows: new Set(),
  modules: {},
  legacyIDs: ["global-search@mapengsen.github.io", "inline-extra@local.zotero", "title-merge@mapengsen.github.io"],
  migrationPref: "extensions.zoteroCenters.pausedLegacy",

  async pauseLegacy() {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    let paused;
    try { paused = JSON.parse(Zotero.Prefs.get(this.migrationPref, true) || "[]"); }
    catch { paused = []; }
    paused = paused.filter(id => this.legacyIDs.includes(id));
    let changed = false;
    for (const id of this.legacyIDs) {
      const addon = await AddonManager.getAddonByID(id);
      if (!addon?.isActive) continue;
      if (!paused.includes(id)) paused.push(id);
      Zotero.Prefs.set(this.migrationPref, JSON.stringify(paused), true);
      await addon.disable();
      changed = true;
    }
    if (changed) {
      // Let the old asynchronous shutdown handlers finish their UI cleanup.
      for (let i = 0; i < 100; i++) {
        await Zotero.Promise.delay(100);
        const remains = Zotero.getMainWindows().some(w => w.document.getElementById("global-search-host")
          || w.document.getElementById("title-merge-tools") || w.document.getElementById("inline-extra-editor"));
        if (!remains) break;
        if (i === 99) throw new Error("旧版插件仍在退出，请等待当前操作完成后重新启用 zotero-centers。");
      }
    }
  },

  async restoreLegacy() {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    let ids;
    try { ids = JSON.parse(Zotero.Prefs.get(this.migrationPref, true) || "[]"); }
    catch { ids = []; }
    for (const id of ids.filter(id => this.legacyIDs.includes(id))) {
      const addon = await AddonManager.getAddonByID(id);
      if (addon?.userDisabled) await addon.enable();
    }
    Zotero.Prefs.clear(this.migrationPref, true);
  },

  loadModule(folder, files, symbol) {
    const scope = { Zotero, Services, ChromeUtils, IOUtils, PathUtils };
    const rootURI = this.rootURI + "modules/" + folder + "/";
    for (const file of files) Services.scriptloader.loadSubScript(rootURI + file, scope, "UTF-8");
    return { plugin: scope[symbol], rootURI };
  },

  async init(info) {
    this.ready = false;
    Object.assign(this, info);
    await this.pauseLegacy();
    const search = this.loadModule("global-search", ["core.js", "engine.js", "plugin.js"], "GlobalSearchPlugin");
    const inline = this.loadModule("inline-extra", ["inline-extra.js"], "InlineExtraPlugin");
    const merge = this.loadModule("title-merge", ["core.js", "engine.js", "plugin.js"], "TitleMergePlugin");
    this.modules = { search: search.plugin, inline: inline.plugin, merge: merge.plugin, metrics: CentersMetrics };
    search.plugin.init({ ...info, rootURI: search.rootURI });
    await merge.plugin.init({ ...info, rootURI: merge.rootURI });
    CentersMetrics.init(info);
    this.ready = true;
  },

  addToWindow(window) {
    if (!this.ready || this.windows.has(window)) return;
    this.windows.add(window);
    for (const name of ["search", "inline", "merge", "metrics"]) this.modules[name]?.addToWindow(window);
  },

  async removeFromWindow(window) {
    if (!this.windows.has(window)) return;
    for (const name of ["inline", "merge", "search", "metrics"]) await this.modules[name]?.removeFromWindow(window);
    this.windows.delete(window);
  },

  async shutdown(restoreLegacy = false) {
    this.ready = false;
    for (const name of ["inline", "merge", "search", "metrics"]) await this.modules[name]?.shutdown();
    this.windows.clear();
    if (restoreLegacy) await this.restoreLegacy();
  }
};
