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
     SLACK_BOT_TOKEN, SLACK_CANVAS_ID, CANVAS_SYNC_SECRET
   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform and
   used only to call the sync RPC (and to read existing card titles for
   lineage resolution) — the browser-side RLS lockdown is untouched.
   ============================================================================ */

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
      conversation, created_at: created.toISOString(),
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

async function fetchExistingTitles(url: string, serviceKey: string) {
  const res = await fetch(
    `${url}/rest/v1/knowledge_items?select=id,title:body->en->>title`,
    { headers: supabaseHeaders(serviceKey) },
  );
  if (!res.ok) throw new Error(`reading existing cards failed: HTTP ${res.status}`);
  return await res.json() as { id: string; title: string | null }[];
}

async function callSyncRpc(url: string, serviceKey: string, cards: unknown[], purge: boolean) {
  const res = await fetch(`${url}/rest/v1/rpc/canvas_sync_upsert`, {
    method: 'POST',
    headers: supabaseHeaders(serviceKey),
    body: JSON.stringify({ cards, purge }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`canvas_sync_upsert failed: ${JSON.stringify(json)}`);
  return json;
}

/* ---- handler ----------------------------------------------------------------- */
Deno.serve(async (req: Request) => {
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const secret = Deno.env.get('CANVAS_SYNC_SECRET');
  if (!secret) return jsonResponse(500, { error: 'CANVAS_SYNC_SECRET is not set' });
  if (req.headers.get('x-canvas-sync-secret') !== secret) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  const token = Deno.env.get('SLACK_BOT_TOKEN');
  const canvasId = Deno.env.get('SLACK_CANVAS_ID');
  if (!token || !canvasId) {
    return jsonResponse(500, { error: 'SLACK_BOT_TOKEN / SLACK_CANVAS_ID not set' });
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available' });
  }

  // mode comes from the POST body; anything but an explicit sync is a dry run
  let mode = 'dry';
  let purge = false;
  try {
    const body = await req.json();
    if (body && body.mode === 'sync') mode = 'sync';
    if (body && body.purge === true) purge = true;
  } catch (_) { /* empty body → dry run */ }

  try {
    const { html, title } = await fetchCanvasHtml(token, canvasId);
    const { preamble, parsed, unparsable } = parseEntries(htmlToLines(html));
    const { cards, excluded, personNotes } = buildCards(parsed);

    // oldest first: canvas entries only reference older entries, so parents
    // are always inserted before their children
    cards.sort((a, b) => a.created_at.localeCompare(b.created_at));

    const existing = await fetchExistingTitles(supabaseUrl, serviceKey);
    const lineage = resolveLineage(cards, existing);

    const cardSummaries = cards.map((c) => ({
      id: c.id, type: c.type, studio: c.studio, title: c.title,
      created_at: c.created_at,
      shared_by: c.shared_by, documented_by: c.documented_by,
      derived_from: c.derived_from, relation_type: c.relation_type,
      status: c.status,
    }));

    let report = null;
    if (mode === 'sync') {
      const rows = cards.map(({ title: _t, relatedRaw: _rel, relationRaw: _rl, ...row }) => row);
      report = await callSyncRpc(supabaseUrl, serviceKey, rows, purge);
    }

    return jsonResponse(200, {
      mode,
      dryRun: mode !== 'sync',
      purgeRequested: purge && mode === 'sync',
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
      report, // null on dry run; the RPC's inserted/skipped/purged on sync
      unparsable,
      ...(mode === 'dry' ? { preamble, parsed } : {}),
    });
  } catch (err) {
    return jsonResponse(502, { error: String(err instanceof Error ? err.message : err) });
  }
});
