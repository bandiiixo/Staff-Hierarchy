-- KNG HALL OF FAME: ALL STAFF CAN SUBMIT ENTRIES AND UPLOAD WINNER PHOTOS
-- Staff access levels are recognised through kng_schedule_access_rank():
-- Member and above can submit/upload. Photo removal and editing existing
-- Hall of Fame records remain management-only.

-- Ensure the bucket exists. Existing files are preserved.
insert into storage.buckets (id, name, public)
values ('kng-hall-of-fame', 'kng-hall-of-fame', true)
on conflict (id) do update set public = true;

-- Hall of Fame records: public read, staff insert, management update/delete.
alter table public.ix_hall_of_fame enable row level security;

drop policy if exists ix_hof_read on public.ix_hall_of_fame;
create policy ix_hof_read
on public.ix_hall_of_fame
for select
to anon, authenticated
using (true);

drop policy if exists ix_hof_manage on public.ix_hall_of_fame;
drop policy if exists ix_hof_staff_insert on public.ix_hall_of_fame;
create policy ix_hof_staff_insert
on public.ix_hall_of_fame
for insert
to authenticated
with check (
    auth.uid() is not null
    and public.kng_schedule_access_rank() >= 1
    and created_by = auth.uid()
);

drop policy if exists ix_hof_management_update on public.ix_hall_of_fame;
create policy ix_hof_management_update
on public.ix_hall_of_fame
for update
to authenticated
using (public.kng_schedule_access_rank() >= 3)
with check (public.kng_schedule_access_rank() >= 3);

drop policy if exists ix_hof_management_delete on public.ix_hall_of_fame;
create policy ix_hof_management_delete
on public.ix_hall_of_fame
for delete
to authenticated
using (public.kng_schedule_access_rank() >= 3);

-- Storage: all authenticated KNG staff can upload to the HOF bucket.
-- Management retains update/delete rights for replacing/removing stored files.
drop policy if exists kng_hof_storage_read on storage.objects;
create policy kng_hof_storage_read
on storage.objects
for select
to public
using (bucket_id = 'kng-hall-of-fame');

drop policy if exists kng_hof_storage_insert on storage.objects;
create policy kng_hof_storage_insert
on storage.objects
for insert
to authenticated
with check (
    bucket_id = 'kng-hall-of-fame'
    and public.kng_schedule_access_rank() >= 1
);

drop policy if exists kng_hof_storage_update on storage.objects;
create policy kng_hof_storage_update
on storage.objects
for update
to authenticated
using (
    bucket_id = 'kng-hall-of-fame'
    and public.kng_schedule_access_rank() >= 3
)
with check (
    bucket_id = 'kng-hall-of-fame'
    and public.kng_schedule_access_rank() >= 3
);

drop policy if exists kng_hof_storage_delete on storage.objects;
create policy kng_hof_storage_delete
on storage.objects
for delete
to authenticated
using (
    bucket_id = 'kng-hall-of-fame'
    and public.kng_schedule_access_rank() >= 3
);

notify pgrst, 'reload schema';
