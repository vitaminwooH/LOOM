-- ============================================================================
-- Loom — 0017: keywords for questions posted from the Loom form.
--
-- A question typed into Home has no keyword: choosing one is the friction the
-- field exists to remove. But Threads and the Home bands group by keyword, so
-- a keyword-less question appears in no band — the person who just asked it
-- cannot find it on the screen they asked from.
--
-- The canvas sync already has Gemini propose 1-3 keywords per card, preferring
-- the vocabulary already in use. This file gives that same pass a door onto
-- FORM cards: a service-role-only RPC that writes machine keywords, and a view
-- of the cards that still need them.
--
-- Two rules, both about whose keywords they are:
--   - a card a PERSON has tuned (keywords_edited_at set) is never touched.
--     The same rule canvas_sync_upsert follows; restated here because this is
--     a second door onto the same column.
--   - machine keywords do NOT set keywords_edited_at. Setting it would lock
--     the card against every later pass and misattribute a machine's guess to
--     a person. A later human edit still locks it as before.
-- Canvas cards are refused: their keywords come from the sync.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- which cards still need keywords — read by the keyword-card function and the
-- daily sweep in canvas-sync. Service role only, like the tables.
-- ----------------------------------------------------------------------------
create or replace view public.form_cards_without_keywords as
  select ki.id, ki.type, ki.source_lang, ki.body, ki.created_at
    from knowledge_items ki
   where ki.origin <> 'canvas'
     and coalesce(cardinality(ki.keywords), 0) = 0
     and ki.keywords_edited_at is null;

revoke all on public.form_cards_without_keywords from public, anon, authenticated;
grant select on public.form_cards_without_keywords to service_role;

-- ----------------------------------------------------------------------------
-- assign_card_keywords: machine keywords onto one form card
-- ----------------------------------------------------------------------------
create or replace function public.assign_card_keywords(card_id text, keywords jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin  text;
  v_locked  boolean;
  v_out     text[] := '{}';
  x         text;
  v_canon   text;
begin
  select origin, keywords_edited_at is not null
    into v_origin, v_locked
    from knowledge_items where id = card_id;
  if v_origin is null then
    raise exception 'unknown card';
  end if;
  if v_origin = 'canvas' then
    return jsonb_build_object('id', card_id, 'skipped', 'canvas card — the sync owns its keywords');
  end if;
  if v_locked then
    return jsonb_build_object('id', card_id, 'skipped', 'edited by hand — kept');
  end if;
  if keywords is null or jsonb_typeof(keywords) <> 'array' then
    raise exception 'invalid keywords';
  end if;

  /* The same normalisation submit_card_keywords applies: at most three, 40
     characters, no case-duplicates, and a word already in the vocabulary
     takes the spelling already in use. */
  for x in select jsonb_array_elements_text(keywords) loop
    x := trim(x);
    continue when x = '' or length(x) > 40;
    select k into v_canon
    from (select distinct unnest(ki.keywords) as k from knowledge_items ki) t
    where lower(t.k) = lower(x)
    limit 1;
    x := coalesce(v_canon, x);
    v_canon := null;
    if not (lower(x) = any (select lower(y) from unnest(v_out) y)) then
      v_out := v_out || x;
    end if;
    exit when cardinality(v_out) = 3;
  end loop;

  -- keywords only; keywords_edited_at/by stay null — this is a machine's guess
  update knowledge_items set keywords = v_out where id = card_id;

  return jsonb_build_object('id', card_id, 'keywords', to_jsonb(v_out));
end;
$$;

comment on function public.assign_card_keywords(text, jsonb) is
  'Machine keywords for a form card (keyword-card function, canvas-sync sweep). Refuses canvas cards and hand-edited cards; never sets keywords_edited_at.';

revoke execute on function public.assign_card_keywords(text, jsonb) from public, anon, authenticated;
grant execute on function public.assign_card_keywords(text, jsonb) to service_role;
