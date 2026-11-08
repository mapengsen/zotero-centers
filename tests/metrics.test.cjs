const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../addon/metrics-core.js');
const row = (regular = true, top = true, feed = false) => ({isObjectRow:true, ref:{
  isRegularItem:()=>regular, isTopLevelItem:()=>top, isFeedItem:feed
}});
test('Index starts at 1 and ignores expanded child rows, notes and library headers',()=>{
  const rows=[{isObjectRow:false},row(),row(false,false),row(false),row(),row(true,true,true),row()];
  assert.deepEqual(core.indexRows(rows),['','1','','','2','','3']);
});
test('A filtered or differently sorted view gets a new contiguous index',()=>{
  assert.deepEqual(core.indexRows([row(),row(),row()]),['1','2','3']);
  assert.deepEqual(core.indexRows([row(),row()]),['1','2']);
  assert.deepEqual(core.indexRows([]),[]);
});
