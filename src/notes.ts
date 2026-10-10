// Shared note storage for the MCP tools and the browser API.
// Every change to an existing note first copies the current version into
// note_revisions inside the same D1 batch (one transaction), so earlier content
// is never lost. Writes are guarded by the expected revision; a stale write
// changes nothing.
export type Source = 'mcp' | 'browser';
export type Note = {name: string; content: string; created_at: string; revision: number; updated_at: string | null};
export type WriteResult = {note: Note} | {error: 'not_found'} | {error: 'conflict'; current: number} | {error: 'name_taken'};

export const NOTE_COLUMNS = 'name, content, created_at, revision, updated_at';
export const MAX_CONTENT = 100000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ARCHIVE = 'INSERT INTO note_revisions (note_name, revision, name, content, updated_at, reason, source) SELECT name, revision, name, content, updated_at, ?, ? FROM notes';

// Archives the note as it is at `revision`; matches nothing if it has moved on.
export const snapshot = (db: D1Database, name: string, revision: number, reason: 'update' | 'rename' | 'delete', source: Source) =>
  db.prepare(`${ARCHIVE} WHERE name = ? AND revision = ?`).bind(reason, source, name, revision);

async function failure(db: D1Database, name: string): Promise<WriteResult> {
  const row = await db.prepare('SELECT revision FROM notes WHERE name = ?').bind(name).first<{revision: number}>();
  return row ? {error: 'conflict', current: row.revision} : {error: 'not_found'};
}

export async function updateNote(db: D1Database, {name, newName = name, content, revision, source}: {name: string; newName?: string; content: string; revision: number; source: Source}): Promise<WriteResult> {
  const renamed = newName !== name;
  const statements = [snapshot(db, name, revision, renamed ? 'rename' : 'update', source)];
  // History follows a rename. Must run before the notes update changes the name.
  if (renamed) statements.push(db.prepare('UPDATE note_revisions SET note_name = ? WHERE note_name = ? AND EXISTS (SELECT 1 FROM notes WHERE name = ? AND revision = ?)').bind(newName, name, name, revision));
  statements.push(db.prepare(`UPDATE notes SET name = ?, content = ?, revision = revision + 1, updated_at = ${NOW} WHERE name = ? AND revision = ? RETURNING ${NOTE_COLUMNS}`).bind(newName, content, name, revision));
  try {
    const note = (await db.batch<Note>(statements)).at(-1)!.results[0];
    return note ? {note} : failure(db, name);
  } catch (err) {
    if (String(err).includes('UNIQUE constraint')) return {error: 'name_taken'};
    throw err;
  }
}

// Appended text starts on a new line unless the note is empty or already ends with one.
const SEPARATOR = "CASE WHEN content = '' OR substr(content, -1) = char(10) THEN '' ELSE char(10) END";
const FITS = `length(content) + length(${SEPARATOR}) + length(?) <= ${MAX_CONTENT}`;

// Archive and append in one transaction, so concurrent appends never drop text.
export async function appendToNote(db: D1Database, name: string, text: string, source: Source): Promise<{note: Note} | {error: 'not_found' | 'too_long'}> {
  const [, updated] = await db.batch<Note>([
    db.prepare(`${ARCHIVE} WHERE name = ? AND ${FITS}`).bind('append', source, name, text),
    db.prepare(`UPDATE notes SET content = content || ${SEPARATOR} || ?, revision = revision + 1, updated_at = ${NOW} WHERE name = ? AND ${FITS} RETURNING ${NOTE_COLUMNS}`).bind(text, name, text),
  ]);
  const note = updated.results[0];
  if (note) return {note};
  return {error: await db.prepare('SELECT 1 FROM notes WHERE name = ?').bind(name).first() ? 'too_long' : 'not_found'};
}

export async function listRevisions(db: D1Database, name: string, limit = 200) {
  const current = await db.prepare('SELECT name, created_at, revision, updated_at FROM notes WHERE name = ?').bind(name).first<Omit<Note, 'content'>>();
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
