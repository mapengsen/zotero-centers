const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../addon/notes-core.js');
test('Notes save escaped literal text and preserve internal line breaks', () => {
  assert.equal(core.toHTML('中文\r\n<script>alert("x")</script> & a'),
    '<div data-schema-version="9"><p>中文<br />&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; a</p></div>');
  assert.equal(core.normalize(' \r\n\t '), '');
  assert.equal(core.normalize('a\u0000b\rc'), 'ab\nc');
});
test('Note conflicts detect changed content and moved or replaced note records', () => {
  const original = [{id:1,html:'<p>text</p>'}];
  assert.notEqual(core.fingerprint(original),core.fingerprint([{id:2,html:'<p>text</p>'}]));
  assert.notEqual(core.fingerprint(original),core.fingerprint([{id:1,html:'<p>changed</p>'}]));
  assert.equal(core.fingerprint(original),core.fingerprint([{...original[0],text:'cached text'}]));
});
