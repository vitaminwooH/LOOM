-- ============================================================================
-- Loom — 0019: a person's login address is not public, and a roster is its
-- own studio's.
--
-- Two holes, both in persons:
--
--   1. persons.email (0012) is the address a person signs in with. The table
--      has been readable by anyone since 0001 (read_all), so with the public
--      anon key `/rest/v1/persons?select=email` listed every member's login.
--      The page never asked for it (data.js reads named columns), but the
--      door was open. RLS filters rows, not columns, so the fix is a column
--      grant: anon and authenticated may read every column except email.
--      submit_roster_edit also handed the whole row back, email included,
--      to whoever called it — it runs as owner, so the grant alone would not
--      have covered it; it now returns the row without email.
--
--      links.email is untouched: that is a contact address a person chose to
--      publish on their roster card, which is the point of the card.
--
--   2. submit_roster_edit checked the payload's studio against the caller's,
--      but never the person's current studio, and then set studio_id to the
--      payload's. A member of one studio could name a person from another,
--      move them into their own roster and rewrite them. An existing person
--      now keeps their studio: the payload's studio must be the one they are
--      already in, on both doors. Moving someone between studios is not a
--      roster edit; the editor never sent one.
--
-- Body otherwise identical to 0013.
--
-- NOTE for later migrations: a column added to persons is NOT readable by
-- anon/authenticated until it is added to the grant below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. persons: every column but email
-- ----------------------------------------------------------------------------
revoke select on table public.persons from anon, authenticated;
grant select (
  id, studio_id, name, role_key, photo_path, photo_pos,
  working_on, can_help, links, on_roster, sort_order
) on table public.persons to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. submit_roster_edit: an existing person stays in their studio, and the
--    row handed back carries no email
-- ----------------------------------------------------------------------------
create or replace function public.submit_roster_edit(payload jsonb, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate     jsonb;
  v_action   text;
  v_id       text;
  v_studio   text;
  v_current  text;
  v_name     text;
  v_links    jsonb := '{}'::jsonb;
  v_pos      jsonb := null;
  v_resolved jsonb;
  k          text;
  v          text;
begin
  v_gate := write_gate(code);

  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'invalid payload';
  end if;
  if length(payload::text) > 8192 then
    raise exception 'payload too large';
  end if;

  v_action := coalesce(payload->>'action', 'upsert');
  if v_action not in ('upsert', 'remove') then
    raise exception 'invalid action';
  end if;
  v_id := payload->>'id';

  if v_action = 'remove' then
    if v_id is null or not exists (select 1 from persons where id = v_id) then
      raise exception 'unknown person';
    end if;
    if v_gate->>'via' = 'auth'
       and (select studio_id from persons where id = v_id) <> v_gate->>'studio' then
      raise exception 'wrong studio';
    end if;
    update persons set on_roster = false where id = v_id;
    return (select to_jsonb(p) - 'email' from persons p where p.id = v_id);
  end if;

  v_studio := payload->>'studio';
  if not exists (select 1 from studios s where s.id = v_studio) then
    raise exception 'invalid studio';
  end if;
  if v_gate->>'via' = 'auth' and v_studio <> v_gate->>'studio' then
    raise exception 'wrong studio';
  end if;
  v_name := trim(coalesce(payload->>'name', ''));
  if v_name = '' or length(v_name) > 80 then
    raise exception 'invalid name';
  end if;

  if v_id is null then
    v_resolved := canvas_resolve_person(jsonb_build_object('name', v_name, 'studio', v_studio));
    v_id := v_resolved->>'id';
    if v_id is null then
      raise exception 'could not create person';
    end if;
  else
    select studio_id into v_current from persons where id = v_id;
    if not found then
      raise exception 'unknown person';
    end if;
    -- the person is edited where they are; the payload cannot relocate them
    if v_current <> v_studio then
      raise exception 'wrong studio';
    end if;
  end if;

  if jsonb_typeof(payload->'links') = 'object' then
    for k, v in select * from jsonb_each_text(payload->'links') loop
      if k in ('email', 'website', 'behance', 'vimeo', 'instagram')
         and v is not null and length(trim(v)) between 1 and 200 then
        v_links := v_links || jsonb_build_object(k, trim(v));
      end if;
    end loop;
  end if;

  if jsonb_typeof(payload->'photo_pos') = 'object'
     and jsonb_typeof(payload->'photo_pos'->'x') = 'number'
     and jsonb_typeof(payload->'photo_pos'->'y') = 'number'
     and (payload->'photo_pos'->>'x')::numeric between 0 and 100
     and (payload->'photo_pos'->>'y')::numeric between 0 and 100 then
    v_pos := jsonb_build_object(
      'x', (payload->'photo_pos'->>'x')::numeric,
      'y', (payload->'photo_pos'->>'y')::numeric);
  end if;

  update persons set
    name       = v_name,
    role_key   = nullif(left(trim(coalesce(payload->>'role', '')), 40), ''),
    working_on = nullif(left(trim(coalesce(payload->>'working_on', '')), 300), ''),
    can_help   = nullif(left(trim(coalesce(payload->>'can_help', '')), 300), ''),
    links      = v_links,
    photo_pos  = v_pos,
    on_roster  = true
  where id = v_id;

  return (select to_jsonb(p) - 'email' from persons p where p.id = v_id);
end;
$$;

-- grants unchanged in effect; re-stated because the body was replaced
revoke execute on function public.submit_roster_edit(jsonb, text) from public;
grant execute on function public.submit_roster_edit(jsonb, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- check, after running:
--   set role anon; select email from persons limit 1;   -- permission denied
--   set role anon; select id, name from persons limit 1; -- works
--   reset role;
-- ----------------------------------------------------------------------------
