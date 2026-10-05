import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

const nameSchema = z.string().trim().min(1).max(200).refine(s => !/[\x00-\x1f\x7f]/.test(s), 'Control characters are not allowed');
const result = (value: unknown) => ({content: [{type: 'text' as const, text: JSON.stringify(value)}]});
const error = (message: string) => ({...result({error: message}), isError: true});
const readOnly = {readOnlyHint: true, destructiveHint: false, openWorldHint: false};

export function createServer(db: D1Database) {
  const server = new McpServer({name: 'personal-vault', version: '1.0.0'});
  server.registerTool('get_vault_status', {description: 'Get private vault status and note count.', inputSchema: {}, annotations: readOnly}, async () => {
    const row = await db.prepare('SELECT count(*) AS note_count FROM notes').first();
    return result({status: 'ready', storage: 'Cloudflare D1', ...row});
  });
  server.registerTool('list_notes', {description: 'List up to 1000 note names and creation times in name order. Use search_notes to narrow larger vaults.', inputSchema: {}, annotations: readOnly}, async () => {
    const rows = await db.prepare('SELECT name, created_at FROM notes ORDER BY name LIMIT 1001').all();
    return result({notes: rows.results.slice(0,1000), truncated: rows.results.length > 1000});
  });
  server.registerTool('read_note', {description: 'Read a note by its exact name.', inputSchema: {name: nameSchema}, annotations: readOnly}, async ({name}) => {
    const note = await db.prepare('SELECT name, content, created_at FROM notes WHERE name = ?').bind(name).first();
    return note ? result(note) : error('Note not found');
  });
  server.registerTool('create_note', {description: 'Create a new note. Existing notes are never overwritten. Maximum content length: 100000 characters.', inputSchema: {name: nameSchema, content: z.string().max(100000)}, annotations: {readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false}}, async ({name,content}) => {
    const rows = await db.prepare('INSERT INTO notes (name, content) VALUES (?, ?) ON CONFLICT(name) DO NOTHING RETURNING name, created_at').bind(name,content).all();
    return rows.results.length ? result(rows.results[0]) : error('A note with that name already exists');
  });
  server.registerTool('search_notes', {description: 'Search note names and content for a literal substring, case-insensitive for ASCII. Returns up to 100 matching names and excerpts.', inputSchema: {query: z.string().trim().min(1).max(200)}, annotations: readOnly}, async ({query}) => {
    const rows = await db.prepare('SELECT name, substr(content, 1, 300) AS excerpt, created_at FROM notes WHERE instr(lower(name), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0 ORDER BY name LIMIT 101').bind(query,query).all();
    return result({notes: rows.results.slice(0,100), truncated: rows.results.length > 100});
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
