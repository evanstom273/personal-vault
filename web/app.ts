import Dexie from 'dexie';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
type Note={name:string;content:string;revision:number;created_at:string;updated_at:string|null};
type Summary=Omit<Note,'content'>&{excerpt:string};
type Draft={key:string;name:string;content:string;revision?:number};
type Revision={revision:number;name:string;saved_at:string|null;reason:string;source:string;characters:number;excerpt:string};
type Trashed={name:string;deleted_at:string;excerpt:string};
const db=new Dexie('personal-vault-browser');db.version(1).stores({notes:'name',drafts:'key'});
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const title=$<HTMLInputElement>('title'),content=$<HTMLTextAreaElement>('content'),search=$<HTMLInputElement>('search');
let sessionGeneration=0;
let csrf='',current:Note|null=null,isNew=false,dirty=false,preview=false,next:string|null=null,searchRun=0,openRun=0,busy=false;
let draftTimer:ReturnType<typeof setTimeout>;
let viewing:{revision:number;content:string}|null=null;
const cache=(op:Promise<unknown>)=>op.catch(()=>{status('Browser cache unavailable · save online to keep changes');});
function status(s:string){$('status').textContent=s;}
function notice(s=''){$('notice').hidden=!s;$('notice').textContent=s;}
function key(){return isNew?'new:':'note:'+current?.name;}
function draft(){return {key:key(),name:title.value,content:content.value,revision:current?.revision};}
async function storeDraft(){clearTimeout(draftTimer);if(dirty) await cache(db.table('drafts').put(draft()));}
async function lock(clearDrafts=false){if(!clearDrafts)await storeDraft();sessionGeneration++;openRun++;searchRun++;clearTimeout(draftTimer);csrf='';current=null;dirty=false;title.value='';content.value='';$('preview').replaceChildren();$('notes').replaceChildren();document.querySelectorAll('dialog').forEach(d=>d.close());$('app').hidden=true;$('login').hidden=false;$('login-status').textContent='Sign in to continue.';await cache(db.table('notes').clear());if(clearDrafts)await cache(db.table('drafts').clear());}
async function api(path:string,options:RequestInit={}){
  const generation=sessionGeneration;
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Vault-CSRF':csrf,...options.headers},credentials:'same-origin'});
  if(generation!==sessionGeneration)throw new Error('Session closed.');
  if(response.status===401){await lock();throw new Error('Your session expired. Sign in again.');}
  const data=await response.json();if(!response.ok) throw new Error(data.error||'Request failed. Try again.');return data;
}
function run(f:()=>Promise<unknown>){return ()=>{void f().catch(e=>{notice(e.message);status('Action not completed');});};}
function countWords(){$('words').textContent=`${content.value.trim()?content.value.trim().split(/\s+/).length:0} words`;}
function renderPreview(){
 // [[Name]], [[Name#heading]], [[Name|alias]] and ![[Name]] all open the note named Name.
 const md=content.value.replace(/!?\[\[([^[\]\n|#]+)(#[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]/g,(_,name:string,heading='',alias?:string)=>`[${(alias||name+heading).replace(/[\\[\]]/g,'\\$&')}](#note=${encodeURIComponent(name)})`);
 $('preview').innerHTML=DOMPurify.sanitize(marked.parse(md,{async:false}) as string,{FORBID_TAGS:['img','style','form','input','button'],FORBID_ATTR:['style']});
 $('preview').querySelectorAll('a').forEach(a=>{if(!a.getAttribute('href')?.startsWith('#note=')){a.target='_blank';a.rel='noopener noreferrer';}});
}
function showEditor(){ $('empty').hidden=true;$('editor').hidden=false;for(const id of ['save','mode','reload']) ($<HTMLButtonElement>(id)).disabled=false;$('app').classList.remove('show-notes');$('mobile-notes').setAttribute('aria-expanded','false');}
function renderNote(n:Note|null,newName=''){
 current=n;isNew=!n;dirty=false;title.value=n?.name||newName;content.value=n?.content||'';showEditor();
 $('meta').textContent=n?`Updated ${new Date(n.updated_at||n.created_at).toLocaleString()} · Revision ${n.revision}`:'New note · not yet saved';
 $('delete').hidden=!n;$('reload').hidden=!n;$('history').hidden=!n;notice();status(n?'Saved':'New note');countWords();if(preview)renderPreview();
}
async function backlinks(name:string){const links=await api('/api/backlinks?name='+encodeURIComponent(name));if(current?.name!==name)return;$('backlinks').replaceChildren(document.createTextNode(links.length?'Linked from: ':'No backlinks yet.'));for(const item of links){const b=document.createElement('button');b.textContent=item.name;b.onclick=run(()=>openNote(item.name));$('backlinks').append(b);}}
async function openNote(name:string,discard=false){
 if(busy)return;await storeDraft();const generation=++openRun;status('Opening…');
 let n:Note;
 try{n=await api('/api/note?name='+encodeURIComponent(name));await cache(db.table('notes').put(n));}
 catch(err){if(!csrf)throw err;const cached=await db.table('notes').get(name);if(!cached||navigator.onLine)throw err;n=cached;notice('Offline · showing a cached note. Reconnect to save.');}
 if(generation!==openRun)return;renderNote(n);
 const saved=discard?null:await db.table('drafts').get('note:'+name).catch(()=>undefined) as Draft|undefined;
 if(generation!==openRun)return;
 if(saved){title.value=saved.name;content.value=saved.content;dirty=true;notice(saved.revision===n.revision?'Restored your unsaved draft.':'A newer version exists on the server. Your draft is shown; copy it before reloading.');if(saved.revision!==n.revision)current={...n,revision:saved.revision||n.revision};status('Unsaved draft');}
 if(discard)await cache(db.table('drafts').delete('note:'+name));countWords();if(preview)renderPreview();
 document.querySelectorAll('#notes button').forEach(b=>b.setAttribute('aria-current',String((b as HTMLElement).dataset.name===name)));
 await backlinks(name);
}
async function newNote(name=''){
 if(busy)return;await storeDraft();++openRun;renderNote(null,name);$('backlinks').textContent='Save this note to see backlinks.';
 {const saved=await db.table('drafts').get('new:').catch(()=>undefined) as Draft|undefined;if(saved){title.value=saved.name;content.value=saved.content;dirty=true;status('Restored new draft');if(name&&name!==saved.name)notice('Save this existing new draft first, then create the linked note.');}}
 title.focus();countWords();if(preview)renderPreview();
}
function appendList(notes:Summary[]){for(const n of notes){const b=document.createElement('button');b.dataset.name=n.name;b.setAttribute('aria-current',String(current?.name===n.name));const strong=document.createElement('strong');strong.textContent=n.name;const small=document.createElement('small');small.textContent=n.excerpt||'Empty note';b.append(strong,small);b.onclick=run(()=>openNote(n.name));$('notes').append(b);}}
async function list(more=false){
 const gen=++searchRun;const q=search.value;const result=await api('/api/notes?'+new URLSearchParams({q,...(more&&next?{after:next}:{})}));if(gen!==searchRun)return;
 if(!more)$('notes').replaceChildren();appendList(result.notes);next=result.next;$('more').hidden=!next;
 const count=$('notes').children.length;$('count').textContent=`${count}${next?'+':''} ${q?'matches':'notes'}`;
 if(!count){const p=document.createElement('p');p.textContent=q?'No matching notes.':'Your first note starts here.';p.className='hint';$('notes').append(p);}
}
async function save(){
 if(busy || (!current&&!isNew))return;if(!title.value.trim()){title.focus();throw new Error('Give your note a name first.');}
 busy=true;$<HTMLButtonElement>('save').disabled=true;await storeDraft();status('Saving…');
 const oldKey=key(),oldName=current?.name;const submitted={name:title.value,content:content.value,revision:current?.revision};
 try{
 const n=await api(isNew?'/api/notes':'/api/note?name='+encodeURIComponent(current!.name),{method:isNew?'POST':'PUT',body:JSON.stringify(submitted)});
 // Preserve edits typed while the save was in flight.
 await cache(db.table('drafts').delete(oldKey));if(oldName&&oldName!==n.name)await cache(db.table('notes').delete(oldName));await cache(db.table('notes').put(n));
 const changed=title.value!==submitted.name||content.value!==submitted.content;
 if(changed){current=n;isNew=false;dirty=true;await storeDraft();status('New changes · save again');}else renderNote(n);
 await list();await backlinks(n.name);
 }finally{busy=false;$<HTMLButtonElement>('save').disabled=false;}
}
async function remove(){if(!current || busy)return;const n=current;if(!confirm(`Move “${n.name}” to the trash? It can be restored later.`))return;
 await api('/api/note?name='+encodeURIComponent(n.name),{method:'DELETE',headers:{'If-Match':String(n.revision)}});
 clearTimeout(draftTimer);await cache(Promise.all([db.table('notes').delete(n.name),db.table('drafts').delete('note:'+n.name)]));current=null;isNew=false;dirty=false;title.value='';content.value='';$('editor').hidden=true;$('empty').hidden=false;for(const id of ['save','mode','reload'])$<HTMLButtonElement>(id).disabled=true;notice();status('Moved to trash');await list();}
function download(blob:Blob,name:string){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
const when=(s:string|null)=>s?new Date(s).toLocaleString():'unknown time';
const replacedBy:Record<string,string>={update:'Replaced by an edit',append:'Replaced by an append',rename:'Replaced when renamed',delete:'Kept when deleted'};
function item(heading:string,details:string[],action?:[string,()=>Promise<unknown>]){const li=document.createElement('li');const text=document.createElement('div');const strong=document.createElement('strong');strong.textContent=heading;text.append(strong);for(const d of details){const small=document.createElement('small');small.textContent=d;text.append(small);}li.append(text);if(action){const b=document.createElement('button');b.textContent=action[0];b.onclick=run(action[1]);li.append(b);}return li;}
async function showHistory(){
 if(!current)return;const name=current.name;viewing=null;$('revision-view').hidden=true;$('revisions').hidden=false;$('revisions').replaceChildren();$<HTMLDialogElement>('history-dialog').showModal();
 const h=await api('/api/revisions?name='+encodeURIComponent(name));if(current?.name!==name)return;
 if(!h.revisions.length){$('revisions').append(item('No earlier versions yet.',['Each save keeps the version it replaces.']));return;}
 for(const r of h.revisions as Revision[])$('revisions').append(item(`Revision ${r.revision} · saved ${when(r.saved_at)}`,[`${replacedBy[r.reason]||r.reason} ${r.source==='mcp'?'via MCP':'in the browser'} · ${r.characters} characters`,...(r.name!==name?[`Then named “${r.name}”`]:[]),r.excerpt||'Empty note'],['View',()=>viewRevision(name,r.revision)]));
}
async function viewRevision(name:string,revision:number){
 const r=await api(`/api/revision?name=${encodeURIComponent(name)}&revision=${revision}`);if(current?.name!==name)return;
 viewing={revision,content:r.content};$('revision-title').textContent=`Revision ${revision} · saved ${when(r.saved_at)}`;$('revision-content').textContent=r.content||'(empty)';$('revisions').hidden=true;$('revision-view').hidden=false;
}
function restoreRevision(){
 if(!viewing||!current)return;if(dirty&&!confirm('Replace your unsaved changes in the editor with this version?'))return;
 content.value=viewing.content;dirty=true;void storeDraft();notice();status(`Revision ${viewing.revision} in the editor · save to keep it`);countWords();if(preview)renderPreview();$<HTMLDialogElement>('history-dialog').close();
}
async function showTrash(){
 $('trash-list').replaceChildren();$<HTMLDialogElement>('trash-dialog').showModal();const t=await api('/api/trash');$('trash-list').replaceChildren();
 if(!t.notes.length){$('trash-list').append(item('The trash is empty.',[]));return;}
 for(const n of t.notes as Trashed[])$('trash-list').append(item(n.name,[`Moved to trash ${when(n.deleted_at)}`,n.excerpt||'Empty note'],['Restore',()=>restoreFromTrash(n.name)]));
}
async function restoreFromTrash(name:string){await api('/api/restore?name='+encodeURIComponent(name),{method:'POST'});$<HTMLDialogElement>('trash-dialog').close();await list();await openNote(name);status('Restored from trash');}
async function exportAll(){
 const generation=sessionGeneration;status('Preparing export…');
 const response=await fetch('/api/export',{credentials:'same-origin'});if(generation!==sessionGeneration)return;
 if(response.status===401){await lock();throw new Error('Your session expired. Sign in again.');}
 if(!response.ok)throw new Error('Export failed. Try again.');
 download(await response.blob(),/filename="([^"]+)"/.exec(response.headers.get('Content-Disposition')||'')?.[1]||'personal-vault.zip');status('Export downloaded');
}
for(const input of [title,content]) input.addEventListener('input',()=>{dirty=true;status('Unsaved · draft in this browser');clearTimeout(draftTimer);draftTimer=setTimeout(()=>void storeDraft(),350);countWords();if(preview)renderPreview();});
$('new').onclick=run(()=>newNote());$('empty-new').onclick=run(()=>newNote());$('save').onclick=run(save);$('delete').onclick=run(remove);
$('refresh').onclick=run(async()=>{await list();status(dirty?'Unsaved draft':'Note list refreshed');});$('more').onclick=run(()=>list(true));
let searchTimer:ReturnType<typeof setTimeout>;search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(run(()=>list()),200);};
$('reload').onclick=run(async()=>{if(current && (!dirty||confirm('Discard your local draft and reload the saved note?'))){dirty=false;clearTimeout(draftTimer);await openNote(current.name,true);}});
$('mode').onclick=()=>{preview=!preview;content.hidden=preview;$('preview').hidden=!preview;$('mode').textContent=preview?'Edit':'Preview';if(preview)renderPreview();};
$('preview').onclick=e=>{const a=(e.target as HTMLElement).closest('a');const href=a?.getAttribute('href');if(href?.startsWith('#note=')){e.preventDefault();const name=decodeURIComponent(href.slice(6));void openNote(name).catch(err=>{if(err.message==='Note not found.'&&confirm(`Create linked note “${name}”?`))void newNote(name);else notice(err.message);});}};
$('export').onclick=()=>download(new Blob([content.value],{type:'text/markdown;charset=utf-8'}),(title.value||'Untitled').replace(/[\\/:*?"<>|]/g,'-')+'.md');
$('history').onclick=run(showHistory);$('revision-restore').onclick=restoreRevision;$('revision-back').onclick=()=>{$('revision-view').hidden=true;$('revisions').hidden=false;};$('close-history').onclick=()=>$<HTMLDialogElement>('history-dialog').close();
$('trash-open').onclick=run(showTrash);$('close-trash').onclick=()=>$<HTMLDialogElement>('trash-dialog').close();$('export-all').onclick=run(exportAll);
$('logout').onclick=run(async()=>{if(dirty&&!confirm('Sign out? Unsaved browser drafts will be cleared. Save first to keep them.'))return;await api('/api/logout',{method:'POST'});clearTimeout(draftTimer);await lock(true);});
$('mobile-notes').onclick=()=>{const shown=$('app').classList.toggle('show-notes');$('mobile-notes').setAttribute('aria-expanded',String(shown));};
$('help').onclick=()=>$<HTMLDialogElement>('help-dialog').showModal();$('close-help').onclick=()=>$<HTMLDialogElement>('help-dialog').close();
window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(csrf)run(save)();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('app').classList.add('show-notes');search.focus();}});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('online',()=>{if(csrf)run(async()=>{await list();notice();status(dirty?'Unsaved draft · ready to save':'Online');})();});
async function init(){try{const session=await api('/api/session');csrf=session.csrf;$('login').hidden=true;$('app').hidden=false;await list();status('Vault ready');}catch(e){$('login-status').textContent=(e as Error).message;}}
void init();
