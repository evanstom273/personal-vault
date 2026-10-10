-- Additive only: a nullable column. SQLite records it in the schema without rewriting existing rows,
-- which all read as NULL (not in the trash).
ALTER TABLE notes ADD COLUMN deleted_at TEXT;
