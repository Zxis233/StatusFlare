-- Independent display order within each service; ties retain the previous order.
ALTER TABLE monitors ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
