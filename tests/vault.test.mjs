import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash, randomBytes } from 'node:crypto';

const origin = 'https://personal-vault.evanstom273.workers.dev';
let githubId = 60609303;
function github(id=60609303) { githubId=id; }
const outboundService = async req => {
  const u=new URL(req.url);
  if(u.origin==='https://github.com' && u.pathname==='/login/oauth/access_token') return Response.json({access_token:'mock-github-token'});
  if(u.origin==='https://api.github.com' && u.pathname==='/user') return Response.json({id:githubId});
  throw new Error('Unexpected outbound request: '+u.origin+u.pathname);
};
const config = (path,secrets=true) => ({modules:[{type:'ESModule',path:'dist/index.js'},...readdirSync('dist').filter(f=>f.endsWith('.txt')).map(f=>({type:'Text',path:'dist/'+f}))],compatibilityDate:'2026-10-05',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],d1Databases:['DB'],resourcePersistencePath:path,outboundService,bindings:{PUBLIC_ORIGIN:origin,GITHUB_OWNER_ID:'60609303',...(secrets?{GITHUB_CLIENT_ID:'mock-id',GITHUB_CLIENT_SECRET:'mock-secret'}:{})}});
const cookie = res => res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function register(mf) {
  const res=await mf.dispatchFetch(origin+'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Test MCP',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
  assert.equal(res.status,201);return res.json();
}
async function start(mf,client) {
  const verifier=randomBytes(32).toString('base64url');
  const params=new URLSearchParams({client_id:client.client_id,redirect_uri:'https://client.example/callback',response_type:'code',scope:'vault',state:'client-state',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:origin+'/mcp'});
  const consent=await mf.dispatchFetch(origin+'/authorize?'+params);assert.equal(consent.status,200);
  const html=await consent.text();const handle=html.match(/name="handle" value="([^"]+)"/)[1];
  return {verifier,handle,cookie:cookie(consent)};
}
async function approve(mf,s,originHeader=origin) {
  const res=await mf.dispatchFetch(origin+'/authorize',{method:'POST',headers:{...(originHeader === null ? {} : {Origin:originHeader}),Cookie:s.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle:s.handle,decision:'approve'}).toString(),redirect:'manual'});
  assert.equal(res.status,302);return {state:new URL(res.headers.get('Location')).searchParams.get('state'),cookie:cookie(res)};
}
async function callback(mf,up,id=60609303) {
  github(id);return mf.dispatchFetch(origin+'/callback?'+new URLSearchParams({state:up.state,code:'mock-code'}),{headers:{Cookie:up.cookie},redirect:'manual'});
}
async function token(mf,client,s,code,verifier=s.verifier) {
  return mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:'https://client.example/callback',code_verifier:verifier,resource:origin+'/mcp'}).toString()});
}
async function rpc(mf,access,name,args={}) {
  const response=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  assert.equal(response.status,200);return (await response.json()).result;
}
const decoded = r => JSON.parse(r.content[0].text);

test('OAuth security, five MCP tools, validation, and D1 persistence',async()=>{
  const path=await mkdtemp(join(tmpdir(),'vault-test-'));let mf=new Miniflare(convertV4MiniflareOptions(config(path)));
  try {
    const db=await mf.getD1Database('DB');await db.exec((await readFile('migrations/0001_notes.sql','utf8')).replaceAll('\n',' '));
    await db.exec((await readFile('migrations/0002_browser.sql','utf8')).replaceAll('\n',' '));
    const home=await mf.dispatchFetch(origin);assert.equal(home.status,200);assert.match(await home.text(),/Open with GitHub/);
    for(const method of ['GET','POST','DELETE']) {
      const res=await mf.dispatchFetch(origin+'/mcp',{method,headers:{Authorization:'Bearer invalid'}});assert.equal(res.status,401);assert.match(res.headers.get('www-authenticate'),/resource_metadata/);
    }
    const metadata=await mf.dispatchFetch(origin+'/.well-known/oauth-protected-resource/mcp');assert.equal(metadata.status,200);assert.equal((await metadata.json()).resource,origin+'/mcp');
    const client=await register(mf);
    const forged=await start(mf,client);
    const noCookie=await mf.dispatchFetch(origin+'/authorize',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle:forged.handle,decision:'approve'}).toString()});assert.equal(noCookie.status,400);
    const evilOrigin=await mf.dispatchFetch(origin+'/authorize',{method:'POST',headers:{Origin:'https://evil.example',Cookie:forged.cookie}});assert.equal(evilOrigin.status,403);
    // Browser regression: privacy settings may omit Origin or send literal null.
    for (const originHeader of [null, 'null']) {
      const s = await start(mf,client);
      const headers = {'Content-Type':'application/x-www-form-urlencoded', ...(originHeader === null ? {} : {Origin:originHeader})};
      const body = new URLSearchParams({handle:s.handle,decision:'approve'}).toString();
      assert.equal((await mf.dispatchFetch(origin+'/authorize',{method:'POST',headers,body})).status,400);
      assert.equal((await mf.dispatchFetch(origin+'/authorize',{method:'POST',headers:{...headers,Cookie:s.cookie,'Sec-Fetch-Site':'cross-site'},body})).status,403);
      const up = await approve(mf,s,originHeader); assert.ok(up.state);
    }
    const wrongUser=await start(mf,client);const rejected=await callback(mf,await approve(mf,wrongUser),123);assert.match(rejected.headers.get('location'),/error=access_denied/);
    const missingCookie=await approve(mf,await start(mf,client));const badCallback=await mf.dispatchFetch(origin+'/callback?state='+missingCookie.state+'&code=x');assert.equal(badCallback.status,400);
    const s=await start(mf,client);const up=await approve(mf,s);const cb=await callback(mf,up);assert.equal(cb.status,302);
    const code=new URL(cb.headers.get('location')).searchParams.get('code');assert.ok(code);
    const badPkce=await token(mf,client,s,code,'wrong-verifier');assert.equal(badPkce.status,400);
    // A bad verifier must not yield access; use a new authorization after the attempt.
    const good=await start(mf,client);const final=await callback(mf,await approve(mf,good));const goodCode=new URL(final.headers.get('location')).searchParams.get('code');
    const tokensResponse=await token(mf,client,good,goodCode);assert.equal(tokensResponse.status,200);const tokens=await tokensResponse.json();assert.ok(tokens.access_token);assert.ok(tokens.refresh_token);
    assert.equal(decoded(await rpc(mf,tokens.access_token,'get_vault_status')).note_count,0);
    assert.equal(decoded(await rpc(mf,tokens.access_token,'create_note',{name:'First note',content:'Private searchable text 100%'})).name,'First note');
    assert.equal((await rpc(mf,tokens.access_token,'create_note',{name:'First note',content:'overwrite'})).isError,true);
    assert.equal(decoded(await rpc(mf,tokens.access_token,'read_note',{name:'First note'})).content,'Private searchable text 100%');
    assert.equal(decoded(await rpc(mf,tokens.access_token,'list_notes')).notes.length,1);
    assert.equal(decoded(await rpc(mf,tokens.access_token,'search_notes',{query:'SEARCHABLE'})).notes.length,1);
    assert.equal(decoded(await rpc(mf,tokens.access_token,'search_notes',{query:'%'})).notes.length,1);
    assert.equal(decoded(await rpc(mf,tokens.access_token,'search_notes',{query:"' OR 1=1 --"})).notes.length,0);
    assert.equal((await rpc(mf,tokens.access_token,'create_note',{name:' ',content:'x'})).isError,true);
    assert.equal((await rpc(mf,tokens.access_token,'create_note',{name:'large',content:'x'.repeat(100001)})).isError,true);
    assert.equal((await rpc(mf,tokens.access_token,'read_note',{name:'missing'})).isError,true);
    const refresh=await mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:origin+'/mcp'}).toString()});assert.equal(refresh.status,200);
    const refreshed=await refresh.json();assert.equal(decoded(await rpc(mf,refreshed.access_token,'get_vault_status')).note_count,1);
    // Browser login shares the GitHub callback but issues a separate HttpOnly session.
    assert.equal((await mf.dispatchFetch(origin+'/api/notes')).status,401);
    async function browserSignIn(id=60609303) {
      const login=await mf.dispatchFetch(origin+'/login',{redirect:'manual'});assert.equal(login.status,302);
      const state=new URL(login.headers.get('location')).searchParams.get('state');
      assert.equal((await mf.dispatchFetch(origin+'/callback?state='+state+'&code=x')).status,400);
      github(id);
      return mf.dispatchFetch(origin+'/callback?state='+state+'&code=x',{headers:{Cookie:cookie(login)},redirect:'manual'});
    }
    assert.equal((await browserSignIn(123)).status,403);
    const webLogin=await browserSignIn();assert.equal(webLogin.status,302);
    const webCookie=cookie(webLogin);
    assert.match(webLogin.headers.getSetCookie().join(';'),/HttpOnly/);
    const session=await (await mf.dispatchFetch(origin+'/api/session',{headers:{Cookie:webCookie}})).json();assert.ok(session.csrf);
    const wh={Cookie:webCookie,Origin:origin,'X-Vault-CSRF':session.csrf,'Content-Type':'application/json'};
    const web=(path,method='GET',body,headers=wh)=>mf.dispatchFetch(origin+path,{method,headers,body:body?JSON.stringify(body):undefined});
    assert.equal((await web('/api/notes','POST',{name:'bad',content:'x'},{Cookie:webCookie,Origin:origin,'Content-Type':'application/json'})).status,403);
    assert.equal((await web('/api/notes','POST',{name:'bad',content:'x'},{...wh,Origin:'https://evil.example'})).status,403);
    const created=await web('/api/notes','POST',{name:'Browser note',content:'See [[First note]]'});assert.equal(created.status,201);let note=await created.json();assert.equal(note.revision,1);
    assert.equal(decoded(await rpc(mf,refreshed.access_token,'read_note',{name:'Browser note'})).content,'See [[First note]]');
    assert.equal((await (await web('/api/backlinks?name=First%20note')).json()).length,1);
    const edited=await web('/api/note?name=Browser%20note','PUT',{name:'Renamed',content:'Updated',revision:note.revision});assert.equal(edited.status,200);note=await edited.json();assert.equal(note.revision,2);
    assert.equal((await web('/api/note?name=Renamed','PUT',{name:'Renamed',content:'Stale',revision:1})).status,409);
    assert.equal((await web('/api/note?name=Renamed','PUT',{name:'First note',content:'Collision',revision:2})).status,409);
    assert.equal((await (await web('/api/notes?q=updated')).json()).notes.length,1);
    assert.equal((await web('/api/note?name=Renamed','DELETE',undefined,{...wh,'If-Match':'1'})).status,409);
    assert.equal((await web('/api/note?name=Renamed','DELETE',undefined,{...wh,'If-Match':'2'})).status,200);
    assert.equal((await web('/api/note?name=Renamed')).status,404);
    assert.equal((await web('/api/logout','POST')).status,200);
    assert.equal((await web('/api/notes')).status,401);
    const replay=await token(mf,client,good,goodCode);assert.equal(replay.status,400);
    await mf.dispose();mf=new Miniflare(convertV4MiniflareOptions(config(path,false)));
    const persisted=await mf.getD1Database('DB');assert.equal((await persisted.prepare('SELECT content FROM notes WHERE name = ?').bind('First note').first()).content,'Private searchable text 100%');
    assert.equal((await mf.dispatchFetch(origin+'/authorize')).status,503);
    assert.equal((await mf.dispatchFetch(origin+'/mcp',{method:'POST'})).status,401);
  } finally {await mf.dispose();await rm(path,{recursive:true,force:true});}
});
