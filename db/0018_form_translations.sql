-- ============================================================================
-- Loom — 0018: translations for cards written in Loom, and the language they
-- were written in.
--
-- Canvas cards arrive in en and the sync has Gemini write ko/de/tr. A card
-- written in Loom (origin <> 'canvas') had only the block it was typed in, so
-- switching to another language showed it untranslated. Two faults, fixed in
-- this order because the second depends on the first:
--
--   1. The source language was the SCREEN's language, not the text's: a
--      question typed in Korean on the English screen was stored as body.en
--      holding Korean, source_lang 'en'. Translating from that would "translate"
--      Korean into ko/de/tr. The client now says ko whenever the text has a
--      Hangul letter, and the keyword-card function has Gemini name the
--      language in the same call it already makes — this file gives it the
--      door to move the block to the right key.
--   2. Nothing filled the other three languages. The same call now returns
--      them, and this file writes them.
--
-- Rules, enforced here so that no deploy of any function can break them:
--   - only EMPTY language keys are filled. A key that exists is never
--     overwritten — neither a translation nor the original.
--   - a block with a Hangul letter is Korean. Gemini cannot move it elsewhere.
--   - an enrichment computed from text that has since changed is dropped
--     (based_on must still equal the stored source block): an edit landing
--     between the read and the write must not get the old text's translations.
--   - an edit is a new original: submit_card_edit keeps only the edited block,
--     clears the other languages and marks the language unchecked, so the
--     next enrichment detects and translates it afresh. That is what lets
--     "never overwrite a key" and "re-translate after an edit" both hold.
--   - keywords keep 0017's rules (assign_card_keywords is called as is): a
--     machine never touches a card a person tuned, and never sets
--     keywords_edited_at.
--
-- lang_checked_at: when Gemini (or the Hangul rule) last confirmed the source
-- language. null = not yet, and the daily sweep picks the card up again — so
-- a failed call cannot leave a card in the wrong key for good.
--
-- Run after 0017. 0017's view and assign_card_keywords stay: the deployed
-- functions read them until they are redeployed, and the RPC below reuses
-- assign_card_keywords.
-- ============================================================================

alter table knowledge_items add column if not exists lang_checked_at timestamptz;

comment on column knowledge_items.lang_checked_at is
  'When the source language of a Loom-written card was confirmed (Gemini or the Hangul rule). null = unchecked; the sweep retries it. Unused for canvas cards.';

-- ----------------------------------------------------------------------------
-- which cards still need something — keywords, a language check, or a
-- translation. Read by the keyword-card function (one card, or the sweep).
-- Service role only, like the tables.
-- ----------------------------------------------------------------------------
create or replace view public.form_cards_pending_enrichment as
  select id, type, source_lang, body, created_at,
         needs_keywords, needs_lang, missing_langs
    from (
      select ki.id, ki.type, ki.source_lang, ki.body, ki.created_at,
             (coalesce(cardinality(ki.keywords), 0) = 0
               and ki.keywords_edited_at is null)                     as needs_keywords,
             (ki.lang_checked_at is null)                             as needs_lang,
             array(select l from unnest(array['en','ko','de','tr']) l
                    where not (coalesce(ki.body, '{}'::jsonb) ? l))   as missing_langs
        from knowledge_items ki
       where ki.origin <> 'canvas'
    ) t
   where needs_keywords or needs_lang or cardinality(missing_langs) > 0;

revoke all on public.form_cards_pending_enrichment from public, anon, authenticated;
grant select on public.form_cards_pending_enrichment to service_role;

-- ----------------------------------------------------------------------------
-- assign_card_enrichment: what one Gemini call produced, written in one go.
--
--   based_on     the source block the call was made from (must still match)
--   keywords     jsonb array, or null — applied only when the card has none
--   source_lang  the detected language, or null when detection failed
--   translations {"ko": {...}, "de": {...}, ...} — only empty keys are filled
--
-- Each part is independent: a missing or invalid part is skipped and the rest
-- is still written, so a failed translation never costs the keywords.
-- ----------------------------------------------------------------------------
create or replace function public.assign_card_enrichment(
  card_id      text,
  based_on     jsonb,
  keywords     jsonb default null,
  source_lang  text  default null,
  translations jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card     knowledge_items;
  v_src      text;
  v_block    jsonb;
  v_body     jsonb;
  v_lang     text;
  v_moved    boolean := false;
  v_filled   text[] := '{}';
  v_kw       jsonb := null;
  -- the parameters are named for PostgREST's JSON keys, and two of them are
  -- also column names; inside SQL statements only these copies are used
  v_detected text := assign_card_enrichment.source_lang;
  l          text;
begin
  select * into v_card from knowledge_items ki where ki.id = card_id;
  if v_card.id is null then
    raise exception 'unknown card';
  end if;
  if v_card.origin = 'canvas' then
    return jsonb_build_object('id', card_id, 'skipped', 'canvas card — the sync owns it');
  end if;

  v_src   := coalesce(v_card.source_lang, 'en');
  v_body  := coalesce(v_card.body, '{}'::jsonb);
  v_block := v_body -> v_src;
  if v_block is null or based_on is null or v_block <> based_on then
    return jsonb_build_object('id', card_id, 'skipped', 'text changed since it was read');
  end if;

  -- the language: Hangul is Korean whatever the model said; otherwise the
  -- model's answer, when it gave a valid one
  v_lang := v_src;
  -- the same ranges as the client and the function: jamo, compatibility
  -- jamo, syllables
  if v_block::text ~ '[ᄀ-ᇿ㄰-㆏가-힯]' then
    v_lang := 'ko';
  elsif v_detected in ('en','ko','de','tr') then
    v_lang := v_detected;
  end if;
  if v_lang <> v_src then
    -- the original moves to its real key; whatever sat under that key is
    -- replaced by it, because the original is the one block that is not a
    -- translation of anything
    v_body := (v_body - v_src) || jsonb_build_object(v_lang, v_block);
    v_moved := true;
  end if;

  -- translations: empty keys only, never the source language, objects with a
  -- title only (the function validates the full shape; this is the floor)
  if translations is not null and jsonb_typeof(translations) = 'object' then
    for l in select unnest(array['en','ko','de','tr']) loop
      continue when l = v_lang or v_body ? l;
      continue when translations -> l is null
                 or jsonb_typeof(translations -> l) <> 'object'
                 -- coalesce: a missing title is a null type, and null <> 'string'
                 -- is null, which `continue when` reads as false
                 or coalesce(jsonb_typeof(translations -> l -> 'title'), '') <> 'string';
      v_body := v_body || jsonb_build_object(l, translations -> l);
      v_filled := v_filled || l;
    end loop;
  end if;

  update knowledge_items ki set
    body            = v_body,
    source_lang     = v_lang,
    -- confirmed only when something actually decided it: a valid answer from
    -- the model, or the Hangul rule
    lang_checked_at = case
                        when v_detected in ('en','ko','de','tr') or v_lang = 'ko' then now()
                        else ki.lang_checked_at
                      end
  where ki.id = card_id;

  -- keywords last and through 0017's own door, which keeps its rules
  if keywords is not null and jsonb_typeof(keywords) = 'array' and jsonb_array_length(keywords) > 0
     and coalesce(cardinality(v_card.keywords), 0) = 0 then
    v_kw := public.assign_card_keywords(card_id, keywords);
  end if;

  return jsonb_build_object(
    'id', card_id,
    'source_lang', v_lang,
    'moved', v_moved,
    'filled', to_jsonb(v_filled),
    'keywords', coalesce(v_kw -> 'keywords', to_jsonb(v_card.keywords)),
    'keywords_skipped', v_kw -> 'skipped',
    'body', v_body);
end;
$$;

comment on function public.assign_card_enrichment(text, jsonb, jsonb, text, jsonb) is
  'Keywords, source language and translations for a Loom-written card, from one Gemini call. Fills empty language keys only; Hangul is always ko; drops the write if the text changed since it was read. 0018.';

revoke execute on function public.assign_card_enrichment(text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.assign_card_enrichment(text, jsonb, jsonb, text, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- submit_card_edit: an edit is a new original.
--
-- Was: body = body || {lang: block} — the edited language replaced, the other
-- three kept, now describing text that no longer exists. Now: only the edited
-- block remains, the language is unchecked again, and the next enrichment
-- detects and translates it.
--
-- Also fixes a question losing its message on edit: the whitelist has no
-- 'conversation', so the edited block had none, and the thread showed an
-- empty opening post. It is rebuilt the way submit_card builds it.
--
-- Returns the stored block so the client can show exactly what was saved.
-- Everything else is 0015's.
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

  -- a question's opening post, as submit_card writes it
  if v_card.type = 'question' then
    v_clean := v_clean || jsonb_build_object('conversation',
      jsonb_build_array(coalesce(v_clean->>'blocked', v_clean->>'title')));
  end if;

  update knowledge_items set
    body = jsonb_build_object(lang, v_clean),   -- the edit is the new original
    source_lang = lang,
    lang_checked_at = null,                      -- detect and translate afresh
    edited_at = now()
  where id = card_id;

  return jsonb_build_object('id', card_id, 'lang', lang, 'edited_at', now(), 'text', v_clean);
end;
$$;

comment on function public.submit_card_edit(text, text, jsonb, text) is
  'Body correction for Loom-authored cards (origin=form). The edit becomes the only language block; the others are re-translated by keyword-card. Canvas cards are refused. 0018.';

revoke execute on function public.submit_card_edit(text, text, jsonb, text) from public;
grant execute on function public.submit_card_edit(text, text, jsonb, text) to anon, authenticated;
