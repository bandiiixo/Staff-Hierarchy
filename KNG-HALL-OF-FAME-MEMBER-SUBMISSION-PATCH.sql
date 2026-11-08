-- KNG Hall of Fame: allow active Members to submit winner entries and upload photos.
-- Ensure winner identity columns are present for staff-linked submissions.
ALTER TABLE public.ix_hall_of_fame
  ADD COLUMN IF NOT EXISTS winner_staff_id uuid NULL,
  ADD COLUMN IF NOT EXISTS winner_discord_id text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ix_hall_of_fame_winner_staff_id_fkey'
      AND conrelid = 'public.ix_hall_of_fame'::regclass
  ) THEN
    ALTER TABLE public.ix_hall_of_fame
      ADD CONSTRAINT ix_hall_of_fame_winner_staff_id_fkey
      FOREIGN KEY (winner_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_hall_of_fame_winner_staff_id_idx
  ON public.ix_hall_of_fame (winner_staff_id);
CREATE INDEX IF NOT EXISTS ix_hall_of_fame_winner_discord_id_idx
  ON public.ix_hall_of_fame (winner_discord_id);

-- Members may INSERT their own submissions. Existing-entry edits/removals stay management-only.

create or replace function public.kng_schedule_can_submit_hof()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_access sa
    where sa.user_id = auth.uid()
      and sa.active = true
      and lower(coalesce(sa.access_level, '')) in (
        'member', 'aux', 'adm', 'entertainment_resp',
        'culture_manager', 'manager', 'director', 'admin'
      )
  );
$$;

create or replace function public.kng_schedule_can_manage_hof()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_access sa
    where sa.user_id = auth.uid()
      and sa.active = true
      and lower(coalesce(sa.access_level, '')) in (
        'adm', 'entertainment_resp', 'culture_manager', 'manager', 'director', 'admin'
      )
  );
$$;

alter table public.ix_hall_of_fame enable row level security;

drop policy if exists ix_hof_read on public.ix_hall_of_fame;
drop policy if exists ix_hof_manage on public.ix_hall_of_fame;
drop policy if exists ix_hof_member_submit on public.ix_hall_of_fame;
drop policy if exists ix_hof_management_update on public.ix_hall_of_fame;
drop policy if exists ix_hof_management_delete on public.ix_hall_of_fame;

create policy ix_hof_read
on public.ix_hall_of_fame
for select
to anon, authenticated
using (true);

create policy ix_hof_member_submit
on public.ix_hall_of_fame
for insert
to authenticated
with check (
  public.kng_schedule_can_submit_hof()
  and created_by = auth.uid()
);

create policy ix_hof_management_update
on public.ix_hall_of_fame
for update
to authenticated
using (public.kng_schedule_can_manage_hof())
with check (public.kng_schedule_can_manage_hof());

create policy ix_hof_management_delete
on public.ix_hall_of_fame
for delete
to authenticated
using (public.kng_schedule_can_manage_hof());

-- Keep the bucket public for viewing generated winner cards, but restrict uploads
-- to the signed-in member's own folder. Only management can replace/delete files.
insert into storage.buckets(id, name, public)
values ('kng-hall-of-fame', 'kng-hall-of-fame', true)
on conflict (id) do update set public = true;

drop policy if exists kng_hof_storage_read on storage.objects;
drop policy if exists kng_hof_storage_insert on storage.objects;
drop policy if exists kng_hof_storage_update on storage.objects;
drop policy if exists kng_hof_storage_delete on storage.objects;

create policy kng_hof_storage_read
on storage.objects
for select
to public
using (bucket_id = 'kng-hall-of-fame');

create policy kng_hof_storage_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'kng-hall-of-fame'
  and public.kng_schedule_can_submit_hof()
  and name like auth.uid()::text || '/%'
);

create policy kng_hof_storage_update
on storage.objects
for update
to authenticated
using (bucket_id = 'kng-hall-of-fame' and public.kng_schedule_can_manage_hof())
with check (bucket_id = 'kng-hall-of-fame' and public.kng_schedule_can_manage_hof());

create policy kng_hof_storage_delete
on storage.objects
for delete
to authenticated
using (bucket_id = 'kng-hall-of-fame' and public.kng_schedule_can_manage_hof());

notify pgrst, 'reload schema';
