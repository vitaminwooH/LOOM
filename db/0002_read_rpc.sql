-- ============================================================================
-- Loom — Shared Knowledge Model v0.1
-- 0002: read RPC for the feed.
--
-- Why an RPC instead of a plain table select:
--   - body holds four language blocks; the feed needs exactly one. PostgREST
--     cannot project body->{lang} with a per-row fallback to body->{source_lang},
--     so the coalesce lives here. One resolved block per row = the lightest
--     payload the design's egress rule allows.
--   - appliedBy (distinct studios from applications) and the documented_by /
--     shared_by display names are folded in server-side, so the client gets
--     feed-ready rows in a single request instead of three.
--
-- Security: SQL, STABLE, security invoker (the default) — anon calls run
-- under the read_all RLS policies from 0001 and can still write nothing.
-- ============================================================================

create or replace function public.get_knowledge_items(lang text default 'en')
returns table (
  id             text,
  type           text,
  studio         text,        -- origin_studio_id (originated_from)
  author         text,        -- documented_by display name
  shared_by_name text,        -- shared_by display name (null when unset)
  keywords       text[],
  related_to     text[],
  derived_from   text,
  relation_type  text,
  relation_note  text,
  status         text,
  asked_to       text,
  image          jsonb,
  link           text,
  source_lang    text,
  demo_age       jsonb,
  created_at     timestamptz,
  conversation   jsonb,       -- language-invariant skeleton
  applied_by     text[],      -- distinct studios from applications
  txt            jsonb        -- body->{lang}, falling back to body->{source_lang}
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
    ki.related_to,
    ki.derived_from_id,
    ki.relation_type,
    ki.relation_note,
    ki.status,
    ki.asked_to_studio_id,
    ki.image,
    ki.link,
    ki.source_lang,
    ki.demo_age,
    ki.created_at,
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
  order by ki.created_at desc;
$$;

comment on function public.get_knowledge_items(text) is
  'Feed read path: knowledge_items resolved to one language block per row, with appliedBy and author names folded in. Anon-callable; RLS applies.';
