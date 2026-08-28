-- ============================================================================
-- Loom — 0013: the write gates learn who you are (stage 3, parallel period).
--
-- Every write RPC now opens to EITHER a signed-in member OR the shared code:
--   - signed in (auth.uid() has a profile): no code needed, and the payload's
--     studio must be YOUR studio — the server refuses writes aimed anywhere
--     else. documented_by becomes your actual Person, not the team stand-in.
--   - shared code: exactly the previous behaviour, unchanged — this is the
--     parallel period, and the front can fall back to it until everyone is
--     signed in. 0014 will remove it.
--
-- write_gate() is the one place the question is asked; the three RPCs just
-- act on its answer. Tables stay locked as ever — RPCs are still the only
-- doors, so every whitelist and length cap keeps standing.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- the gate: who is writing?
--   returns { via: 'auth'|'code', studio: text|null, person: text|null }
--   raises 'invalid code' when neither door opens (same message as before,
--   so the front's invalid-code handling keeps working)
-- ----------------------------------------------------------------------------
create or replace function public.write_gate(code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_studio text;
begin
  v_studio := auth_studio();
  if v_studio is not null then
    return jsonb_build_object('via', 'auth', 'studio', v_studio, 'person', auth_person());
  end if;
  if code is not null
     and exists (select 1 from write_codes w where w.code = write_gate.code and w.active) then
    return jsonb_build_object('via', 'code', 'studio', null, 'person', null);
  end if;
  raise exception 'invalid code';
end;
$$;

revoke execute on function public.write_gate(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- submit_card: gate swapped, documented_by personal on the auth path.
-- Body otherwise identical to 0004.
-- ----------------------------------------------------------------------------
create or replace function public.submit_card(payload jsonb, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate        jsonb;
  v_id          text;
  v_type        text;
  v_studio      text;
  v_lang        text;
  v_text        jsonb;
  v_clean       jsonb := '{}'::jsonb;
  v_keywords    text[];
  v_asked       text := null;
  v_status      text := null;
  v_conv        jsonb := null;
  v_link        text := null;
  v_author_id   text;
  v_author_name text;
  v_created     timestamptz;
  k             text;
  allowed       text[];
begin
  v_gate := write_gate(code);

  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'invalid payload';
  end if;
  if length(payload::text) > 20000 then
    raise exception 'payload too large';
  end if;

  v_id := payload->>'id';
  if v_id is null or v_id !~ '^[a-z0-9][a-z0-9-]{5,63}$' then
    raise exception 'invalid id';
  end if;
  if exists (select 1 from knowledge_items ki where ki.id = v_id) then
    raise exception 'duplicate id';
  end if;

  v_type := payload->>'type';
  if v_type is null or v_type not in ('update','project','experiment','question') then
    raise exception 'invalid type';
  end if;

  v_studio := payload->>'studio';
  if not exists (select 1 from studios s where s.id = v_studio) then
    raise exception 'invalid studio';
  end if;
  -- a signed-in member writes as their own studio, nowhere else
  if v_gate->>'via' = 'auth' and v_studio <> v_gate->>'studio' then
    raise exception 'wrong studio';
  end if;

  v_lang := coalesce(payload->>'source_lang', 'en');
  if v_lang not in ('en','ko','de','tr') then
    raise exception 'invalid language';
  end if;

  v_text := payload->'text';
  if v_text is null or jsonb_typeof(v_text) <> 'object' then
    raise exception 'invalid text';
  end if;
  allowed := array['title','summary'] || case v_type
    when 'update'     then array['note','next','openQuestion']
    when 'project'    then array['made','constraints','solved','borrow','next','openQuestion']
    when 'experiment' then array['goal','method','happened','learned','next','openQuestion']
    else                   array['blocked','triedSoFar','next','openQuestion']
  end;
  for k in select jsonb_object_keys(v_text) loop
    if k = any(allowed)
       and jsonb_typeof(v_text->k) = 'string'
       and length(v_text->>k) between 1 and 4000 then
      v_clean := v_clean || jsonb_build_object(k, v_text->k);
    end if;
  end loop;
  if v_clean->>'title' is null or length(v_clean->>'title') > 300 then
    raise exception 'invalid title';
  end if;
  if length(coalesce(v_clean->>'summary','')) > 400 then
    raise exception 'invalid summary';
  end if;

  select coalesce(array_agg(left(x, 40)), '{}') into v_keywords
  from (
    select jsonb_array_elements_text(
      case when jsonb_typeof(payload->'keywords') = 'array'
           then payload->'keywords' else '[]'::jsonb end) as x
    limit 10
  ) t
  where length(trim(x)) > 0;

  -- documented_by: the signed-in Person; the studio's team stand-in only on
  -- the code path (the pre-auth convention, kept for the parallel period)
  if v_gate->>'via' = 'auth' and v_gate->>'person' is not null then
    select p.id, p.name into v_author_id, v_author_name
    from persons p where p.id = v_gate->>'person';
  end if;
  if v_author_id is null then
    select p.id, p.name into v_author_id, v_author_name
    from persons p
    where p.studio_id = v_studio and p.id in ('du-team','wh-team')
    limit 1;
  end if;

  if v_type = 'question' then
    v_status := 'open';
    v_asked := payload->>'asked_to';
    if v_asked is not null
       and not exists (select 1 from studios s where s.id = v_asked) then
      v_asked := null;
    end if;
    v_conv := jsonb_build_array(jsonb_build_object(
      'author', coalesce(v_author_name, v_studio),
      'studio', v_studio,
      'justNow', true));
    v_clean := v_clean || jsonb_build_object('conversation',
      jsonb_build_array(coalesce(v_text->>'blocked', v_clean->>'title')));
  end if;

  if v_type = 'update' then
    v_link := left(payload->>'link', 500);
    if v_link is not null and v_link !~* '^https?://' then v_link := null; end if;
  end if;

  insert into knowledge_items
    (id, type, origin_studio_id, documented_by_id, keywords,
     body, source_lang, conversation, status, asked_to_studio_id, link)
  values
    (v_id, v_type, v_studio, v_author_id, v_keywords,
     jsonb_build_object(v_lang, v_clean), v_lang, v_conv, v_status, v_asked, v_link)
  returning created_at into v_created;

  return jsonb_build_object('id', v_id, 'created_at', v_created, 'author', v_author_name);
end;
$$;

-- ----------------------------------------------------------------------------
-- submit_roster_edit: gate swapped; a member edits their own studio only.
-- Body otherwise identical to 0010.
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
    return (select to_jsonb(p) from persons p where p.id = v_id);
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
  elsif not exists (select 1 from persons where id = v_id) then
    raise exception 'unknown person';
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

-- ----------------------------------------------------------------------------
-- submit_roster_order: gate swapped; a member orders their own roster only.
-- Body otherwise identical to 0011.
-- ----------------------------------------------------------------------------
create or replace function public.submit_roster_order(studio text, ids jsonb, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate  jsonb;
  v_id    text;
  v_count integer;
  n       integer;
  i       integer := 0;
begin
  v_gate := write_gate(code);
  if v_gate->>'via' = 'auth' and studio <> v_gate->>'studio' then
    raise exception 'wrong studio';
  end if;

  if not exists (select 1 from studios s where s.id = studio) then
    raise exception 'invalid studio';
  end if;
  if ids is null or jsonb_typeof(ids) <> 'array' then
    raise exception 'invalid ids';
  end if;
  n := jsonb_array_length(ids);
  if n < 1 or n > 50 then
    raise exception 'invalid ids';
  end if;
  if (select count(distinct x) from jsonb_array_elements_text(ids) x) <> n then
    raise exception 'duplicate ids';
  end if;

  select count(*) into v_count from persons p
  where p.studio_id = submit_roster_order.studio and p.on_roster;
  if v_count <> n then
    raise exception 'order must include the whole roster (% given, % on it)', n, v_count;
  end if;

  for v_id in select jsonb_array_elements_text(ids) loop
    if not exists (select 1 from persons p
                   where p.id = v_id and p.studio_id = submit_roster_order.studio and p.on_roster) then
      raise exception 'not on this roster: %', v_id;
    end if;
    update persons set sort_order = i where id = v_id;
    i := i + 1;
  end loop;

  return jsonb_build_object('ok', true, 'count', n);
end;
$$;

-- grants unchanged in effect; re-stated because bodies were replaced
revoke execute on function public.submit_card(jsonb, text) from public;
grant execute on function public.submit_card(jsonb, text) to anon, authenticated;
revoke execute on function public.submit_roster_edit(jsonb, text) from public;
grant execute on function public.submit_roster_edit(jsonb, text) to anon, authenticated;
revoke execute on function public.submit_roster_order(text, jsonb, text) from public;
grant execute on function public.submit_roster_order(text, jsonb, text) to anon, authenticated;
