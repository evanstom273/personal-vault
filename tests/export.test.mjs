import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { openVault, connectMcp, browserSession, origin } from './helpers.mjs';

test('export downloads every note, trashed note and earlier version as Markdown in a ZIP',async()=>{
  const {mf,db}=await openVault();
  try {
    const mcp=await connectMcp(mf);
    const seed=[['Garden / Ideas','# Ideas\n\nSee [[Garden]] ✨ — café'],['Garden','Root note'],['note','lower'],['Note','Upper'],['a:b?*','illegal'],['../escape','traversal'],['CON','reserved'],['/','slash only'],['Bin','to be trashed'],['Empty','']];
    for (const [name,content] of seed) assert.equal((await mcp.call('create_note',{name,content})).isError,false,name);
    await mcp.call('update_note',{name:'Garden',content:'Root note v2',expected_revision:1});
    await mcp.call('update_note',{name:'Garden',content:'Root note v3',expected_revision:2});
    await mcp.call('append_to_note',{name:'Note',content:'more'});
    await mcp.call('delete_note',{name:'Bin'});

    assert.equal((await mf.dispatchFetch(origin+'/api/export')).status,401);
    const web=await browserSession(mf,db);
    const res=await web('/api/export');
    assert.equal(res.status,200);
    assert.equal(res.headers.get('content-type'),'application/zip');
    assert.match(res.headers.get('content-disposition'),/^attachment; filename="personal-vault-\d{4}-\d{2}-\d{2}\.zip"$/);
    assert.equal(res.headers.get('cache-control'),'no-store');
    const files=unzipSync(new Uint8Array(await res.arrayBuffer()));
    const text=path=>strFromU8(files[path]);

    // Paths are safe to extract anywhere and distinct on case-insensitive file systems.
    const paths=Object.keys(files);
    for (const path of paths) {
      assert.ok(!path.startsWith('/') && !/[\\:*?"<>|]/.test(path),path);
      assert.ok(path.split('/').every(part=>part && part!=='.' && part!=='..'),path);
    }
    assert.equal(new Set(paths.map(p=>p.toLowerCase())).size,paths.length);

    const manifest=JSON.parse(text('vault.json'));
    assert.equal(manifest.format,'personal-vault-export');
    const where=Object.fromEntries([...manifest.notes,...manifest.trash].map(n=>[n.name,n.path]));
    assert.deepEqual(where,{
      '/':'notes/Untitled.md','../escape':'notes/escape.md','CON':'notes/CON_.md','Empty':'notes/Empty.md','Garden':'notes/Garden.md',
      'Garden / Ideas':'notes/Garden/Ideas.md','Note':'notes/Note.md','a:b?*':'notes/a-b--.md','note':'notes/note (2).md','Bin':'trash/Bin.md',
    });
    assert.ok(manifest.trash[0].deleted_at);

    // Lossless: every note's exact name maps to a file holding its exact content.
    const rows=(await db.prepare('SELECT name, content, revision, created_at, updated_at FROM notes').all()).results;
    assert.equal(rows.length,seed.length);
    for (const row of rows) {
      assert.equal(text(where[row.name]),row.content,row.name);
      const entry=[...manifest.notes,...manifest.trash].find(n=>n.name===row.name);
      assert.deepEqual([entry.revision,entry.created_at,entry.updated_at],[row.revision,row.created_at,row.updated_at]);
    }

    // Earlier versions sit under history/, one file per revision.
    assert.deepEqual(manifest.revisions.map(r=>[r.note_name,r.revision,r.reason,r.path]),[
      ['Garden',1,'update','history/Garden/r1.md'],['Garden',2,'update','history/Garden/r2.md'],['Note',1,'append','history/Note/r1.md'],
    ]);
    assert.deepEqual(['history/Garden/r1.md','history/Garden/r2.md','history/Note/r1.md'].map(text),['Root note','Root note v2','Upper']);
    assert.equal(paths.length,seed.length+3+1);
  } finally {await mf.dispose();}
});
