-- A repeatable migration: not a table, not replayed
CREATE OR REPLACE VIEW user_emails AS SELECT email FROM users;
