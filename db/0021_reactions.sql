-- ============================================================================
-- Loom — 0021: reactions, their replies and emoji are kept, and shared.
--
-- The three pills on a card (try this / same problem / question), the line a
-- person adds to one, the replies under it and the five emoji all lived in
-- one browser's localStorage. Whoever left them saw them; nobody else ever
-- did, which made "Bengt at Whow hit the same thing" — the whole point of the
-- reaction column — impossible. This is where they live instead.
--
--   card_reactions   one per (card, person, kind): the pills are a toggle
--   reaction_replies one level deep, as the page has always drawn them
--   emoji_marks      on a card's body, a reaction or a reply — exactly one
--
-- Emoji are a person's now, not a studio's. The local version keyed them by
-- studio, so one person's heart was every colleague's heart and the tooltip
-- could only say "DoubleU". A name is what makes a quiet agreement mean
-- something.
--
-- Signed-in members only, like replies (0020): every row is a person.
--
-- Taking a reaction back does not take other people's words with it: a
-- reaction somebody else has replied to cannot be removed (the replies would
-- cascade). Its note can still be cleared.
-- ============================================================================

create table if not exists public.card_reactions (
  id         bigint generated always as identity primary key,
  card_id    text not null references knowledge_items(id) on delete cascade,
  person_id  text not null references persons(id),
  studio_id  text not null references studios(id),
  kind       text not null check (kind in ('tryThis', 'sameProblem', 'question')),
  note       text check (note is null or length(note) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (card_id, person_id, kind)
);

create table if not exists public.reaction_replies (
  id          bigint generated always as identity primary key,
  reaction_id bigint not null references card_reactions(id) on delete cascade,
  person_id   text not null references persons(id),
  studio_id   text not null references studios(id),
  body        text not null check (length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);

create table if not exists public.emoji_marks (
  id          bigint generated always as identity primary key,
  card_id     text   references knowledge_items(id) on delete cascade,
  reaction_id bigint references card_reactions(id)  on delete cascade,
  reply_id    bigint references reaction_replies(id) on delete cascade,
  emoji       text not null check (emoji in ('❤️', '👍', '👀', '🔥', '❓')),
  person_id   text not null references persons(id),
  studio_id   text not null references studios(id),
  created_at  timestamptz not null default now(),
  constraint emoji_one_target check (num_nonnulls(card_id, reaction_id, reply_id) = 1),
  unique nulls not distinct (card_id, reaction_id, reply_id, emoji, person_id)
);

create index if not exists card_reactions_card on public.card_reactions (card_id, created_at);
create index if not exists card_reactions_person_recent on public.card_reactions (person_id, created_at desc);
create index if not exists reaction_replies_reaction on public.reaction_replies (reaction_id, created_at);
create index if not exists reaction_replies_person_recent on public.reaction_replies (person_id, created_at desc);
create index if not exists emoji_marks_person_recent on public.emoji_marks (person_id, created_at desc);

alter table public.card_reactions   enable row level security;
alter table public.reaction_replies enable row level security;
alter table public.emoji_marks      enable row level security;
-- readable like the rest of the record; written only through the RPCs below
create policy read_all on public.card_reactions   for select using (true);
create policy read_all on public.reaction_replies for select using (true);
create policy read_all on public.emoji_marks      for select using (true);

-- ----------------------------------------------------------------------------
-- the one place a member is identified: (studio, person), or 'sign in'
-- ----------------------------------------------------------------------------
create or replace function public.member_gate()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_studio text := auth_studio();
  v_person text := auth_person();
begin
  if v_studio is null or v_person is null then
    raise exception 'sign in to react';
  end if;
  return jsonb_build_object('studio', v_studio, 'person', v_person);
end;
$$;

revoke execute on function public.member_gate() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- toggle_card_reaction: leave a pill, or take your own back
--   returns { added: bool, id }
-- ----------------------------------------------------------------------------
create or replace function public.toggle_card_reaction(card_id text, kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate jsonb := member_gate();
  v_person text := v_gate->>'person';
  v_id bigint;
begin
  if toggle_card_reaction.kind not in ('tryThis', 'sameProblem', 'question') then
    raise exception 'invalid kind';
  end if;
  if not exists (select 1 from knowledge_items ki where ki.id = toggle_card_reaction.card_id) then
    raise exception 'unknown card';
  end if;

  select r.id into v_id from card_reactions r
   where r.card_id = toggle_card_reaction.card_id
     and r.person_id = v_person
     and r.kind = toggle_card_reaction.kind;

  if found then
    if exists (select 1 from reaction_replies x
                where x.reaction_id = v_id and x.person_id <> v_person) then
      raise exception 'others replied';
    end if;
    delete from card_reactions r where r.id = v_id;
    return jsonb_build_object('added', false, 'id', v_id);
  end if;

  if (select count(*) from card_reactions r
       where r.person_id = v_person and r.created_at > now() - interval '10 minutes') >= 60 then
    raise exception 'too many, try again in a few minutes';
  end if;

  insert into card_reactions (card_id, person_id, studio_id, kind)
  values (toggle_card_reaction.card_id, v_person, v_gate->>'studio', toggle_card_reaction.kind)
  returning card_reactions.id into v_id;
  return jsonb_build_object('added', true, 'id', v_id);
end;
$$;

-- ----------------------------------------------------------------------------
-- set_reaction_note: the optional line on your own reaction ('' clears it)
-- ----------------------------------------------------------------------------
create or replace function public.set_reaction_note(reaction_id bigint, note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate jsonb := member_gate();
  v_note text := nullif(trim(coalesce(set_reaction_note.note, '')), '');
begin
  if v_note is not null and length(v_note) > 500 then
    raise exception 'note too long';
  end if;
  update card_reactions r set note = v_note
   where r.id = set_reaction_note.reaction_id and r.person_id = v_gate->>'person';
  if not found then
    raise exception 'not your reaction';
  end if;
  return jsonb_build_object('id', set_reaction_note.reaction_id, 'note', coalesce(v_note, ''));
end;
$$;

-- ----------------------------------------------------------------------------
-- submit_reaction_reply: anyone signed in answers a reaction, one level deep
-- ----------------------------------------------------------------------------
create or replace function public.submit_reaction_reply(reaction_id bigint, body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate jsonb := member_gate();
  v_person text := v_gate->>'person';
  v_body text := trim(coalesce(submit_reaction_reply.body, ''));
  v_id bigint;
begin
  if not exists (select 1 from card_reactions r where r.id = submit_reaction_reply.reaction_id) then
    raise exception 'unknown reaction';
  end if;
  if v_body = '' or length(v_body) > 1000 then
    raise exception 'invalid reply';
  end if;
  if (select count(*) from reaction_replies x
       where x.person_id = v_person and x.created_at > now() - interval '10 minutes') >= 20 then
    raise exception 'too many, try again in a few minutes';
  end if;

  insert into reaction_replies (reaction_id, person_id, studio_id, body)
  values (submit_reaction_reply.reaction_id, v_person, v_gate->>'studio', v_body)
  returning reaction_replies.id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

-- ----------------------------------------------------------------------------
-- toggle_emoji: target is 'card' | 'reaction' | 'reply'
--   returns { added: bool }
-- ----------------------------------------------------------------------------
create or replace function public.toggle_emoji(target text, target_id text, emoji text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate jsonb := member_gate();
  v_person text := v_gate->>'person';
  v_card text;
  v_reaction bigint;
  v_reply bigint;
  v_mark bigint;
begin
  if toggle_emoji.emoji not in ('❤️', '👍', '👀', '🔥', '❓') then
    raise exception 'invalid emoji';
  end if;

  if toggle_emoji.target = 'card' then
    select ki.id into v_card from knowledge_items ki where ki.id = toggle_emoji.target_id;
  elsif toggle_emoji.target in ('reaction', 'reply') and toggle_emoji.target_id ~ '^[0-9]{1,18}$' then
    if toggle_emoji.target = 'reaction' then
      select r.id into v_reaction from card_reactions r where r.id = toggle_emoji.target_id::bigint;
    else
      select x.id into v_reply from reaction_replies x where x.id = toggle_emoji.target_id::bigint;
    end if;
  end if;
  if v_card is null and v_reaction is null and v_reply is null then
    raise exception 'unknown target';
  end if;

  select m.id into v_mark from emoji_marks m
   where m.card_id is not distinct from v_card
     and m.reaction_id is not distinct from v_reaction
     and m.reply_id is not distinct from v_reply
     and m.emoji = toggle_emoji.emoji
     and m.person_id = v_person;

  if found then
    delete from emoji_marks m where m.id = v_mark;
    return jsonb_build_object('added', false);
  end if;

  if (select count(*) from emoji_marks m
       where m.person_id = v_person and m.created_at > now() - interval '10 minutes') >= 120 then
    raise exception 'too many, try again in a few minutes';
  end if;

  insert into emoji_marks (card_id, reaction_id, reply_id, emoji, person_id, studio_id)
  values (v_card, v_reaction, v_reply, toggle_emoji.emoji, v_person, v_gate->>'studio');
  return jsonb_build_object('added', true);
end;
$$;

revoke execute on function public.toggle_card_reaction(text, text) from public, anon;
revoke execute on function public.set_reaction_note(bigint, text) from public, anon;
revoke execute on function public.submit_reaction_reply(bigint, text) from public, anon;
revoke execute on function public.toggle_emoji(text, text, text) from public, anon;
grant execute on function public.toggle_card_reaction(text, text) to authenticated;
grant execute on function public.set_reaction_note(bigint, text) to authenticated;
grant execute on function public.submit_reaction_reply(bigint, text) to authenticated;
grant execute on function public.toggle_emoji(text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- get_reactions: the whole reaction layer in the shape the page draws
--   { reactions: [{ id, cardId, kind, person, author, studio, note, at,
--                   emoji: { "👍": [{person, name, studio}] },
--                   replies: [{ id, person, author, studio, text, at, emoji }] }],
--     bodyEmoji: { <card id>: { "👍": [{person, name, studio}] } } }
-- One request at boot and after each write. At this size that is cheaper
-- than keeping a client-side copy in step; past a few thousand rows it
-- becomes per card.
-- ----------------------------------------------------------------------------
create or replace function public.get_reactions()
returns jsonb
language sql
stable
set search_path = public
as $$
  with who as (
    select e.card_id, e.reaction_id, e.reply_id, e.emoji,
           jsonb_agg(jsonb_build_object('person', e.person_id, 'name', p.name, 'studio', e.studio_id)
                     order by e.created_at) as people
      from emoji_marks e
      join persons p on p.id = e.person_id
     group by e.card_id, e.reaction_id, e.reply_id, e.emoji
  ),
  marks as (
    select w.card_id, w.reaction_id, w.reply_id, jsonb_object_agg(w.emoji, w.people) as map
      from who w
     group by w.card_id, w.reaction_id, w.reply_id
  )
  select jsonb_build_object(
    'reactions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',      r.id,
               'cardId',  r.card_id,
               'kind',    r.kind,
               'person',  r.person_id,
               'author',  p.name,
               'studio',  r.studio_id,
               'note',    coalesce(r.note, ''),
               'at',      r.created_at,
               'emoji',   coalesce((select m.map from marks m where m.reaction_id = r.id), '{}'::jsonb),
               'replies', coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'id',     x.id,
                           'person', x.person_id,
                           'author', xp.name,
                           'studio', x.studio_id,
                           'text',   x.body,
                           'at',     x.created_at,
                           'emoji',  coalesce((select m.map from marks m where m.reply_id = x.id), '{}'::jsonb))
                         order by x.created_at)
                    from reaction_replies x
                    join persons xp on xp.id = x.person_id
                   where x.reaction_id = r.id), '[]'::jsonb))
             order by r.created_at)
        from card_reactions r
        join persons p on p.id = r.person_id), '[]'::jsonb),
    'bodyEmoji', coalesce((
      select jsonb_object_agg(m.card_id, m.map) from marks m where m.card_id is not null), '{}'::jsonb)
  );
$$;

grant execute on function public.get_reactions() to anon, authenticated;
