import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { linkedNotes } from './links';
import { appendToNote, createNote, listRevisions, listTrash, readNote, readRevision, restoreNote, trashNote, updateNote } from './notes';

const nameSchema = z.string().trim().min(1).max(200).refine(s => !/[\x00-\x1f\x7f]/.test(s), 'Control characters are not allowed');
const result = (value: unknown) => ({content: [{type: 'text' as const, text: JSON.stringify(value)}]});
const error = (message: string) => ({...result({error: message}), isError: true});
const readOnly = {readOnlyHint: true, destructiveHint: false, openWorldHint: false};
const revisionSchema = z.number().int().positive();
const inTrash = 'That note is in the trash. Restore it with restore_note first.';

export function createServer(db: D1Database) {
  const server = new McpServer({name: 'personal-vault', version: '1.0.0'});
  server.registerTool('get_vault_status', {description: 'Get private vault status, note count and trash count.', inputSchema: {}, annotations: readOnly}, async () => {
    const row = await db.prepare('SELECT count(*) - count(deleted_at) AS note_count, count(deleted_at) AS trash_count FROM notes').first();
    return result({status: 'ready', storage: 'Cloudflare D1', ...row});
  });
  server.registerTool('list_notes', {description: 'List up to 1000 note names and creation times in name order. Use search_notes to narrow larger vaults.', inputSchema: {}, annotations: readOnly}, async () => {
    const rows = await db.prepare('SELECT name, created_at FROM notes WHERE deleted_at IS NULL ORDER BY name LIMIT 1001').all();
    return result({notes: rows.results.slice(0,1000), truncated: rows.results.length > 1000});
  });
  server.registerTool('read_note', {description: 'Read a note by its exact name.', inputSchema: {name: nameSchema}, annotations: readOnly}, async ({name}) => {
    const note = await readNote(db, name);
    return note ? result(note) : error('Note not found');
  });
  server.registerTool('create_note', {description: 'Create a new note. Existing notes are never overwritten. Maximum content length: 100000 characters.', inputSchema: {name: nameSchema, content: z.string().max(100000)}, annotations: {readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false}}, async ({name,content}) => {
    const r = await createNote(db, name, content);
    if ('note' in r) return result({name: r.note.name, created_at: r.note.created_at});
    return error(r.trashed ? 'A note with that name is in the trash. Restore it with restore_note or choose another name.' : 'A note with that name already exists');
  });
  server.registerTool('search_notes', {description: 'Search note names and content for a literal substring, case-insensitive for ASCII. Returns up to 100 matching names and excerpts.', inputSchema: {query: z.string().trim().min(1).max(200)}, annotations: readOnly}, async ({query}) => {
    const rows = await db.prepare('SELECT name, substr(content, 1, 300) AS excerpt, created_at FROM notes WHERE deleted_at IS NULL AND (instr(lower(name), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0) ORDER BY name LIMIT 101').bind(query,query).all();
    return result({notes: rows.results.slice(0,100), truncated: rows.results.length > 100});
  });
  server.registerTool('update_note', {description: 'Replace the full content of an existing note. Pass expected_revision from read_note; the update is rejected if the note changed since then. The previous version is kept in revision history (see list_note_revisions). Identical content changes nothing. Maximum content length: 100000 characters.', inputSchema: {name: nameSchema, content: z.string().max(100000), expected_revision: revisionSchema}, annotations: {readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false}}, async ({name,content,expected_revision}) => {
    const r = await updateNote(db, {name, content, revision: expected_revision, source: 'mcp'});
    if ('note' in r) return result({name: r.note.name, revision: r.note.revision, updated_at: r.note.updated_at, previous_revision: expected_revision, changed: r.note.revision !== expected_revision});
    return error(r.error === 'conflict' ? `Note changed since revision ${expected_revision}; current revision is ${r.current}. Read it again before updating.` : r.error === 'trashed' ? inTrash : 'Note not found');
  });
  server.registerTool('append_to_note', {description: 'Append text to the end of an existing note, starting on a new line. Does not need a revision; the previous version is kept in revision history. The note may hold at most 100000 characters.', inputSchema: {name: nameSchema, content: z.string().min(1).max(100000)}, annotations: {readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false}}, async ({name,content}) => {
    const r = await appendToNote(db, name, content, 'mcp');
    if ('note' in r) return result({name: r.note.name, revision: r.note.revision, updated_at: r.note.updated_at, characters: [...r.note.content].length});
    return error(r.error === 'too_long' ? 'Appending would exceed the 100000-character note limit. Nothing was changed.' : r.error === 'trashed' ? inTrash : 'Note not found');
  });
  server.registerTool('delete_note', {description: 'Move a note to the trash. It no longer appears in list, read or search, but keeps its content and revision history and can be brought back with restore_note. Its name stays reserved while it is in the trash.', inputSchema: {name: nameSchema}, annotations: {readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false}}, async ({name}) => {
    const r = await trashNote(db, name);
    return 'error' in r ? error(r.error === 'trashed' ? 'That note is already in the trash' : 'Note not found') : result(r);
  });
  server.registerTool('restore_note', {description: 'Restore a note from the trash, with its content and revision history unchanged.', inputSchema: {name: nameSchema}, annotations: {readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false}}, async ({name}) => {
    const note = await restoreNote(db, name);
    return note ? result({name: note.name, revision: note.revision, restored: true}) : error('No note with that name is in the trash');
  });
  server.registerTool('list_trash', {description: 'List notes in the trash, most recently deleted first (up to 1000), with excerpts.', inputSchema: {}, annotations: readOnly}, async () => result(await listTrash(db)));
  server.registerTool('get_linked_notes', {description: 'Get the notes linked from a note and the notes linking to it. Outgoing [[wikilinks]] are listed in order with status exists, missing or trashed; backlinks (up to 100) include text around the link. [[Name|alias]] and [[Name#heading]] link to the note named exactly Name.', inputSchema: {name: nameSchema}, annotations: readOnly}, async ({name}) => {
    const linked = await linkedNotes(db, name);
    return linked ? result(linked) : error('Note not found');
  });
  server.registerTool('list_note_revisions', {description: 'List earlier saved versions of a note, newest first (up to 200), with excerpts. The current version is not included; read_note returns it.', inputSchema: {name: nameSchema}, annotations: readOnly}, async ({name}) => {
    const history = await listRevisions(db, name);
    return history ? result(history) : error('Note not found');
  });
  server.registerTool('read_note_revision', {description: 'Read the full content of one version of a note by revision number. To restore it, pass its content to update_note.', inputSchema: {name: nameSchema, revision: revisionSchema}, annotations: readOnly}, async ({name,revision}) => {
    const found = await readRevision(db, name, revision);
    return found ? result(found) : error('Revision not found');
  });
  return server;
}

export async function handleMcp(request: Request, env: Env) {
  const server = createServer(env.DB);
  const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
