-- ============================================================================
-- Loom — 0022: "we applied this too" is kept, and the other studio sees it.
--
-- The three-step apply flow (where did you apply it, what kind of
-- connection, what changed) wrote its edge onto the deriving card in this
-- browser's localStorage, and its "who picked this up" studio onto the
-- source the same way. The lineage strip, the traces and Home's answered
-- rule all read those fields — so the link was drawn for its maker and for
-- nobody else, least of all the studio whose work it was.
--
-- The edge belongs where the record already keeps lineage:
--   knowledge_items.derived_from_id / relation_type / relation_note on the
--   card that took the idea (yours), and an applications row for the
--   studio-level fact on the card it came from (theirs).
--
-- Rules, the same ones the flow already offers (applyFlowTargets):
--   - you link FROM your own studio's card, never another studio's
--   - a question is not somewhere an idea was applied
--   - a card has one parent, and an existing link is never replaced
--   - no loops: the parent may not descend from the child
-- Signed-in members only (member_gate, 0021): a link is a person's claim.
--
-- The canvas sync rewrites derived_from on every refresh from the canvas's
-- own "Related:" line, and most cards come from the canvas. Left alone it
-- would quietly erase every link made here at the next refresh, so it now
-- keeps a Loom-made link (lineage_linked_by set) unless the canvas names a
-- link of its own — in which case the canvas, as the card's source, wins.
-- ============================================================================

alter table public.knowledge_items
  add column if not exists lineage_linked_by text references persons(id),
  add column if not exists lineage_linked_at timestamptz;

comment on column public.knowledge_items.lineage_linked_by is
  'Who made derived_from in Loom (submit_lineage_link). Null when the link came from the canvas or a seed.';

-- ----------------------------------------------------------------------------
-- submit_lineage_link: your card took an idea from another one
--   returns { child, parent, relation, note, studio }
-- ----------------------------------------------------------------------------
create or replace function public.submit_lineage_link(
  child_id  text,
  parent_id text,
  relation  text,
  note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate   jsonb := member_gate();
  v_studio text  := v_gate->>'studio';
  v_child  knowledge_items;
  v_note   text  := nullif(trim(coalesce(submit_lineage_link.note, '')), '');
  v_cursor text;
  v_steps  integer := 0;
begin
  if submit_lineage_link.relation not in
     ('builtOn', 'inspiredBy', 'appliedFrom', 'continuedFrom', 'solvedThrough') then
    raise exception 'invalid relation';
  end if;
  if v_note is not null and length(v_note) > 300 then
    raise exception 'note too long';
  end if;

  select * into v_child from knowledge_items ki where ki.id = submit_lineage_link.child_id;
  if not found then
    raise exception 'unknown card';
  end if;
  if v_child.origin_studio_id <> v_studio then
    raise exception 'not your studio';
  end if;
  if v_child.type = 'question' then
    raise exception 'a question cannot carry a link';
  end if;
  if v_child.derived_from_id is not null then
    raise exception 'already linked';
  end if;

  if submit_lineage_link.parent_id = submit_lineage_link.child_id
     or not exists (select 1 from knowledge_items ki where ki.id = submit_lineage_link.parent_id) then
    raise exception 'unknown source';
  end if;

  -- walk up from the parent; meeting the child means the link would loop
  v_cursor := submit_lineage_link.parent_id;
  while v_cursor is not null and v_steps < 200 loop
    if v_cursor = submit_lineage_link.child_id then
      raise exception 'would loop';
    end if;
    select ki.derived_from_id into v_cursor from knowledge_items ki where ki.id = v_cursor;
    v_steps := v_steps + 1;
  end loop;

  update knowledge_items ki set
    derived_from_id   = submit_lineage_link.parent_id,
    relation_type     = submit_lineage_link.relation,
    relation_note     = v_note,
    lineage_linked_by = v_gate->>'person',
    lineage_linked_at = now()
  where ki.id = submit_lineage_link.child_id;

  -- the studio-level fact on the source: "picked up by <your studio>"
  insert into applications (knowledge_item_id, studio_id, project_id)
  values (submit_lineage_link.parent_id, v_studio, null)
  on conflict do nothing;

  return jsonb_build_object(
    'child',    submit_lineage_link.child_id,
    'parent',   submit_lineage_link.parent_id,
    'relation', submit_lineage_link.relation,
    'note',     coalesce(v_note, ''),
    'studio',   v_studio);
end;
$$;

revoke execute on function public.submit_lineage_link(text, text, text, text) from public, anon;
grant execute on function public.submit_lineage_link(text, text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- canvas_sync_upsert: a refresh keeps a link made in Loom unless the canvas
-- names one itself. Body otherwise identical to 0015.
-- ----------------------------------------------------------------------------
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
  v_kw_locked     boolean;
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
      -- keywords a person has tuned are theirs; the sync keeps its hands off
      select keywords_edited_at is not null into v_kw_locked
      from knowledge_items where id = v_id;
      if v_kw_locked then
        select keywords into v_keywords from knowledge_items where id = v_id;
        v_warnings := v_warnings || (v_id || ': keywords kept (edited by hand)');
      end if;

      update knowledge_items set
        type               = card->>'type',
        origin             = 'canvas',
        origin_studio_id   = card->>'studio',
        shared_by_id       = v_shared->>'id',
        documented_by_id   = v_documented->>'id',
        -- a link made in Loom stays unless the canvas itself names one
        derived_from_id    = case when v_derived is null and lineage_linked_by is not null
                                  then derived_from_id else v_derived end,
        relation_type      = case when v_derived is null and lineage_linked_by is not null
                                  then relation_type else v_relation end,
        lineage_linked_by  = case when v_derived is null then lineage_linked_by else null end,
        lineage_linked_at  = case when v_derived is null then lineage_linked_at else null end,
        keywords           = v_keywords,
        status             = card->>'status',
        body               = coalesce(card->'body', '{}'::jsonb),
        source_lang        = coalesce(card->>'source_lang', 'en'),
        conversation       = card->'conversation',
        image              = card->'image',
        attachments        = card->'attachments',
        created_at         = coalesce((card->>'created_at')::timestamptz, created_at)
      where id = v_id;
      v_updated := v_updated || v_id;
    else
      insert into knowledge_items
        (id, type, origin, origin_studio_id, shared_by_id, documented_by_id,
         derived_from_id, relation_type, keywords, status,
         body, source_lang, conversation, image, attachments, created_at)
      values
        (v_id, card->>'type', 'canvas', card->>'studio',
         v_shared->>'id', v_documented->>'id',
         v_derived, v_relation, v_keywords, card->>'status',
         coalesce(card->'body', '{}'::jsonb),
         coalesce(card->>'source_lang', 'en'),
         card->'conversation',
         card->'image',
         card->'attachments',
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

revoke execute on function public.canvas_sync_upsert(jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.canvas_sync_upsert(jsonb, boolean, boolean) to service_role;
