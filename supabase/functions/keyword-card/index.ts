/* ============================================================================
   Loom — keyword-card: machine keywords for a question posted from the form.

   A question typed into Home is saved with no keyword (choosing one is the
   friction the field exists to remove), and the Home bands and Threads group
   by keyword — so until something tags it, the person who just asked cannot
   find their own question on the screen they asked from.

   The client calls this the moment submit_card returns, in the background:
   the card is already saved and visible on the Open questions floor, the
   field says "finding its thread…", and when this comes back the card's dot
   arrives in a band. If this call fails (quota, a closed tab) the daily
   canvas-sync run sweeps every form card still without keywords — the same
   pass, same vocabulary — so nothing stays untagged for more than a day.

   Two doors:
     - a member's JWT (Authorization: Bearer <access_token>) + { card_id }
       — checked against auth/v1/user; a guest or the bare anon key cannot
       spend Gemini calls
     - the canvas-sync header secret + { sweep: true } — every pending card,
       for an operator running the sweep by hand

   What it will never do (the view and the RPC enforce it server-side too):
     - touch a canvas card — the sync owns those keywords
     - touch a card a PERSON has tuned (keywords_edited_at) — theirs stay
     - set keywords_edited_at — a machine's guess must not lock the card or
       be attributed to a person

   Secrets (Dashboard → Edge Functions → Secrets): GEMINI_API_KEY and
   CANVAS_SYNC_SECRET, both already set for canvas-sync. SUPABASE_URL,
   SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected.
   Deployed with verify_jwt off (the JWT is verified here, so the sweep door
   can exist). CORS on, because the browser calls this directly.

   The Gemini pieces are a deliberate copy of canvas-sync's so this function
   deploys as one file through the Management API; canvas-sync/index.ts is
   the source of truth if they ever need to change.
   ============================================================================ */

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_TIMEOUT_MS = 30_000;
const SWEEP_LIMIT = 20;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-canvas-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type FormCard = { id: string; type: string; source_lang: string | null; body: Record<string, unknown> | null };

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

// the card's own text, in the language it was typed in — attachments and
// the conversation skeleton are not prose
function pickTextBlock(card: FormCard): { lang: string; block: Record<string, unknown> } {
  const body = card.body || {};
  const lang = card.source_lang && body[card.source_lang] ? card.source_lang : 'en';
  const raw = (body[lang] || body.en || {}) as Record<string, unknown>;
  const { attachments: _a, conversation: _c, ...block } = raw;
  return { lang, block };
}

function buildKeywordPrompt(block: Record<string, unknown>, lang: string, vocab: Map<string, string>) {
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

/* ---- the cards that still need keywords, and the write ---------------------- */
async function fetchPending(url: string, serviceKey: string, cardId: string | null) {
  const filter = cardId ? `&id=eq.${encodeURIComponent(cardId)}` : `&order=created_at.asc&limit=${SWEEP_LIMIT}`;
  const res = await fetch(
    `${url}/rest/v1/form_cards_without_keywords?select=id,type,source_lang,body${filter}`,
    { headers: serviceHeaders(serviceKey) },
  );
  if (!res.ok) throw new Error(`reading pending cards failed: HTTP ${res.status}`);
  return await res.json() as FormCard[];
}

async function assignKeywords(url: string, serviceKey: string, cardId: string, keywords: string[]) {
  const res = await fetch(`${url}/rest/v1/rpc/assign_card_keywords`, {
    method: 'POST',
    headers: serviceHeaders(serviceKey),
    body: JSON.stringify({ card_id: cardId, keywords }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`assign_card_keywords failed: ${JSON.stringify(json)}`);
  return json as { id: string; keywords?: string[]; skipped?: string };
}

async function tagCards(cards: FormCard[], url: string, serviceKey: string, geminiKey: string) {
  const tagged: { id: string; keywords: string[] }[] = [];
  const failed: { id: string; reason: string }[] = [];
  if (!cards.length) return { tagged, failed };
  const vocab = await fetchKeywordVocabulary(url, serviceKey);
  // sequential on purpose: a keyword chosen for one card is offered to the next
  for (const card of cards) {
    try {
      const { lang, block } = pickTextBlock(card);
      const res = await callGemini(geminiKey, buildKeywordPrompt(block, lang, vocab));
      const keywords = normalizeKeywords(res.keywords, vocab);
      if (!keywords.length) { failed.push({ id: card.id, reason: 'gemini returned no usable keyword' }); continue; }
      const written = await assignKeywords(url, serviceKey, card.id, keywords);
      if (written.skipped) failed.push({ id: card.id, reason: written.skipped });
      else tagged.push({ id: card.id, keywords: written.keywords || keywords });
    } catch (err) {
      failed.push({ id: card.id, reason: String(err instanceof Error ? err.message : err).slice(0, 300) });
    }
  }
  return { tagged, failed };
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

  /* Door 2 — the operator sweep, by header secret. */
  const secret = Deno.env.get('CANVAS_SYNC_SECRET');
  if (body.sweep === true) {
    if (!secret || req.headers.get('x-canvas-sync-secret') !== secret) return json(401, { ok: false, error: 'unauthorized' });
    try {
      const pending = await fetchPending(supabaseUrl, serviceKey, null);
      const result = await tagCards(pending, supabaseUrl, serviceKey, geminiKey);
      return json(200, { ok: true, pending: pending.length, ...result });
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
    // not in the view: already tagged, hand-edited, a canvas card, or unknown — nothing to do, and not an error
    if (!pending.length) return json(200, { ok: true, id: cardId, keywords: [], skipped: 'nothing to tag' });
    const { tagged, failed } = await tagCards(pending, supabaseUrl, serviceKey, geminiKey);
    if (tagged.length) return json(200, { ok: true, id: cardId, keywords: tagged[0].keywords });
    return json(502, { ok: false, id: cardId, error: failed[0]?.reason || 'tagging failed' });
  } catch (err) {
    return json(502, { ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});
