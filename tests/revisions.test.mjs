import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openVault, connectMcp, browserSession } from './helpers.mjs';

test('update_note keeps every earlier version and rejects stale revisions',async()=>{
  const {mf,db}=await openVault();
  const historyCount=async()=>(await db.prepare('SELECT count(*) AS c FROM note_revisions').first()).c;
  try {
    const mcp=await connectMcp(mf);
    const tools=await mcp.tools();
    const update=tools.find(t=>t.name==='update_note');
    assert.equal(update.annotations.destructiveHint,true);
    assert.deepEqual(update.inputSchema.required.sort(),['content','expected_revision','name']);
    for (const name of ['list_note_revisions','read_note_revision']) assert.equal(tools.find(t=>t.name===name).annotations.readOnlyHint,true);

    await mcp.call('create_note',{name:'Plan',content:'v1'});
    const created=(await mcp.call('read_note',{name:'Plan'})).data;
    assert.equal(created.revision,1);assert.equal(created.updated_at,null);

    const stale=await mcp.call('update_note',{name:'Plan',content:'nope',expected_revision:2});
    assert.equal(stale.isError,true);assert.match(stale.data.error,/current revision is 1/);
    assert.equal(await historyCount(),0);

    const v2=(await mcp.call('update_note',{name:'Plan',content:'v2',expected_revision:1})).data;
    assert.deepEqual([v2.revision,v2.previous_revision],[2,1]);assert.ok(v2.updated_at);
    assert.equal((await mcp.call('update_note',{name:'Plan',content:'v3',expected_revision:2})).data.revision,3);
    assert.equal((await mcp.call('read_note',{name:'Plan'})).data.content,'v3');

    const history=(await mcp.call('list_note_revisions',{name:'Plan'})).data;
    assert.equal(history.current.revision,3);
    assert.deepEqual(history.revisions.map(r=>[r.revision,r.excerpt,r.reason,r.source]),[[2,'v2','update','mcp'],[1,'v1','update','mcp']]);
    assert.equal(history.revisions[1].saved_at,created.created_at);
    assert.equal(history.revisions[0].saved_at,v2.updated_at);

    const r1=(await mcp.call('read_note_revision',{name:'Plan',revision:1})).data;
    assert.deepEqual([r1.content,r1.current],['v1',false]);
    const r3=(await mcp.call('read_note_revision',{name:'Plan',revision:3})).data;
    assert.deepEqual([r3.content,r3.current],['v3',true]);
    assert.equal((await mcp.call('read_note_revision',{name:'Plan',revision:9})).isError,true);

    assert.match((await mcp.call('update_note',{name:'Missing',content:'x',expected_revision:1})).data.error,/not found/);
    assert.equal((await mcp.call('list_note_revisions',{name:'Missing'})).isError,true);
    assert.equal((await mcp.call('update_note',{name:'Plan',content:'x'.repeat(100001),expected_revision:3})).isError,true);
    assert.equal((await mcp.call('update_note',{name:'Plan',content:'x',expected_revision:0})).isError,true);

    // Restoring an old version is an ordinary update, so it is itself reversible.
    assert.equal((await mcp.call('update_note',{name:'Plan',content:r1.content,expected_revision:3})).data.revision,4);
    assert.equal((await mcp.call('read_note',{name:'Plan'})).data.content,'v1');
    assert.equal(await historyCount(),3);

    // Two writers holding the same revision: exactly one wins, nothing is lost.
    const race=await Promise.all(['A','B'].map(content=>mcp.call('update_note',{name:'Plan',content,expected_revision:4})));
    assert.equal(race.filter(r=>!r.isError).length,1);
    assert.equal(await historyCount(),4);

    // Browser saves go through the same history path, and history follows a rename.
    const web=await browserSession(mf,db);
    const renamed=await web('/api/note?name=Plan',{method:'PUT',body:{name:'Plan 2',content:'browser edit',revision:5}});
    assert.equal(renamed.status,200);assert.equal((await renamed.json()).revision,6);
    const moved=(await mcp.call('list_note_revisions',{name:'Plan 2'})).data.revisions;
    assert.equal(moved.length,5);assert.deepEqual([moved[0].reason,moved[0].source,moved[0].name],['rename','browser','Plan']);
    assert.equal((await mcp.call('list_note_revisions',{name:'Plan'})).isError,true);

    // A rejected rename or stale save leaves both the note and its history untouched.
    await mcp.call('create_note',{name:'Other',content:'keep me'});
    assert.equal((await web('/api/note?name=Plan%202',{method:'PUT',body:{name:'Other',content:'collide',revision:6}})).status,409);
    assert.equal((await web('/api/note?name=Plan%202',{method:'PUT',body:{name:'Plan 2',content:'stale',revision:5}})).status,409);
    assert.equal(await historyCount(),5);
    assert.equal((await db.prepare('SELECT count(*) AS c FROM note_revisions WHERE note_name = ?').bind('Other').first()).c,0);
    assert.equal((await mcp.call('read_note',{name:'Plan 2'})).data.content,'browser edit');

    // A browser delete moves the note to the trash; its row and content stay.
    assert.equal((await web('/api/note?name=Other',{method:'DELETE',headers:{'If-Match':'1'}})).status,200);
    const kept=await db.prepare('SELECT content, deleted_at FROM notes WHERE name = ?').bind('Other').first();
    assert.equal(kept.content,'keep me');assert.ok(kept.deleted_at);
  } finally {await mf.dispose();}
});
