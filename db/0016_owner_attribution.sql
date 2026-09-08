-- ============================================================================
-- Loom — 0016: a card is attributed to the OWNER of its knowledge.
--
-- knowledge_items has two people. shared_by is whose knowledge it is;
-- documented_by is who typed it in. On the canvas they differ whenever one
-- person logs another's answer (Aug 14: Miles records what Bengt and Felix
-- worked out — Whow's knowledge, in Whow's bracket, documented by a DoubleU
-- person). The screen used to put documented_by next to the studio, which
-- read as "Whow · Minwoo Heo": a Whow person who does not exist.
--
-- The screen now shows shared_by only (data.js ownerName). This file makes
-- the data match that rule on the one path that never set shared_by:
--
--   submit_card (the Loom form)  the writer IS the owner — you share your own
--                                knowledge here — so shared_by := documented_by.
--   existing form/test rows      backfilled the same way. Canvas rows are left
--                                alone: there the sync already writes both,
--                                and an unrecorded owner must stay unrecorded
--                                rather than be guessed from the documenter.
--
-- documented_by is not touched anywhere. It stays the record of who typed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- backfill: form and test cards written before this file
-- ----------------------------------------------------------------------------
update knowledge_items
   set shared_by_id = documented_by_id
 where shared_by_id is null
   and documented_by_id is not null
   and origin <> 'canvas';

-- ----------------------------------------------------------------------------
-- submit_card: body identical to 0013 except the insert also stores
-- shared_by_id (same Person as documented_by_id).
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

  -- shared_by = documented_by: on the form you share your own knowledge
  insert into knowledge_items
    (id, type, origin_studio_id, shared_by_id, documented_by_id, keywords,
     body, source_lang, conversation, status, asked_to_studio_id, link)
  values
    (v_id, v_type, v_studio, v_author_id, v_author_id, v_keywords,
     jsonb_build_object(v_lang, v_clean), v_lang, v_conv, v_status, v_asked, v_link)
  returning created_at into v_created;

  return jsonb_build_object('id', v_id, 'created_at', v_created, 'author', v_author_name);
end;
$$;

comment on function public.submit_card(jsonb, text) is
  'Form write path. Stores the writer as both shared_by (owner) and documented_by (documenter); 0016.';

-- grants unchanged in effect; re-stated because the body was replaced
revoke execute on function public.submit_card(jsonb, text) from public;
grant execute on function public.submit_card(jsonb, text) to anon, authenticated;
