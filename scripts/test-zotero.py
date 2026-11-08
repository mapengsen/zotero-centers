"""Prepare a disposable profile with a real XPI and test-only bootstrap instrumentation."""
import json
from pathlib import Path
import shutil
import time
import zipfile

root = Path(__file__).resolve().parents[1]
run = root / '.tools/runs' / str(time.time_ns())
profile, data, staging = run / 'profile', run / 'data', run / 'addon'
for path in [profile / 'extensions', data, root / 'test-results', root / '.cache']:
    path.mkdir(parents=True, exist_ok=True)
shutil.copytree(root / 'addon', staging)
with (staging / 'bootstrap.js').open('a', encoding='utf8') as f:
    f.write('''
var actualStartup = startup;
startup = async function(info) {
  try {
    await actualStartup(info);
    Services.scriptloader.loadSubScript(%s, {Zotero, Centers, Services, ChromeUtils, IOUtils, PathUtils, TEST_ROOT:%s}, 'UTF-8');
  } catch(error) {
    await IOUtils.writeJSON(%s,{done:true,failures:[{name:'startup',message:String(error),stack:error.stack}]});
  }
};
''' % (json.dumps((root / 'tests/integration-zotero.js').as_uri()),json.dumps(str(root)),json.dumps(str(root / 'test-results/integration.json'))))
with zipfile.ZipFile(profile / 'extensions/zotero-centers@mapengsen.github.io.xpi','w',zipfile.ZIP_DEFLATED) as archive:
    for path in staging.rglob('*'):
        if path.is_file():archive.write(path,path.relative_to(staging).as_posix())
# Frozen legacy fixtures make migration checks reproducible after retiring the old repos.
# These test-only packages are never included in the release XPI.
for source,name in [('Zotero-Global-Search','global-search'),('Zotero-Inline-Extra','inline-extra'),('Zotero-Title-Merge','title-merge')]:
    fixture = root / 'tests/legacy' / (name+'.xpi')
    if fixture.exists():
        shutil.copyfile(fixture, root / '.cache' / (name+'.xpi'))
    else:
        with zipfile.ZipFile(root / '.cache' / (name+'.xpi'),'w',zipfile.ZIP_DEFLATED) as archive:
            for path in (root.parent / source / 'addon').rglob('*'):
                if path.is_file():archive.write(path,path.relative_to(root.parent / source / 'addon').as_posix())
prefs={
    'extensions.zotero.dataDir':str(data),'extensions.zotero.useDataDir':True,
    'extensions.zotero.firstRun':False,'extensions.zotero.firstRun2':False,
    'extensions.zotero.sync.autoSync':False,'extensions.zotero.httpServer.enabled':False,
    'extensions.zoteroWinWordIntegration.skipInstallation':True,
    'extensions.zoteroOpenOfficeIntegration.skipInstallation':True,
    'extensions.autoDisableScopes':0,'extensions.enabledScopes':15,
    'app.update.auto':False,'app.update.enabled':False,'intl.locale.requested':'zh-CN',
}
with (profile / 'user.js').open('w',encoding='utf8',newline='\n') as f:
    f.write(''.join(f'user_pref({json.dumps(k)}, {json.dumps(v)});\n' for k,v in prefs.items()))
record={'profile':str(profile),'data':str(data),'addon':str(staging)}
(root / 'test-results/last-run.json').write_text(json.dumps(record),encoding='utf8')
print(json.dumps(record,indent=2))
