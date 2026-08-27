-- ============================================================================
-- Loom — 0011: roster ordering (drag-to-reorder in the Designers editor).
--
-- persons.sort_order: position within the studio's roster, 0-based. The read
-- query orders by sort_order (nulls last, then id), so a person created by
-- submit_roster_edit — which never sets sort_order — lands at the end until
-- somebody drags them somewhere.
--
-- submit_roster_order(studio, ids, code): one drag = one call = ONE
-- transaction. The ids array must be exactly the studio's current roster
-- (every on_roster person, no extras, no duplicates) so a stale or partial
-- client can never interleave a half-order into the table. Gated by the same
-- shared write code as everything else, checked first.
--
-- Backfill: the order the roster was curated in (the localStorage export the
-- roster was migrated from): Minwoo, Su-A, Minji / Bengt, Felix, Mira.
-- ============================================================================

alter table persons add column if not exists sort_order integer;

update persons set sort_order = v.ord
from (values
  ('du-minwoo', 0), ('du-sua', 1), ('du-minji', 2),
  ('wh-bengt', 0), ('wh-felix', 1), ('wh-mira', 2)
) as v(id, ord)
where persons.id = v.id;

create or replace function public.submit_roster_order(studio text, ids jsonb, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    text;
  v_count integer;
  n       integer;
  i       integer := 0;
begin
  -- 1. the gate, before anything is looked at
  if code is null
     or not exists (select 1 from write_codes w where w.code = submit_roster_order.code and w.active) then
    raise exception 'invalid code';
  end if;

  if not exists (select 1 from studios s where s.id = studio) then
    raise exception 'invalid studio';
  end if;
  if ids is null or jsonb_typeof(ids) <> 'array' then
    raise exception 'invalid ids';
  end if;
  n := jsonb_array_length(ids);
  if n < 1 or n > 50 then
    raise exception 'invalid ids';
  end if;
  if (select count(distinct x) from jsonb_array_elements_text(ids) x) <> n then
    raise exception 'duplicate ids';
  end if;

  -- the array must be the WHOLE current roster of this studio — a partial
  -- list would interleave old and new positions
  select count(*) into v_count from persons p
  where p.studio_id = submit_roster_order.studio and p.on_roster;
  if v_count <> n then
    raise exception 'order must include the whole roster (% given, % on it)', n, v_count;
  end if;

  for v_id in select jsonb_array_elements_text(ids) loop
    if not exists (select 1 from persons p
                   where p.id = v_id and p.studio_id = submit_roster_order.studio and p.on_roster) then
      raise exception 'not on this roster: %', v_id;
    end if;
    update persons set sort_order = i where id = v_id;
    i := i + 1;
  end loop;

  return jsonb_build_object('ok', true, 'count', n);
end;
$$;

comment on function public.submit_roster_order(text, jsonb, text) is
  'Drag-to-reorder save: the studio''s whole roster in its new order, one transaction, shared-code gated.';

revoke execute on function public.submit_roster_order(text, jsonb, text) from public;
grant execute on function public.submit_roster_order(text, jsonb, text) to anon, authenticated;
