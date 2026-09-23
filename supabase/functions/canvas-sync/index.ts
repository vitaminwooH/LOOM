/* ============================================================================
   Loom — canvas-sync Edge Function (stage 2: Canvas as single source of truth).

   Reads the Slack channel canvas, parses its entries, maps them to Loom
   cards, and — in sync mode — writes them through the canvas_sync_upsert RPC
   (db/0005). Two modes, chosen in the POST body:

     {}                          → dry run (DEFAULT): full pipeline including
                                   field mapping and lineage resolution, but
                                   nothing is written. The response shows
                                   exactly what sync would do.
     { "mode": "sync" }          → append-only sync: insert new entries, skip
                                   ids that already exist (ids derive from
                                   date + title, so that IS the dedup rule).
     { "mode": "sync",
       "purge": true }           → ONE-TIME cutover: the RPC deletes every
                                   knowledge_item and inserts the canvas cards
                                   in a single transaction (no empty-table
                                   moment is ever observable).

   Canvas entry template (one entry per block):

     [Aug 14, 2026] Title of the entry (Whow · Bengt Ott)
     Type: Project
     What / How / Learned / Next / Open question / Related / Relation / 📎

   Attribution rule (approved): the (Studio · Name) bracket names the OWNER
   of the knowledge → shared_by; a "(logged by X …)" footnote names who typed
   it into the canvas → documented_by (falls back to the bracket person).

   Secrets (Dashboard → Edge Functions → Secrets; never in this repo):
     SLACK_BOT_TOKEN, SLACK_CANVAS_ID, CANVAS_SYNC_SECRET, GEMINI_API_KEY
   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform and
   used only to call the sync RPC (and to read existing card titles for
   lineage resolution) — the browser-side RLS lockdown is untouched.

   v3 — Gemini enrichment (keywords + ko/de/tr translations):
   Canvas authors only write; keywords and translations are generated at
   sync time, one Gemini call per card, processed SEQUENTIALLY so a keyword
   chosen for an earlier card is already in the vocabulary offered to the
   next one (Threads exists so both studios end up on the same words).
   Every Gemini failure is isolated and reported — a dead Gemini can cost
   keywords and translations, never the sync itself. Dry runs call Gemini
   too, so quality can be checked before anything is written.
   { "mode": "sync", "refresh": true } updates existing canvas cards in
   place (deterministic ids make this safe) — the retro-fill path.
   ============================================================================ */

import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';

const SLACK_API = 'https://slack.com/api';

/* ---- template vocabulary -------------------------------------------------- */
const FIELD_LABELS = [
  'type', 'what', 'how', 'learned', 'next', 'open question', 'related', 'relation',
] as const;
type FieldLabel = (typeof FIELD_LABELS)[number];

const FIELD_TO_CARD: Record<FieldLabel, string> = {
  'type': 'type', 'what': 'what', 'how': 'how', 'learned': 'learned',
  'next': 'next', 'open question': 'openQuestion',
  'related': 'related', 'relation': 'relation',
};

const TYPES = ['update', 'project', 'experiment', 'question'];

const STUDIO_ALIASES: Record<string, string> = {
  'doubleu': 'doubleu', 'doubleu games': 'doubleu', 'double u': 'doubleu',
  'whow': 'whow', 'whow games': 'whow',
  'paxie': 'paxie',
};

/* Canvas display names → persons.id for the people we already know.
   Unknown names are created by the RPC (name + studio only, off-roster). */
const NAME_ALIASES: Record<string, string> = {
  'miles': 'du-minwoo', 'minwoo': 'du-minwoo', 'minwoo heo': 'du-minwoo',
  'bengt': 'wh-bengt', 'bengt ott': 'wh-bengt',
  'felix': 'wh-felix', 'felix heitmann': 'wh-felix',
};

/* Per-entry shared_by overrides, keyed by normalised title.
   Aug 14: the header says "Bengt & Felix", but the case and the rules behind
   it are Felix's — the bracket names the knowledge's owner (approved). */
const SHARED_BY_TITLE_OVERRIDES: Record<string, string> = {
  'multi-format motion adaptation - a case and the rules behind it': 'wh-felix',
};

/* Canvas Relation labels → relation_type keys the DB check constraint knows. */
const RELATION_LABELS: Record<string, string> = {
  'built on': 'builtOn', 'inspired by': 'inspiredBy', 'applied from': 'appliedFrom',
  'continued from': 'continuedFrom', 'solved through': 'solvedThrough',
};

/* ---- HTML → plain text lines ---------------------------------------------- */
function htmlToLines(html: string): string[] {
  let s = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|blockquote|pre|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  return s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/* ---- entry parsing --------------------------------------------------------- */
const HEADER_RE = /^\[(.+?)\]\s*(.+?)\s*\((.+?)\s*[·•|,]\s*(.+?)\)\s*$/;
const LABEL_RE = new RegExp(
  '^(' + FIELD_LABELS.map((l) => l.replace(' ', '\\s+')).join('|') + ')\\s*[:：\\-–—]?\\s*(.*)$',
  'i',
);
// "(logged by Miles based on Bengt and Felix's notes — …)" → documenter name
const LOGGED_BY_RE = /^\(logged by\s+(.+?)(?:\s+based\s+on\b.*)?\)\s*$/i;

interface ParsedEntry {
  date: string;
  title: string;
  studioRaw: string;
  studio: string | null;
  author: string;
  isTemplate: boolean;
  loggedBy: string | null; // "(logged by X …)" footnote, when present
  type: string | null;
  fields: Record<string, string>;
  attachments: string[];
  warnings: string[];
}

interface UnparsableEntry { reason: string; raw: string; }

function parseEntries(lines: string[]) {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  const preamble: string[] = [];
  for (const line of lines) {
    if (line.startsWith('[')) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) blocks.push(current);

  const parsed: ParsedEntry[] = [];
  const unparsable: UnparsableEntry[] = [];

  for (const block of blocks) {
    const header = block[0].match(HEADER_RE);
    if (!header) {
      unparsable.push({
        reason: 'header does not match "[date] title (Studio · Name)"',
        raw: block.join('\n').slice(0, 1200),
      });
      continue;
    }

    const entry: ParsedEntry = {
      date: header[1].trim(),
      title: header[2].trim(),
      studioRaw: header[3].trim(),
      studio: STUDIO_ALIASES[header[3].trim().toLowerCase()] ?? null,
      author: header[4].trim(),
      isTemplate: header[3].trim() === 'Studio' && header[4].trim() === 'Name',
      loggedBy: null,
      type: null,
      fields: {},
      attachments: [],
      warnings: [],
    };

    let currentField: string | null = null;
    for (const line of block.slice(1)) {
      // 📎 or :paperclip: — the export contains both forms
      const attach = line.match(/^(?:📎|:paperclip:)\s*(.*)$/);
      if (attach) {
        if (attach[1]) entry.attachments.push(attach[1].trim());
        currentField = null;
        continue;
      }
      const logged = line.match(LOGGED_BY_RE);
      if (logged) {
        entry.loggedBy = logged[1].trim();
        currentField = null;
        continue;
      }
      const m = line.match(LABEL_RE);
      if (m) {
        const label = m[1].toLowerCase().replace(/\s+/g, ' ') as FieldLabel;
        currentField = FIELD_TO_CARD[label];
        entry.fields[currentField] = m[2].trim();
      } else if (currentField) {
        entry.fields[currentField] = (entry.fields[currentField] + '\n' + line).trim();
      } else {
        entry.warnings.push('line before any field label: "' + line.slice(0, 120) + '"');
      }
    }

    const typeRaw = (entry.fields['type'] || '').toLowerCase().trim();
    delete entry.fields['type'];
    if (TYPES.includes(typeRaw)) entry.type = typeRaw;
    else if (typeRaw) entry.warnings.push('unknown type: "' + typeRaw + '"');
    else entry.warnings.push('no Type field');

    if (!entry.studio) entry.warnings.push('unknown studio: "' + entry.studioRaw + '"');
    if (Object.keys(entry.fields).length === 0) {
      unparsable.push({
        reason: 'header matched but no template fields found',
        raw: block.join('\n').slice(0, 1200),
      });
      continue;
    }

    parsed.push(entry);
  }

  return { preamble: preamble.join('\n'), parsed, unparsable };
}

/* ---- entry → Loom card ------------------------------------------------------
   Field mapping (approved design):
     project:    What→made, How→solved, Learned→borrow
     experiment: What→goal, How→method, Learned→learned
     update:     What+How+Learned → note (paragraphs; Loom updates are one field)
     question:   What→blocked, How(+Learned)→triedSoFar
   next / openQuestion pass through on every type. */

function slugify(s: string, max: number): string {
  const slug = s.toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/, '');
}

function normTitle(s: string): string {
  return s.toLowerCase()
    .replace(/’/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
}

function mapFields(type: string, f: Record<string, string>): Record<string, string> {
  const joined = (...parts: (string | undefined)[]) =>
    parts.filter((p) => p && p.trim()).join('\n\n');
  let out: Record<string, string>;
  if (type === 'project') out = { made: f.what, solved: f.how, borrow: f.learned };
  else if (type === 'experiment') out = { goal: f.what, method: f.how, learned: f.learned };
  else if (type === 'update') out = { note: joined(f.what, f.how, f.learned) };
  else out = { blocked: f.what, triedSoFar: joined(f.how, f.learned) };
  if (f.next) out.next = f.next;
  if (f.openQuestion) out.openQuestion = f.openQuestion;
  for (const k of Object.keys(out)) {
    if (!out[k] || !out[k].trim()) delete out[k];
  }
  return out;
}

// posters read the last filled body field — same philosophy as the share form
const SUMMARY_ORDER: Record<string, string[]> = {
  project: ['made', 'solved', 'borrow'],
  experiment: ['goal', 'method', 'learned'],
  update: ['note'],
  question: ['blocked', 'triedSoFar'],
};

function summarize(type: string, body: Record<string, string>, title: string): string {
  const keys = SUMMARY_ORDER[type] || [];
  for (let i = keys.length - 1; i >= 0; i--) {
    const v = (body[keys[i]] || '').trim();
    if (v) return v.length > 100 ? v.slice(0, 99).trim() + '…' : v.split('\n')[0];
  }
  return title;
}

interface PersonRef { id?: string; name?: string; studio?: string; }

function resolvePersonRef(name: string, studio: string): PersonRef {
  const alias = NAME_ALIASES[name.toLowerCase()];
  return alias ? { id: alias } : { name, studio };
}

interface AttachmentEntry {
  label: string;      // author's text or the real filename
  url?: string;       // public Storage URL (absent: label-only line or >20MB)
  bytes?: number;
  mime?: string;
  slackId?: string;
}

interface CardRow {
  id: string;
  type: string;
  studio: string;
  status: string | null;
  keywords: string[];
  shared_by: PersonRef | null;
  documented_by: PersonRef | null;
  derived_from: string | null;
  relation_type: string | null;
  body: Record<string, unknown>;
  source_lang: string;
  conversation: unknown[] | null;
  image: Record<string, unknown> | null;        // PDF cover, filled by storage pass
  attachments: AttachmentEntry[] | null;        // resolved files, filled by storage pass
  created_at: string;
  // carried alongside for the report / lineage pass, not inserted as-is
  title: string;
  relatedRaw: string | null;
  relationRaw: string | null;
}

function buildCards(entries: ParsedEntry[]) {
  const excluded: { title: string; reason: string }[] = [];
  const personNotes: string[] = [];
  const cards: CardRow[] = [];
  const total = entries.length;

  entries.forEach((e, index) => {
    if (e.isTemplate) { excluded.push({ title: e.title, reason: 'blank template' }); return; }
    if (!e.studio) { excluded.push({ title: e.title, reason: 'unknown studio: ' + e.studioRaw }); return; }
    if (!e.type) { excluded.push({ title: e.title, reason: 'missing/unknown Type' }); return; }
    if (!(e.fields.what || '').trim()) { excluded.push({ title: e.title, reason: 'empty What' }); return; }

    const dateMs = Date.parse(e.date);
    if (Number.isNaN(dateMs)) { excluded.push({ title: e.title, reason: 'unparsable date: ' + e.date }); return; }
    // noon UTC + a minute per canvas position, so same-day entries keep their
    // canvas order (the canvas lists newest first; earlier index = newer)
    const created = new Date(dateMs + 12 * 3600_000 + (total - index) * 60_000);

    const id = 'cv-' +
      new Date(dateMs).toISOString().slice(0, 10).replace(/-/g, '') +
      '-' + slugify(e.title, 40);

    // shared_by: the bracket person (first name when several are listed)
    const authors = e.author.split(/\s*(?:&|,|\band\b)\s*/i).map((a) => a.trim()).filter(Boolean);
    const overrideId = SHARED_BY_TITLE_OVERRIDES[normTitle(e.title)];
    const sharedBy: PersonRef = overrideId
      ? { id: overrideId }
      : resolvePersonRef(authors[0] || e.author, e.studio);
    if (authors.length > 1) {
      personNotes.push(id + ': multiple sharers "' + e.author + '" — recorded ' +
        JSON.stringify(sharedBy) + '; the others stay in the body text');
    }

    // documented_by: the logged-by footnote, else the bracket person.
    // A logged-by name may belong to the OTHER studio (Aug 14: Miles logs a
    // Whow entry), so only alias-known names resolve; unknown ones stay null
    // rather than creating a person under the wrong studio.
    let documentedBy: PersonRef | null;
    if (e.loggedBy) {
      const alias = NAME_ALIASES[e.loggedBy.toLowerCase()];
      documentedBy = alias ? { id: alias } : null;
      if (!documentedBy) {
        personNotes.push(id + ': documenter "' + e.loggedBy +
          '" not in the alias map — documented_by left null (add an alias to fix)');
      }
    } else {
      documentedBy = sharedBy;
    }

    const body = mapFields(e.type, e.fields);
    const bodyBlock: Record<string, unknown> = {
      title: e.title,
      summary: summarize(e.type, body, e.title),
      ...body,
    };
    if (e.attachments.length) bodyBlock.attachments = e.attachments;

    let conversation: unknown[] | null = null;
    if (e.type === 'question') {
      const daysAgo = Math.max(0, Math.round((Date.now() - created.getTime()) / 86_400_000));
      conversation = [{
        author: authors[0] || e.author, studio: e.studio,
        timeValue: daysAgo, timeUnit: 'day',
      }];
      bodyBlock.conversation = [body.blocked || e.title];
    }

    cards.push({
      id, type: e.type, studio: e.studio,
      status: e.type === 'question' ? 'open' : null,
      keywords: [], // the canvas template has no Keywords field (yet)
      shared_by: sharedBy,
      documented_by: documentedBy,
      derived_from: null, relation_type: null, // filled by the lineage pass
      body: { en: bodyBlock }, source_lang: 'en',
      conversation,
      image: null, attachments: null,          // filled by the storage pass
      created_at: created.toISOString(),
      title: e.title,
      relatedRaw: (e.fields.related || '').trim() || null,
      relationRaw: (e.fields.relation || '').trim() || null,
    });
  });

  return { cards, excluded, personNotes };
}

/* Related (a title) → derived_from (an id), against this batch AND the cards
   already in the DB. Unresolved links are reported, never silently dropped. */
function resolveLineage(cards: CardRow[], existing: { id: string; title: string | null }[]) {
  const byTitle = new Map<string, string>();
  for (const row of existing) if (row.title) byTitle.set(normTitle(row.title), row.id);
  for (const c of cards) byTitle.set(normTitle(c.title), c.id); // batch overrides on tie

  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const c of cards) {
    if (!c.relatedRaw) {
      if (c.relationRaw) unresolved.push(c.id + ': Relation "' + c.relationRaw + '" without Related');
      continue;
    }
    const targetId = byTitle.get(normTitle(c.relatedRaw));
    const relType = RELATION_LABELS[(c.relationRaw || '').toLowerCase().trim()] ?? null;
    if (!targetId) {
      unresolved.push(c.id + ': Related title not found: "' + c.relatedRaw + '"');
      continue;
    }
    if (!relType) {
      unresolved.push(c.id + ': Related resolved but Relation label unknown: "' + (c.relationRaw || '(none)') + '"');
      continue;
    }
    if (targetId === c.id) {
      unresolved.push(c.id + ': Related points at itself');
      continue;
    }
    c.derived_from = targetId;
    c.relation_type = relType;
    resolved.push(c.id + ' —' + relType + '→ ' + targetId);
  }
  return { resolved, unresolved };
}

/* ---- Slack ------------------------------------------------------------------ */
async function slackGet(path: string, token: string) {
  const res = await fetch(`${SLACK_API}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`slack ${path.split('?')[0]} failed: ${json.error}`);
  return json;
}

async function fetchCanvasHtml(token: string, canvasId: string) {
  const info = await slackGet(`files.info?file=${encodeURIComponent(canvasId)}`, token);
  const url = info.file?.url_private_download || info.file?.url_private;
  if (!url) throw new Error('files.info returned no url_private_download for this id');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`canvas download failed: HTTP ${res.status}`);
  return { html: await res.text(), title: info.file?.title ?? null };
}

/* ---- Supabase (service role; used for lineage reads and the sync RPC) ------- */
function supabaseHeaders(serviceKey: string) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

/* id + title for lineage resolution, plus stored keywords and translation
   blocks so a refresh can REUSE enrichment instead of regenerating it —
   a Gemini failure must never cost a card the translations it already has. */
async function fetchExistingCards(url: string, serviceKey: string) {
  const res = await fetch(
    `${url}/rest/v1/knowledge_items?select=id,title:body->en->>title,keywords,ko:body->ko,de:body->de,tr:body->tr`,
    { headers: supabaseHeaders(serviceKey) },
  );
  if (!res.ok) throw new Error(`reading existing cards failed: HTTP ${res.status}`);
  return await res.json() as {
    id: string; title: string | null; keywords: string[] | null;
    ko: Record<string, unknown> | null; de: Record<string, unknown> | null; tr: Record<string, unknown> | null;
  }[];
}

async function callSyncRpc(url: string, serviceKey: string, cards: unknown[], purge: boolean, refresh: boolean) {
  const res = await fetch(`${url}/rest/v1/rpc/canvas_sync_upsert`, {
    method: 'POST',
    headers: supabaseHeaders(serviceKey),
    body: JSON.stringify({ cards, purge, refresh }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`canvas_sync_upsert failed: ${JSON.stringify(json)}`);
  return json;
}

async function fetchKeywordVocabulary(url: string, serviceKey: string) {
  const res = await fetch(`${url}/rest/v1/knowledge_items?select=keywords`, {
    headers: supabaseHeaders(serviceKey),
  });
  if (!res.ok) throw new Error(`reading keyword vocabulary failed: HTTP ${res.status}`);
  const rows = await res.json() as { keywords: string[] }[];
  // lowercase → the exact spelling already in use (first seen wins); handing
  // Gemini — and the normaliser below — one canonical spelling per word is
  // what keeps Threads' case-folded grouping intact
  const vocab = new Map<string, string>();
  for (const row of rows) {
    for (const kw of row.keywords || []) {
      const key = kw.toLowerCase();
      if (!vocab.has(key)) vocab.set(key, kw);
    }
  }
  return vocab;
}

/* ---- form cards still without keywords (the daily sweep) --------------------
   A question posted from the Loom form is tagged by the keyword-card function
   the moment it is saved. When that call failed — Gemini quota, a closed tab
   — the card sits with no keyword and appears in no band. This sweep, run by
   the ordinary daily sync, catches those. Keywords only: a form card's body
   is in the language it was typed in and is not translated here. The view
   already excludes canvas cards and hand-edited ones (db/0017). */
type FormCardRow = { id: string; type: string; source_lang: string | null; body: Record<string, unknown> | null };

async function fetchFormCardsWithoutKeywords(url: string, serviceKey: string) {
  const res = await fetch(
    `${url}/rest/v1/form_cards_without_keywords?select=id,type,source_lang,body&order=created_at.asc&limit=20`,
    { headers: supabaseHeaders(serviceKey) },
  );
  if (!res.ok) throw new Error(`reading form cards without keywords failed: HTTP ${res.status}`);
  return await res.json() as FormCardRow[];
}

async function assignCardKeywords(url: string, serviceKey: string, cardId: string, keywords: string[]) {
  const res = await fetch(`${url}/rest/v1/rpc/assign_card_keywords`, {
    method: 'POST',
    headers: supabaseHeaders(serviceKey),
    body: JSON.stringify({ card_id: cardId, keywords }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`assign_card_keywords failed: ${JSON.stringify(json)}`);
  return json as { id: string; keywords?: string[]; skipped?: string };
}

// the card's own text in the language it was typed in; attachments and the
// conversation skeleton are not prose
function pickFormTextBlock(card: FormCardRow): { lang: string; block: Record<string, unknown> } {
  const body = card.body || {};
  const lang = card.source_lang && body[card.source_lang] ? card.source_lang : 'en';
  const raw = (body[lang] || body.en || {}) as Record<string, unknown>;
  const { attachments: _a, conversation: _c, ...block } = raw;
  return { lang, block };
}

// keywords-only variant of buildGeminiPrompt — same vocabulary clause, no translation
function buildKeywordOnlyPrompt(block: Record<string, unknown>, lang: string, vocab: Map<string, string>) {
  const vocabList = [...vocab.values()];
  return [
    'You tag one knowledge card of a shared game-studio knowledge base with topical keywords.',
    'Return ONLY a JSON object: {"keywords": [...]}',
    '',
    'keywords: 1 to 3 short topical keywords for this card, in English, each at most 40 characters.',
    vocabList.length
      ? 'Existing vocabulary — reuse one of these (exact spelling) ONLY when it genuinely describes THIS card; ' +
        'never attach an existing keyword just to reuse it. If nothing here fits, invent AT MOST ONE new keyword. ' +
        'One name per topic: never return two keywords where one contains the other (not both "Market Trends" and "European Market Trends"):\n' +
        vocabList.map((v) => '- ' + v).join('\n')
      : 'There is no existing vocabulary yet — choose keywords that other cards on similar topics could reuse. One name per topic: never two keywords where one contains the other.',
    '',
    'The card may be written in Korean, German or Turkish. Keywords stay in English so they group with the vocabulary above.',
    'A question card asks something; tag what it is ABOUT, not the fact that it is a question.',
    '',
    `Card block (${lang}):`,
    JSON.stringify(block),
  ].join('\n');
}

/* ---- Gemini enrichment (keywords + ko/de/tr) --------------------------------
   One call per card returns {"keywords": [...], "ko": {...}, "de": {...},
   "tr": {...}}. The model is asked to prefer the existing vocabulary; the
   code below enforces it regardless (case-insensitive match → existing
   spelling, ≤3 keywords, ≤40 chars — the submit_card limits). */
// gemini-2.5-flash returns 404 for keys issued after its retirement — the
// error message itself names this successor.
const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_TIMEOUT_MS = 30_000;
const TRANSLATION_LANGS = ['ko', 'de', 'tr'] as const;

function buildGeminiPrompt(enBlock: Record<string, unknown>, vocab: Map<string, string>) {
  // attachments are file references, not prose — excluded from what Gemini sees
  const { attachments: _a, ...textBlock } = enBlock as Record<string, unknown>;
  const vocabList = [...vocab.values()];
  return [
    'You enrich one knowledge card of a shared game-studio knowledge base.',
    'Return ONLY a JSON object: {"keywords": [...], "ko": {...}, "de": {...}, "tr": {...}}',
    '',
    'keywords: 1 to 3 short topical keywords for this card, each at most 40 characters.',
    vocabList.length
      ? 'Existing vocabulary — reuse one of these (exact spelling) ONLY when it genuinely describes THIS card; ' +
        'never attach an existing keyword just to reuse it. If nothing here fits, invent AT MOST ONE new keyword. ' +
        'One name per topic: never return two keywords where one contains the other (not both "Market Trends" and "European Market Trends"):\n' +
        vocabList.map((v) => '- ' + v).join('\n')
      : 'There is no existing vocabulary yet — choose keywords that other cards on similar topics could reuse. One name per topic: never two keywords where one contains the other.',
    '',
    'ko / de / tr: translate the card block below into Korean, German and Turkish.',
    'Return the SAME keys as the input block; string values stay strings, arrays of strings stay arrays of the same length.',
    'Style: concise internal studio documentation, no added politeness or flourish.',
    'Keep technical terms in English (e.g. Slack pipeline, self-QA, n8n, thread root, fail-open).',
    'Example of the expected Korean tone: "Same idea, different stack — n8n Cloud instead of a local codebase." → "같은 아이디어, 다른 스택 — 로컬 코드베이스 대신 n8n Cloud."',
    '',
    'Card block (en):',
    JSON.stringify(textBlock),
  ].join('\n');
}

async function callGeminiOnce(apiKey: string, prompt: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('gemini returned no text part');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// One retry after a short pause, for exactly the failures seen in practice:
// 503 (model overloaded) and the timeout abort. Anything else fails fast.
async function callGemini(apiKey: string, prompt: string) {
  try {
    return await callGeminiOnce(apiKey, prompt);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    const transient = msg.includes('HTTP 503') || msg.includes('HTTP 429') || msg.toLowerCase().includes('abort');
    if (!transient) throw err;
    await new Promise((r) => setTimeout(r, 3000));
    return await callGeminiOnce(apiKey, prompt);
  }
}

// enforce the keyword rules no matter what the model returned, and register
// accepted keywords in the vocabulary so the NEXT card is offered them
function normalizeKeywords(raw: unknown, vocab: Map<string, string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t || t.length > 40) continue;
    const canonical = vocab.get(t.toLowerCase()) ?? t;
    if (out.some((k) => k.toLowerCase() === canonical.toLowerCase())) continue;
    out.push(canonical);
    if (out.length === 3) break;
  }
  /* One name per topic. The model was asked not to return both "Market
     Trends" and "European Market Trends" for one card, and did anyway — so
     when one keyword contains another, the longer one goes: the shorter is
     the name the next card on the topic can share. Unless only the longer one
     is already in the vocabulary — then that is the shared name, and it stays.
     Checked against the vocabulary as it was, before this card adds to it. */
  const kept = out.filter((k, i) => !out.some((o, j) => {
    if (i === j) return false;
    const a = k.toLowerCase(), b = o.toLowerCase();
    if (!a.includes(b) && !b.includes(a)) return false;   // two different topics
    // one topic, two names — decide the survivor once, symmetrically:
    const aIn = vocab.has(a), bIn = vocab.has(b);
    if (aIn !== bIn) return bIn;        // exactly one is already the shared name: k goes if o is it
    return a.length > b.length;         // otherwise the longer goes
  }));
  for (const k of kept) if (!vocab.has(k.toLowerCase())) vocab.set(k.toLowerCase(), k);
  return kept;
}

/* A translated block is adopted only when it mirrors the en block exactly:
   same keys, strings for strings, same-length string arrays for arrays.
   attachments are copied verbatim (file references don't translate). */
function validateTranslation(en: Record<string, unknown>, cand: unknown): Record<string, unknown> | null {
  if (!cand || typeof cand !== 'object' || Array.isArray(cand)) return null;
  const c = cand as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(en)) {
    if (key === 'attachments') continue;
    const v = en[key];
    const t = c[key];
    if (typeof v === 'string') {
      if (typeof t !== 'string' || !t.trim()) return null;
      out[key] = t;
    } else if (Array.isArray(v)) {
      if (!Array.isArray(t) || t.length !== v.length || !t.every((s) => typeof s === 'string')) return null;
      out[key] = t;
    }
  }
  if (en.attachments) out.attachments = en.attachments;
  return out;
}

/* ---- attachment storage + PDF covers ----------------------------------------
   📎 lines carrying a Slack file id (sf:F… / F…) are downloaded with the bot
   token and re-hosted in the public `attachments` bucket, at a DETERMINISTIC
   path (<card_id>/<file_id>-<name>) — uploading with x-upsert:false makes a
   repeat sync a no-op (409 → 'exists'), so refresh runs are idempotent.
   Slack renders a first-page thumbnail for PDFs (thumb_pdf); the first PDF's
   thumbnail becomes the card cover, resized to ≤800px JPEG so the feed never
   pays original-PDF egress. Lines without a file id keep their text (and a
   bare URL when one is present). One failed file never fails the card. */
const STORAGE_BUCKET = 'attachments';
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const COVER_MAX_EDGE = 800;
const SLACK_FILE_ID_RE = /\b(?:sf:)?(F[A-Z0-9]{8,})\b/;

function sanitizeFilename(name: string): string {
  const safe = (name || '').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return safe || 'file';
}

function publicStorageUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
}

async function uploadToStorage(
  supabaseUrl: string, serviceKey: string, path: string,
  bytes: ArrayBuffer | Uint8Array, contentType: string,
): Promise<'uploaded'> {
  /* Multipart with an explicit cacheControl field — the raw-body upload
     ignored the cache-control header and stored `no-cache`, which put every
     cover view back on the egress meter. Deterministic, content-fixed paths
     → a year of caching is safe. x-upsert on purpose: re-uploading the same
     bytes is how existing objects pick up corrected metadata on a refresh. */
  const form = new FormData();
  form.append('cacheControl', '31536000');
  form.append('', new Blob([bytes as BlobPart], { type: contentType || 'application/octet-stream' }), path.split('/').pop());
  const res = await fetch(`${supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      // apikey AND Authorization, like every other Supabase call here — the
      // gateway rejects the injected service key without the apikey header
      // ("Invalid Compact JWS")
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'x-upsert': 'true',
    },
    body: form,
  });
  if (res.ok) return 'uploaded';
  const text = await res.text();
  throw new Error(`storage upload ${path}: HTTP ${res.status} ${text.slice(0, 150)}`);
}

async function downloadSlackFile(token: string, url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`slack file download failed: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

// Slack's thumb_pdf (PNG of page 1) → ≤800px JPEG for the card cover
async function makeCoverJpeg(source: ArrayBuffer): Promise<Uint8Array> {
  const img = await Image.decode(new Uint8Array(source));
  const long = Math.max(img.width, img.height);
  if (long > COVER_MAX_EDGE) {
    const scale = COVER_MAX_EDGE / long;
    img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
  }
  return await img.encodeJPEG(80);
}

/* ---- Slack notification + slash command ------------------------------------
   Two ways a sync can be asked for besides a manual curl:
     - pg_cron (db/0008): header-secret path with {"mode":"sync","notify":true}
       — acked immediately, sync runs in the background (pg_net's short
       timeout never truncates the work). Scheduled runs post NOTHING to
       Slack; outcome and errors go to the function log only.
     - /loom-sync slash command: Slack signs every request with the app's
       Signing Secret (its own credential, fully separate from
       CANVAS_SYNC_SECRET — leaking one never opens the other), we verify the
       HMAC, ack within Slack's 3-second window, sync in the background and
       post the result to the channel — a person asked and is waiting.
   Posting the result needs chat:write on the bot and SLACK_CHANNEL_ID in
   Secrets. A failed notification is logged, never fatal — same isolation
   rule as everything else here. */

async function postSlackMessage(text: string) {
  const token = Deno.env.get('SLACK_BOT_TOKEN');
  const channel = Deno.env.get('SLACK_CHANNEL_ID');
  if (!token || !channel) {
    console.error('[canvas-sync] notify skipped: SLACK_BOT_TOKEN / SLACK_CHANNEL_ID not set');
    return;
  }
  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text }),
    });
    const json = await res.json();
    if (!json.ok) console.error('[canvas-sync] chat.postMessage failed:', json.error);
  } catch (err) {
    console.error('[canvas-sync] notify failed:', err);
  }
}

// the one-line result message both trigger paths post
function summarizeForSlack(payload: Record<string, unknown>): string {
  const report = payload.report as Record<string, unknown> | null;
  const enrichment = payload.enrichment as { gemini_failed: unknown[]; translation_failed: unknown[] };
  const lineage = payload.lineage as { unresolved: unknown[] };
  const inserted = (report?.inserted as string[]) || [];
  const updated = (report?.updated as string[]) || [];
  const skipped = (report?.skipped as string[]) || [];
  const parts = [
    `✅ canvas-sync — new: ${inserted.length}, updated: ${updated.length}, unchanged: ${skipped.length}`,
  ];
  if (inserted.length) parts.push(`new cards: ${inserted.join(', ')}`);
  if (enrichment.gemini_failed.length) parts.push(`⚠️ gemini failed: ${enrichment.gemini_failed.length}`);
  if (enrichment.translation_failed.length) parts.push(`⚠️ translations missing: ${enrichment.translation_failed.length}`);
  const formKeywords = payload.formKeywords as { tagged: unknown[]; failed: unknown[] } | undefined;
  if (formKeywords && formKeywords.tagged.length) parts.push(`form questions tagged: ${formKeywords.tagged.length}`);
  if (formKeywords && formKeywords.failed.length) parts.push(`⚠️ form keywords failed: ${formKeywords.failed.length}`);
  if (lineage.unresolved.length) parts.push(`⚠️ unresolved Related: ${lineage.unresolved.length}`);
  const storage = payload.storage as { failed: unknown[] } | undefined;
  if (storage && storage.failed.length) parts.push(`⚠️ attachments failed: ${storage.failed.length}`);
  return parts.join('\n');
}

// HMAC check for slash-command requests: v0=<hex of HMAC(v0:{ts}:{body})>
async function verifySlackSignature(rawBody: string, timestamp: string, signature: string, signingSecret: string) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // stale = replay
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`v0:${timestamp}:${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `v0=${hex}` === signature;
}

// Edge runtime keeps background promises alive via EdgeRuntime.waitUntil;
// fall back to fire-and-forget if the global is ever absent (local tooling).
function runInBackground(job: Promise<unknown>) {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(job);
}

/* ---- the pipeline, shared by every trigger path ---------------------------- */
async function runPipeline(mode: string, purge: boolean, refresh: boolean) {
  const token = Deno.env.get('SLACK_BOT_TOKEN');
  const canvasId = Deno.env.get('SLACK_CANVAS_ID');
  if (!token || !canvasId) throw new Error('SLACK_BOT_TOKEN / SLACK_CANVAS_ID not set');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available');

  {
    const { html, title } = await fetchCanvasHtml(token, canvasId);
    const { preamble, parsed, unparsable } = parseEntries(htmlToLines(html));
    const { cards, excluded, personNotes } = buildCards(parsed);

    // oldest first: canvas entries only reference older entries, so parents
    // are always inserted before their children
    cards.sort((a, b) => a.created_at.localeCompare(b.created_at));

    const existing = await fetchExistingCards(supabaseUrl, serviceKey);
    const lineage = resolveLineage(cards, existing);
    const existingById = new Map(existing.map((row) => [row.id, row]));

    /* Gemini enrichment — ONLY for cards this run will actually write:
       everything under purge/refresh, otherwise just the ids the DB does not
       have yet. An ordinary sync with no new canvas entries makes zero
       Gemini calls (an unchanged card would have its enrichment thrown away
       by the RPC's skip anyway — calling was pure cost and noise).
       Sequential on purpose (keyword consistency), and every failure is
       contained: a failed card keeps keywords [] and its en block only, and
       the sync still runs. Dry runs enrich the same scope sync would, so a
       refresh preview needs {"refresh": true} in the dry body too. */
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    const existingIds = new Set(existing.map((row) => row.id));
    // the cards this run will actually write — enrichment AND the storage
    // pass below both scope to these
    const writeTargets = (purge || refresh)
      ? cards
      : cards.filter((c) => !existingIds.has(c.id));
    const enrichTargets = writeTargets;
    const enrichment = {
      enabled: !!geminiKey,
      model: GEMINI_MODEL,
      scope: purge || refresh ? 'all' : 'new-only',
      enriched: 0,
      reused: 0, // refresh targets that kept their stored keywords/translations
      gemini_failed: [] as { id: string; reason: string }[],
      translation_failed: [] as { id: string; lang: string }[],
    };
    if (geminiKey && enrichTargets.length) {
      const vocab = await fetchKeywordVocabulary(supabaseUrl, serviceKey);
      for (const c of enrichTargets) {
        /* Already-enriched cards keep what they have — regenerating would
           reshuffle keyword spellings at best and, on a Gemini failure
           (quota days exist), overwrite stored translations with nothing.
           Gemini runs only for cards that have no enrichment yet. */
        const stored = existingById.get(c.id);
        if (stored && ((stored.keywords || []).length || stored.ko || stored.de || stored.tr)) {
          c.keywords = stored.keywords || [];
          const bodyRef = c.body as Record<string, unknown>;
          if (stored.ko) bodyRef.ko = stored.ko;
          if (stored.de) bodyRef.de = stored.de;
          if (stored.tr) bodyRef.tr = stored.tr;
          for (const k of c.keywords) {
            if (!vocab.has(k.toLowerCase())) vocab.set(k.toLowerCase(), k);
          }
          enrichment.reused++;
          continue;
        }
        const en = (c.body as Record<string, Record<string, unknown>>).en;
        try {
          const res = await callGemini(geminiKey, buildGeminiPrompt(en, vocab));
          c.keywords = normalizeKeywords(res.keywords, vocab);
          for (const lang of TRANSLATION_LANGS) {
            const block = validateTranslation(en, res[lang]);
            if (block) (c.body as Record<string, unknown>)[lang] = block;
            else enrichment.translation_failed.push({ id: c.id, lang });
          }
          enrichment.enriched++;
        } catch (err) {
          const reason = String(err instanceof Error ? err.message : err).slice(0, 300);
          // also into the function log, so the dashboard shows WHY (the
          // Slack summary only carries the count)
          console.warn('[canvas-sync] gemini failed for ' + c.id + ': ' + reason);
          enrichment.gemini_failed.push({ id: c.id, reason });
        }
      }
    }

    /* Form-card sweep — the safety net under the keyword-card function (see
       fetchFormCardsWithoutKeywords). Only on a real sync: a dry run must
       not write, and this writes straight through assign_card_keywords
       rather than through the canvas upsert, because these are not canvas
       cards. Sequential like the pass above, for the same reason. */
    const formKeywords = {
      enabled: !!geminiKey && mode === 'sync',
      pending: 0,
      tagged: [] as { id: string; keywords: string[] }[],
      failed: [] as { id: string; reason: string }[],
    };
    if (formKeywords.enabled) {
      try {
        const pending = await fetchFormCardsWithoutKeywords(supabaseUrl, serviceKey);
        formKeywords.pending = pending.length;
        if (pending.length) {
          const formVocab = await fetchKeywordVocabulary(supabaseUrl, serviceKey);
          for (const row of pending) {
            try {
              const { lang, block } = pickFormTextBlock(row);
              const res = await callGemini(geminiKey!, buildKeywordOnlyPrompt(block, lang, formVocab));
              const kws = normalizeKeywords(res.keywords, formVocab);
              if (!kws.length) { formKeywords.failed.push({ id: row.id, reason: 'gemini returned no usable keyword' }); continue; }
              const written = await assignCardKeywords(supabaseUrl, serviceKey, row.id, kws);
              if (written.skipped) formKeywords.failed.push({ id: row.id, reason: written.skipped });
              else formKeywords.tagged.push({ id: row.id, keywords: written.keywords || kws });
            } catch (err) {
              const reason = String(err instanceof Error ? err.message : err).slice(0, 300);
              console.warn('[canvas-sync] form keywords failed for ' + row.id + ': ' + reason);
              formKeywords.failed.push({ id: row.id, reason });
            }
          }
        }
      } catch (err) {
        // the sweep must never cost the sync itself
        formKeywords.failed.push({ id: '*', reason: String(err instanceof Error ? err.message : err).slice(0, 300) });
      }
    }

    /* Storage pass — same write-target scope as enrichment. In dry mode this
       goes as far as files.info (read-only planning: names, sizes, which PDF
       becomes the cover) and uploads nothing. */
    const storage = {
      mode: mode === 'sync' ? 'executed' : 'planned',
      files: [] as { card: string; name: string; bytes?: number; mime?: string; action: string; url?: string }[],
      covers: [] as { card: string; action: string; url?: string }[],
      failed: [] as { card: string; item: string; reason: string }[],
    };
    for (const c of writeTargets) {
      const raw = ((c.body as Record<string, Record<string, unknown>>).en.attachments as string[] | undefined) || [];
      if (!raw.length) continue;
      const resolved: AttachmentEntry[] = [];
      let coverDone = false;
      for (const line of raw) {
        try {
          const m = line.match(SLACK_FILE_ID_RE);
          if (!m) {
            // not a Slack file — keep the author's text (and a bare URL if present)
            const urlMatch = line.match(/https?:\/\/\S+/);
            resolved.push(urlMatch ? { label: line, url: urlMatch[0] } : { label: line });
            continue;
          }
          const fileId = m[1];
          const info = await slackGet(`files.info?file=${encodeURIComponent(fileId)}`, token);
          const f = info.file;
          const name = sanitizeFilename(f.name || fileId);
          if ((f.size || 0) > MAX_ATTACHMENT_BYTES) {
            storage.files.push({ card: c.id, name, bytes: f.size, mime: f.mimetype, action: 'skipped_too_large' });
            resolved.push({ label: f.name || line, bytes: f.size, mime: f.mimetype, slackId: fileId });
            continue;
          }
          const path = `${c.id}/${fileId}-${name}`;
          const url = publicStorageUrl(supabaseUrl, path);
          if (mode === 'sync') {
            const data = await downloadSlackFile(token, f.url_private_download || f.url_private);
            const action = await uploadToStorage(supabaseUrl, serviceKey, path, data, f.mimetype);
            storage.files.push({ card: c.id, name, bytes: f.size, mime: f.mimetype, action, url });
          } else {
            storage.files.push({ card: c.id, name, bytes: f.size, mime: f.mimetype, action: 'planned', url });
          }
          resolved.push({ label: f.name || line, url, bytes: f.size, mime: f.mimetype, slackId: fileId });

          // cover: the first PDF with Slack's first-page thumbnail
          if (!coverDone && !c.image && f.mimetype === 'application/pdf' && f.thumb_pdf) {
            const coverPath = `${c.id}/cover.jpg`;
            const coverUrl = publicStorageUrl(supabaseUrl, coverPath);
            if (mode === 'sync') {
              const thumb = await downloadSlackFile(token, f.thumb_pdf);
              const jpeg = await makeCoverJpeg(thumb);
              const action = await uploadToStorage(supabaseUrl, serviceKey, coverPath, jpeg, 'image/jpeg');
              storage.covers.push({ card: c.id, action, url: coverUrl });
            } else {
              storage.covers.push({ card: c.id, action: 'planned', url: coverUrl });
            }
            c.image = { path: coverUrl, fit: 'contain', bg: '#ffffff' };
            coverDone = true;
          }
        } catch (err) {
          const reason = String(err instanceof Error ? err.message : err).slice(0, 200);
          console.warn('[canvas-sync] storage failed for ' + c.id + ': ' + reason);
          storage.failed.push({ card: c.id, item: line.slice(0, 80), reason });
          // never lose the author's reference — and a cross-workspace file
          // (access_denied on Slack Connect uploads from the other org) at
          // least keeps its Slack URL, which channel members can open
          const urlMatch = line.match(/https?:\/\/\S+/);
          resolved.push(urlMatch ? { label: line, url: urlMatch[0] } : { label: line });
        }
      }
      c.attachments = resolved;
    }

    const cardSummaries = cards.map((c) => ({
      id: c.id, type: c.type, studio: c.studio, title: c.title,
      created_at: c.created_at,
      shared_by: c.shared_by, documented_by: c.documented_by,
      derived_from: c.derived_from, relation_type: c.relation_type,
      status: c.status,
      keywords: c.keywords,
      image: c.image,
      attachments: c.attachments,
      body: c.body, // en + whatever translations were adopted
    }));

    let report = null;
    if (mode === 'sync') {
      const rows = cards.map(({ title: _t, relatedRaw: _rel, relationRaw: _rl, ...row }) => row);
      report = await callSyncRpc(supabaseUrl, serviceKey, rows, purge, refresh);
    }

    return {
      mode,
      dryRun: mode !== 'sync',
      purgeRequested: purge && mode === 'sync',
      refreshRequested: refresh && mode === 'sync',
      enrichment,
      formKeywords, // the sweep over form cards still without keywords (db/0017)
      canvas: { id: canvasId, title },
      counts: {
        blocks: parsed.length,
        cards: cards.length,
        excluded: excluded.length,
        unparsable: unparsable.length,
      },
      cards: cardSummaries,
      excluded,
      lineage,
      personNotes,
      storage,
      report, // null on dry run; the RPC's inserted/skipped/purged on sync
      unparsable,
      ...(mode === 'dry' ? { preamble, parsed } : {}),
    } as Record<string, unknown>;
  }
}

/* ---- handler ----------------------------------------------------------------- */
Deno.serve(async (req: Request) => {
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  /* Path 1 — Slack slash command (/loom-sync). Identified by Slack's
     signature header; verified against the app's Signing Secret, which is
     deliberately NOT the header secret below. Ack within 3s, sync in the
     background, result posted to the channel. */
  const slackSignature = req.headers.get('x-slack-signature');
  if (slackSignature) {
    const signingSecret = Deno.env.get('SLACK_SIGNING_SECRET');
    if (!signingSecret) return jsonResponse(500, { error: 'SLACK_SIGNING_SECRET is not set' });
    const timestamp = req.headers.get('x-slack-request-timestamp') || '';
    const rawBody = await req.text();
    if (!(await verifySlackSignature(rawBody, timestamp, slackSignature, signingSecret))) {
      return jsonResponse(401, { error: 'bad slack signature' });
    }
    const params = new URLSearchParams(rawBody);
    const user = params.get('user_name') || 'someone';
    runInBackground((async () => {
      try {
        const result = await runPipeline('sync', false, false);
        await postSlackMessage(summarizeForSlack(result) + `\n(triggered by @${user})`);
      } catch (err) {
        await postSlackMessage('❌ canvas-sync failed: ' + String(err instanceof Error ? err.message : err));
      }
    })());
    return jsonResponse(200, {
      response_type: 'in_channel',
      text: '⏳ Canvas sync started — the result will be posted here shortly.',
    });
  }

  /* Path 2 — header secret (curl, pg_cron). */
  const secret = Deno.env.get('CANVAS_SYNC_SECRET');
  if (!secret) return jsonResponse(500, { error: 'CANVAS_SYNC_SECRET is not set' });
  if (req.headers.get('x-canvas-sync-secret') !== secret) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // mode comes from the POST body; anything but an explicit sync is a dry run
  let mode = 'dry';
  let purge = false;
  let refresh = false;
  let notify = false;
  try {
    const body = await req.json();
    if (body && body.mode === 'sync') mode = 'sync';
    if (body && body.purge === true) purge = true;
    if (body && body.refresh === true) refresh = true;
    if (body && body.notify === true) notify = true;
  } catch (_) { /* empty body → dry run */ }

  /* notify=true (the pg_cron shape) means the caller only needs an ack —
     pg_net's timeout is seconds, the pipeline takes a minute. Run in the
     background. Scheduled runs stay SILENT in Slack (the channel is not a
     log; Loom isn't announced yet): outcome and errors go to the function
     log only. The slash command above is the loud path, because a person
     asked and is waiting. */
  if (notify) {
    runInBackground((async () => {
      try {
        const result = await runPipeline(mode, purge, refresh);
        console.log('[canvas-sync] scheduled run: ' + summarizeForSlack(result).replace(/\n/g, ' | '));
      } catch (err) {
        console.error('[canvas-sync] scheduled run failed: ' + String(err instanceof Error ? err.message : err));
      }
    })());
    return jsonResponse(202, { started: true, mode, notify: true });
  }

  try {
    return jsonResponse(200, await runPipeline(mode, purge, refresh));
  } catch (err) {
    return jsonResponse(502, { error: String(err instanceof Error ? err.message : err) });
  }
});
