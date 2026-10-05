CREATE TABLE IF NOT EXISTS notes (
  name TEXT PRIMARY KEY NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  content TEXT NOT NULL CHECK(length(content) <= 100000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
