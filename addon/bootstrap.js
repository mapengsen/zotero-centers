var Centers;
var chromeHandle;

async function startup(info) {
  await Zotero.initializationPromise;
  chromeHandle = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup)
    .registerChrome(Services.io.newURI(info.rootURI + "manifest.json"), [
      ["content", "zotero-centers-merge", info.rootURI + "modules/title-merge/"],
      ["content", "zotero-centers-metadata", info.rootURI + "modules/metadata/"]
    ]);
  const scope = { Zotero, Services, ChromeUtils, IOUtils, PathUtils };
  for (const file of ["notes-core.js", "notes.js", "metrics-core.js", "metrics.js", "centers.js"]) {
    Services.scriptloader.loadSubScript(info.rootURI + file, scope, "UTF-8");
  }
  Centers = scope.CentersPlugin;
  try { await Centers.init(info); }
  catch (error) {
    await Centers.shutdown(true);
    chromeHandle.destruct(); chromeHandle = undefined;
    throw error;
  }
  for (const window of Zotero.getMainWindows()) Centers.addToWindow(window);
}

function onMainWindowLoad({ window }) { Centers?.addToWindow(window); }
async function onMainWindowUnload({ window }) { await Centers?.removeFromWindow(window); }

async function shutdown(data, reason) {
  // Keep the legacy addons paused during app shutdown and an in-place update.
  const restoreLegacy = reason === ADDON_DISABLE || reason === ADDON_UNINSTALL;
  await Centers?.shutdown(restoreLegacy);
  Centers = undefined;
  chromeHandle?.destruct(); chromeHandle = undefined;
}
function install() {}
function uninstall() {}
