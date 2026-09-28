-- Optional public navigation URL, independent of the encrypted probe target.
ALTER TABLE monitors ADD COLUMN link TEXT NOT NULL DEFAULT '';
