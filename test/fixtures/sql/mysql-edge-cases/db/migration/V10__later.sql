-- Version 10, after 2 and 3
ALTER TABLE post_labels ADD COLUMN weight SMALLINT NOT NULL DEFAULT 1;
-- MySQL removes a dropped column from the indexes that hold it
ALTER TABLE users DROP COLUMN status;
