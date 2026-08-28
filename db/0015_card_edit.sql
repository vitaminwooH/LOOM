-- ============================================================================
-- Loom — 0015: editing a card from the screen.
--
-- The principle: a field is edited where it was authored.
--   canvas body   -> edited in Slack Canvas (this file refuses it in Loom)
--   form body     -> edited in Loom, and now reaches the DB
--   keywords      -> nobody authors them in Canvas (no such field, by design);
--                    Gemini proposes, people refine. Editable in Loom for ANY
--                    card, either studio: Threads is shared property, and a
--                    keyword stuck on the wrong card spoils the other
--                    studio's map as much as its own.
--
-- New columns:
--   origin              'canvas' | 'form' | 'test' — who owns this row's body.
--                       Server-side truth instead of reading the id prefix.
--   keywords_edited_at  set when a person tunes the keywords. canvas_sync_upsert
--                       then NEVER overwrites them again (enforced here, so no
--                       Edge Function deploy can undo it).
--   keywords_edited_by  which Person did it — cross-studio editing without a
--                       trace is how a wrong keyword becomes an argument.
--   edited_at           when the body was last corrected in Loom.
-- ============================================================================

alter table knowledge_items add column if not exists origin text not null default 'form';
alter table knowledge_items add column if not exists keywords_edited_at timestamptz;
alter table knowledge_items add column if not exists keywords_edited_by text references persons(id);
alter table knowledge_items add column if not exists edited_at timestamptz;

-- existing rows: the canvas sync made every cv- card
update knowledge_items set origin = 'canvas' where id like 'cv-%' and origin <> 'canvas';

-- ----------------------------------------------------------------------------
-- keyword tuning. No studio restriction on purpose (see the header).
-- ----------------------------------------------------------------------------
create or replace function public.submit_card_keywords(card_id text, keywords jsonb, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate    jsonb;
  v_person  text;
  v_out     text[] := '{}';
  x         text;
  v_canon   text;
  v_name    text;
begin
  v_gate := write_gate(code);
  v_person := v_gate->>'person';

  if not exists (select 1 from knowledge_items where id = card_id) then
    raise exception 'unknown card';
  end if;
  if keywords is null or jsonb_typeof(keywords) <> 'array' then
    raise exception 'invalid keywords';
  end if;
  if jsonb_array_length(keywords) > 3 then
    raise exception 'at most three keywords';
  end if;

  /* Same rules the sync enforces (canvas-sync normalizeKeywords), re-stated
     here because this is a second door onto the same column: at most three,
     40 characters, no case-duplicates, and a word that already exists in the
     vocabulary takes the spelling already in use — Threads groups by folded
     case, so two spellings of one word would read as one thread but sort as
     two everywhere else. */
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
  end loop;

  update knowledge_items set
    keywords = v_out,
    keywords_edited_at = now(),
    keywords_edited_by = coalesce(v_person, keywords_edited_by)
  where id = card_id;

  select p.name into v_name from persons p where p.id = v_person;

  return jsonb_build_object(
    'id', card_id,
    'keywords', to_jsonb(v_out),
    'edited_by', v_name,
    'edited_at', now());
end;
$$;

comment on function public.submit_card_keywords(text, jsonb, text) is
  'Keyword tuning from the card detail. Any studio may tune any card (Threads is shared); gated by write_gate.';

revoke execute on function public.submit_card_keywords(text, jsonb, text) from public;
grant execute on function public.submit_card_keywords(text, jsonb, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- body correction — Loom-authored cards only, own studio only.
-- ----------------------------------------------------------------------------
create or replace function public.submit_card_edit(card_id text, lang text, text_block jsonb, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate   jsonb;
  v_card   knowledge_items;
  v_clean  jsonb := '{}'::jsonb;
  allowed  text[];
  k        text;
begin
  v_gate := write_gate(code);

  select * into v_card from knowledge_items where id = card_id;
  if v_card.id is null then
    raise exception 'unknown card';
  end if;
  -- the Canvas owns what was written in the Canvas
  if v_card.origin = 'canvas' then
    raise exception 'canvas card: edit the entry in Slack, then run a refresh sync';
  end if;
  if v_gate->>'via' = 'auth' and v_card.origin_studio_id <> v_gate->>'studio' then
    raise exception 'wrong studio';
  end if;
  if lang is null or lang not in ('en','ko','de','tr') then
    raise exception 'invalid language';
  end if;
  if text_block is null or jsonb_typeof(text_block) <> 'object' then
    raise exception 'invalid text';
  end if;
  if length(text_block::text) > 20000 then
    raise exception 'payload too large';
  end if;

  -- the same per-type whitelist submit_card uses
  allowed := array['title','summary'] || case v_card.type
    when 'update'     then array['note','next','openQuestion']
    when 'project'    then array['made','constraints','solved','borrow','next','openQuestion']
    when 'experiment' then array['goal','method','happened','learned','next','openQuestion']
    else                   array['blocked','triedSoFar','next','openQuestion']
  end;
  for k in select jsonb_object_keys(text_block) loop
    if k = any(allowed)
       and jsonb_typeof(text_block->k) = 'string'
       and length(text_block->>k) between 1 and 4000 then
      v_clean := v_clean || jsonb_build_object(k, text_block->k);
    end if;
  end loop;
  if v_clean->>'title' is null or length(v_clean->>'title') > 300 then
    raise exception 'invalid title';
  end if;

  update knowledge_items set
    body = coalesce(body, '{}'::jsonb) || jsonb_build_object(lang, v_clean),
    source_lang = lang,   -- a correction is authored in the language it was typed in
    edited_at = now()
  where id = card_id;

  return jsonb_build_object('id', card_id, 'lang', lang, 'edited_at', now());
end;
$$;

comment on function public.submit_card_edit(text, text, jsonb, text) is
  'Body correction for Loom-authored cards (origin=form). Canvas cards are refused: their source is the Slack Canvas.';

revoke execute on function public.submit_card_edit(text, text, jsonb, text) from public;
grant execute on function public.submit_card_edit(text, text, jsonb, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- canvas_sync_upsert: stamps origin='canvas', and never touches keywords a
-- person has tuned. The guard lives HERE rather than in the Edge Function so
-- that no deploy — old, new, or hand-rolled — can overwrite a human decision.
-- Body otherwise identical to 0009.
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
        derived_from_id    = v_derived,
        relation_type      = v_relation,
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

-- ----------------------------------------------------------------------------
-- the read RPC gains the new fields (return type change → drop first)
-- ----------------------------------------------------------------------------
drop function if exists public.get_knowledge_items(text);

create or replace function public.get_knowledge_items(lang text default 'en')
returns table (
  id                 text,
  type               text,
  studio             text,
  author             text,
  shared_by_name     text,
  keywords           text[],
  keywords_edited_by text,
  keywords_edited_at timestamptz,
  origin             text,
  related_to         text[],
  derived_from       text,
  relation_type      text,
  relation_note      text,
  status             text,
  asked_to           text,
  image              jsonb,
  attachments        jsonb,
  link               text,
  source_lang        text,
  demo_age           jsonb,
  created_at         timestamptz,
  edited_at          timestamptz,
  conversation       jsonb,
  applied_by         text[],
  txt                jsonb
)
language sql
stable
set search_path = public
as $$
  select
    ki.id,
    ki.type,
    ki.origin_studio_id,
    doc.name,
    sh.name,
    ki.keywords,
    kwp.name,
    ki.keywords_edited_at,
    ki.origin,
    ki.related_to,
    ki.derived_from_id,
    ki.relation_type,
    ki.relation_note,
    ki.status,
    ki.asked_to_studio_id,
    ki.image,
    ki.attachments,
    ki.link,
    ki.source_lang,
    ki.demo_age,
    ki.created_at,
    ki.edited_at,
    ki.conversation,
    coalesce(
      (select array_agg(distinct a.studio_id)
         from applications a
        where a.knowledge_item_id = ki.id),
      '{}'
    ),
    coalesce(ki.body -> lang, ki.body -> ki.source_lang, '{}'::jsonb)
  from knowledge_items ki
  left join persons doc on doc.id = ki.documented_by_id
  left join persons sh  on sh.id  = ki.shared_by_id
  left join persons kwp on kwp.id = ki.keywords_edited_by
  order by ki.created_at desc;
$$;

comment on function public.get_knowledge_items(text) is
  'Feed read path: one language block per row, with appliedBy, names, image, attachments, origin and keyword-edit provenance folded in.';
