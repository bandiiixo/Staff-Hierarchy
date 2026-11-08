-- KNG Entertainment complete migration
-- Run this ONE file in Supabase SQL Editor.
-- It is written to be re-runnable and fixes the missing tables/columns used by the site.

create extension if not exists pgcrypto;

-- =========================================================
-- PERMISSIONS
-- =========================================================

drop function if exists public.kng_schedule_access_rank();
create or replace function public.kng_schedule_access_rank()
returns integer
language sql stable security definer
set search_path = public
as $$
  select case coalesce((select sa.access_level from public.staff_access sa where sa.user_id = auth.uid() and sa.active = true limit 1), 'public')
    when 'public' then 0
    when 'member' then 1
    when 'adm' then 2
    when 'manager' then 3
    when 'director' then 4
    when 'admin' then 4
    when 'entertainment' then 2
    else 0
  end;
$$;

create or replace function public.kng_schedule_can_manage()
returns boolean language sql stable security definer set search_path = public as $$
  select public.kng_schedule_access_rank() >= 2;
$$;

create or replace function public.kng_schedule_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.kng_schedule_access_rank() >= 3;
$$;

create or replace function public.kng_schedule_is_director()
returns boolean language sql stable security definer set search_path = public as $$
  select public.kng_schedule_access_rank() >= 4;
$$;

-- Bring legacy access names into the requested hierarchy.
alter table public.staff_access drop constraint if exists staff_access_access_level_check;
update public.staff_access set access_level = 'member' where access_level = 'viewer';
update public.staff_access set access_level = 'adm' where access_level = 'entertainment';
update public.staff_access set access_level = 'director' where access_level = 'admin';
alter table public.staff_access add constraint staff_access_access_level_check
  check (access_level in ('member','adm','manager','director'));

-- =========================================================
-- EVENT TYPES + EVENT STATE
-- =========================================================

alter table public.events add column if not exists visibility text not null default 'public';
alter table public.events add column if not exists recurrence_group_id uuid;
alter table public.events add column if not exists recurrence_rule text;
alter table public.events add column if not exists status text not null default 'scheduled';
alter table public.events add column if not exists is_meeting boolean not null default false;
alter table public.events add column if not exists attendance_count integer;
alter table public.events add column if not exists winner_name text;
alter table public.events add column if not exists completion_notes text;
alter table public.events add column if not exists completed_at timestamptz;
alter table public.events add column if not exists completed_by uuid references auth.users(id) on delete set null;

update public.events set visibility = 'public' where visibility is null or visibility not in ('public','staff');
update public.events set status = 'scheduled' where status is null or status not in ('scheduled','completed','cancelled');

alter table public.events drop constraint if exists events_visibility_check;
alter table public.events add constraint events_visibility_check check (visibility in ('public','staff'));
alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check check (status in ('scheduled','completed','cancelled'));
alter table public.events drop constraint if exists events_attendance_check;
alter table public.events add constraint events_attendance_check check (attendance_count is null or attendance_count >= 0);

insert into public.event_types (name, colour, description)
select 'Party', '#ff2d5b', 'KNG Entertainment party'
where not exists (select 1 from public.event_types where lower(name) = 'party');
insert into public.event_types (name, colour, description)
select 'Event', '#ef334f', 'General KNG Entertainment event'
where not exists (select 1 from public.event_types where lower(name) = 'event');
insert into public.event_types (name, colour, description)
select 'Battle Royale', '#9b2c5e', 'Battle Royale event'
where not exists (select 1 from public.event_types where lower(name) = 'battle royale');
insert into public.event_types (name, colour, description)
select 'Community Meeting', '#6d28d9', 'Community meeting'
where not exists (select 1 from public.event_types where lower(name) = 'community meeting');
insert into public.event_types (name, colour, description)
select 'Staff Meeting', '#22c55e', 'KNG staff meeting'
where not exists (select 1 from public.event_types where lower(name) = 'staff meeting');

-- Repoint legacy events before removing legacy type rows.
update public.events e set event_type_id = t_new.id
from public.event_types t_old, public.event_types t_new
where e.event_type_id = t_old.id and lower(t_old.name) = 'f3' and lower(t_new.name) = 'party';
update public.events e set event_type_id = t_new.id
from public.event_types t_old, public.event_types t_new
where e.event_type_id = t_old.id and lower(t_old.name) = 'br' and lower(t_new.name) = 'battle royale';
update public.events e set event_type_id = t_new.id
from public.event_types t_old, public.event_types t_new
where e.event_type_id = t_old.id and lower(t_old.name) = 'meeting' and lower(t_new.name) = 'community meeting';
update public.events e set event_type_id = t_new.id
from public.event_types t_old, public.event_types t_new
where e.event_type_id = t_old.id and lower(t_old.name) = 'large action' and lower(t_new.name) = 'event';

delete from public.event_types where lower(name) in ('f3','br','meeting','large action');

update public.event_types set colour = '#ff2d5b' where lower(name) = 'party';
update public.event_types set colour = '#ef334f' where lower(name) = 'event';
update public.event_types set colour = '#9b2c5e' where lower(name) = 'battle royale';
update public.event_types set colour = '#6d28d9' where lower(name) = 'community meeting';
update public.event_types set colour = '#22c55e' where lower(name) = 'staff meeting';

update public.events e
set is_meeting = true, visibility = 'staff'
where e.event_type_id in (select id from public.event_types where lower(name) in ('community meeting','staff meeting'));

-- Set up the recurring Community Meeting series if one does not already exist.
do $$
declare
  type_id uuid;
  group_id uuid := gen_random_uuid();
  d date;
  until_date date := current_date + 180;
begin
  select id into type_id from public.event_types where lower(name)='community meeting' limit 1;
  if type_id is not null and not exists (select 1 from public.events where lower(title)='community meeting' and recurrence_rule='biweekly') then
    d := current_date + ((8 - extract(isodow from current_date)::int) % 7);
    while d <= until_date loop
      insert into public.events(title,event_type_id,event_date,start_time,end_time,visibility,recurrence_group_id,recurrence_rule,description,staff_required,is_meeting,status)
      values('Community Meeting',type_id,d,'19:00','20:00','staff',group_id,'biweekly','KNG Entertainment Community Meeting',0,true,'scheduled');
      d := d + 14;
    end loop;
  end if;
end $$;

create index if not exists events_visibility_idx on public.events(visibility);
create index if not exists events_recurrence_group_idx on public.events(recurrence_group_id);
create index if not exists events_status_idx on public.events(status, event_date);

-- Replace old event policies with the requested ADM+ management model.
drop policy if exists "Anyone can view events" on public.events;
drop policy if exists "Managers can create events" on public.events;
drop policy if exists "Managers can update events" on public.events;
drop policy if exists "Managers can delete events" on public.events;
drop policy if exists events_public_read on public.events;
drop policy if exists events_staff_write on public.events;

create policy events_public_read on public.events for select to anon, authenticated using (true);
create policy events_staff_write on public.events for insert to authenticated
  with check (public.kng_schedule_can_manage() and (coalesce(is_meeting,false) = false or public.kng_schedule_is_admin()));
create policy events_staff_update on public.events for update to authenticated
  using (public.kng_schedule_can_manage())
  with check (public.kng_schedule_can_manage() and (coalesce(is_meeting,false) = false or public.kng_schedule_is_admin()));
create policy events_staff_delete on public.events for delete to authenticated
  using (public.kng_schedule_can_manage());

-- =========================================================
-- OPERATIONS TABLES
-- =========================================================

create table if not exists public.ops_tracker (
  id uuid primary key default gen_random_uuid(), staff_id uuid references public.staff(id) on delete set null,
  team text not null, activity_type text not null, status text not null default 'Logged', notes text,
  created_by uuid, created_at timestamptz not null default now()
);
create table if not exists public.ops_points (
  id uuid primary key default gen_random_uuid(), staff_id uuid not null references public.staff(id) on delete cascade,
  amount integer not null check (amount between -25 and 25), reason text not null, created_by uuid, created_at timestamptz not null default now()
);
create table if not exists public.ops_hungry (
  id uuid primary key default gen_random_uuid(), event_date date not null, event_time time,
  title text not null, department text, notes text, created_by uuid, created_at timestamptz not null default now()
);
alter table public.ops_hungry add column if not exists status text not null default 'open';
alter table public.ops_hungry add column if not exists claimed_by uuid;
alter table public.ops_hungry add column if not exists claimed_by_name text;
alter table public.ops_hungry add column if not exists claimed_at timestamptz;
alter table public.ops_hungry add column if not exists completed_by uuid;
alter table public.ops_hungry add column if not exists completed_by_name text;
alter table public.ops_hungry add column if not exists completed_at timestamptz;
create table if not exists public.ops_reductions (
  id uuid primary key default gen_random_uuid(), staff_id uuid not null references public.staff(id) on delete cascade,
  amount integer not null check (amount > 0), reason text not null, active boolean not null default true, created_by uuid, created_at timestamptz not null default now()
);
create table if not exists public.ops_audit (
  id uuid primary key default gen_random_uuid(), actor_id uuid, actor_name text, action text not null,
  target_type text, target_id uuid, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table if not exists public.ops_security (
  id uuid primary key default gen_random_uuid(), actor_id uuid, actor_name text, event_type text not null,
  severity text not null default 'info', details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table if not exists public.ops_prizes (
  id uuid primary key default gen_random_uuid(), label text not null, code text not null unique,
  amount integer not null check (amount > 0), active boolean not null default true, created_by uuid, created_at timestamptz not null default now()
);
alter table public.ops_prizes add column if not exists command_template text not null default '/giveitem {discord_id} {code} {amount}';
create table if not exists public.ops_helpers (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade, note text, created_by uuid, created_at timestamptz not null default now(), unique(event_id, staff_id)
);
create table if not exists public.ops_prize_wins (
  id uuid primary key default gen_random_uuid(), prize_id uuid not null references public.ops_prizes(id) on delete restrict,
  recipient_name text not null, discord_id text not null, amount integer not null default 1, command text not null, won_by uuid, created_at timestamptz not null default now()
);
create table if not exists public.ops_timeouts (
  id uuid primary key default gen_random_uuid(), email text not null, expires_at timestamptz not null,
  reason text, created_by uuid, created_at timestamptz not null default now()
);
create table if not exists public.ops_access_blocks (
  id uuid primary key default gen_random_uuid(), email text not null unique, reason text,
  active boolean not null default true, created_by uuid, created_at timestamptz not null default now()
);
create table if not exists public.ops_security_settings (
  id integer primary key check (id = 1), max_removals integer not null default 3 check (max_removals > 0),
  window_minutes integer not null default 60 check (window_minutes > 0), timeout_minutes integer not null default 30 check (timeout_minutes > 0),
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.ops_security_settings(id) values (1) on conflict (id) do nothing;

create index if not exists ops_tracker_created_idx on public.ops_tracker(created_at desc);
create index if not exists ops_points_staff_idx on public.ops_points(staff_id, created_at desc);
create index if not exists ops_hungry_date_idx on public.ops_hungry(event_date, event_time);
create index if not exists ops_reductions_staff_idx on public.ops_reductions(staff_id, created_at desc);
create index if not exists ops_audit_created_idx on public.ops_audit(created_at desc);
create index if not exists ops_security_created_idx on public.ops_security(created_at desc);
create index if not exists ops_helpers_event_idx on public.ops_helpers(event_id);
create index if not exists ops_prize_wins_created_idx on public.ops_prize_wins(created_at desc);
create index if not exists ops_timeouts_email_idx on public.ops_timeouts(email, expires_at desc);
create index if not exists ops_access_blocks_active_idx on public.ops_access_blocks(email, active);

-- Hungry pool RPCs, because members need to claim/complete slots without broad write access.
create or replace function public.claim_hungry_slot(p_id uuid, p_claimed_by_name text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in required.'; end if;
  update public.ops_hungry set status='claimed', claimed_by=auth.uid(), claimed_by_name=left(coalesce(p_claimed_by_name,'Staff'),100), claimed_at=now()
  where id=p_id and status='open';
  if not found then raise exception 'This slot is no longer available.'; end if;
  return true;
end; $$;
create or replace function public.unclaim_hungry_slot(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.ops_hungry set status='open', claimed_by=null, claimed_by_name=null, claimed_at=null
  where id=p_id and claimed_by=auth.uid() and status='claimed';
  if not found then raise exception 'You cannot unclaim this slot.'; end if;
  return true;
end; $$;
create or replace function public.complete_hungry_slot(p_id uuid, p_completed_by_name text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.ops_hungry set status='completed', completed_by=auth.uid(), completed_by_name=left(coalesce(p_completed_by_name,'Staff'),100), completed_at=now()
  where id=p_id and ((claimed_by=auth.uid()) or public.kng_schedule_can_manage());
  if not found then raise exception 'You cannot complete this slot.'; end if;
  return true;
end; $$;
grant execute on function public.claim_hungry_slot(uuid,text) to authenticated;
grant execute on function public.unclaim_hungry_slot(uuid) to authenticated;
grant execute on function public.complete_hungry_slot(uuid,text) to authenticated;

-- RLS for operations.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_tracker','ops_points','ops_hungry','ops_reductions','ops_audit','ops_security','ops_prizes','ops_helpers','ops_prize_wins','ops_timeouts','ops_access_blocks','ops_security_settings'] LOOP
    EXECUTE format('alter table public.%I enable row level security', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS ops_tracker_read ON public.ops_tracker; DROP POLICY IF EXISTS ops_tracker_write ON public.ops_tracker;
CREATE POLICY ops_tracker_read ON public.ops_tracker FOR SELECT TO authenticated USING (public.kng_schedule_can_manage());
CREATE POLICY ops_tracker_write ON public.ops_tracker FOR INSERT TO authenticated WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_points_read ON public.ops_points; DROP POLICY IF EXISTS ops_points_write ON public.ops_points;
CREATE POLICY ops_points_read ON public.ops_points FOR SELECT TO authenticated USING (public.kng_schedule_can_manage());
CREATE POLICY ops_points_write ON public.ops_points FOR INSERT TO authenticated WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_hungry_read ON public.ops_hungry; DROP POLICY IF EXISTS ops_hungry_write ON public.ops_hungry;
CREATE POLICY ops_hungry_read ON public.ops_hungry FOR SELECT TO authenticated USING (public.kng_schedule_can_manage() or status in ('open','claimed','completed'));
CREATE POLICY ops_hungry_write ON public.ops_hungry FOR ALL TO authenticated USING (public.kng_schedule_can_manage()) WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_reductions_read ON public.ops_reductions; DROP POLICY IF EXISTS ops_reductions_write ON public.ops_reductions;
CREATE POLICY ops_reductions_read ON public.ops_reductions FOR SELECT TO authenticated USING (public.kng_schedule_can_manage());
CREATE POLICY ops_reductions_write ON public.ops_reductions FOR ALL TO authenticated USING (public.kng_schedule_can_manage()) WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_audit_read ON public.ops_audit; DROP POLICY IF EXISTS ops_audit_insert ON public.ops_audit;
CREATE POLICY ops_audit_read ON public.ops_audit FOR SELECT TO authenticated USING (public.kng_schedule_can_manage());
CREATE POLICY ops_audit_insert ON public.ops_audit FOR INSERT TO authenticated WITH CHECK (actor_id = auth.uid());
DROP POLICY IF EXISTS ops_security_read ON public.ops_security; DROP POLICY IF EXISTS ops_security_write ON public.ops_security;
CREATE POLICY ops_security_read ON public.ops_security FOR SELECT TO authenticated USING (public.kng_schedule_can_manage());
CREATE POLICY ops_security_write ON public.ops_security FOR INSERT TO authenticated WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_prizes_read ON public.ops_prizes; DROP POLICY IF EXISTS ops_prizes_write ON public.ops_prizes;
CREATE POLICY ops_prizes_read ON public.ops_prizes FOR SELECT TO authenticated USING (public.kng_schedule_can_manage());
CREATE POLICY ops_prizes_write ON public.ops_prizes FOR ALL TO authenticated USING (public.kng_schedule_can_manage()) WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_helpers_read ON public.ops_helpers; DROP POLICY IF EXISTS ops_helpers_write ON public.ops_helpers;
CREATE POLICY ops_helpers_read ON public.ops_helpers FOR SELECT TO authenticated USING (public.kng_schedule_can_manage());
CREATE POLICY ops_helpers_write ON public.ops_helpers FOR ALL TO authenticated USING (public.kng_schedule_can_manage()) WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_prize_wins_read ON public.ops_prize_wins; DROP POLICY IF EXISTS ops_prize_wins_write ON public.ops_prize_wins;
CREATE POLICY ops_prize_wins_read ON public.ops_prize_wins FOR SELECT TO authenticated USING (public.kng_schedule_can_manage());
CREATE POLICY ops_prize_wins_write ON public.ops_prize_wins FOR ALL TO authenticated USING (public.kng_schedule_can_manage()) WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_timeouts_read ON public.ops_timeouts; DROP POLICY IF EXISTS ops_timeouts_write ON public.ops_timeouts;
CREATE POLICY ops_timeouts_read ON public.ops_timeouts FOR SELECT TO authenticated USING (public.kng_schedule_can_manage() or lower(email)=lower(auth.jwt()->>'email'));
CREATE POLICY ops_timeouts_write ON public.ops_timeouts FOR ALL TO authenticated USING (public.kng_schedule_can_manage()) WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_access_blocks_read ON public.ops_access_blocks; DROP POLICY IF EXISTS ops_access_blocks_write ON public.ops_access_blocks;
CREATE POLICY ops_access_blocks_read ON public.ops_access_blocks FOR SELECT TO authenticated USING (public.kng_schedule_can_manage() or lower(email)=lower(auth.jwt()->>'email'));
CREATE POLICY ops_access_blocks_write ON public.ops_access_blocks FOR ALL TO authenticated USING (public.kng_schedule_can_manage()) WITH CHECK (public.kng_schedule_can_manage());
DROP POLICY IF EXISTS ops_security_settings_read ON public.ops_security_settings; DROP POLICY IF EXISTS ops_security_settings_write ON public.ops_security_settings;
CREATE POLICY ops_security_settings_read ON public.ops_security_settings FOR SELECT TO authenticated USING (public.kng_schedule_can_manage());
CREATE POLICY ops_security_settings_write ON public.ops_security_settings FOR ALL TO authenticated USING (public.kng_schedule_is_director()) WITH CHECK (public.kng_schedule_is_director());

-- =========================================================
-- ACCESS REQUESTS / DISCORD AUTHORIZATION
-- =========================================================

create table if not exists public.staff_access_requests (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  discord_id text not null, discord_username text, requested_name text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_access_level text not null default 'member', review_note text,
  reviewed_by uuid references auth.users(id) on delete set null, reviewed_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists staff_access_requests_status_idx on public.staff_access_requests(status, created_at desc);
create unique index if not exists staff_access_requests_one_pending_idx on public.staff_access_requests(user_id) where status='pending';
alter table public.staff_access_requests enable row level security;
drop policy if exists staff_access_requests_select on public.staff_access_requests;
drop policy if exists staff_access_requests_insert on public.staff_access_requests;
create policy staff_access_requests_select on public.staff_access_requests for select to authenticated using (user_id=auth.uid() or public.kng_schedule_can_manage());
create policy staff_access_requests_insert on public.staff_access_requests for insert to authenticated with check (user_id=auth.uid() and status='pending');

create or replace function public.request_staff_access(p_requested_access_level text default 'member')
returns uuid language plpgsql security definer set search_path=public as $$
declare identity_row record; staff_row record; request_id uuid; discord_name text; current_rank integer; requested_rank integer;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  p_requested_access_level:=lower(coalesce(trim(p_requested_access_level),'member'));
  if p_requested_access_level not in ('member','adm','manager') then raise exception 'Director access is assigned directly by an existing Director.'; end if;
  current_rank:=public.kng_schedule_access_rank();
  requested_rank:=case p_requested_access_level when 'member' then 1 when 'adm' then 2 when 'manager' then 3 else 99 end;
  if requested_rank <= current_rank or requested_rank > current_rank+1 then raise exception 'Permission levels must be approved in order.'; end if;
  select i.provider_id,i.identity_data into identity_row from auth.identities i where i.user_id=auth.uid() and i.provider='discord' order by i.created_at desc limit 1;
  if identity_row.provider_id is null then raise exception 'Discord sign-in is required for staff access.'; end if;
  discord_name:=coalesce(identity_row.identity_data->>'global_name',identity_row.identity_data->>'username','Discord user');
  select s.id,s.name into staff_row from public.staff s where s.discord_id=identity_row.provider_id and s.active=true limit 1;
  insert into public.staff_access_requests(user_id,discord_id,discord_username,requested_name,status,requested_access_level)
  values(auth.uid(),identity_row.provider_id,discord_name,coalesce(staff_row.name,discord_name),'pending',p_requested_access_level)
  returning id into request_id;
  return request_id;
exception when unique_violation then
  select id into request_id from public.staff_access_requests where user_id=auth.uid() and status='pending' order by created_at desc limit 1; return request_id;
end; $$;

create or replace function public.approve_staff_access_request(p_request_id uuid,p_access_level text default 'adm')
returns boolean language plpgsql security definer set search_path=public as $$
declare req record; updated_count integer; target_rank integer;
begin
  if not public.kng_schedule_can_manage() then raise exception 'You do not have permission to approve staff access.'; end if;
  p_access_level:=lower(p_access_level);
  if p_access_level not in ('member','adm','manager') then raise exception 'Invalid approval level.'; end if;
  target_rank:=case p_access_level when 'member' then 1 when 'adm' then 2 when 'manager' then 3 else 99 end;
  if public.kng_schedule_access_rank() < target_rank+1 then raise exception 'Security chain: ADM confirms Members; Manager confirms Members and ADMs; Director confirms Members, ADMs and Managers.'; end if;
  select * into req from public.staff_access_requests where id=p_request_id for update;
  if req.id is null then raise exception 'Access request not found.'; end if;
  if req.status<>'pending' then raise exception 'This request has already been decided.'; end if;
  if coalesce(req.requested_access_level,'member')<>p_access_level then raise exception 'Approval level does not match request.'; end if;
  update public.staff_access set access_level=p_access_level,active=true where user_id=req.user_id; get diagnostics updated_count=row_count;
  if updated_count=0 then insert into public.staff_access(user_id,access_level,active) values(req.user_id,p_access_level,true); end if;
  update public.staff_access_requests set status='approved',review_note='Access confirmed by staff.',reviewed_by=auth.uid(),reviewed_at=now() where id=p_request_id;
  return true;
end; $$;

create or replace function public.reject_staff_access_request(p_request_id uuid,p_reason text default 'Access not approved')
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if not public.kng_schedule_can_manage() then raise exception 'You do not have permission to reject staff access.'; end if;
  update public.staff_access_requests set status='rejected',review_note=coalesce(nullif(trim(p_reason),''),'Access not approved'),reviewed_by=auth.uid(),reviewed_at=now() where id=p_request_id;
  if not found then raise exception 'Access request not found.'; end if; return true;
end; $$;
grant execute on function public.kng_schedule_access_rank() to authenticated;
grant execute on function public.request_staff_access(text) to authenticated;
grant execute on function public.approve_staff_access_request(uuid,text) to authenticated;
grant execute on function public.reject_staff_access_request(uuid,text) to authenticated;

-- =========================================================
-- PUBLIC FEEDBACK + EVENT SUGGESTIONS
-- =========================================================

create table if not exists public.event_feedback (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id) on delete cascade,
  display_name text not null default 'Anonymous', rating integer not null check (rating between 1 and 5), feedback text not null,
  created_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now()
);
create table if not exists public.event_suggestions (
  id uuid primary key default gen_random_uuid(), event_id uuid references public.events(id) on delete set null,
  display_name text not null default 'Anonymous', title text not null, suggestion text not null,
  status text not null default 'new' check (status in ('new','reviewed','accepted','declined')),
  created_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists event_feedback_event_idx on public.event_feedback(event_id, created_at desc);
create index if not exists event_suggestions_created_idx on public.event_suggestions(created_at desc);
alter table public.event_feedback enable row level security;
alter table public.event_suggestions enable row level security;
drop policy if exists event_feedback_public_read on public.event_feedback;
drop policy if exists event_feedback_public_insert on public.event_feedback;
drop policy if exists event_suggestions_public_read on public.event_suggestions;
drop policy if exists event_suggestions_public_insert on public.event_suggestions;
drop policy if exists event_suggestions_staff_update on public.event_suggestions;
create policy event_feedback_public_read on public.event_feedback for select to anon,authenticated using (true);
create policy event_feedback_public_insert on public.event_feedback for insert to anon,authenticated with check (rating between 1 and 5 and length(trim(feedback)) between 1 and 1500);
create policy event_suggestions_public_read on public.event_suggestions for select to anon,authenticated using (true);
create policy event_suggestions_public_insert on public.event_suggestions for insert to anon,authenticated with check (length(trim(title)) between 1 and 120 and length(trim(suggestion)) between 1 and 1500);
create policy event_suggestions_staff_update on public.event_suggestions for update to authenticated using (public.kng_schedule_can_manage()) with check (public.kng_schedule_can_manage());

-- =========================================================
-- HALL OF FAME + DAILY GOALS
-- =========================================================

create table if not exists public.ix_hall_of_fame (
  id uuid primary key default gen_random_uuid(), winner_name text not null, image_url text, frame text not null default 'Original',
  frame_colour text not null default '#22D3EE', frame_mode text not null default 'none', hue integer not null default 180,
  intensity integer not null default 100 check (intensity between 0 and 100), created_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now()
);
create table if not exists public.ix_daily_goals (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  goal_date date not null, target_points integer not null default 8 check (target_points>0), points_earned integer not null default 0 check(points_earned>=0), created_at timestamptz not null default now(), unique(user_id,goal_date)
);
alter table public.ix_hall_of_fame enable row level security;
alter table public.ix_daily_goals enable row level security;
drop policy if exists ix_hof_read on public.ix_hall_of_fame; drop policy if exists ix_hof_manage on public.ix_hall_of_fame;
create policy ix_hof_read on public.ix_hall_of_fame for select to anon,authenticated using (true);
create policy ix_hof_manage on public.ix_hall_of_fame for all to authenticated using (public.kng_schedule_can_manage()) with check (public.kng_schedule_can_manage());
drop policy if exists ix_goals_read on public.ix_daily_goals; drop policy if exists ix_goals_manage on public.ix_daily_goals;
create policy ix_goals_read on public.ix_daily_goals for select to authenticated using (user_id=auth.uid() or public.kng_schedule_is_director());
create policy ix_goals_manage on public.ix_daily_goals for all to authenticated using (public.kng_schedule_is_director()) with check (public.kng_schedule_is_director());

insert into storage.buckets(id,name,public) values('kng-hall-of-fame','kng-hall-of-fame',true) on conflict(id) do update set public=true;
drop policy if exists kng_hof_storage_read on storage.objects;
drop policy if exists kng_hof_storage_insert on storage.objects;
drop policy if exists kng_hof_storage_update on storage.objects;
drop policy if exists kng_hof_storage_delete on storage.objects;
create policy kng_hof_storage_read on storage.objects for select to public using(bucket_id='kng-hall-of-fame');
create policy kng_hof_storage_insert on storage.objects for insert to authenticated with check(bucket_id='kng-hall-of-fame' and public.kng_schedule_can_manage());
create policy kng_hof_storage_update on storage.objects for update to authenticated using(bucket_id='kng-hall-of-fame' and public.kng_schedule_can_manage()) with check(bucket_id='kng-hall-of-fame' and public.kng_schedule_can_manage());
create policy kng_hof_storage_delete on storage.objects for delete to authenticated using(bucket_id='kng-hall-of-fame' and public.kng_schedule_can_manage());

-- =========================================================
-- ACTIONS / INTERACTIONS ROSTER
-- =========================================================

create table if not exists public.entertainment_roster (
  id uuid primary key default gen_random_uuid(), staff_id uuid not null unique references public.staff(id) on delete cascade,
  team text not null check(team in ('actions','interactions')),
  hierarchy_level text not null default 'member' check(hierarchy_level in ('director','manager','adm','aux','ld','sub_ld','member')),
  kng_id text,
  discord_id text,
  strikes integer not null default 0 check(strikes between 0 and 3),
  mentor boolean not null default false,
  on_alopa boolean not null default false,
  notes text,
  active boolean not null default true,
  created_by uuid, updated_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists entertainment_roster_team_idx on public.entertainment_roster(team,hierarchy_level);
alter table public.entertainment_roster enable row level security;
drop policy if exists entertainment_roster_read on public.entertainment_roster;
drop policy if exists entertainment_roster_write on public.entertainment_roster;
create policy entertainment_roster_read on public.entertainment_roster for select to authenticated using(public.kng_schedule_can_manage());
create policy entertainment_roster_write on public.entertainment_roster for all to authenticated using(public.kng_schedule_can_manage()) with check(public.kng_schedule_can_manage());

-- =========================================================
-- FINISH
-- =========================================================

notify pgrst, 'reload schema';
