-- ============================================================================
-- Loom — 0007: canvas_sync_upsert gains a refresh mode (v3, Gemini enrichment).
--
-- refresh = true turns "id exists → skip" into "id exists → update": body
-- (now carrying Gemini-generated ko/de/tr blocks), keywords, people, lineage
-- and created_at are all recomputed deterministically from the canvas, so an
-- update can only converge a card toward its source. Unlike a purge re-run,
-- refresh never touches cards the canvas does not know about (e.g. form-
-- submitted shared-* cards).
--
-- The old two-argument function is dropped first — create or replace with a
-- new signature would leave the old overload behind.
-- ============================================================================

drop function if exists public.canvas_sync_upsert(jsonb, boolean);

create or replace function public.canvas_sync_upsert(
  cards jsonb,
  purge boolean default false,
  refresh boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  card            jsonb;
  v_purged        integer := 0;
  v_inserted      text[] := '{}';
  v_updated       text[] := '{}';
  v_skipped       text[] := '{}';
  v_persons_new   text[] := '{}';
  v_warnings      text[] := '{}';
  v_id            text;
  v_exists        boolean;
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
    -- id is the PK: matches every row; the WHERE exists for pg-safeupdate
    delete from knowledge_items where id is not null;
    get diagnostics v_purged = row_count;
  end if;

  for card in select * from jsonb_array_elements(cards) loop
    v_id := card->>'id';
    if v_id is null or v_id !~ '^[a-z0-9][a-z0-9-]{5,63}$' then
      raise exception 'invalid card id: %', coalesce(v_id, '(null)');
    end if;

    v_exists := exists (select 1 from knowledge_items where id = v_id);
    if v_exists and not refresh then
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

    if v_exists then
      update knowledge_items set
        type               = card->>'type',
        origin_studio_id   = card->>'studio',
        shared_by_id       = v_shared->>'id',
        documented_by_id   = v_documented->>'id',
        derived_from_id    = v_derived,
        relation_type      = v_relation,
        keywords           = v_keywords,
        status             = card->>'status',
        body               = coalesce(card->'body', '{}'::jsonb),
        source_lang        = coalesce(card->>'source_lang', 'en'),
        conversation       = card->'conversation',
        created_at         = coalesce((card->>'created_at')::timestamptz, created_at)
      where id = v_id;
      v_updated := v_updated || v_id;
    else
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
    end if;
  end loop;

  return jsonb_build_object(
    'purged', v_purged,
    'inserted', to_jsonb(v_inserted),
    'updated', to_jsonb(v_updated),
    'skipped', to_jsonb(v_skipped),
    'persons_created', to_jsonb(v_persons_new),
    'warnings', to_jsonb(v_warnings));
end;
$$;

comment on function public.canvas_sync_upsert(jsonb, boolean, boolean) is
  'Canvas → cards sync (service role only). purge = atomic cutover; refresh = update existing canvas cards in place.';

revoke execute on function public.canvas_sync_upsert(jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.canvas_sync_upsert(jsonb, boolean, boolean) to service_role;
