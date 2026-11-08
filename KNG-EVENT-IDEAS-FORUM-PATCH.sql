-- KNG Event Ideas Forum: make public posting + reading deterministic.
-- Safe to run more than once.

create table if not exists public.event_suggestions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete set null,
  display_name text not null default 'Anonymous',
  title text not null,
  suggestion text not null,
  status text not null default 'new' check (status in ('new','reviewed','accepted','declined')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_suggestions_created_idx
on public.event_suggestions(created_at desc);

alter table public.event_suggestions enable row level security;

drop policy if exists event_suggestions_public_read on public.event_suggestions;
drop policy if exists event_suggestions_public_insert on public.event_suggestions;
drop policy if exists event_suggestions_staff_update on public.event_suggestions;

create policy event_suggestions_public_read
on public.event_suggestions
for select
to anon, authenticated
using (true);

create policy event_suggestions_public_insert
on public.event_suggestions
for insert
to anon, authenticated
with check (
  length(trim(title)) between 1 and 120
  and length(trim(suggestion)) between 1 and 1500
);

create policy event_suggestions_staff_update
on public.event_suggestions
for update
to authenticated
using (public.kng_schedule_can_manage())
with check (public.kng_schedule_can_manage());

notify pgrst, 'reload schema';
