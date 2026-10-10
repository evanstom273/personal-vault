import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export const origin = 'https://personal-vault.evanstom273.workers.dev';
export const ownerId = '60609303';

// Migrations in filename order, as `wrangler d1 migrations apply` runs them.
export const migrationFiles = () => readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort();
// D1 exec treats each line as a statement, so join lines after stripping line comments.
export async function applyMigration(db,file) {
  await db.exec((await readFile('migrations/'+file,'utf8')).replace(/--[^\n]*/g,'').replaceAll('\n',' '));
}
export async function applyMigrations(db,files=migrationFiles()) { for (const f of files) await applyMigration(db,f); }

// Worker built by `npm run build` (dist/), local D1/KV, GitHub HTTP mocked to answer as the owner.
export const workerModules = () => [{type:'ESModule',path:'dist/index.js'},...readdirSync('dist').filter(f=>f.endsWith('.txt')).map(f=>({type:'Text',path:'dist/'+f}))];
export async function openVault({migrate=true}={}) {
  const outboundService = async req => {
    const u=new URL(req.url);
    if(u.origin==='https://github.com' && u.pathname==='/login/oauth/access_token') return Response.json({access_token:'mock-github-token'});
    if(u.origin==='https://api.github.com' && u.pathname==='/user') return Response.json({id:Number(ownerId)});
    throw new Error('Unexpected outbound request: '+u.origin+u.pathname);
  };
  const mf=new Miniflare(convertV4MiniflareOptions({modules:workerModules(),compatibilityDate:'2026-10-05',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],d1Databases:['DB'],outboundService,bindings:{PUBLIC_ORIGIN:origin,GITHUB_OWNER_ID:ownerId,GITHUB_CLIENT_ID:'mock-id',GITHUB_CLIENT_SECRET:'mock-secret'}}));
  const db=await mf.getD1Database('DB');
  if(migrate) await applyMigrations(db);
  return {mf,db};
}

const cookie = res => res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');

// Full MCP OAuth flow as the owner; returns a JSON-RPC client for /mcp.
export async function connectMcp(mf) {
  const reg=await mf.dispatchFetch(origin+'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Test MCP',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
  assert.equal(reg.status,201);const client=await reg.json();
  const verifier=randomBytes(32).toString('base64url');
  const params=new URLSearchParams({client_id:client.client_id,redirect_uri:'https://client.example/callback',response_type:'code',scope:'vault',state:'s',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:origin+'/mcp'});
  const consent=await mf.dispatchFetch(origin+'/authorize?'+params);assert.equal(consent.status,200);
  const handle=(await consent.text()).match(/name="handle" value="([^"]+)"/)[1];
  const approved=await mf.dispatchFetch(origin+'/authorize',{method:'POST',headers:{Origin:origin,Cookie:cookie(consent),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,decision:'approve'}).toString(),redirect:'manual'});
  assert.equal(approved.status,302);
  const state=new URL(approved.headers.get('Location')).searchParams.get('state');
  const cb=await mf.dispatchFetch(origin+'/callback?'+new URLSearchParams({state,code:'mock-code'}),{headers:{Cookie:cookie(approved)},redirect:'manual'});
  const code=new URL(cb.headers.get('location')).searchParams.get('code');
  const tokens=await (await mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:'https://client.example/callback',code_verifier:verifier,resource:origin+'/mcp'}).toString()})).json();
  assert.ok(tokens.access_token);
  const rpc=async(method,params)=>{
    const res=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    assert.equal(res.status,200);const body=await res.json();assert.ok(body.result,JSON.stringify(body.error));return body.result;
  };
  return {
    tools: async()=>(await rpc('tools/list',{})).tools,
    // Returns the decoded JSON payload; `isError` marks tool-level failures.
    // Input validation failures are plain text from the SDK, so wrap those as {error}.
    call: async(name,args={})=>{
      const r=await rpc('tools/call',{name,arguments:args});const text=r.content[0].text;
      try {return {isError:!!r.isError,data:JSON.parse(text)};} catch {assert.ok(r.isError,text);return {isError:true,data:{error:text}};}
    },
  };
}

// Owner browser session inserted directly (login flow is covered in vault.test.mjs).
export async function browserSession(mf,db) {
  const token=randomBytes(24).toString('hex');
  await db.prepare('INSERT INTO browser_sessions VALUES (?, ?, ?)').bind(createHash('sha256').update(token).digest('hex'),ownerId,Math.floor(Date.now()/1000)+3600).run();
  const Cookie='__Host-vault-session='+token;
  const {csrf}=await (await mf.dispatchFetch(origin+'/api/session',{headers:{Cookie}})).json();
  return (path,{method='GET',body,headers={}}={})=>mf.dispatchFetch(origin+path,{method,headers:{Cookie,Origin:origin,'X-Vault-CSRF':csrf,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
}
