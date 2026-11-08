const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../addon/modules/title-merge/core.js');
const record = (id, title, type = 'journalArticle', fields = {}, libraryID = 1) => ({
  id, libraryID, data: { title, itemType: type, ...fields }
});

test('title comparison ignores case and repeated whitespace only', () => {
  assert.equal(core.normalizeTitle('  HyenaDNA:\n Long-range  Modeling\t'), 'hyenadna: long-range modeling');
  assert.notEqual(core.normalizeTitle('Paper: A'), core.normalizeTitle('Paper A'));
  assert.notEqual(core.normalizeTitle('Alpha v1'), core.normalizeTitle('Alpha v2'));
  assert.notEqual(core.normalizeTitle('DNA'), core.normalizeTitle('ＤＮＡ'));
});
test('same title groups across types despite conflicting DOI, author and year', () => {
  const groups = core.groupRecords([
    record(1, 'Example', 'preprint', { DOI: '10.1/a', date: '2020', creators: [{name: 'A'}] }),
    record(2, ' EXAMPLE ', 'journalArticle', { DOI: '10.1/b', date: '2026', creators: [{name: 'B'}] })
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].masterID, 2);
});
test('journal > conference > preprint > other', () => {
  const group = core.groupRecords([
    record(1, 'A', 'webpage'), record(2, 'A', 'preprint'),
    record(3, 'A', 'conferencePaper'), record(4, 'A', 'journalArticle')
  ])[0];
  assert.deepEqual(group.records.map(r => r.id), [4, 3, 2, 1]);
});
test('completeness never overrides publication priority', () => {
  const group = core.groupRecords([
    record(1, 'A', 'journalArticle'), record(2, 'A', 'preprint', { DOI: 'x', abstractNote: 'A', url: 'x' })
  ])[0];
  assert.equal(group.masterID, 1);
});
test('same type prefers populated fields, not abstract length', () => {
  const group = core.groupRecords([
    record(1, 'A', 'journalArticle', { abstractNote: 'A'.repeat(10000) }),
    record(2, 'A', 'journalArticle', { DOI: 'x', date: '2020' })
  ])[0];
  assert.equal(group.masterID, 2);
});
test('metadata bookkeeping does not improve completeness', () => {
  assert.equal(core.completeness(record(1, 'A').data), core.completeness(record(1, 'A', 'journalArticle', {
    key: 'KEY', version: 5, dateAdded: '2026', tags: [{tag: 'tag'}], collections: ['ABC']
  }).data));
});
test('ties prefer earliest date added, then lowest item ID', () => {
  const group = core.groupRecords([
    record(4, 'A', 'preprint', {dateAdded: '2026-01-02'}),
    record(3, 'A', 'preprint', {dateAdded: '2026-01-01'}),
    record(2, 'A', 'preprint', {dateAdded: '2026-01-01'})
  ])[0];
  assert.equal(group.masterID, 2);
});
test('empty titles and singletons are never grouped', () => {
  assert.deepEqual(core.groupRecords([record(1, ''), record(2, '  '), record(3, 'A'), record(4, null)]), []);
});
test('libraries remain separate even for identical titles', () => {
  const groups = core.groupRecords([
    record(1, 'A', 'preprint', {}, 1), record(2, 'A', 'preprint', {}, 2),
    record(3, 'A', 'journalArticle', {}, 1), record(4, 'A', 'journalArticle', {}, 2)
  ]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(g => g.records.every(r => r.libraryID === g.libraryID)));
});
test('untrusted titles and archived fields are HTML-escaped', () => {
  const text = '<script>"x" & \'y\'</script>';
  assert.equal(core.escapeHTML(text), '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
});
