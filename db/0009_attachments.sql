-- ============================================================================
-- Loom — 0009: attachment storage + PDF covers (canvas-sync v5).
--
-- 1) storage bucket `attachments`: public read (files are served from the
--    /object/public/ path with no auth), NO write policies — anon cannot
--    upload; the Edge Function writes with the service role. 20MB cap is
--    enforced at the bucket on top of the function's own check.
-- 2) knowledge_items.attachments jsonb — attachments are language-invariant
--    (like image), so they live on the card, not in the body blocks. The
--    body keeps the author's raw 📎 strings; this column carries the
--    resolved files: [{label, url, bytes, mime, slackId}] (label-only for
--    non-file lines such as Figma links).
-- 3) get_knowledge_items returns the new column (return type change → drop
--    first), and canvas_sync_upsert writes image + attachments.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', true, 20971520)
on conflict (id) do nothing;

alter table knowledge_items add column if not exists attachments jsonb;

-- ----------------------------------------------------------------------------
-- read RPC: same as 0002 plus the attachments column
-- ----------------------------------------------------------------------------
drop function if exists public.get_knowledge_items(text);

create or replace function public.get_knowledge_items(lang text default 'en')
returns table (
  id             text,
  type           text,
  studio         text,
  author         text,
  shared_by_name text,
  keywords       text[],
  related_to     text[],
  derived_from   text,
  relation_type  text,
  relation_note  text,
  status         text,
  asked_to       text,
  image          jsonb,
  attachments    jsonb,
  link           text,
  source_lang    text,
  demo_age       jsonb,
  created_at     timestamptz,
  conversation   jsonb,
  applied_by     text[],
  txt            jsonb
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
    ki.attachments,
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
  'Feed read path: knowledge_items resolved to one language block per row, with appliedBy, author names, image and attachments folded in. Anon-callable; RLS applies.';

-- ----------------------------------------------------------------------------
-- sync RPC: 0007 plus image + attachments in both insert and update
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
        image              = card->'image',
        attachments        = card->'attachments',
        created_at         = coalesce((card->>'created_at')::timestamptz, created_at)
      where id = v_id;
      v_updated := v_updated || v_id;
    else
      insert into knowledge_items
        (id, type, origin_studio_id, shared_by_id, documented_by_id,
         derived_from_id, relation_type, keywords, status,
         body, source_lang, conversation, image, attachments, created_at)
      values
        (v_id, card->>'type', card->>'studio',
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
