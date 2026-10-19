ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL AFTER email, ADD COLUMN nickname VARCHAR(50) FIRST;
ALTER TABLE users MODIFY COLUMN name VARCHAR(100) NOT NULL;
ALTER TABLE users CHANGE `bio` `about` MEDIUMTEXT NULL;
ALTER TABLE users DROP COLUMN `key`;
ALTER TABLE posts ADD COLUMN (summary TEXT, views INT UNSIGNED NOT NULL DEFAULT 0);
ALTER TABLE posts DROP FOREIGN KEY posts_user_fk;
ALTER TABLE posts ADD CONSTRAINT posts_author_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;
ALTER TABLE posts DROP INDEX posts_title_idx, ADD INDEX posts_title_slug_idx (title, slug);
ALTER TABLE posts RENAME INDEX slug TO posts_slug_unique;
RENAME TABLE tags TO labels;
CREATE TABLE post_labels (
  post_id INT NOT NULL,
  label_id INT NOT NULL,
  PRIMARY KEY (post_id, label_id),
  FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES labels (id)
);
-- The foreign keys of post_labels follow the renamed table
ALTER TABLE labels RENAME TO tags;
CREATE TABLE users_archive LIKE users;
DROP TABLE IF EXISTS missing_table;
