-- KNG editable Host an Event catalogue
-- Run once in Supabase SQL Editor. Existing scheduled event records are not changed.
create table if not exists public.kng_host_event_catalogue (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
create unique index if not exists kng_host_event_catalogue_active_name_uq
  on public.kng_host_event_catalogue (lower(name)) where active = true;
alter table public.kng_host_event_catalogue enable row level security;
drop policy if exists kng_host_event_catalogue_read on public.kng_host_event_catalogue;
drop policy if exists kng_host_event_catalogue_manage on public.kng_host_event_catalogue;
create policy kng_host_event_catalogue_read on public.kng_host_event_catalogue
  for select to authenticated using (public.kng_schedule_access_rank() >= 1);
create policy kng_host_event_catalogue_manage on public.kng_host_event_catalogue
  for all to authenticated
  using (public.kng_schedule_access_rank() >= 3)
  with check (public.kng_schedule_access_rank() >= 3);

insert into public.kng_host_event_catalogue(name, active, sort_order)
values
  ('Arena Annihilation', true, 1),
  ('Bar Fight', true, 2),
  ('BMX Sprint', true, 3),
  ('Boxes', true, 4),
  ('Breaks Are Gone', true, 5),
  ('Buggy Blitz', true, 6),
  ('Bumper Cars', true, 7),
  ('Cargo FFA', true, 8),
  ('Compound FFA', true, 9),
  ('Cops & Robbers', true, 10),
  ('Crossy Road', true, 11),
  ('Dead Man''s Dash', true, 12),
  ('Dirty Derby', true, 13),
  ('Dress to Impress', true, 14),
  ('Factory of Fear', true, 15),
  ('Family Fortunes', true, 16),
  ('Find the Animal', true, 17),
  ('Football Trivia', true, 18),
  ('Fortune''s Choice', true, 19),
  ('Grand Prix', true, 20),
  ('Guess the Song', true, 21),
  ('Got-A-Reason', true, 22),
  ('Go-Kart Race', true, 23),
  ('Hide My Ride', true, 24),
  ('Higher or Lower', true, 25),
  ('Hide-or-Die Chicken Coop', true, 26),
  ('Hide-or-Die Chinatown', true, 27),
  ('Hide-or-Die Hospital', true, 28),
  ('Hide-or-Die University', true, 29),
  ('KNG Got Talent', true, 30),
  ('KNG Trivia', true, 31),
  ('Long Haul Championship', true, 32),
  ('Monster Truck Gauntlet', true, 33),
  ('Musical Cars', true, 34),
  ('Musical Statues', true, 35),
  ('Need for Speed', true, 36),
  ('Phantoms vs Runners', true, 37),
  ('Pop Quiz', true, 38),
  ('Ramps', true, 39),
  ('Rubber Dinghy Rapids', true, 40),
  ('Sandy Seeking', true, 41),
  ('Scavenger Hunt', true, 42),
  ('Simon Says', true, 43),
  ('Slippy Slide', true, 44),
  ('Subway Surfers', true, 45),
  ('Taxi Dash', true, 46),
  ('Harbour Havoc', true, 47),
  ('Would You Rather', true, 48),
  ('Word War', true, 49),
  ('Clown Survival', true, 50),
  ('Deadman''s Pit', true, 51),
  ('Ghost Rider Rally', true, 52),
  ('Haunted Hospital', true, 53),
  ('Headless Horseman', true, 54),
  ('Infected', true, 55),
  ('Scrapyard Showdown', true, 56),
  ('The Haunting Grounds', true, 57),
  ('The Slasher', true, 58),
  ('Chemist Clash', true, 59),
  ('KNG Boxing', true, 60),
  ('Club 77', true, 61),
  ('Vanilla', true, 62)
on conflict do nothing;

-- BR names remain in kng_action_types (kind='br'). ADM+ can add/remove them
-- from the in-site catalogue manager; existing tracker rows are retained.
