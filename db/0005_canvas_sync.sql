-- ============================================================================
-- Loom — Shared Knowledge Model v0.1
-- 0005: canvas sync write path (Canvas = single source of truth for cards).
--
-- canvas_sync_upsert(cards, purge) is called ONLY by the canvas-sync Edge
-- Function with the service role key. It is revoked from anon/authenticated,
-- so the browser-side lockdown from 0001/0004 is untouched.
--
--   purge = true   one-time cutover: delete every knowledge_item (applications
--                  go with them via FK cascade) and insert the given cards —
--                  ONE transaction, so no reader ever sees an empty table.
--                  studios / persons / projects are never touched.
--   purge = false  normal sync: insert cards whose id is not present yet,
--                  skip the rest. Canvas entries are append-only, and the
--                  Edge Function derives ids deterministically from
--                  date + title, so "id exists" IS the date+title dedup rule.
--
-- Cards arrive oldest-first so derived_from can point at a card inserted in
-- the same batch (canvas entries only ever reference older entries).
--
-- NOTE: db/0003_backfill_seed.sql is history from this point on — re-running
-- it would resurrect the deleted demo seeds on top of the canvas cards.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- canvas_resolve_person(p): resolve {"id": …} or {"name": …, "studio": …}
-- to a persons.id, creating the person (name + studio only, off-roster) when
-- unknown — documented_by/shared_by must always point at a real Person row.
-- Returns {"id": text|null, "created": bool}.
-- ----------------------------------------------------------------------------
create or replace function public.canvas_resolve_person(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     text;
  v_name   text;
  v_studio text;
  v_base   text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return jsonb_build_object('id', null, 'created', false);
  end if;

  -- an explicit id (alias-mapped in the Edge Function, e.g. Miles → du-minwoo)
  v_id := p->>'id';
  if v_id is not null then
    if exists (select 1 from persons where id = v_id) then
      return jsonb_build_object('id', v_id, 'created', false);
    end if;
    -- unknown alias target: fall through to name resolution if possible
  end if;

  v_name := trim(coalesce(p->>'name', ''));
  v_studio := p->>'studio';
  if v_name = '' or not exists (select 1 from studios where id = v_studio) then
    return jsonb_build_object('id', null, 'created', false);
  end if;

  -- same name in the same studio → same person
  select id into v_id from persons
  where studio_id = v_studio and lower(name) = lower(v_name)
  limit 1;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'created', false);
  end if;

  -- create: id follows the roster convention (du-/wh-/px- + name slug)
  v_base := case v_studio
    when 'doubleu' then 'du' when 'whow' then 'wh' when 'paxie' then 'px'
    else left(v_studio, 2) end
    || '-' || trim(both '-' from lower(regexp_replace(v_name, '[^a-zA-Z0-9]+', '-', 'g')));
  if v_base ~ '-$' or length(v_base) < 4 then
    v_base := v_base || substr(md5(v_name || v_studio), 1, 4);
  end if;
  if exists (select 1 from persons where id = v_base) then
    v_base := v_base || '-' || substr(md5(v_name || v_studio), 1, 4);
  end if;

  insert into persons (id, studio_id, name, on_roster)
  values (v_base, v_studio, v_name, false);
  return jsonb_build_object('id', v_base, 'created', true);
end;
$$;

revoke execute on function public.canvas_resolve_person(jsonb) from public, anon, authenticated;
grant execute on function public.canvas_resolve_person(jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- canvas_sync_upsert(cards, purge)
--
-- card row shape (built by the Edge Function):
--   { "id", "type", "studio", "status"?, "keywords": [],
--     "shared_by":     {"id"?} | {"name","studio"} | null,
--     "documented_by": {"id"?} | {"name","studio"} | null,
--     "derived_from"?: "cv-…", "relation_type"?: "builtOn"|…,
--     "body": {"en": {…}}, "source_lang": "en",
--     "conversation"?: [...], "created_at": "2026-08-14T12:00:00Z" }
-- ----------------------------------------------------------------------------
create or replace function public.canvas_sync_upsert(cards jsonb, purge boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  card            jsonb;
  v_purged        integer := 0;
  v_inserted      text[] := '{}';
  v_skipped       text[] := '{}';
  v_persons_new   text[] := '{}';
  v_warnings      text[] := '{}';
  v_id            text;
  v_derived       text;
  v_relation      text;
  v_shared        jsonb;
  v_documented    jsonb;
  v_keywords      text[];
begin
  if cards is null or jsonb_typeof(cards) <> 'array' then
    raise exception 'cards must be a json array';
  end if;

  if purge then
    delete from knowledge_items;             -- applications cascade with it
    get diagnostics v_purged = row_count;
  end if;

  for card in select * from jsonb_array_elements(cards) loop
    v_id := card->>'id';
    if v_id is null or v_id !~ '^[a-z0-9][a-z0-9-]{5,63}$' then
      raise exception 'invalid card id: %', coalesce(v_id, '(null)');
    end if;
    if exists (select 1 from knowledge_items where id = v_id) then
      v_skipped := v_skipped || v_id;
      continue;
    end if;
    if card->>'type' not in ('update','project','experiment','question') then
      raise exception 'invalid type on %: %', v_id, card->>'type';
    end if;
    if not exists (select 1 from studios where id = card->>'studio') then
      raise exception 'invalid studio on %: %', v_id, card->>'studio';
    end if;

    v_shared := canvas_resolve_person(card->'shared_by');
    if (v_shared->>'created')::boolean then
      v_persons_new := v_persons_new || (v_shared->>'id');
    end if;
    v_documented := canvas_resolve_person(card->'documented_by');
    if (v_documented->>'created')::boolean then
      v_persons_new := v_persons_new || (v_documented->>'id');
    end if;

    -- lineage: the Edge Function resolves titles to ids; still guard the FK
    v_derived := card->>'derived_from';
    v_relation := card->>'relation_type';
    if v_derived is not null and not exists (select 1 from knowledge_items where id = v_derived) then
      v_warnings := v_warnings || (v_id || ': derived_from target not found: ' || v_derived);
      v_derived := null; v_relation := null;
    end if;
    if v_derived is not null and (v_relation is null or v_relation not in
      ('builtOn','inspiredBy','appliedFrom','continuedFrom','solvedThrough')) then
      v_warnings := v_warnings || (v_id || ': derived_from without valid relation_type, link dropped');
      v_derived := null; v_relation := null;
    end if;

    select coalesce(array_agg(x), '{}') into v_keywords
    from jsonb_array_elements_text(
      case when jsonb_typeof(card->'keywords') = 'array'
           then card->'keywords' else '[]'::jsonb end) x;

    insert into knowledge_items
      (id, type, origin_studio_id, shared_by_id, documented_by_id,
       derived_from_id, relation_type, keywords, status,
       body, source_lang, conversation, created_at)
    values
      (v_id, card->>'type', card->>'studio',
       v_shared->>'id', v_documented->>'id',
       v_derived, v_relation, v_keywords, card->>'status',
       coalesce(card->'body', '{}'::jsonb),
       coalesce(card->>'source_lang', 'en'),
       card->'conversation',
       coalesce((card->>'created_at')::timestamptz, now()));

    v_inserted := v_inserted || v_id;
  end loop;

  return jsonb_build_object(
    'purged', v_purged,
    'inserted', to_jsonb(v_inserted),
    'skipped', to_jsonb(v_skipped),
    'persons_created', to_jsonb(v_persons_new),
    'warnings', to_jsonb(v_warnings));
end;
$$;

comment on function public.canvas_sync_upsert(jsonb, boolean) is
  'Canvas → cards sync (service role only). purge=true is the one-time atomic cutover.';

revoke execute on function public.canvas_sync_upsert(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.canvas_sync_upsert(jsonb, boolean) to service_role;
