-- Additive only: a new table and index. Existing notes rows are not modified.
CREATE TABLE IF NOT EXISTS note_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_name TEXT NOT NULL,    -- current name of the note this history belongs to
  revision INTEGER NOT NULL,  -- the notes.revision being replaced
  name TEXT NOT NULL,         -- the note's name at that revision
  content TEXT NOT NULL,
  updated_at TEXT,            -- when that version was saved (NULL = never edited)
  archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reason TEXT NOT NULL,       -- update | append | rename | delete; validated in code
  source TEXT NOT NULL        -- mcp | browser
);
CREATE INDEX IF NOT EXISTS note_revisions_by_note ON note_revisions (note_name, revision);
