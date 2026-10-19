-- Enum values
ALTER TYPE public.mood ADD VALUE 'happy' AFTER 'ok';
ALTER TYPE public.mood ADD VALUE IF NOT EXISTS 'sad';
ALTER TYPE public.mood RENAME VALUE 'sad' TO 'blue';

-- The DDL of the branches of a DO block is applied, not the one of its exception handler
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'priority') THEN
    CREATE TYPE public.priority AS ENUM ('low', 'high');
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    CREATE TABLE never_created_either (id int);
END
$$;

ALTER TABLE app.posts ADD COLUMN editor_id bigint;
-- drizzle-kit 0.2x wrote its foreign keys so
DO $$ BEGIN
 ALTER TABLE "app"."posts" ADD CONSTRAINT "posts_editor_id_users_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

ALTER TABLE app.posts ADD COLUMN priority public.priority DEFAULT 'low', ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE app.posts ALTER COLUMN body SET NOT NULL, ALTER COLUMN body SET DEFAULT '';
ALTER TABLE app.posts ALTER COLUMN slug TYPE varchar(120) USING slug::varchar(120);
ALTER TABLE app.posts RENAME COLUMN body TO content;
-- The foreign keys follow a renamed table and a renamed column
ALTER TABLE public.users RENAME TO members;
ALTER TABLE public.members RENAME COLUMN id TO member_id;
ALTER TABLE public.members DROP COLUMN key, DROP COLUMN IF EXISTS missing;
ALTER TABLE ONLY public.members ADD CONSTRAINT members_display_name_key UNIQUE (display_name);
ALTER TABLE public.members DROP CONSTRAINT members_display_name_key;
-- The name PostgreSQL gave to UNIQUE on "Email" when the table was users
ALTER TABLE public.members DROP CONSTRAINT "users_Email_key";

-- supabase db diff (migra) writes its keys from indexes, and validates its foreign keys later
create table "public"."tags" ("id" bigint not null, "name" text not null, "member_id" bigint);
CREATE UNIQUE INDEX tags_pkey ON public.tags USING btree (id);
CREATE UNIQUE INDEX tags_name_key ON public.tags USING btree (name);
alter table "public"."tags" add constraint "tags_pkey" PRIMARY KEY using index "tags_pkey";
alter table "public"."tags" add constraint "tags_name_key" UNIQUE using index "tags_name_key";
alter table "public"."tags" add constraint "tags_member_id_fkey" FOREIGN KEY (member_id) REFERENCES members(member_id) not valid;
alter table "public"."tags" validate constraint "tags_member_id_fkey";

-- Partitions, inheritance, LIKE, temporary and unlogged tables
CREATE TABLE public.events (id bigint NOT NULL, at date NOT NULL, kind text) PARTITION BY RANGE (at);
CREATE TABLE public.events_2024 PARTITION OF public.events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE public.events_2025 (id bigint NOT NULL, at date NOT NULL, kind text);
ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2025 FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE INDEX events_2025_at_idx ON public.events_2025 (at);
CREATE TABLE public.audit_base (created_at timestamptz DEFAULT now() NOT NULL, created_by text);
CREATE TABLE public.audited_notes (id serial PRIMARY KEY, body text) INHERITS (public.audit_base);
CREATE TABLE public.notes_copy (LIKE public.audited_notes INCLUDING ALL);
CREATE TEMP TABLE scratch (id int);
CREATE UNLOGGED TABLE public.cache (key text PRIMARY KEY, value bytea);
ALTER INDEX app.posts_title_lower_idx RENAME TO posts_title_idx;
DROP INDEX IF EXISTS app.posts_slug_published;

-- Unqualified names in the schemas of the search path
SET search_path TO app, public;
CREATE TABLE comments (id bigserial PRIMARY KEY, post_id uuid REFERENCES posts ON DELETE CASCADE, member_id bigint REFERENCES members);
