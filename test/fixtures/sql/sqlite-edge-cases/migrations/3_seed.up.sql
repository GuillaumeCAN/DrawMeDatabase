INSERT INTO users (email, name) VALUES ('a@example.com', 'A; B');
BEGIN TRANSACTION;
INSERT INTO tags (name, color) VALUES ('news', '#f00');
COMMIT;
