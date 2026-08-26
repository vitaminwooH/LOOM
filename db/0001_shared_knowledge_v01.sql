-- ============================================================================
-- Loom — Shared Knowledge Model v0.1
-- 0001: initial schema (studios, persons, projects, knowledge_items,
--       applications) + RLS: read public / write locked.
--
-- Design decisions (approved 2026-08-26):
--   - All PKs are text slugs so existing card ids ('c1'…'x3'), studio keys
--     ('doubleu') and roster ids ('du-minwoo') survive backfill verbatim.
--   - relation_note is a single text column (derivedNote is language-invariant
--     in the current data). Revisit if lineage notes ever need translation.
--   - demo_age keeps the staged relative times of seeded demo cards; real
--     cards leave it null and derive age from created_at.
--   - applications.project_id is nullable: one row can say "applied by studio
--     X, project unknown" (the current appliedBy data), and gets the project
--     filled in later without a schema change.
--   - shared_by is a single column; when two people shared (e.g. the Aug 14
--     canvas entry, Bengt & Felix), the case author goes here and the second
--     person is named in relation_note or the body. Promote to a join table
--     in v0.2 if plural sharers become common.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- studios
-- ----------------------------------------------------------------------------
create table studios (
  id         text primary key,               -- 'doubleu' | 'whow' | 'paxie'
  name       text not null,                  -- 'DoubleU'
  color      text not null,                  -- '#378ADD'
  logo_path  text,                           -- GitHub Pages relative path
  enabled    boolean not null default true   -- Paxie: in data, hidden on screen
);

comment on table studios is 'Shared Knowledge Model v0.1 — Studio entity';

-- ----------------------------------------------------------------------------
-- persons
-- ----------------------------------------------------------------------------
create table persons (
  id         text primary key,               -- 'du-minwoo', 'wh-bengt', …
  studio_id  text not null references studios(id),
  name       text not null,
  -- Designers (roster) screen fields — null for card-author-only persons.
  -- Real colleagues keep name only; roles/contacts are never invented.
  role_key   text,
  photo_path text,
  photo_pos  jsonb,                          -- { "x": 53, "y": 20 }
  working_on text,
  can_help   text,
  links      jsonb not null default '{}'::jsonb,
  on_roster  boolean not null default false
);

comment on table persons is 'Shared Knowledge Model v0.1 — Person entity';

-- ----------------------------------------------------------------------------
-- projects  (belongs_to = studio_id column)
-- ----------------------------------------------------------------------------
create table projects (
  id         text primary key,               -- slug, e.g. 'whow-jackpot-social-generator'
  studio_id  text not null references studios(id),  -- belongs_to
  name       text not null,
  note       text
);

comment on table projects is 'Shared Knowledge Model v0.1 — Project entity; studio_id is the belongs_to relation';

-- ----------------------------------------------------------------------------
-- knowledge_items
--   originated_from → origin_studio_id
--   shared_by       → shared_by_id
--   documented_by   → documented_by_id
--   derived_from    → derived_from_id + relation_type + relation_note
-- ----------------------------------------------------------------------------
create table knowledge_items (
  id                 text primary key,
  type               text not null check (type in ('update','project','experiment','question')),
  origin_studio_id   text not null references studios(id),
  shared_by_id       text references persons(id),
  documented_by_id   text references persons(id),

  -- lineage: relation keys stored exactly as the client code uses them
  derived_from_id    text references knowledge_items(id),
  relation_type      text check (relation_type in
                       ('builtOn','inspiredBy','appliedFrom','continuedFrom','solvedThrough')),
  relation_note      text,
  constraint derived_needs_relation
    check (derived_from_id is null or relation_type is not null),

  -- v0.1 attributes (not entities)
  keywords           text[] not null default '{}',   -- drives Threads
  related_to         text[] not null default '{}',   -- loose links, outside the model
  status             text check (status in ('open','discussion','resolved')),
  asked_to_studio_id text references studios(id),

  -- multilingual body: { "en": {title, summary, …}, "ko": {…}, "de": {…}, "tr": {…} }
  body               jsonb not null default '{}'::jsonb,
  source_lang        text not null default 'en',

  -- language-invariant conversation skeleton (speaker/studio per message);
  -- message texts live in body.<lang>.conversation, index-aligned
  conversation       jsonb,

  image              jsonb,                  -- { "path", "fit", "bg", "focal" } — path only, bytes stay on GitHub Pages
  link               text,                   -- update-type external link

  created_at         timestamptz not null default now(),
  demo_age           jsonb                   -- seeded cards only: { "value": 3, "unit": "day" }
);

comment on table knowledge_items is 'Shared Knowledge Model v0.1 — KnowledgeItem entity (UI name: Knowledge Card)';

create index ki_keywords_gin on knowledge_items using gin (keywords);
create index ki_created_at   on knowledge_items (created_at desc);
create index ki_derived_from on knowledge_items (derived_from_id);

-- ----------------------------------------------------------------------------
-- applications  (applied_to, M:N; nullable project_id absorbs the appliedBy gap)
-- ----------------------------------------------------------------------------
create table applications (
  id                 bigint generated always as identity primary key,
  knowledge_item_id  text not null references knowledge_items(id) on delete cascade,
  studio_id          text not null references studios(id),  -- who applied it (always known)
  project_id         text references projects(id),          -- which project (null = unknown yet)
  note               text,
  created_at         timestamptz not null default now(),
  -- nulls not distinct: only one "project unknown" row per (item, studio)
  unique nulls not distinct (knowledge_item_id, studio_id, project_id)
);

comment on table applications is 'Shared Knowledge Model v0.1 — applied_to relation; project_id null means "applied by this studio, project not yet recorded"';

create index app_item on applications (knowledge_item_id);

-- ----------------------------------------------------------------------------
-- RLS: read public / write locked.
-- No insert/update/delete policies exist, so RLS denies all writes for anon.
-- Writes happen only via the service role (backfill) until the shared-code
-- RPC is introduced in a later step.
-- ----------------------------------------------------------------------------
alter table studios         enable row level security;
alter table persons         enable row level security;
alter table projects        enable row level security;
alter table knowledge_items enable row level security;
alter table applications    enable row level security;

create policy read_all on studios         for select using (true);
create policy read_all on persons         for select using (true);
create policy read_all on projects        for select using (true);
create policy read_all on knowledge_items for select using (true);
create policy read_all on applications    for select using (true);
