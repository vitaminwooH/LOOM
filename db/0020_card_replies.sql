-- ============================================================================
-- Loom — 0020: a reply to a question is kept, and the other studio sees it.
--
-- Until now a reply typed into a question's Conversation pane lived in the
-- page's memory: gone on reload, never seen by anyone else, and never counted
-- as an answer. This is where it lives instead.
--
-- Its own table, not an append to knowledge_items.conversation, on purpose:
--   - that column is the canvas's. A refresh sync rewrites it, and
--     submit_card_edit rebuilds it from the opening post (0018) — either would
--     silently delete people's replies.
--   - its texts sit per language in body.<lang>.conversation, index-aligned,
--     so one reply would mean four writes into a document the translation
--     sweep also writes. A row with its own text is one write and one owner.
--
-- Signed-in members only. A reply is a person speaking to another studio, and
-- the shared code has no person behind it — so this door has no code at all.
--
-- Stored in the language it was typed in. `translations` is there for the
-- sweep to fill later ({"ko": "…", "de": "…"}); until then every reader gets
-- the author's own words, which the page labels as the original.
-- ============================================================================

create table if not exists public.card_replies (
  id          bigint generated always as identity primary key,
  card_id     text not null references knowledge_items(id) on delete cascade,
  person_id   text not null references persons(id),
  studio_id   text not null references studios(id),
  body        text not null check (length(body) between 1 and 2000),
  source_lang text not null default 'en' check (source_lang in ('en', 'ko', 'de', 'tr')),
  translations jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.card_replies is
  'Replies written in Loom under a card (questions today). One row per message, in the language it was typed in.';

create index if not exists card_replies_card on public.card_replies (card_id, created_at);
create index if not exists card_replies_person_recent on public.card_replies (person_id, created_at desc);

alter table public.card_replies enable row level security;
-- readable like every other part of the record; written only through the RPC
create policy read_all on public.card_replies for select using (true);

-- ----------------------------------------------------------------------------
-- submit_card_reply: a signed-in member replies under a card
--   returns { id, created_at, author, studio, source_lang }
-- ----------------------------------------------------------------------------
create or replace function public.submit_card_reply(card_id text, body text, lang text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_studio text;
  v_person text;
  v_body   text;
  v_lang   text;
  v_row    card_replies;
begin
  v_studio := auth_studio();
  v_person := auth_person();
  if v_studio is null or v_person is null then
    raise exception 'sign in to reply';
  end if;

  if not exists (select 1 from knowledge_items ki where ki.id = submit_card_reply.card_id) then
    raise exception 'unknown card';
  end if;

  v_body := trim(coalesce(submit_card_reply.body, ''));
  if v_body = '' or length(v_body) > 2000 then
    raise exception 'invalid reply';
  end if;

  v_lang := coalesce(submit_card_reply.lang, 'en');
  if v_lang not in ('en', 'ko', 'de', 'tr') then
    v_lang := 'en';
  end if;
  -- same rule as the page and 0018: a Hangul letter means Korean
  if v_body ~ '[가-힣ᄀ-ᇿ㄰-㆏]' then
    v_lang := 'ko';
  end if;

  -- a person talking does not need more than this; a script does
  if (select count(*) from card_replies r
       where r.person_id = v_person and r.created_at > now() - interval '10 minutes') >= 20 then
    raise exception 'too many replies, try again in a few minutes';
  end if;

  insert into card_replies (card_id, person_id, studio_id, body, source_lang)
  values (submit_card_reply.card_id, v_person, v_studio, v_body, v_lang)
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'created_at', v_row.created_at,
    'author', (select p.name from persons p where p.id = v_person),
    'studio', v_studio,
    'source_lang', v_row.source_lang);
end;
$$;

revoke execute on function public.submit_card_reply(text, text, text) from public, anon;
grant execute on function public.submit_card_reply(text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- the read RPC carries each card's replies (return type change → drop first).
-- Body otherwise identical to 0015.
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
  replies            jsonb,
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
    -- oldest first, text in the reader's language where the sweep has one
    coalesce(
      (select jsonb_agg(jsonb_build_object(
                'id',          r.id,
                'author',      rp.name,
                'studio',      r.studio_id,
                'created_at',  r.created_at,
                'source_lang', r.source_lang,
                'text',        coalesce(r.translations ->> lang, r.body))
              order by r.created_at)
         from card_replies r
         join persons rp on rp.id = r.person_id
        where r.card_id = ki.id),
      '[]'::jsonb
    ),
    coalesce(ki.body -> lang, ki.body -> ki.source_lang, '{}'::jsonb)
  from knowledge_items ki
  left join persons doc on doc.id = ki.documented_by_id
  left join persons sh  on sh.id  = ki.shared_by_id
  left join persons kwp on kwp.id = ki.keywords_edited_by
  order by ki.created_at desc;
$$;

comment on function public.get_knowledge_items(text) is
  'Feed read path: one language block per row, with appliedBy, replies, names, image, attachments, origin and keyword-edit provenance folded in.';

grant execute on function public.get_knowledge_items(text) to anon, authenticated;
