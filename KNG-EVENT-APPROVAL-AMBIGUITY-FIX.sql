-- KNG EVENT APPROVAL AMBIGUITY FIX
-- Run this once after KNG-ACTIONS-WORKSPACE-PATCH.sql.
-- Fixes PostgreSQL ambiguity between the function variable event_id and
-- the kng_event_submissions.event_id column when approving a submission.

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
  v_event_id uuid;
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

  select *
  into s
  from public.kng_event_submissions
  where id = p_submission_id
  for update;

  if s.id is null then
    raise exception 'Submission not found.';
  end if;

  if s.status <> 'pending' then
    raise exception 'This submission has already been processed.';
  end if;

  insert into public.events(
    title, event_type_id, event_date, start_time, end_time, description,
    visibility, status, is_meeting, created_by, updated_by, workspace
  )
  values (
    trim(p_title),
    p_event_type_id,
    p_event_date,
    p_start_time,
    p_end_time,
    nullif(trim(p_note), ''),
    'public',
    'scheduled',
    false,
    auth.uid(),
    auth.uid(),
    p_workspace
  )
  returning id into v_event_id;

  update public.kng_event_submissions AS sub
  set status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      event_id = v_event_id,
      review_note = nullif(trim(p_note), ''),
      updated_at = now()
  where sub.id = p_submission_id;

  return v_event_id;
end;
$$;

grant execute on function public.approve_kng_event_submission(uuid,uuid,text,text,date,time,time,text) to authenticated;
