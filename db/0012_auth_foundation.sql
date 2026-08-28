-- ============================================================================
-- Loom — 0012: auth foundation (stage 1 of the magic-link login).
--
-- NOTHING here changes any existing path: the shared-code RPCs, the read
-- RPCs, canvas-sync and the front end behave exactly as before. This only
-- lays the ground the next stages stand on:
--
--   studio_domains   which email domain belongs to which studio (N:1)
--   persons.email    the join key between a login and a Person
--   profiles         one row per auth user: studio + linked person
--   handle_new_user  trigger on auth.users — rejects domains we don't know
--                    (the server half of invite-only), links or creates the
--                    Person (via canvas_resolve_person, so canvas-sync and
--                    auth mint people by the same rule)
--   auth_studio()    helper the stage-3 RPC gates will call
--
-- ⚠ BEFORE anyone logs in for the first time: fill persons.email for every
--   real person below. A user whose email matches no person gets a NEW
--   person created — fine for someone genuinely new, a duplicate for
--   somebody already on the roster.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. domain → studio
-- ----------------------------------------------------------------------------
create table if not exists studio_domains (
  domain    text primary key,
  studio_id text not null references studios(id)
);

insert into studio_domains (domain, studio_id) values
  ('doubleugames.com', 'doubleu'),
  ('afewgoodsoft.com', 'doubleu'),
  ('whow.net', 'whow')
on conflict (domain) do nothing;

alter table studio_domains enable row level security;
create policy read_all on studio_domains for select using (true); -- the lobby prefilter reads this

-- ----------------------------------------------------------------------------
-- 2. persons.email — the login ↔ Person join key
-- ----------------------------------------------------------------------------
alter table persons add column if not exists email text unique;

-- Known addresses (from the roster the people entered themselves).
update persons set email = v.email
from (values
  ('du-minwoo', 'vitaminwoo@afewgoodsoft.com'),
  ('du-sua',    'ssa0928@afewgoodsoft.com'),
  ('wh-felix',  'felix.heitmann@whow.net')
) as v(id, email)
where persons.id = v.id and persons.email is null;

-- ⚠ FILL IN before first logins — copy the pattern per person:
-- update persons set email = 'bengt@whow.net'        where id = 'wh-bengt';
-- update persons set email = 'nayeon@doubleugames.com' where id = 'du-nayeon';
-- (모르는 사람은 비워둬도 됨 — 첫 로그인 때 새 person이 생기는 것만 감수)

-- ----------------------------------------------------------------------------
-- 3. profiles — one per auth user
-- ----------------------------------------------------------------------------
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  studio_id  text not null references studios(id),
  person_id  text references persons(id),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
-- you may read your own profile (the client asks "which studio am I");
-- nobody writes it from outside — the trigger below is the only writer
create policy read_own on profiles for select using (id = auth.uid());

-- ----------------------------------------------------------------------------
-- 4. the linker: email → studio + person. Shared by the trigger (new
--    signups, incl. future OAuth) and the backfill below (users already
--    created in the dashboard, whom the trigger never saw).
-- ----------------------------------------------------------------------------
create or replace function public.link_auth_user(user_id uuid, user_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_domain text;
  v_studio text;
  v_person text;
  v_name   text;
begin
  v_domain := lower(split_part(user_email, '@', 2));
  select studio_id into v_studio from studio_domains where domain = v_domain;
  if v_studio is null then
    -- the server half of invite-only: unknown domains cannot become users
    raise exception 'email domain % is not allowed', v_domain;
  end if;

  select id into v_person from persons where lower(email) = lower(user_email);
  if v_person is null then
    -- somebody genuinely new: a readable name from the local part
    -- ('minwoo.heo' → 'Minwoo Heo'), minted by the same rule canvas-sync uses
    v_name := initcap(regexp_replace(split_part(user_email, '@', 1), '[._-]+', ' ', 'g'));
    v_person := (canvas_resolve_person(jsonb_build_object('name', v_name, 'studio', v_studio)))->>'id';
    update persons set email = lower(user_email) where id = v_person and email is null;
  end if;

  insert into profiles (id, email, studio_id, person_id)
  values (user_id, lower(user_email), v_studio, v_person)
  on conflict (id) do nothing;
end;
$$;

revoke execute on function public.link_auth_user(uuid, text) from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform link_auth_user(new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 5. backfill: users created in the dashboard before this trigger existed.
--    A user on an unknown domain is reported, not fatal — fix and re-run
--    (the whole file is re-runnable).
-- ----------------------------------------------------------------------------
do $$
declare
  u record;
begin
  for u in select id, email from auth.users
           where id not in (select id from profiles) and email is not null
  loop
    begin
      perform link_auth_user(u.id, u.email);
      raise notice 'linked: %', u.email;
    exception when others then
      raise notice 'SKIPPED %: %', u.email, sqlerrm;
    end;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. the helper stage 3's gates will use: which studio (and person) am I
-- ----------------------------------------------------------------------------
create or replace function public.auth_studio()
returns text
language sql
stable
security definer
set search_path = public
as $$ select studio_id from profiles where id = auth.uid() $$;

create or replace function public.auth_person()
returns text
language sql
stable
security definer
set search_path = public
as $$ select person_id from profiles where id = auth.uid() $$;

-- callable by everyone; returns null when not signed in
grant execute on function public.auth_studio() to anon, authenticated;
grant execute on function public.auth_person() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- verification (run after):
--   select * from profiles;                          -- 10 rows expected
--   select id, name, email from persons where email is not null;
-- ----------------------------------------------------------------------------
