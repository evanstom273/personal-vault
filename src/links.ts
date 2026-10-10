import { readNote } from './notes';

// [[Name]], [[Name|alias]], [[Name#Heading]] and embeds ![[Name]] all link to
// the note named exactly `Name`. Links are computed when asked; there is no
// links table to keep in sync.
const WIKILINK = /\[\[([^[\]\n|#]+)(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]/g;

// Distinct link targets in order of first appearance.
export const wikilinks = (content: string) => [...new Set(Array.from(content.matchAll(WIKILINK), m => m[1]))];

// Live notes (other than `name` itself) that link to `name`, with text around the first link.
export async function backlinks(db: D1Database, name: string, limit = 100) {
  const rows = await db.prepare(`SELECT name, substr(content, max(1, coalesce(nullif(instr(content, ?1), 0), nullif(instr(content, ?2), 0), instr(content, ?3)) - 80), 200) AS context
    FROM notes WHERE deleted_at IS NULL AND name <> ?4 AND (instr(content, ?1) > 0 OR instr(content, ?2) > 0 OR instr(content, ?3) > 0) ORDER BY name LIMIT ?5`)
    .bind(`[[${name}]]`, `[[${name}|`, `[[${name}#`, name, limit + 1).all<{name: string; context: string}>();
  return {notes: rows.results.slice(0, limit), truncated: rows.results.length > limit};
}

export async function linkedNotes(db: D1Database, name: string, limit = 100) {
  const note = await readNote(db, name);
  if (!note) return null;
  const targets = wikilinks(note.content);
  const found = new Map((await db.prepare('SELECT name, deleted_at FROM notes WHERE name IN (SELECT value FROM json_each(?))').bind(JSON.stringify(targets.slice(0, limit))).all<{name: string; deleted_at: string | null}>()).results.map(r => [r.name, r.deleted_at ? 'trashed' : 'exists']));
  const back = await backlinks(db, name, limit);
  return {
    name,
    links: targets.slice(0, limit).map(target => ({name: target, status: found.get(target) ?? 'missing'})),
    links_truncated: targets.length > limit,
    backlinks: back.notes,
    backlinks_truncated: back.truncated,
  };
}
