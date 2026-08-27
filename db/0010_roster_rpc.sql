-- ============================================================================
-- Loom — 0010: roster edits reach the persons table (option iii, pulled in).
--
-- submit_roster_edit(payload, code): the Designers editor's save path, gated
-- by the same shared write code as submit_card (write_codes reused, checked
-- before anything else). One person per call.
--
--   { "action": "upsert" | "remove",
--     "id": "du-minwoo" | null,        -- null = create (id via canvas_resolve_person,
--                                      --   same rule the canvas sync uses)
--     "studio": "doubleu",
--     "name": "…", "role": "…",        -- role: translatable key OR free text,
--                                      --   both live in persons.role_key
--     "working_on": "…", "can_help": "…",
--     "links": { email/website/behance/vimeo/instagram },
--     "photo_pos": { "x": 0-100, "y": 0-100 } }
--
-- remove = on_roster false, never a row delete: persons are FK targets of
-- knowledge_items (shared_by/documented_by), and leaving the roster is what
-- it means anyway. Photos travel separately (roster-photo Edge Function) —
-- this RPC never touches photo_path.
-- ============================================================================

create or replace function public.submit_roster_edit(payload jsonb, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action   text;
  v_id       text;
  v_studio   text;
  v_name     text;
  v_links    jsonb := '{}'::jsonb;
  v_pos      jsonb := null;
  v_resolved jsonb;
  k          text;
  v          text;
begin
  -- 1. the gate, before anything is looked at
  if code is null
     or not exists (select 1 from write_codes w where w.code = submit_roster_edit.code and w.active) then
    raise exception 'invalid code';
  end if;

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
    update persons set on_roster = false where id = v_id;
    return (select to_jsonb(p) from persons p where p.id = v_id);
  end if;

  -- 2. upsert
  v_studio := payload->>'studio';
  if not exists (select 1 from studios where id = v_studio) then
    raise exception 'invalid studio';
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
  elsif not exists (select 1 from persons where id = v_id) then
    raise exception 'unknown person';
  end if;

  -- links: whitelisted kinds only, values trimmed and capped
  if jsonb_typeof(payload->'links') = 'object' then
    for k, v in select * from jsonb_each_text(payload->'links') loop
      if k in ('email', 'website', 'behance', 'vimeo', 'instagram')
         and v is not null and length(trim(v)) between 1 and 200 then
        v_links := v_links || jsonb_build_object(k, trim(v));
      end if;
    end loop;
  end if;

  -- photo_pos: {x, y} numbers within 0..100, or null
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
    studio_id  = v_studio,
    name       = v_name,
    role_key   = nullif(left(trim(coalesce(payload->>'role', '')), 40), ''),
    working_on = nullif(left(trim(coalesce(payload->>'working_on', '')), 300), ''),
    can_help   = nullif(left(trim(coalesce(payload->>'can_help', '')), 300), ''),
    links      = v_links,
    photo_pos  = v_pos,
    on_roster  = true
  where id = v_id;

  return (select to_jsonb(p) from persons p where p.id = v_id);
end;
$$;

comment on function public.submit_roster_edit(jsonb, text) is
  'Designers editor save path: shared-code gated upsert/remove on persons. Photos go through the roster-photo Edge Function.';

revoke execute on function public.submit_roster_edit(jsonb, text) from public;
grant execute on function public.submit_roster_edit(jsonb, text) to anon, authenticated;
