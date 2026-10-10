import { z } from 'zod';
import { createNote, readNote, trashNote, updateNote } from './notes';
export const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const random = () => crypto.randomUUID()+crypto.randomUUID();
const now = () => Math.floor(Date.now()/1000);
const cookie = (req: Request,name: string) => req.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
const sessionCookie = (value: string,age: number) => `__Host-vault-session=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const loginCookie = (value: string,age: number) => `__Host-vault-login=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
export async function githubIdentity(req: Request,env: Env,verifier: string): Promise<string|null> {
  const code = new URL(req.url).searchParams.get('code'); if (!code) return null;
  const res = await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:env.PUBLIC_ORIGIN+'/callback',code_verifier:verifier}),signal:AbortSignal.timeout(15000)});
  if(!res.ok) throw new Error('GitHub unavailable');
  const token=await res.json<{access_token?:string}>(); if(!token.access_token) return null;
  const user=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'personal-vault'},signal:AbortSignal.timeout(15000)});
  if(!user.ok) throw new Error('GitHub unavailable');
  const data=await user.json<{id?:number}>();return data.id ? String(data.id) : null;
}
export async function browserLogin(req: Request,env: Env): Promise<Response> {
  if(!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return new Response('GitHub login is not configured',{status:503});
  const state='web_'+random(),verifier=random();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM browser_logins WHERE expires_at < ?').bind(now()),
    env.DB.prepare('DELETE FROM browser_sessions WHERE expires_at < ?').bind(now()),
    env.DB.prepare('INSERT INTO browser_logins VALUES (?, ?, ?)').bind(await hash(state),verifier,now()+600)
  ]);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  const challenge=btoa(String.fromCharCode(...digest)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const target=new URL('https://github.com/login/oauth/authorize');
  target.search=new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,redirect_uri:env.PUBLIC_ORIGIN+'/callback',state,scope:'',code_challenge:challenge,code_challenge_method:'S256'}).toString();
  return new Response(null,{status:302,headers:{Location:target.toString(),'Set-Cookie':loginCookie(state,600)}});
}
export async function browserCallback(req: Request,env: Env) {
  const state=new URL(req.url).searchParams.get('state');
  if(!state || state!==cookie(req,'__Host-vault-login')) return new Response('Login expired. Return to the vault and sign in again.',{status:400});
  const row=await env.DB.prepare('DELETE FROM browser_logins WHERE state_hash = ? AND expires_at > ? RETURNING verifier').bind(await hash(state),now()).first<{verifier:string}>();
  const headers=new Headers({'Set-Cookie':loginCookie('',0)});
  if(!row) return new Response('Login expired. Return to the vault and sign in again.',{status:400,headers});
  const owner=await githubIdentity(req,env,row.verifier);
  if(owner!==env.GITHUB_OWNER_ID) return new Response('This vault belongs to another GitHub account.',{status:403,headers});
  const token=random();
  await env.DB.prepare('INSERT INTO browser_sessions VALUES (?, ?, ?)').bind(await hash(token),owner,now()+604800).run();
  headers.append('Set-Cookie',sessionCookie(token,604800));headers.set('Location','/');
  return new Response(null,{status:302,headers});
}
const input=z.object({name:z.string().trim().min(1).max(200).refine(s=>!/[\x00-\x1f\x7f]/.test(s)),content:z.string().max(100000),revision:z.number().int().positive().optional()});
const jsonError=(error: string,status=400)=>Response.json({error},{status});
const nameTaken=(trashed: boolean)=>trashed?'A note in the trash already uses that name. Restore it or choose another name.':'That note name already exists.';
export async function browserApi(req: Request,env: Env): Promise<Response> {
  const token=cookie(req,'__Host-vault-session');
  const session=token && await env.DB.prepare('SELECT owner_id FROM browser_sessions WHERE token_hash = ? AND expires_at > ?').bind(await hash(token),now()).first<{owner_id:string}>();
  if(!token || !session || session.owner_id!==env.GITHUB_OWNER_ID) return jsonError('Sign in to open your vault.',401);
  const csrf=await hash('csrf:'+token);
  if(!['GET','HEAD'].includes(req.method)) {
    if(req.headers.get('Origin')!==env.PUBLIC_ORIGIN || req.headers.get('X-Vault-CSRF')!==csrf) return jsonError('Invalid request. Reload and try again.',403);
  }
  const url=new URL(req.url);
  if(url.pathname==='/api/session' && req.method==='GET') return Response.json({csrf,owner:session.owner_id});
  if(url.pathname==='/api/logout' && req.method==='POST') {
    await env.DB.prepare('DELETE FROM browser_sessions WHERE token_hash = ?').bind(await hash(token)).run();
    return Response.json({ok:true},{headers:{'Set-Cookie':sessionCookie('',0),'Clear-Site-Data':'"cache", "storage"'}});
  }
  if(url.pathname==='/api/notes' && req.method==='GET') {
    const q=(url.searchParams.get('q')||'').slice(0,200);
    const after=url.searchParams.get('after')||'';
    const rows=await env.DB.prepare('SELECT name, created_at, updated_at, revision, substr(content,1,180) AS excerpt FROM notes WHERE deleted_at IS NULL AND name > ? AND (instr(lower(name),lower(?)) > 0 OR instr(lower(content),lower(?)) > 0) ORDER BY name LIMIT 201').bind(after,q,q).all<{name:string}>();
    return Response.json({notes:rows.results.slice(0,200),next:rows.results.length>200?rows.results[199].name:null});
  }
  if(url.pathname==='/api/notes' && req.method==='POST') {
    const parsed=input.safeParse(await req.json());if(!parsed.success) return jsonError('Use a name of 1–200 characters and content up to 100000 characters.');
    const {name,content}=parsed.data;
    const r=await createNote(env.DB,name,content);
    return 'note' in r?Response.json(r.note,{status:201}):jsonError(nameTaken(r.trashed),409);
  }
  if(url.pathname==='/api/note') {
    const name=url.searchParams.get('name');if(!name) return jsonError('Missing note name.');
    if(req.method==='GET') {
      const note=await readNote(env.DB,name);
      return note?Response.json(note):jsonError('Note not found.',404);
    }
    if(req.method==='PUT') {
      const parsed=input.safeParse(await req.json());if(!parsed.success) return jsonError('Invalid note or missing revision.');
      const {name:newName,content,revision}=parsed.data;if(!revision) return jsonError('Invalid note or missing revision.');
      const r=await updateNote(env.DB,{name,newName,content,revision,source:'browser'});
      if('note' in r) return Response.json(r.note);
      return r.error==='name_taken'?jsonError(nameTaken(r.trashed),409):jsonError('This note changed or was deleted elsewhere. Reload it before saving. Your draft is kept in this browser.',409);
    }
    if(req.method==='DELETE') {
      const revision=Number(req.headers.get('If-Match'));
      if(!Number.isInteger(revision)||revision<1) return jsonError('Missing revision.');
      const r=await trashNote(env.DB,name,revision);
      return 'error' in r?jsonError('The note changed elsewhere. Reload it before deleting.',409):Response.json({ok:true,...r});
    }
  }
  if(url.pathname==='/api/backlinks' && req.method==='GET') {
    const name=url.searchParams.get('name')||'';
    const rows=await env.DB.prepare('SELECT name FROM notes WHERE deleted_at IS NULL AND instr(content, ?) > 0 ORDER BY name LIMIT 100').bind('[['+name+']]').all();
    return Response.json(rows.results);
  }
  return jsonError('Not found.',404);
}
