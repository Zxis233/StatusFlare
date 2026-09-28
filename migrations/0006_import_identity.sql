-- Stable client-generated identity lets a migration recover after a lost create response.
ALTER TABLE monitors ADD COLUMN import_owner TEXT;
