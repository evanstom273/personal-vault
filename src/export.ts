import { strToU8, zipSync, type Zippable } from 'fflate';

// Whole-vault export as a ZIP:
//   notes/<path>.md               live notes, exact content
//   trash/<path>.md               trashed notes, exact content
//   history/<path>/r<n>.md        earlier versions from note_revisions
//   vault.json                    exact names, timestamps, revisions and file paths
// A `/` in a note name becomes a folder. File names are made safe for common
// file systems, so vault.json is the authority for the exact note names.

type NoteRow = {name: string; content: string; created_at: string; updated_at: string | null; revision: number; deleted_at: string | null};
type RevisionRow = {note_name: string; revision: number; name: string; content: string; updated_at: string | null; archived_at: string; reason: string; source: string};

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
function safePath(name: string) {
  const parts = name.split('/')
    .map(part => part.trim().replace(/[\\:*?"<>|\x00-\x1f\x7f]/g, '-').slice(0, 120).replace(/[. ]+$/, ''))
    .filter(Boolean)
    .map(part => RESERVED.test(part) ? part + '_' : part);
  return parts.length ? parts.join('/') : 'Untitled';
}

// Unique per export, ignoring case so case-insensitive file systems don't merge files.
function allocator() {
  const used = new Set<string>();
  return (base: string, ext: string) => {
    let path = base + ext;
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${base} (${n})${ext}`;
    used.add(path.toLowerCase());
    return path;
  };
}

export async function exportVault(db: D1Database, now = new Date()) {
  const [notes, revisions] = await db.batch([
    db.prepare('SELECT name, content, created_at, updated_at, revision, deleted_at FROM notes ORDER BY name'),
    db.prepare('SELECT note_name, revision, name, content, updated_at, archived_at, reason, source FROM note_revisions ORDER BY note_name, revision, id'),
  ]) as [D1Result<NoteRow>, D1Result<RevisionRow>];
  const allocate = allocator();
  const files: Zippable = {};
  const add = (path: string, content: string, time: string) => { files[path] = [strToU8(content), {mtime: new Date(time)}]; };
  const historyDir = new Map<string, string>();
  const manifest = {format: 'personal-vault-export', version: 1, exported_at: now.toISOString(), notes: [] as object[], trash: [] as object[], revisions: [] as object[]};

  for (const n of notes.results) {
    const path = allocate((n.deleted_at ? 'trash/' : 'notes/') + safePath(n.name), '.md');
    add(path, n.content, n.deleted_at ?? n.updated_at ?? n.created_at);
    const entry = {name: n.name, path, created_at: n.created_at, updated_at: n.updated_at, revision: n.revision};
    if (n.deleted_at) manifest.trash.push({...entry, deleted_at: n.deleted_at}); else manifest.notes.push(entry);
  }
  for (const r of revisions.results) {
    if (!historyDir.has(r.note_name)) historyDir.set(r.note_name, allocate('history/' + safePath(r.note_name), ''));
    const path = allocate(`${historyDir.get(r.note_name)}/r${r.revision}`, '.md');
    add(path, r.content, r.updated_at ?? r.archived_at);
    manifest.revisions.push({note_name: r.note_name, revision: r.revision, name: r.name, path, updated_at: r.updated_at, archived_at: r.archived_at, reason: r.reason, source: r.source});
  }
  add('vault.json', JSON.stringify(manifest, null, 2) + '\n', now.toISOString());
  // Stored, not compressed: keeps CPU time low on the Workers free plan.
  return zipSync(files, {level: 0});
}
