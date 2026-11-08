"""Publish explicit stages using Git Credential Manager; credentials stay in memory."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPO = 'mapengsen/zotero-centers'
OWNER = 'mapengsen'
LEGACY = 'mapengsen/zotero-title-merge'
TOKEN = None


def credentials():
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')
    result = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                            text=True, capture_output=True, env=env, check=True)
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if not fields.get('password'):
        raise RuntimeError('No existing GitHub credential')
    return fields['password']


def api(path, data=None, method=None, raw=None):
    url = path if path.startswith('https://') else 'https://api.github.com' + path
    if urllib.parse.urlparse(url).hostname not in {'api.github.com', 'uploads.github.com'}:
        raise ValueError('Unexpected API host')
    headers = {'Authorization': 'Bearer ' + TOKEN, 'User-Agent': 'zotero-centers-release',
               'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    body = raw
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode('utf8')
        headers['Content-Type'] = 'application/json'
    elif raw is not None:
        headers['Content-Type'] = 'application/octet-stream'
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=40) as response:
        content = response.read()
    return json.loads(content) if content else None


def optional(path):
    try:
        return api(path)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        return None


def record(**values):
    path = ROOT / 'docs/publication.json'
    state = json.loads(path.read_text(encoding='utf8')) if path.exists() else {}
    state.update(values)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps(values, ensure_ascii=False), flush=True)


def repository():
    repo = optional('/repos/' + REPO)
    if repo is None:
        repo = api('/user/repos', {'name': 'zotero-centers', 'private': False,
            'description': 'Zotero 10: global search, inline editing, same-title merging, recursive collection/library totals and Index in one plugin.',
            'has_issues': True, 'has_wiki': False, 'auto_init': False})
    assert repo['full_name'] == REPO and not repo['private'] and not repo['fork']
    api('/repos/' + REPO + '/topics', {'names': ['zotero', 'zotero-plugin', 'zotero10', 'search', 'deduplication']}, method='PUT')
    record(repository=repo['html_url'])


def backup():
    repo = api('/repos/' + LEGACY)
    assert repo['full_name'] == LEGACY and repo['permissions']['admin'] and not repo['fork']
    directory = ROOT / '.cache/backups/zotero-title-merge'
    directory.mkdir(parents=True, exist_ok=True)
    mirror = directory / 'repository.git'
    if not mirror.exists():
        subprocess.run(['git', 'clone', '--mirror', 'https://github.com/' + LEGACY + '.git', str(mirror)], check=True)
    subprocess.run(['git', '--git-dir=' + str(mirror), 'fsck', '--full'], check=True)
    releases = api('/repos/' + LEGACY + '/releases?per_page=100')
    snapshot = {'repository': repo, 'releases': releases,
                'issues': api('/repos/' + LEGACY + '/issues?state=all&per_page=100')}
    snapshot['assetBackups'] = []
    for release in releases:
        target = directory / ('release-' + str(release['id']))
        target.mkdir(exist_ok=True)
        for asset in release['assets']:
            name = asset['name']
            if Path(name).name != name or '\\' in name:
                raise ValueError('Unsafe backup asset name')
            url = asset['browser_download_url']
            if not url.startswith('https://github.com/' + LEGACY + '/releases/download/'):
                raise ValueError('Unexpected release asset URL')
            destination = target / name
            local = ROOT.parent / 'Zotero-Title-Merge/dist' / name
            if local.exists() and asset.get('digest') == 'sha256:' + hashlib.sha256(local.read_bytes()).hexdigest():
                shutil.copyfile(local, destination)
                snapshot['assetBackups'].append({'name': name, 'release': release['tag_name'], 'verified': True})
            else:
                snapshot['assetBackups'].append({'name': name, 'release': release['tag_name'], 'verified': False,
                    'note': 'Source history and release metadata are preserved; this historical asset is not present locally.'})
    (directory / 'metadata.json').write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding='utf8')
    latest = api('/repos/' + LEGACY + '/releases/latest')
    assert any(item['verified'] and item['name'].endswith('.xpi') and item['release'] == latest['tag_name']
               for item in snapshot['assetBackups']), 'Latest XPI must also be backed up before deletion'
    (directory / 'COMPLETE').write_text(LEGACY + '\n', encoding='utf8')
    print('Verified local backup:', directory, flush=True)


def release():
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf8'))['version']
    validation = json.loads((ROOT / f'docs/validation-{version}.json').read_text(encoding='utf8'))
    result = json.loads((ROOT / 'test-results/integration.json').read_text(encoding='utf8'))
    assert result['version'] == version and result['done'] and not result['failures']
    assert result['lifecycleReady'] and result['migrationReady']
    for name, digest in validation['addonSourceSha256'].items():
        assert hashlib.sha256((ROOT / 'addon' / name).read_bytes()).hexdigest() == digest, name
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()
    subprocess.run(['python', 'scripts/build.py'], cwd=ROOT, check=True)
    xpi = ROOT / f'dist/zotero-centers-{version}.xpi'
    assert hashlib.sha256(xpi.read_bytes()).hexdigest() == validation['artifact']['sha256']
    assert not optional(f'/repos/{REPO}/releases/tags/v{version}'), 'Release already exists'
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    rel = api(f'/repos/{REPO}/releases', {'tag_name': 'v' + version, 'target_commitish': commit,
        'name': 'zotero-centers ' + version, 'draft': True, 'prerelease': False,
        'body': (ROOT / 'docs/release-notes.md').read_text(encoding='utf8')})
    upload = rel['upload_url'].split('{')[0]
    for source in [xpi, ROOT / 'dist/updates.json', ROOT / 'dist/SHA256SUMS', ROOT / f'docs/validation-{version}.json']:
        content = source.read_bytes()
        asset = api(upload + '?name=' + urllib.parse.quote(source.name), method='POST', raw=content)
        assert asset['size'] == len(content)
        if asset.get('digest'):
            assert asset['digest'] == 'sha256:' + hashlib.sha256(content).hexdigest()
    rel = api(f'/repos/{REPO}/releases/{rel["id"]}', {'draft': False}, method='PATCH')
    record(release=rel['html_url'], version=version, commit=commit, sha256=validation['artifact']['sha256'])


def fork_branch(upstream, branch):
    base = api('/repos/' + upstream)['default_branch']
    name = upstream.split('/')[1]
    fork = api('/repos/' + OWNER + '/' + name)
    assert fork['fork'] and fork['parent']['full_name'] == upstream
    sha = api(f'/repos/{upstream}/git/ref/heads/{base}')['object']['sha']
    if not optional(f'/repos/{OWNER}/{name}/git/ref/heads/{branch}'):
        api(f'/repos/{OWNER}/{name}/git/refs', {'ref': 'refs/heads/' + branch, 'sha': sha})
    return fork['full_name'], base


def put_file(repo, branch, path, content, message):
    existing = optional(f'/repos/{repo}/contents/{path}?ref={branch}')
    if existing and base64.b64decode(existing['content']).decode('utf8') == content:
        return
    payload = {'message': message, 'content': base64.b64encode(content.encode('utf8')).decode(), 'branch': branch}
    if existing:
        payload['sha'] = existing['sha']
    api(f'/repos/{repo}/contents/{path}', payload, method='PUT')


def marketplace():
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf8'))['version']
    assert not api(f'/repos/{REPO}/releases/tags/v{version}')['draft']
    body = (ROOT / 'docs/market-submission.md').read_text(encoding='utf8')
    branch = 'add-zotero-centers'
    upstream = 'zotero-chinese/zotero-plugins'
    fork, base = fork_branch(upstream, branch)
    file = api(f'/repos/{upstream}/contents/src/plugins.ts?ref={base}')
    original = base64.b64decode(file['content']).decode('utf8')
    assert REPO not in original
    entry = """  {
    repo: 'mapengsen/zotero-centers',
    summaryZh: '全局搜索、短标题与其他行内编辑、同标题合并、文库与目录文献总数、Index 首列，一次安装全部使用。',
    keywords: ['zotero-centers', 'global search', 'inline extra', 'title merge', '全局搜索', '文献合并', '目录计数', 'Index'],
    releases: [],
    tags: ['metadata', 'utility'],
    discoverReleases: true,
    publishInShadow: true,
  },
"""
    matches = list(re.finditer(r"^  \{\n    repo: '([^']+)'", original, re.M))
    position = next(match.start() for match in matches if match.group(1).lower() > REPO.lower())
    updated = original[:position] + entry + original[position:]
    assert updated.replace(entry, '', 1) == original
    put_file(fork, branch, 'src/plugins.ts', updated, 'feat: add zotero-centers for Zotero 10')
    compare = f'https://github.com/{upstream}/compare/{base}...{OWNER}:zotero-plugins:{branch}'
    issue = api(f'/repos/{upstream}/issues/357')
    assert issue['user']['login'] == OWNER and issue['state'] == 'open'
    issue = api(f'/repos/{upstream}/issues/357', {'title': '请求收录 zotero-centers：替代 Title Merge，集成五项功能（Zotero 10）',
                'body': body + '\n\n已准备源清单更改：' + compare + '\n商店仓库限制外部用户创建 PR，因此更新原 Issue 请求审核。\n'}, method='PATCH')
    record(chineseStoreSubmission=issue['html_url'], catalogChange=compare)
    upstream = 'syt2/zotero-addons-scraper'
    fork, base = fork_branch(upstream, branch)
    old_path = 'addons/mapengsen@zotero-title-merge'
    existing = optional(f'/repos/{fork}/contents/{old_path}?ref={branch}')
    if existing:
        api(f'/repos/{fork}/contents/{old_path}', {'message': 'chore: replace retired Title Merge source',
            'branch': branch, 'sha': existing['sha']}, method='DELETE')
    put_file(fork, branch, 'addons/mapengsen@zotero-centers', '{"tags": ["metadata", "utility"]}\n', 'feat: add zotero-centers')
    existing_prs = api(f'/repos/{upstream}/pulls?state=open&head={OWNER}:{branch}')
    pr = existing_prs[0] if existing_prs else api(f'/repos/{upstream}/pulls', {
        'title': 'Replace Title Merge with zotero-centers: five integrated Zotero 10 features',
        'body': body, 'head': OWNER + ':' + branch, 'base': base, 'maintainer_can_modify': True})
    record(scraperPullRequest=pr['html_url'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['repo', 'backup', 'release', 'market'])
    args = parser.parse_args()
    TOKEN = credentials()
    try:
        assert api('/user')['login'] == OWNER
        {'repo': repository, 'backup': backup, 'release': release, 'market': marketplace}[args.stage]()
    except urllib.error.HTTPError as error:
        print('GitHub API error:', error.code, error.read().decode('utf8', errors='replace')[:1200])
        raise SystemExit(1)
