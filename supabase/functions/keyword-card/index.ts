/* ============================================================================
   Loom — keyword-card: what a card written in Loom is missing, from one
   Gemini call — keywords, the language it was written in, and the other
   languages.

   A question typed into Home is saved with no keyword (choosing one is the
   friction the field exists to remove), and the Home bands and Threads group
   by keyword — so until something tags it, the person who just asked cannot
   find their own question on the screen they asked from. And it is saved in
   one language only, so a reader on another language saw it untranslated
   while every canvas card around it was translated.

   The client calls this the moment submit_card (or submit_card_edit) returns,
   in the background: the card is already saved and shown in its original, and
   when this comes back its dot arrives in a band and its other languages are
   there. If this call fails (quota, a closed tab) the daily canvas-sync run
   calls the sweep door below, so nothing stays untagged, unchecked or
   untranslated for more than a day.

   One call per card, never two: keywords, source language and translations
   are asked for together (the free quota is per request), and only what the
   card actually lacks is asked for at all. A card that lacks nothing a model
   is needed for — a Korean card whose only gap was the language check — makes
   no call. Each part is written independently (db/0018), so a malformed
   translation never costs the keywords.

   Two doors:
     - a member's JWT (Authorization: Bearer <access_token>) + { card_id }
       — checked against auth/v1/user; a guest or the bare anon key cannot
       spend Gemini calls
     - the canvas-sync header secret + { sweep: true } — every pending card;
       the daily sync calls this, and an operator can by hand

   What it will never do (db/0017 and 0018 enforce it server-side too):
     - touch a canvas card — the sync owns those
     - overwrite a language block that exists — only empty keys are filled
     - call a block with a Hangul letter anything but Korean
     - touch keywords a PERSON has tuned, or set keywords_edited_at

   Secrets (Dashboard → Edge Functions → Secrets): GEMINI_API_KEY and
   CANVAS_SYNC_SECRET, both already set for canvas-sync. SUPABASE_URL,
   SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected.
   Deployed with verify_jwt off (the JWT is verified here, so the sweep door
   can exist). CORS on, because the browser calls this directly.

   The Gemini pieces are a deliberate copy of canvas-sync's so this function
   deploys as one file through the Management API; canvas-sync/index.ts is
   the source of truth for the call and the keyword rules.
   ============================================================================ */

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_TIMEOUT_MS = 30_000;
/* Per sweep. The sweep is one request (canvas-sync waits on it), and a
   request lives about 150 s. A call that translates takes ~10 s, which
   already exceeds the 7 s pacing below, so 8 cards run ~80 s; two retried
   calls (3 s pause + up to 30 s each) still fit, where 10 cards would not.
   A bigger backlog drains over the next days. */
const SWEEP_LIMIT = 8;
const LANGS = ['en', 'ko', 'de', 'tr'] as const;
const LANG_NAMES: Record<string, string> = { en: 'English', ko: 'Korean', de: 'German', tr: 'Turkish' };
// any Hangul letter — syllables and jamo. A Korean sentence carries English
// terms all the time; an English one almost never carries Hangul.
const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;

// how a translation should read — a copy of canvas-sync's TRANSLATION_STYLE
// (the source of truth, with the reasoning); change both together
const TRANSLATION_STYLE = [
  'Style: concise internal studio documentation, no added politeness or flourish.',
  'Keep in their original form ONLY: names of people, studios, companies, products, tools, models and services ' +
    '(e.g. Slack, n8n, fal.ai, Kling, After Effects, Gemini, Whow, DoubleU); titles of documents, decks and events; ' +
    'and literal code — status values, identifiers, file names, commands, model ids (e.g. COMPLETED, claude-sonnet-5). ' +
    'Acronyms that practitioners say as acronyms stay too (QA, AI, API, UI).',
  'Translate everything else, including technical concepts and everyday work words ' +
    '(layout, spacing, asset, background, polling, concurrency, payload, fail-open, thread root, walkthrough, ad creatives). ' +
    'Where practitioners of the target language normally use a loanword, write it in that language\'s own script ' +
    '(Korean: 레이아웃, 에셋, 폴링, 크레딧, 페이로드), never in Latin letters.',
  'Korean examples:',
  '"A hard backstop on credits; the poll loop posts progress pings to the thread root." → "크레딧에 최종 안전장치를 두고, 폴링 루프가 진행 알림을 스레드 첫 메시지에 올린다."',
  '"Same idea, different stack — n8n Cloud instead of a local codebase." → "같은 아이디어, 다른 스택 — 로컬 코드베이스 대신 n8n Cloud."',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-canvas-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type PendingCard = {
  id: string;
  type: string;
  source_lang: string | null;
  body: Record<string, unknown> | null;
  needs_keywords: boolean;
  needs_lang: boolean;
  missing_langs: string[];
};

type Enriched = {
  id: string;
  keywords: string[];
  source_lang: string;
  moved: boolean;
  filled: string[];
  translation_failed: string[];
  body: Record<string, unknown>;
};

function serviceHeaders(serviceKey: string) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
}

/* ---- the same vocabulary rule as canvas-sync ------------------------------- */
async function fetchKeywordVocabulary(url: string, serviceKey: string) {
  const res = await fetch(`${url}/rest/v1/knowledge_items?select=keywords`, { headers: serviceHeaders(serviceKey) });
  if (!res.ok) throw new Error(`reading keyword vocabulary failed: HTTP ${res.status}`);
  const rows = await res.json() as { keywords: string[] | null }[];
  const vocab = new Map<string, string>();
  for (const row of rows) {
    for (const kw of row.keywords || []) {
      const key = kw.toLowerCase();
      if (!vocab.has(key)) vocab.set(key, kw);
    }
  }
  return vocab;
}

/* The card's original, exactly as stored — it goes back to the RPC as
   based_on, which refuses the write if the text changed meanwhile — and the
   part of it that is prose. Attachments are file references; the
   conversation stays, because it is the question's opening post and a
   translated block without it shows that post empty. */
function sourceBlock(card: PendingCard) {
  const body = card.body || {};
  const lang = card.source_lang || 'en';
  const stored = body[lang];
  if (!stored || typeof stored !== 'object') return null;
  const { attachments: _a, ...prose } = stored as Record<string, unknown>;
  return { lang, stored: stored as Record<string, unknown>, prose };
}

function hasHangul(block: Record<string, unknown>) {
  return HANGUL_RE.test(JSON.stringify(block));
}

function buildPrompt(
  prose: Record<string, unknown>,
  ask: { keywords: boolean; detect: boolean; targets: string[] | 'all-but-source' },
  vocab: Map<string, string>,
) {
  const fields: string[] = [];
  if (ask.detect) fields.push('"source_lang": "en" | "ko" | "de" | "tr"');
  if (ask.keywords) fields.push('"keywords": [...]');
  const translating = ask.targets === 'all-but-source' || ask.targets.length > 0;
  if (translating) fields.push('"translations": {"<lang>": {...}, ...}');

  const lines = [
    'You enrich one knowledge card of a shared game-studio knowledge base.',
    `Return ONLY a JSON object: {${fields.join(', ')}}`,
    '',
  ];
  if (ask.detect) {
    lines.push(
      'source_lang: the language the card block below is written in — one of en, ko, de, tr.',
      'Judge by the sentences, not by technical terms (a German sentence about an "AI Video Pipeline" is de).',
      '',
    );
  }
  if (ask.keywords) {
    const vocabList = [...vocab.values()];
    lines.push(
      'keywords: 1 to 3 short topical keywords for this card, in English, each at most 40 characters.',
      vocabList.length
        ? 'Existing vocabulary — reuse one of these (exact spelling) ONLY when it genuinely describes THIS card; ' +
          'never attach an existing keyword just to reuse it. If nothing here fits, invent AT MOST ONE new keyword. ' +
          'One name per topic: never return two keywords where one contains the other (not both "Market Trends" and "European Market Trends"):\n' +
          vocabList.map((v) => '- ' + v).join('\n')
        : 'There is no existing vocabulary yet — choose keywords that other cards on similar topics could reuse. One name per topic: never two keywords where one contains the other.',
      'Keywords stay in English whatever language the card is in, so they group with the vocabulary above.',
      'A question card asks something; tag what it is ABOUT, not the fact that it is a question.',
      '',
    );
  }
  if (translating) {
    lines.push(
      ask.targets === 'all-but-source'
        ? 'translations: translate the card block into every one of English (en), Korean (ko), German (de) and Turkish (tr) EXCEPT its own source_lang, keyed by language code.'
        : `translations: translate the card block into ${ask.targets.map((l) => `${LANG_NAMES[l]} (${l})`).join(', ')}, keyed by language code.`,
      'Each translation has the SAME keys as the input block; string values stay strings, arrays of strings stay arrays of the same length.',
      ...TRANSLATION_STYLE,
      '',
    );
  }
  lines.push('Card block:', JSON.stringify(prose));
  return lines.join('\n');
}

// calls start at least this far apart — the free tier is metered per minute,
// and a sweep's back-to-back calls ran into it (see canvas-sync's copy)
const GEMINI_MIN_INTERVAL_MS = 7_000;
let geminiLastStart = 0;
async function paceGemini() {
  const wait = geminiLastStart + GEMINI_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  geminiLastStart = Date.now();
}

async function callGeminiOnce(apiKey: string, prompt: string) {
  await paceGemini();
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

// one retry for the transient failures seen in practice (503 / 429 / timeout)
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

// ≤3, ≤40 chars, no case-duplicates, existing spelling wins — the RPC applies
// the same rules again; doing it here too keeps the vocabulary map honest
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

/* A translated block is adopted only when it mirrors the original exactly:
   same keys, strings for strings, same-length string arrays for arrays —
   canvas-sync's rule, against the source block instead of en. Attachments
   are copied verbatim (file references don't translate). */
function validateTranslation(src: Record<string, unknown>, cand: unknown): Record<string, unknown> | null {
  if (!cand || typeof cand !== 'object' || Array.isArray(cand)) return null;
  const c = cand as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (key === 'attachments') continue;
    const v = src[key];
    const t = c[key];
    if (typeof v === 'string') {
      if (typeof t !== 'string' || !t.trim()) return null;
      out[key] = t;
    } else if (Array.isArray(v)) {
      if (!Array.isArray(t) || t.length !== v.length || !t.every((s) => typeof s === 'string')) return null;
      out[key] = t;
    }
  }
  if (src.attachments) out.attachments = src.attachments;
  return out;
}

/* ---- the cards that still need something, and the write --------------------- */
async function fetchPending(url: string, serviceKey: string, cardId: string | null) {
  const filter = cardId ? `&id=eq.${encodeURIComponent(cardId)}` : `&order=created_at.asc&limit=${SWEEP_LIMIT}`;
  const res = await fetch(
    `${url}/rest/v1/form_cards_pending_enrichment?select=id,type,source_lang,body,needs_keywords,needs_lang,missing_langs${filter}`,
    { headers: serviceHeaders(serviceKey) },
  );
  if (!res.ok) throw new Error(`reading pending cards failed: HTTP ${res.status}`);
  return await res.json() as PendingCard[];
}

async function assignEnrichment(url: string, serviceKey: string, args: {
  card_id: string; based_on: Record<string, unknown>;
  keywords: string[] | null; source_lang: string | null; translations: Record<string, unknown> | null;
}) {
  const res = await fetch(`${url}/rest/v1/rpc/assign_card_enrichment`, {
    method: 'POST',
    headers: serviceHeaders(serviceKey),
    body: JSON.stringify(args),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`assign_card_enrichment failed: ${JSON.stringify(json)}`);
  return json as {
    id: string; skipped?: string; source_lang?: string; moved?: boolean; filled?: string[];
    keywords?: string[] | null; body?: Record<string, unknown>;
  };
}

async function enrichCard(
  card: PendingCard, vocab: Map<string, string>,
  url: string, serviceKey: string, geminiKey: string,
): Promise<Enriched> {
  const src = sourceBlock(card);
  if (!src) throw new Error(`no ${card.source_lang} block to work from`);
  const body = card.body || {};

  // the language, when it can be known without asking
  // the whole stored block, as the RPC tests it — the two must agree
  const korean = hasHangul(src.stored);
  const knownLang = korean ? 'ko' : (card.needs_lang ? null : src.lang);
  // which languages are empty once the original sits under its real key
  const targets = knownLang
    ? LANGS.filter((l) => l !== knownLang && (l === src.lang || !(l in body)))
    : null;

  const ask = {
    keywords: card.needs_keywords,
    detect: !knownLang,
    targets: targets ?? ('all-but-source' as const),
  };
  const needsModel = ask.keywords || ask.detect || (Array.isArray(ask.targets) && ask.targets.length > 0);

  let keywords: string[] | null = null;
  let lang: string | null = knownLang;
  let translations: Record<string, unknown> | null = null;
  const translationFailed: string[] = [];
  let modelError: string | null = null;

  if (needsModel) {
    try {
      const res = await callGemini(geminiKey, buildPrompt(src.prose, ask, vocab));
      if (ask.keywords) keywords = normalizeKeywords(res.keywords, vocab);
      if (ask.detect && (LANGS as readonly string[]).includes(res.source_lang)) lang = res.source_lang;
      if (lang) {
        const wanted = targets ?? LANGS.filter((l) => l !== lang);
        translations = {};
        for (const l of wanted) {
          const block = validateTranslation(src.stored, res.translations?.[l]);
          if (block) translations[l] = block;
          else translationFailed.push(l);
        }
      }
    } catch (err) {
      // the whole call failed: nothing from the model, but a Korean card can
      // still be moved to its key — the Hangul rule needs no model
      modelError = String(err instanceof Error ? err.message : err).slice(0, 300);
    }
  }
  if (modelError && !knownLang) throw new Error(modelError);

  const written = await assignEnrichment(url, serviceKey, {
    card_id: card.id,
    based_on: src.stored,
    keywords: keywords && keywords.length ? keywords : null,
    source_lang: lang,
    translations,
  });
  if (written.skipped) throw new Error(written.skipped);
  if (modelError) throw new Error(`language fixed by the Hangul rule, model failed: ${modelError}`);
  return {
    id: card.id,
    keywords: written.keywords || [],
    source_lang: written.source_lang || lang || src.lang,
    moved: !!written.moved,
    filled: written.filled || [],
    translation_failed: translationFailed,
    body: written.body || body,
  };
}

async function enrichCards(cards: PendingCard[], url: string, serviceKey: string, geminiKey: string) {
  const enriched: Enriched[] = [];
  const failed: { id: string; reason: string }[] = [];
  if (!cards.length) return { enriched, failed };
  const vocab = await fetchKeywordVocabulary(url, serviceKey);
  // sequential on purpose: a keyword chosen for one card is offered to the next
  for (const card of cards) {
    try {
      enriched.push(await enrichCard(card, vocab, url, serviceKey, geminiKey));
    } catch (err) {
      failed.push({ id: card.id, reason: String(err instanceof Error ? err.message : err).slice(0, 300) });
    }
  }
  return { enriched, failed };
}

/* ---- the handler ------------------------------------------------------------- */
Deno.serve(async (req: Request) => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) return json(500, { ok: false, error: 'supabase env not available' });
  if (!geminiKey) return json(500, { ok: false, error: 'GEMINI_API_KEY is not set' });

  let body: { card_id?: unknown; sweep?: unknown } = {};
  try { body = await req.json(); } catch (_) { /* empty body handled below */ }

  /* Door 2 — the sweep, by header secret: the daily sync, or an operator. */
  const secret = Deno.env.get('CANVAS_SYNC_SECRET');
  if (body.sweep === true) {
    if (!secret || req.headers.get('x-canvas-sync-secret') !== secret) return json(401, { ok: false, error: 'unauthorized' });
    try {
      const pending = await fetchPending(supabaseUrl, serviceKey, null);
      const { enriched, failed } = await enrichCards(pending, supabaseUrl, serviceKey, geminiKey);
      return json(200, {
        ok: true,
        pending: pending.length,
        // the texts stay out of the report — the Slack summary only needs counts
        enriched: enriched.map(({ body: _b, ...rest }) => rest),
        failed,
      });
    } catch (err) {
      return json(502, { ok: false, error: String(err instanceof Error ? err.message : err) });
    }
  }

  /* Door 1 — a signed-in member, one card. */
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer || bearer === anonKey) return json(401, { ok: false, error: 'sign in to tag a card' });
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${bearer}` } });
  if (!userRes.ok) return json(401, { ok: false, error: 'invalid session' });

  const cardId = typeof body.card_id === 'string' ? body.card_id.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(cardId)) return json(400, { ok: false, error: 'invalid card_id' });

  try {
    const pending = await fetchPending(supabaseUrl, serviceKey, cardId);
    // not in the view: nothing missing, a canvas card, or unknown — not an error
    if (!pending.length) return json(200, { ok: true, id: cardId, keywords: [], skipped: 'nothing to do' });
    const { enriched, failed } = await enrichCards(pending, supabaseUrl, serviceKey, geminiKey);
    if (enriched.length) {
      const e = enriched[0];
      return json(200, {
        ok: true, id: cardId, keywords: e.keywords, source_lang: e.source_lang, moved: e.moved,
        filled: e.filled, translation_failed: e.translation_failed,
        // every language block the card now has, so the page can show them
        // without fetching all four languages again
        texts: e.body,
      });
    }
    return json(502, { ok: false, id: cardId, error: failed[0]?.reason || 'enrichment failed' });
  } catch (err) {
    return json(502, { ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});
