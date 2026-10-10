import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openVault, browserSession, origin } from './helpers.mjs';

test('browser history, trash and restore endpoints are owner-only and CSRF-protected',async()=>{
  const {mf,db}=await openVault();
  try {
    for (const path of ['/api/revisions?name=a','/api/revision?name=a&revision=1','/api/trash','/api/export']) assert.equal((await mf.dispatchFetch(origin+path)).status,401,path);
    assert.equal((await mf.dispatchFetch(origin+'/api/restore?name=a',{method:'POST',headers:{Origin:origin}})).status,401);

    const web=await browserSession(mf,db);
    assert.equal((await web('/api/notes',{method:'POST',body:{name:'Draft',content:'one'}})).status,201);
    assert.equal((await web('/api/note?name=Draft',{method:'PUT',body:{name:'Draft',content:'two',revision:1}})).status,200);

    const history=await (await web('/api/revisions?name=Draft')).json();
    assert.equal(history.current.revision,2);
    assert.deepEqual(history.revisions.map(r=>[r.revision,r.excerpt,r.reason,r.source]),[[1,'one','update','browser']]);
    assert.equal((await (await web('/api/revision?name=Draft&revision=1')).json()).content,'one');
    assert.equal((await (await web('/api/revision?name=Draft&revision=2')).json()).current,true);
    assert.equal((await web('/api/revision?name=Draft&revision=0')).status,400);
    assert.equal((await web('/api/revision?name=Draft&revision=5')).status,404);
    assert.equal((await web('/api/revisions?name=Nope')).status,404);

    assert.equal((await web('/api/note?name=Draft',{method:'DELETE',headers:{'If-Match':'2'}})).status,200);
    assert.deepEqual((await (await web('/api/trash')).json()).notes.map(n=>n.name),['Draft']);
    assert.equal((await web('/api/restore?name=Draft',{method:'POST',headers:{'X-Vault-CSRF':''}})).status,403);
    assert.equal((await web('/api/restore?name=Draft',{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal((await web('/api/restore?name=Draft',{method:'GET'})).status,404);
    const restored=await web('/api/restore?name=Draft',{method:'POST'});
    assert.equal(restored.status,200);assert.deepEqual(Object.entries(await restored.json()).filter(([k])=>['name','content','revision'].includes(k)),[['name','Draft'],['content','two'],['revision',2]]);
    assert.equal((await web('/api/restore?name=Draft',{method:'POST'})).status,404);
    assert.equal((await (await web('/api/note?name=Draft')).json()).content,'two');
    assert.deepEqual((await (await web('/api/trash')).json()).notes,[]);
  } finally {await mf.dispose();}
});
