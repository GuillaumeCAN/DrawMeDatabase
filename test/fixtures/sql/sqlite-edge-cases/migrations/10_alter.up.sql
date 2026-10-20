-- Version 10, after 2 and 3 (golang-migrate orders by number)
ALTER TABLE users ADD COLUMN bio TEXT DEFAULT '' NOT NULL;
ALTER TABLE users RENAME COLUMN name TO display_name;
ALTER TABLE users DROP COLUMN flags;
-- The foreign keys of post_tags follow the renamed table
ALTER TABLE tags RENAME TO labels;
