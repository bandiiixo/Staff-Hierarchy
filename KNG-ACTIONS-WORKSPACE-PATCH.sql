-- KNG ACTIONS WORKSPACE + ACCESS SYNC PATCH
-- Run after the existing KNG Entertainment migration / role-access patch.
-- Safe to re-run.

begin;

-- =========================================================
-- 1) ROSTER -> SITE ACCESS SYNC
-- =========================================================

create or replace function public.sync_entertainment_roster_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  discord text;
  target_user uuid;
  mapped_level text;
begin
  select coalesce(nullif(trim(new.discord_id),''), s.discord_id)
    into discord
  from public.staff s
  where s.id = new.staff_id;

  if discord is null then
    return new;
  end if;

  select i.user_id into target_user
  from auth.identities i
  where i.provider = 'discord'
    and i.provider_id = discord
  order by i.created_at desc
  limit 1;

  if target_user is null then
    return new;
  end if;

  mapped_level := case
    when new.active = false then 'member'
    when new.hierarchy_level = 'director' then 'director'
    when new.hierarchy_level = 'manager' then 'manager'
    when new.hierarchy_level = 'adm' then 'adm'
    when new.hierarchy_level = 'aux' then 'aux'
    else 'member'
  end;

  insert into public.staff_access(user_id, access_level, active)
  values(target_user, mapped_level, true)
  on conflict (user_id) do update
    set access_level = excluded.access_level,
        active = true,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists entertainment_roster_access_sync on public.entertainment_roster;
create trigger entertainment_roster_access_sync
after insert or update of hierarchy_level, discord_id, active, staff_id
on public.entertainment_roster
for each row execute function public.sync_entertainment_roster_access();

-- Backfill existing roster members immediately.
do $$
declare r record;
begin
  for r in
    select er.id
    from public.entertainment_roster er
    where er.active = true
  loop
    update public.entertainment_roster
    set hierarchy_level = hierarchy_level
    where id = r.id;
  end loop;
end $$;

-- =========================================================
-- 2) SHARED EVENTS: identify the Actions workspace
-- =========================================================

alter table public.events add column if not exists workspace text not null default 'general';
alter table public.events drop constraint if exists events_workspace_check;
alter table public.events add constraint events_workspace_check
  check (workspace in ('general','actions','interactions'));
create index if not exists events_workspace_date_idx
  on public.events(workspace, event_date, start_time);

-- =========================================================
-- 3) STRUCTURED EVENT SUBMISSIONS
-- Every confirmed staff member may submit.
-- AUX+ may approve/reject.
-- Approval creates a real shared-calendar event.
-- =========================================================

create table if not exists public.kng_event_submissions (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'KNG Staff',
  workspace text not null default 'general' check(workspace in ('general','actions','interactions')),
  title text not null check(length(trim(title)) between 1 and 120),
  event_type text,
  event_date date not null,
  start_time time not null,
  end_time time not null,
  description text,
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  event_id uuid references public.events(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kng_event_submission_time_check check(end_time > start_time)
);

create index if not exists kng_event_submissions_status_idx
  on public.kng_event_submissions(status, created_at desc);

alter table public.kng_event_submissions enable row level security;
drop policy if exists kng_event_submissions_read on public.kng_event_submissions;
drop policy if exists kng_event_submissions_insert on public.kng_event_submissions;
drop policy if exists kng_event_submissions_review on public.kng_event_submissions;

create policy kng_event_submissions_read
on public.kng_event_submissions for select to authenticated
using (public.kng_schedule_access_rank() >= 1);

create policy kng_event_submissions_insert
on public.kng_event_submissions for insert to authenticated
with check (
  public.kng_schedule_access_rank() >= 1
  and submitted_by = auth.uid()
);

create policy kng_event_submissions_review
on public.kng_event_submissions for update to authenticated
using (public.kng_schedule_access_rank() >= 2)
with check (public.kng_schedule_access_rank() >= 2);

-- =========================================================
-- 4) ACTION TYPES
-- =========================================================

create table if not exists public.kng_action_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null check(kind in ('action','br')),
  colour text not null default '#ef334f',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.kng_action_types(name,kind,colour) values
  ('Back Rooms','action','#cbd5e1'),
  ('Bank of England','action','#dbeafe'),
  ('Boat Raid','action','#bfdbfe'),
  ('Butcher Shop','action','#fecaca'),
  ('Cayo BR','br','#f9a8d4'),
  ('City BR','br','#a5b4fc'),
  ('City Hall','action','#c4b5fd'),
  ('Dead Man''s Valley BR','br','#f5d0fe'),
  ('Diamond Casino','action','#fef3c7'),
  ('DO NOT BOOK','action','#1e1b4b'),
  ('DO NOT BOOK 2','action','#312e81'),
  ('DO NOT BOOK 3','action','#3730a3'),
  ('Farms','action','#d9f99d'),
  ('Flight and Fight BR','br','#22c55e'),
  ('Gang VS Gang','action','#86efac'),
  ('General market','action','#fde68a'),
  ('Humane labs','action','#fbcfe8'),
  ('Island Seige','action','#e0e7ff'),
  ('Jewellery Heist','action','#f9a8d4'),
  ('King of Crime BR','br','#c4b5fd'),
  ('KNG Infected','br','#fb7185'),
  ('Pharmacy','action','#fda4af'),
  ('Prison Break','action','#fecdd3'),
  ('Raid','action','#bfdbfe'),
  ('Sandy Bank','action','#bbf7d0'),
  ('Sandy BR','br','#86efac'),
  ('Uni Heist','action','#fbcfe8')
on conflict(name) do update set kind=excluded.kind, colour=excluded.colour, active=true;

-- Mirror Actions types into the shared event_types table so approved Actions
-- become first-class entries on the main KNG Schedule.
insert into public.event_types(name, colour, description)
select name, colour, 'KNG Actions event type'
from public.kng_action_types
where kind='action'
on conflict(name) do update set colour=excluded.colour, description=excluded.description;

insert into public.event_types(name, colour, description)
select name, colour, 'KNG Battle Royale action type'
from public.kng_action_types
where kind='br'
on conflict(name) do update set colour=excluded.colour, description=excluded.description;

alter table public.kng_action_types enable row level security;
drop policy if exists kng_action_types_read on public.kng_action_types;
drop policy if exists kng_action_types_manage on public.kng_action_types;
create policy kng_action_types_read on public.kng_action_types for select to authenticated using (public.kng_schedule_access_rank() >= 1);
create policy kng_action_types_manage on public.kng_action_types for all to authenticated using (public.kng_schedule_access_rank() >= 3) with check (public.kng_schedule_access_rank() >= 3);

-- =========================================================
-- 5) ACTION TRACKER / BR TRACKER / ACTION LOG / GOALS
-- =========================================================

create table if not exists public.kng_action_tracker (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  action_type text not null,
  status text not null default 'Completed',
  org1 text,
  org2 text,
  attended text,
  winner text,
  org1_count integer not null default 0 check(org1_count >= 0),
  org2_count integer not null default 0 check(org2_count >= 0),
  ids text,
  winner_comped boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.kng_action_br_tracker (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  action_type text not null,
  status text not null default 'Completed',
  attended text,
  first_place text,
  winner_comped boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.kng_action_logs (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references public.staff(id) on delete set null,
  organisation text,
  action text not null,
  result text not null check(result in ('Positive','Negative')),
  numbers text,
  proof_url text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.kng_action_goals (
  id uuid primary key default gen_random_uuid(),
  goal_month date not null unique,
  target_actions integer not null default 1 check(target_actions > 0),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists kng_action_tracker_date_idx on public.kng_action_tracker(event_date desc);
create index if not exists kng_action_br_tracker_date_idx on public.kng_action_br_tracker(event_date desc);
create index if not exists kng_action_logs_created_idx on public.kng_action_logs(created_at desc);

alter table public.kng_action_tracker enable row level security;
alter table public.kng_action_br_tracker enable row level security;
alter table public.kng_action_logs enable row level security;
alter table public.kng_action_goals enable row level security;

-- Tracker: Actions staff can use it; AUX+ can manage all records, members can submit/edit their own records.
drop policy if exists kng_action_tracker_read on public.kng_action_tracker;
drop policy if exists kng_action_tracker_insert on public.kng_action_tracker;
drop policy if exists kng_action_tracker_update on public.kng_action_tracker;
drop policy if exists kng_action_tracker_delete on public.kng_action_tracker;
create policy kng_action_tracker_read on public.kng_action_tracker for select to authenticated using (public.kng_schedule_access_rank() >= 1);
create policy kng_action_tracker_insert on public.kng_action_tracker for insert to authenticated with check (public.kng_schedule_access_rank() >= 1 and created_by = auth.uid());
create policy kng_action_tracker_update on public.kng_action_tracker for update to authenticated using (public.kng_schedule_access_rank() >= 2 or created_by = auth.uid()) with check (public.kng_schedule_access_rank() >= 1);
create policy kng_action_tracker_delete on public.kng_action_tracker for delete to authenticated using (public.kng_schedule_access_rank() >= 2);

drop policy if exists kng_action_br_read on public.kng_action_br_tracker;
drop policy if exists kng_action_br_insert on public.kng_action_br_tracker;
drop policy if exists kng_action_br_update on public.kng_action_br_tracker;
drop policy if exists kng_action_br_delete on public.kng_action_br_tracker;
create policy kng_action_br_read on public.kng_action_br_tracker for select to authenticated using (public.kng_schedule_access_rank() >= 1);
create policy kng_action_br_insert on public.kng_action_br_tracker for insert to authenticated with check (public.kng_schedule_access_rank() >= 1 and created_by = auth.uid());
create policy kng_action_br_update on public.kng_action_br_tracker for update to authenticated using (public.kng_schedule_access_rank() >= 2 or created_by = auth.uid()) with check (public.kng_schedule_access_rank() >= 1);
create policy kng_action_br_delete on public.kng_action_br_tracker for delete to authenticated using (public.kng_schedule_access_rank() >= 2);

drop policy if exists kng_action_logs_read on public.kng_action_logs;
drop policy if exists kng_action_logs_insert on public.kng_action_logs;
drop policy if exists kng_action_logs_delete on public.kng_action_logs;
create policy kng_action_logs_read on public.kng_action_logs for select to authenticated using (public.kng_schedule_access_rank() >= 1);
create policy kng_action_logs_insert on public.kng_action_logs for insert to authenticated with check (public.kng_schedule_access_rank() >= 1 and created_by = auth.uid());
create policy kng_action_logs_delete on public.kng_action_logs for delete to authenticated using (public.kng_schedule_access_rank() >= 2);

drop policy if exists kng_action_goals_read on public.kng_action_goals;
drop policy if exists kng_action_goals_manage on public.kng_action_goals;
create policy kng_action_goals_read on public.kng_action_goals for select to authenticated using (public.kng_schedule_access_rank() >= 1);
create policy kng_action_goals_manage on public.kng_action_goals for all to authenticated using (public.kng_schedule_access_rank() >= 3) with check (public.kng_schedule_access_rank() >= 3);

-- =========================================================
-- 6) Approval helper. AUX+ can approve a structured submission.
-- =========================================================

create or replace function public.approve_kng_event_submission(
  p_submission_id uuid,
  p_event_type_id uuid,
  p_workspace text,
  p_title text,
  p_event_date date,
  p_start_time time,
  p_end_time time,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  event_id uuid;
begin
  if public.kng_schedule_access_rank() < 2 then
    raise exception 'AUX+ access is required to approve events.';
  end if;
  if p_workspace not in ('general','actions','interactions') then
    raise exception 'Invalid workspace.';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'End time must be later than start time.';
  end if;

  select * into s from public.kng_event_submissions where id=p_submission_id for update;
  if s.id is null then raise exception 'Submission not found.'; end if;
  if s.status <> 'pending' then raise exception 'This submission has already been processed.'; end if;

  insert into public.events(
    title,event_type_id,event_date,start_time,end_time,description,visibility,status,is_meeting,created_by,updated_by,workspace
  ) values (
    trim(p_title),p_event_type_id,p_event_date,p_start_time,p_end_time,nullif(trim(p_note),''),'public','scheduled',false,auth.uid(),auth.uid(),p_workspace
  ) returning id into event_id;

  update public.kng_event_submissions
  set status='approved', reviewed_by=auth.uid(), reviewed_at=now(), event_id=event_id, review_note=nullif(trim(p_note),''), updated_at=now()
  where id=p_submission_id;

  return event_id;
end;
$$;

grant execute on function public.approve_kng_event_submission(uuid,uuid,text,text,date,time,time,text) to authenticated;

create or replace function public.reject_kng_event_submission(p_submission_id uuid, p_note text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.kng_schedule_access_rank() < 2 then
    raise exception 'AUX+ access is required to reject events.';
  end if;
  update public.kng_event_submissions
  set status='rejected', reviewed_by=auth.uid(), reviewed_at=now(), review_note=nullif(trim(p_note),''), updated_at=now()
  where id=p_submission_id and status='pending';
  if not found then raise exception 'Submission not found or already processed.'; end if;
  return true;
end;
$$;

grant execute on function public.reject_kng_event_submission(uuid,text) to authenticated;

notify pgrst, 'reload schema';
commit;
