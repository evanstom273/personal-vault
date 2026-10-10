import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openVault, connectMcp } from './helpers.mjs';

test('append_to_note adds a line, keeps the previous version, and respects the size limit',async()=>{
  const {mf,db}=await openVault();
  const history=async name=>(await db.prepare('SELECT revision, content, reason, source FROM note_revisions WHERE note_name = ? ORDER BY revision').bind(name).all()).results.map(r=>({...r}));
  try {
    const mcp=await connectMcp(mf);
    const tool=(await mcp.tools()).find(t=>t.name==='append_to_note');
    assert.deepEqual([tool.annotations.readOnlyHint,tool.annotations.destructiveHint],[false,false]);

    await mcp.call('create_note',{name:'Journal',content:'Day 1'});
    const appended=(await mcp.call('append_to_note',{name:'Journal',content:'Day 2'})).data;
    assert.deepEqual([appended.revision,appended.characters],[2,11]);
    assert.equal((await mcp.call('read_note',{name:'Journal'})).data.content,'Day 1\nDay 2');
    assert.deepEqual(await history('Journal'),[{revision:1,content:'Day 1',reason:'append',source:'mcp'}]);

    // No extra blank line after a trailing newline, and none before the first line.
    await mcp.call('create_note',{name:'Ends with newline',content:'- a\n'});
    await mcp.call('append_to_note',{name:'Ends with newline',content:'- b'});
    assert.equal((await mcp.call('read_note',{name:'Ends with newline'})).data.content,'- a\n- b');
    await mcp.call('create_note',{name:'Empty',content:''});
    await mcp.call('append_to_note',{name:'Empty',content:'first'});
    assert.equal((await mcp.call('read_note',{name:'Empty'})).data.content,'first');

    assert.match((await mcp.call('append_to_note',{name:'Missing',content:'x'})).data.error,/not found/);
    assert.equal((await mcp.call('append_to_note',{name:'Journal',content:''})).isError,true);

    // Limit counts the separator: 99998 + newline + 1 fits exactly, one more does not.
    await mcp.call('create_note',{name:'Big',content:'x'.repeat(99998)});
    assert.equal((await mcp.call('append_to_note',{name:'Big',content:'y'})).data.characters,100000);
    const over=await mcp.call('append_to_note',{name:'Big',content:'z'});
    assert.match(over.data.error,/100000-character/);
    const big=(await mcp.call('read_note',{name:'Big'})).data;
    assert.deepEqual([big.revision,big.content.length,big.content.endsWith('\ny')],[2,100000,true]);
    assert.equal((await history('Big')).length,1);

    // Concurrent appends all land, each with its own archived predecessor.
    const lines=['a','b','c','d','e'];
    const results=await Promise.all(lines.map(content=>mcp.call('append_to_note',{name:'Journal',content})));
    assert.ok(results.every(r=>!r.isError));
    const final=(await mcp.call('read_note',{name:'Journal'})).data;
    assert.equal(final.revision,7);
    assert.deepEqual(final.content.split('\n').slice(2).sort(),lines);
    assert.deepEqual((await history('Journal')).map(r=>r.revision),[1,2,3,4,5,6]);

    // An appended note can still be updated, and its revisions are visible via MCP.
    assert.deepEqual((await mcp.call('list_note_revisions',{name:'Journal'})).data.revisions.map(r=>r.reason),Array(6).fill('append'));
    assert.equal((await mcp.call('update_note',{name:'Journal',content:'reset',expected_revision:7})).data.revision,8);
  } finally {await mf.dispose();}
});
