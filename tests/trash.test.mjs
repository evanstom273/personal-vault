import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openVault, connectMcp, browserSession } from './helpers.mjs';

test('delete_note moves notes to a recoverable trash; restore_note brings them back intact',async()=>{
  const {mf,db}=await openVault();
  const rowCount=async()=>(await db.prepare('SELECT count(*) AS c FROM notes').first()).c;
  try {
    const mcp=await connectMcp(mf);
    const tools=await mcp.tools();
    assert.equal(tools.find(t=>t.name==='delete_note').annotations.destructiveHint,true);
    assert.equal(tools.find(t=>t.name==='restore_note').annotations.destructiveHint,false);
    assert.equal(tools.find(t=>t.name==='list_trash').annotations.readOnlyHint,true);

    await mcp.call('create_note',{name:'Keep',content:'stays'});
    await mcp.call('create_note',{name:'Bin',content:'first'});
    await mcp.call('update_note',{name:'Bin',content:'bin content [[Keep]]',expected_revision:1});
    const before=(await mcp.call('read_note',{name:'Bin'})).data;

    const trashed=(await mcp.call('delete_note',{name:'Bin'})).data;
    assert.equal(trashed.name,'Bin');assert.ok(trashed.deleted_at);
    assert.equal(await rowCount(),2);

    // Gone from every live view.
    assert.match((await mcp.call('read_note',{name:'Bin'})).data.error,/not found/);
    assert.deepEqual((await mcp.call('list_notes')).data.notes.map(n=>n.name),['Keep']);
    assert.equal((await mcp.call('search_notes',{query:'bin content'})).data.notes.length,0);
    const status=(await mcp.call('get_vault_status')).data;
    assert.deepEqual([status.note_count,status.trash_count],[1,1]);

    // Writes are refused with a pointer to restore_note, and the name stays reserved.
    assert.match((await mcp.call('update_note',{name:'Bin',content:'x',expected_revision:2})).data.error,/trash/);
    assert.match((await mcp.call('append_to_note',{name:'Bin',content:'x'})).data.error,/trash/);
    assert.match((await mcp.call('create_note',{name:'Bin',content:'x'})).data.error,/in the trash/);
    assert.match((await mcp.call('delete_note',{name:'Bin'})).data.error,/already in the trash/);
    assert.match((await mcp.call('delete_note',{name:'Missing'})).data.error,/not found/);

    const trash=(await mcp.call('list_trash')).data;
    assert.deepEqual(trash.notes.map(n=>[n.name,n.excerpt,n.revision]),[['Bin','bin content [[Keep]]',2]]);
    const history=(await mcp.call('list_note_revisions',{name:'Bin'})).data;
    assert.ok(history.current.deleted_at);assert.equal(history.revisions[0].excerpt,'first');

    // The browser hides trashed notes and their links, and cannot rename onto them.
    const web=await browserSession(mf,db);
    assert.equal((await web('/api/note?name=Bin')).status,404);
    assert.deepEqual((await (await web('/api/notes')).json()).notes.map(n=>n.name),['Keep']);
    assert.deepEqual(await (await web('/api/backlinks?name=Keep')).json(),[]);
    const collide=await web('/api/note?name=Keep',{method:'PUT',body:{name:'Bin',content:'x',revision:1}});
    assert.equal(collide.status,409);assert.match((await collide.json()).error,/trash/);
    assert.equal((await web('/api/notes',{method:'POST',body:{name:'Bin',content:'x'}})).status,409);

    // Restore returns the note exactly as it was, history included.
    const restored=(await mcp.call('restore_note',{name:'Bin'})).data;
    assert.deepEqual([restored.name,restored.revision,restored.restored],['Bin',2,true]);
    assert.deepEqual((await mcp.call('read_note',{name:'Bin'})).data,before);
    assert.equal((await mcp.call('list_note_revisions',{name:'Bin'})).data.revisions.length,1);
    assert.match((await mcp.call('restore_note',{name:'Bin'})).data.error,/in the trash/);
    assert.deepEqual((await mcp.call('list_trash')).data.notes,[]);
    assert.equal((await mcp.call('update_note',{name:'Bin',content:'editable again',expected_revision:2})).data.revision,3);

    // Browser deletes are revision-checked and also go to the trash.
    assert.equal((await web('/api/note?name=Keep',{method:'DELETE',headers:{'If-Match':'7'}})).status,409);
    assert.equal((await mcp.call('read_note',{name:'Keep'})).data.content,'stays');
    assert.equal((await web('/api/note?name=Keep',{method:'DELETE',headers:{'If-Match':'1'}})).status,200);
    assert.deepEqual((await mcp.call('list_trash')).data.notes.map(n=>n.name),['Keep']);
    assert.equal(await rowCount(),2);
  } finally {await mf.dispose();}
});
