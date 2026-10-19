PRAGMA foreign_keys = ON;
CREATE TABLE [users] (
  [id] INTEGER PRIMARY KEY AUTOINCREMENT,
  "email" TEXT NOT NULL UNIQUE ON CONFLICT REPLACE,
  `name` VARCHAR(100),
  created_at DATETIME DEFAULT (datetime('now')) NOT NULL,
  flags,
  CHECK (length(email) > 3)
);
CREATE TABLE "posts" (
  id integer NOT NULL PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'untitled',
  body text
);
CREATE TABLE tags (name TEXT PRIMARY KEY, color TEXT) WITHOUT ROWID;
CREATE TABLE post_tags (
  post_id INTEGER,
  tag TEXT,
  PRIMARY KEY (post_id, tag),
  FOREIGN KEY (post_id) REFERENCES posts (id),
  FOREIGN KEY (tag) REFERENCES tags (name) ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS posts_user_id ON posts (user_id);
CREATE UNIQUE INDEX main.posts_title ON posts (title COLLATE NOCASE) WHERE body IS NOT NULL;
-- A trigger: the semicolons of its body do not end the statement
CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
  UPDATE posts SET title = trim(new.title) WHERE id = new.id;
  INSERT INTO post_tags (post_id, tag) VALUES (new.id, 'edited');
END;
CREATE VIRTUAL TABLE posts_fts USING fts5(title, body);
