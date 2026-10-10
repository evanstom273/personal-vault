import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openVault, connectMcp, browserSession } from './helpers.mjs';

test('get_linked_notes reports outgoing wikilinks with status and backlinks with context',async()=>{
  const {mf,db}=await openVault();
  try {
    const mcp=await connectMcp(mf);
    assert.equal((await mcp.tools()).find(t=>t.name==='get_linked_notes').annotations.readOnlyHint,true);
    const seed=[
      ['Hub','See [[Alpha]], [[Beta|the beta]] and [[Gamma#Intro]].\nAlso [[Missing]], [[Alpha]] again, ![[Alpha]], [[Trashed]], [[Q&A (2026)]] and [[Hub]].\nNot links: [[]] [[a\nb]] `[x]`'],
      ['Alpha','Back to [[Hub]].'],
      ['Beta','A long preamble '.repeat(10)+'then [[Hub|home]] and more text after it.'],
      ['Gamma','Ref [[Hub#Section]]'],
      ['Unrelated','Mentions Hub and [[Hubble]] but does not link.'],
      ['Q&A (2026)','Answers. [[Hub]]'],
      ['Trashed','[[Hub]]'],
    ];
    for (const [name,content] of seed) await mcp.call('create_note',{name,content});
    await mcp.call('delete_note',{name:'Trashed'});

    const linked=(await mcp.call('get_linked_notes',{name:'Hub'})).data;
    assert.deepEqual(linked.links,[
      {name:'Alpha',status:'exists'},{name:'Beta',status:'exists'},{name:'Gamma',status:'exists'},{name:'Missing',status:'missing'},
      {name:'Trashed',status:'trashed'},{name:'Q&A (2026)',status:'exists'},{name:'Hub',status:'exists'},
    ]);
    assert.deepEqual(linked.backlinks.map(b=>b.name),['Alpha','Beta','Gamma','Q&A (2026)']);
    assert.equal(linked.backlinks_truncated,false);
    const beta=linked.backlinks.find(b=>b.name==='Beta').context;
    assert.ok(beta.includes('[[Hub|home]]') && beta.length<=200 && !beta.startsWith('A long'),beta);

    // Special characters in names are matched literally.
    assert.deepEqual((await mcp.call('get_linked_notes',{name:'Q&A (2026)'})).data.backlinks.map(b=>b.name),['Hub']);
    assert.deepEqual((await mcp.call('get_linked_notes',{name:'Alpha'})).data.links,[{name:'Hub',status:'exists'}]);
    assert.match((await mcp.call('get_linked_notes',{name:'Missing'})).data.error,/not found/);
    assert.equal((await mcp.call('get_linked_notes',{name:'Trashed'})).isError,true);

    // Links follow edits: removing a link removes the backlink.
    await mcp.call('update_note',{name:'Alpha',content:'No more links.',expected_revision:1});
    assert.deepEqual((await mcp.call('get_linked_notes',{name:'Hub'})).data.backlinks.map(b=>b.name),['Beta','Gamma','Q&A (2026)']);

    // The browser's backlinks panel uses the same matching.
    const web=await browserSession(mf,db);
    assert.deepEqual(await (await web('/api/backlinks?name=Hub')).json(),[{name:'Beta'},{name:'Gamma'},{name:'Q&A (2026)'}]);
  } finally {await mf.dispose();}
});
