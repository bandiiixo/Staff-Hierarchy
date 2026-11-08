-- KNG EVENT IDEAS MODERATION PATCH
-- Run once. Safe to re-run.
-- Adds management deletion and a database-side profanity/slur guard.

begin;

-- AUX+ can permanently delete suggestions. Public users cannot.
drop policy if exists event_suggestions_staff_delete on public.event_suggestions;
create policy event_suggestions_staff_delete
on public.event_suggestions
for delete
to authenticated
using (public.kng_schedule_access_rank() >= 2);

-- Database-side safety net. The website also checks this list before insert,
-- but the trigger prevents bypassing the UI through direct API calls.
create or replace function public.kng_event_suggestion_language_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_text text;
  blocked_term text;
  obfuscated_pattern text;
  i integer;
  blocked_terms text[] := array[
    'fuck','fucker','fucking','shit','shite','bitch','bastard','cunt','twat','prick','dickhead',
    'nigger','nigga','faggot','fag','dyke','tranny','retard','spastic','kike','chink','paki','coon',
    'wetback','gook','raghead','beaner','cripple','mong','retardation','whore','slut','skank',
    'rapist','molest','pedo','paedo','nonce','nazi'
  ];
begin
  raw_text := lower(coalesce(new.title,'') || ' ' || coalesce(new.suggestion,'') || ' ' || coalesce(new.display_name,''));

  foreach blocked_term in array blocked_terms loop
    -- Normal whole-word match.
    if raw_text ~ ('(^|[^a-z0-9])' || blocked_term || '([^a-z0-9]|$)') then
      raise exception 'This suggestion contains prohibited language and cannot be posted.';
    end if;

    -- Catch simple punctuation/space obfuscation such as f.u.c.k or f u c k.
    obfuscated_pattern := '';
    for i in 1..length(blocked_term) loop
      obfuscated_pattern := obfuscated_pattern || substr(blocked_term, i, 1);
      if i < length(blocked_term) then
        obfuscated_pattern := obfuscated_pattern || '[^a-z0-9]*';
      end if;
    end loop;

    if raw_text ~ ('(^|[^a-z0-9])' || obfuscated_pattern || '([^a-z0-9]|$)') then
      raise exception 'This suggestion contains prohibited language and cannot be posted.';
    end if;
  end loop;

  return new;
end;
$$;
drop trigger if exists event_suggestions_language_guard on public.event_suggestions;
create trigger event_suggestions_language_guard
before insert or update of title, suggestion, display_name
on public.event_suggestions
for each row
execute function public.kng_event_suggestion_language_guard();

grant execute on function public.kng_event_suggestion_language_guard() to anon, authenticated;

notify pgrst, 'reload schema';

commit;
