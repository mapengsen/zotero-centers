const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../addon/modules/global-search/core.js');
const engine = require('../addon/modules/global-search/engine.js');

const root = { itemID: 1, libraryID: 1 };
const entry = (field, value, item = root) => core.makeEntry({ field, value }, item);

test('any field matches; title ranking; parents deduplicate', () => {
  const rows = [entry('extra', 'Project: AlphaGenome'), entry('tag', 'alphagenome'),
    entry('title', 'AlphaGenome', { itemID: 2, libraryID: 5 }), entry('DOI', '10.1/alpha')];
  const found = core.matchEntries(rows, 'ALPHAGENOME');
  assert.deepEqual(found.map(r => r.id), [2, 1]);
  assert.deepEqual(found[1].matches.map(m => m.field), ['extra', 'tag']);
  assert.deepEqual(core.matchEntries(rows, '10.1/alpha').map(r => r.id), [1]);
});

test('Chinese, Unicode, whitespace, literal punctuation and blank input', () => {
  const rows = [entry('abstractNote', '中文　基因'), entry('title', 'ＡＢＣ Σigma'),
    entry('extra', '100%_literal [a].*')];
  for (const query of ['中文 基因', 'abc', 'σIGMA', '%_', '[a].*']) {
    assert.equal(core.matchEntries(rows, query).length, 1, query);
  }
  assert.deepEqual(core.matchEntries(rows, '  '), []);
  assert.deepEqual(core.matchEntries(rows, 'missing'), []);
});

test('deleted child, parent, attachment and cyclic ancestry are excluded', () => {
  const items = new Map([
    [1, root], [2, { itemID: 2, parentItemID: 1 }],
    [3, { itemID: 3, parentItemID: 2 }],
    [4, { itemID: 4, deleted: true, parentItemID: 1 }],
    [5, { itemID: 5, parentItemID: 4 }],
    [6, { itemID: 6, parentItemID: 7 }], [7, { itemID: 7, parentItemID: 6 }]
  ]);
  assert.equal(core.rootFor(3, items), root);
  for (const id of [4, 5, 6, 8]) assert.equal(core.rootFor(id, items), null);
});

test('notes match visible text and snippets reach late matches', () => {
  const value = '<p>gene <b>regulation</b> &amp; disease</p>';
  const e = core.makeEntry({ field: 'note', value }, root,
    s => s.replace(/<[^>]*>/g, '').replace('&amp;', '&'));
  assert.equal(core.matchEntries([e], 'gene regulation & disease').length, 1);
  assert.equal(core.matchEntries([e], '<b>').length, 0);
  assert.match(core.snippet('x'.repeat(1000) + 'NEEDLE', 'needle'), /NEEDLE/);
});

test('an invalidation during index build triggers a fresh build', async () => {
  const e = Object.assign(Object.create(engine), { cache: null, pending: null, revision: 0 });
  let calls = 0;
  e.build = async () => {
    if (++calls === 1) e.invalidate();
    return [calls];
  };
  assert.deepEqual(await e.getIndex({}), [2]);
  assert.deepEqual(await e.getIndex({}), [2]);
  assert.equal(calls, 2);
});

test('concurrent callers never receive a build invalidated while pending', async () => {
  const e = Object.assign(Object.create(engine), { cache: null, pending: null, revision: 0 });
  let release, calls = 0;
  e.build = async () => {
    const call = ++calls;
    if (call === 1) await new Promise(resolve => { release = resolve; });
    return [call];
  };
  const first = e.getIndex({});
  const second = e.getIndex({});
  e.invalidate();
  release();
  assert.deepEqual(await first, [2]);
  assert.deepEqual(await second, [2]);
});
