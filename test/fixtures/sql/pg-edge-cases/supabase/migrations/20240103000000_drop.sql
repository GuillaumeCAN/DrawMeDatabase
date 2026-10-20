DROP TABLE IF EXISTS public.cache, public.does_not_exist;
DROP TABLE public.notes_copy;
ALTER TABLE app.posts DROP CONSTRAINT posts_parent_fkey;
DROP TYPE IF EXISTS public.unused_type;
-- DROP SCHEMA ... CASCADE drops its tables and the foreign keys that reference them
CREATE SCHEMA trash;
CREATE TABLE trash.old (id int PRIMARY KEY);
ALTER TABLE public.tags ADD COLUMN old_id int REFERENCES trash.old;
DROP SCHEMA trash CASCADE;
-- A table moved to another schema, its foreign keys follow it
ALTER TABLE app.posts SET SCHEMA public;
-- Data of a dump
COPY public.tags (id, name) FROM stdin;
1	a; CREATE TABLE not_a_table (id int);
2	it's
\.
CREATE INDEX tags_name_idx ON public.tags (name text_pattern_ops DESC NULLS LAST);
