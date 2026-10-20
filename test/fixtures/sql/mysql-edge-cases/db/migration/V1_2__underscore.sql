-- Version 1.2: Flyway reads the underscores of a version as dots
ALTER TABLE tags ADD COLUMN color CHAR(7) DEFAULT '#000000';
