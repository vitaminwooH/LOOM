-- ============================================================================
-- Loom — Shared Knowledge Model v0.1
-- 0004: write path — shared code + security definer RPC.
--
-- The tables stay write-locked for anon (RLS, no write policies). The ONLY
-- way in is submit_card(payload, code): it checks the code against a private
-- table, validates the payload inside the function, and inserts under the
-- function owner's rights. Rotating/revoking access = updating write_codes.
--
-- The actual code VALUE is never in this file or in the repository — it is
-- inserted separately, by hand, in the SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- write_codes: private. RLS on with NO policies and explicit revokes, so the
-- anon/authenticated roles cannot see that rows exist, let alone read them.
-- Only definer functions (and the dashboard) can look inside.
-- ----------------------------------------------------------------------------
create table write_codes (
  code       text primary key,
  label      text,                              -- who/what this code is for
  active     boolean not null default true,     -- flip off to revoke instantly
  created_at timestamptz not null default now()
);

alter table write_codes enable row level security;
revoke all on table write_codes from anon, authenticated;

comment on table write_codes is
  'Shared write codes for submit_card. Values live only in this table — never in the repo.';

-- ----------------------------------------------------------------------------
-- submit_card(payload, code)
--
-- payload shape (built by data.js from the share form):
--   {
--     "id":          "shared-…",             -- client-generated slug
--     "type":        "update|project|experiment|question",
--     "studio":      "doubleu|whow|paxie",   -- the sharer's studio
--     "source_lang": "en|ko|de|tr",          -- language it was written in
--     "keywords":    ["…", …],               -- ≤10, each ≤40 chars
--     "asked_to":    "whow",                 -- questions only, optional
--     "link":        "https://…",            -- updates only, optional
--     "text":        { "title": …, "summary": …, <type fields> }
--   }
--
-- body is stored as ONE language block under source_lang; the read RPC's
-- coalesce serves it to every other language until a translation exists.
--
-- documented_by: there is no signed-in person yet (v0.1), so the card is
-- recorded against the studio's team person (du-team / wh-team) — the same
-- convention the seed uses for c16/c17. Real Person attribution arrives
-- with auth in v0.2.
-- ----------------------------------------------------------------------------
create or replace function public.submit_card(payload jsonb, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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
  -- 1. the gate: wrong or inactive code fails before anything is looked at
  if code is null
     or not exists (select 1 from write_codes w where w.code = submit_card.code and w.active) then
    raise exception 'invalid code';
  end if;

  -- 2. envelope checks
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

  v_lang := coalesce(payload->>'source_lang', 'en');
  if v_lang not in ('en','ko','de','tr') then
    raise exception 'invalid language';
  end if;

  -- 3. text block: whitelist per type (FIELD_SETS + next/openQuestion),
  --    strings only, each capped — anything else is silently dropped
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

  -- 4. keywords: up to 10, each trimmed to 40 chars, empties dropped
  select coalesce(array_agg(left(x, 40)), '{}') into v_keywords
  from (
    select jsonb_array_elements_text(
      case when jsonb_typeof(payload->'keywords') = 'array'
           then payload->'keywords' else '[]'::jsonb end) as x
    limit 10
  ) t
  where length(trim(x)) > 0;

  -- 5. documented_by: the studio's team person (see header note)
  select p.id, p.name into v_author_id, v_author_name
  from persons p
  where p.studio_id = v_studio and p.id in ('du-team','wh-team')
  limit 1;

  -- 6. question extras: open status, addressee, and the opening post —
  --    skeleton on the card, text in the language block, exactly the split
  --    the seed conversations use. justNow mirrors what the client's own
  --    localStorage entry stores today; it becomes a real timestamp when
  --    messages become an entity (v0.2).
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

  -- 7. link: updates only, http(s) only (same rule as the client normalizer)
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

comment on function public.submit_card(jsonb, text) is
  'The only write path for anon: shared-code gated, validating insert into knowledge_items.';

-- Explicit grants: definer functions should say out loud who may call them.
revoke execute on function public.submit_card(jsonb, text) from public;
grant execute on function public.submit_card(jsonb, text) to anon, authenticated;
