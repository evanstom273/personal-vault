// Shared note storage for the MCP tools and the browser API.
// Every change to an existing note first copies the current version into
// note_revisions inside the same D1 batch (one transaction), so earlier content
// is never lost. Writes are guarded by the expected revision; a stale write
// changes nothing. Deleting moves a note to the trash (deleted_at is set): it
// keeps its row, content and history, and its name stays reserved until it
// is restored. Live reads and writes ignore trashed notes.
export type Source = 'mcp' | 'browser';
export type Note = {name: string; content: string; created_at: string; revision: number; updated_at: string | null};
export type WriteResult = {note: Note} | Failure | {error: 'name_taken'; trashed: boolean};

export const NOTE_COLUMNS = 'name, content, created_at, revision, updated_at';
export const MAX_CONTENT = 100000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ARCHIVE = 'INSERT INTO note_revisions (note_name, revision, name, content, updated_at, reason, source) SELECT name, revision, name, content, updated_at, ?, ? FROM notes';

const LIVE = 'deleted_at IS NULL';

const state = (db: D1Database, name: string) => db.prepare('SELECT revision, deleted_at FROM notes WHERE name = ?').bind(name).first<{revision: number; deleted_at: string | null}>();

type Failure = {error: 'not_found' | 'trashed'} | {error: 'conflict'; current: number};
async function failure(db: D1Database, name: string): Promise<Failure> {
  const row = await state(db, name);
  return !row ? {error: 'not_found'} : row.deleted_at ? {error: 'trashed'} : {error: 'conflict', current: row.revision};
}

export const readNote = (db: D1Database, name: string) =>
  db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE name = ? AND ${LIVE}`).bind(name).first<Note>();

// Inserts only if the name is free; `trashed` reports a name held by a trashed note.
export async function createNote(db: D1Database, name: string, content: string): Promise<{note: Note} | {error: 'name_taken'; trashed: boolean}> {
  const note = await db.prepare(`INSERT INTO notes (name, content) VALUES (?, ?) ON CONFLICT(name) DO NOTHING RETURNING ${NOTE_COLUMNS}`).bind(name, content).first<Note>();
  return note ? {note} : {error: 'name_taken', trashed: !!(await state(db, name))?.deleted_at};
}

export async function updateNote(db: D1Database, {name, newName = name, content, revision, source}: {name: string; newName?: string; content: string; revision: number; source: Source}): Promise<WriteResult> {
  const renamed = newName !== name;
  // Matches the live note at `revision`, unless the save would change nothing.
  const guard = `name = ? AND revision = ? AND ${LIVE}${renamed ? '' : ' AND content <> ?'}`;
  const args = renamed ? [name, revision] : [name, revision, content];
  const statements = [db.prepare(`${ARCHIVE} WHERE ${guard}`).bind(renamed ? 'rename' : 'update', source, ...args)];
  // History follows a rename. Must run before the notes update changes the name.
  if (renamed) statements.push(db.prepare(`UPDATE note_revisions SET note_name = ? WHERE note_name = ? AND EXISTS (SELECT 1 FROM notes WHERE name = ? AND revision = ? AND ${LIVE})`).bind(newName, name, name, revision));
  statements.push(db.prepare(`UPDATE notes SET name = ?, content = ?, revision = revision + 1, updated_at = ${NOW} WHERE ${guard} RETURNING ${NOTE_COLUMNS}`).bind(newName, content, ...args));
  try {
    const note = (await db.batch<Note>(statements)).at(-1)!.results[0];
    if (note) return {note};
    // An unchanged save succeeds without a new revision or a duplicate history entry.
    const unchanged = renamed ? null : await db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE ${guard.replace('content <>', 'content =')}`).bind(...args).first<Note>();
    return unchanged ? {note: unchanged} : failure(db, name);
  } catch (err) {
    if (String(err).includes('UNIQUE constraint')) return {error: 'name_taken', trashed: !!(await state(db, newName))?.deleted_at};
    throw err;
  }
}

// Appended text starts on a new line unless the note is empty or already ends with one.
const SEPARATOR = "CASE WHEN content = '' OR substr(content, -1) = char(10) THEN '' ELSE char(10) END";
const FITS = `length(content) + length(${SEPARATOR}) + length(?) <= ${MAX_CONTENT}`;

// Archive and append in one transaction, so concurrent appends never drop text.
export async function appendToNote(db: D1Database, name: string, text: string, source: Source): Promise<{note: Note} | {error: 'not_found' | 'trashed' | 'too_long'}> {
  const [, updated] = await db.batch<Note>([
    db.prepare(`${ARCHIVE} WHERE name = ? AND ${LIVE} AND ${FITS}`).bind('append', source, name, text),
    db.prepare(`UPDATE notes SET content = content || ${SEPARATOR} || ?, revision = revision + 1, updated_at = ${NOW} WHERE name = ? AND ${LIVE} AND ${FITS} RETURNING ${NOTE_COLUMNS}`).bind(text, name, text),
  ]);
  const note = updated.results[0];
  if (note) return {note};
  const row = await state(db, name);
  return {error: !row ? 'not_found' : row.deleted_at ? 'trashed' : 'too_long'};
}

// `revision`, when given, must match (browser deletes are revision-checked).
export async function trashNote(db: D1Database, name: string, revision?: number): Promise<{name: string; deleted_at: string} | Failure> {
  const query = `UPDATE notes SET deleted_at = ${NOW} WHERE name = ? AND ${LIVE}${revision === undefined ? '' : ' AND revision = ?'} RETURNING name, deleted_at`;
  const trashed = await db.prepare(query).bind(...(revision === undefined ? [name] : [name, revision])).first<{name: string; deleted_at: string}>();
  return trashed ?? failure(db, name);
}

export async function restoreNote(db: D1Database, name: string) {
  return db.prepare(`UPDATE notes SET deleted_at = NULL WHERE name = ? AND deleted_at IS NOT NULL RETURNING ${NOTE_COLUMNS}`).bind(name).first<Note>();
}

export async function listTrash(db: D1Database, limit = 1000) {
  const rows = await db.prepare(`SELECT name, deleted_at, created_at, updated_at, revision, substr(content, 1, 180) AS excerpt FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, name LIMIT ?`).bind(limit + 1).all();
  return {notes: rows.results.slice(0, limit), truncated: rows.results.length > limit};
}

export async function listRevisions(db: D1Database, name: string, limit = 200) {
  const current = await db.prepare('SELECT name, created_at, revision, updated_at, deleted_at FROM notes WHERE name = ?').bind(name).first<Omit<Note, 'content'> & {deleted_at: string | null}>();
  const rows = await db.prepare(`SELECT r.revision, r.name, r.updated_at, coalesce(r.updated_at, n.created_at) AS saved_at, r.archived_at, r.reason, r.source, length(r.content) AS characters, substr(r.content, 1, 120) AS excerpt
    FROM note_revisions r LEFT JOIN notes n ON n.name = r.note_name WHERE r.note_name = ? ORDER BY r.revision DESC, r.id DESC LIMIT ?`).bind(name, limit + 1).all();
  if (!current && !rows.results.length) return null;
  return {name, current: current ?? null, revisions: rows.results.slice(0, limit), truncated: rows.results.length > limit};
}

export async function readRevision(db: D1Database, name: string, revision: number) {
  const archived = await db.prepare(`SELECT r.revision, r.name, r.content, r.updated_at, coalesce(r.updated_at, n.created_at) AS saved_at, r.archived_at, r.reason, r.source
    FROM note_revisions r LEFT JOIN notes n ON n.name = r.note_name WHERE r.note_name = ? AND r.revision = ? ORDER BY r.id DESC LIMIT 1`).bind(name, revision).first();
  if (archived) return {...archived, current: false};
  const live = await db.prepare('SELECT revision, name, content, updated_at, coalesce(updated_at, created_at) AS saved_at FROM notes WHERE name = ? AND revision = ?').bind(name, revision).first();
  return live ? {...live, current: true} : null;
}
