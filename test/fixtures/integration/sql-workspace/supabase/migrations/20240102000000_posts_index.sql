create index posts_author_idx on public.posts (author_id);
alter table public.users add column created_at timestamptz not null default now();
alter table public.posts enable row level security;
