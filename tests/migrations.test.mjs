import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openVault, connectMcp, migrationFiles, applyMigrations } from './helpers.mjs';

// The two migrations already applied to the live D1 database.
const deployed = ['0001_notes.sql','0002_browser.sql'];

test('later migrations keep existing rows byte-for-byte and the original MCP tools working',async()=>{
  const {mf,db}=await openVault({migrate:false});
  try {
    await applyMigrations(db,deployed);
    // Shapes found in production: an untouched MCP note and a browser-edited note.
    await db.prepare('INSERT INTO notes (name, content, created_at) VALUES (?, ?, ?)').bind('test','hello! MCP works!','2026-10-05T23:20:43.247Z').run();
    await db.prepare('INSERT INTO notes (name, content, created_at, revision, updated_at) VALUES (?, ?, ?, ?, ?)').bind('Personal Vault — Design Brief','# Brief\n\nSee [[test]].','2026-10-08T18:04:44.662Z',3,'2026-10-09T10:00:00.000Z').run();
    const snapshot=async()=>(await db.prepare('SELECT name, content, created_at, revision, updated_at FROM notes ORDER BY name').all()).results;
    const before=await snapshot();
    for (const file of migrationFiles().filter(f=>!deployed.includes(f))) {
      await applyMigrations(db,[file]);
      assert.deepEqual(await snapshot(),before,`${file} changed existing note rows`);
    }
    const mcp=await connectMcp(mf);
    const names=(await mcp.tools()).map(t=>t.name);
    for (const tool of ['get_vault_status','list_notes','read_note','create_note','search_notes']) assert.ok(names.includes(tool),tool);
    assert.equal((await mcp.call('get_vault_status')).data.note_count,2);
    assert.deepEqual((await mcp.call('list_notes')).data.notes.map(n=>n.name),['Personal Vault — Design Brief','test']);
    const read=(await mcp.call('read_note',{name:'test'})).data;
    assert.equal(read.content,'hello! MCP works!');assert.equal(read.created_at,'2026-10-05T23:20:43.247Z');
    assert.equal((await mcp.call('search_notes',{query:'mcp WORKS'})).data.notes.length,1);
    assert.equal((await mcp.call('create_note',{name:'test',content:'overwrite'})).isError,true);
    assert.equal((await mcp.call('read_note',{name:'test'})).data.content,'hello! MCP works!');
  } finally {await mf.dispose();}
});
