"""Build one self-contained XPI. No runtime dependencies or test code are included."""
import hashlib
import json
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'addon/manifest.json').read_text(encoding='utf8'))
package = json.loads((root / 'package.json').read_text(encoding='utf8'))
assert manifest['version'] == package['version']
dist = root / 'dist'; dist.mkdir(exist_ok=True)
xpi = dist / f'zotero-centers-{manifest["version"]}.xpi'
with zipfile.ZipFile(xpi, 'w', zipfile.ZIP_DEFLATED) as archive:
    files = [(p.relative_to(root / 'addon').as_posix(), p) for p in sorted((root / 'addon').rglob('*')) if p.is_file()]
    files.append(('LICENSE', root / 'LICENSE'))
    for name, path in files:
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())
digest = hashlib.sha256(xpi.read_bytes()).hexdigest()
compat = manifest['applications']['zotero']
updates = {'addons': {compat['id']: {'updates': [{
    'version': manifest['version'],
    'update_link': f'https://github.com/mapengsen/zotero-centers/releases/download/v{manifest["version"]}/{xpi.name}',
    'update_hash': 'sha256:' + digest,
    'applications': {'zotero': {key: compat[key] for key in ['strict_min_version', 'strict_max_version']}}
}]}}}
(dist / 'updates.json').write_text(json.dumps(updates, indent=2) + '\n', encoding='utf8')
(dist / 'SHA256SUMS').write_text(f'{digest}  {xpi.name}\n', encoding='utf8')
print(f'Built {xpi} ({xpi.stat().st_size} bytes)\nSHA256 {digest}')
