/* ============================================================================
   Loom — data access layer (Shared Knowledge Model v0.1).

   ALL network data access lives in this file, by rule: screen code calls the
   functions on `LoomData` and never talks to Supabase (or any future in-house
   server) itself. Swapping the backend later means rewriting this file and
   nothing else.

   Read phase only. Writes are locked at the database (RLS: read public /
   write locked), so nothing here mutates anything.

   Egress discipline (Supabase free plan):
     - One request per (page load, language): the get_knowledge_items RPC
       returns feed-ready rows with exactly ONE language block per card
       (body->{lang}, falling back server-side to body->{source_lang}),
       appliedBy already aggregated, and author names already joined.
     - Results are cached per language for the session; switching back to a
       language already seen costs nothing.
     - Image bytes never travel through Supabase — cards carry GitHub Pages
       asset paths only.
   ============================================================================ */

const LoomData = (function () {
  'use strict';

  /* The anon key is public by design (it ships to every browser anyway);
     row-level security is the actual boundary — anon can read, not write. */
  const SUPABASE_URL = 'https://gfyfdfdxidiuzdiiehea.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmeWZkZmR4aWRpdXpkaWllaGVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3MDg1MDMsImV4cCI6MjEwMzI4NDUwM30.0vq0ttz3oLdMPHWYVLGjeQB6ON6UCXBbPdB8ipl8ekw';

  const REQUEST_TIMEOUT_MS = 8000;

  // lang → array of mapped cards. null-able entries are never stored: a
  // failed or empty fetch leaves the key absent so a retry stays possible.
  const cardCache = {};

  // Whether the last successful load actually had rows. Screens use this
  // only indirectly (loadCards returns null when there is nothing), but it
  // makes "is the DB live?" answerable from the console.
  let remoteLive = false;

  function isConfigured() {
    return SUPABASE_ANON_KEY.indexOf('PASTE_') !== 0 && !!SUPABASE_URL;
  }

  async function rpc(name, params) {
    const qs = Object.keys(params || {})
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
      .join('&');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/rpc/' + name + (qs ? '?' + qs : ''),
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
          },
          signal: controller.signal,
        }
      );
      if (!res.ok) throw new Error('RPC ' + name + ' → HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- row → card ----------------------------------------------------------
     The card shape is exactly what loom_feed.html already renders (see CARDS
     and buildSharedCardEntry there): the screen must not be able to tell a
     remote card from a seed card except by `isRemote`. */

  // Relative age in the feed's timeValue/timeUnit vocabulary. Seeded demo
  // cards carry a pinned demo_age instead (staged times must not drift as
  // real days pass); anything without one is aged from created_at.
  function ageOf(createdAtIso) {
    const ms = Date.now() - new Date(createdAtIso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return { justNow: true, timeValue: 0, timeUnit: 'minute' };
    if (mins < 60) return { timeValue: mins, timeUnit: 'minute' };
    const hours = Math.floor(mins / 60);
    if (hours < 24) return { timeValue: hours, timeUnit: 'hour' };
    const days = Math.floor(hours / 24);
    if (days < 7) return { timeValue: days, timeUnit: 'day' };
    if (days < 30) return { timeValue: Math.floor(days / 7), timeUnit: 'week' };
    return { timeValue: Math.max(1, Math.floor(days / 30)), timeUnit: 'month' };
  }

  function toCard(row) {
    const age = row.demo_age
      ? {
          timeValue: row.demo_age.value,
          timeUnit: row.demo_age.unit,
          justNow: !!row.demo_age.justNow,
        }
      : ageOf(row.created_at);
    const img = row.image || null;
    return {
      id: row.id,
      studio: row.studio,               // originated_from
      type: row.type,
      author: row.author || '',         // documented_by display name
      sharedByName: row.shared_by_name || null, // shared_by — data kept even
                                                // where the UI has no slot yet
      justNow: age.justNow || undefined,
      timeValue: age.timeValue,
      timeUnit: age.timeUnit,
      appliedBy: row.applied_by || [],  // distinct studios from applications
      image: img ? img.path || null : null,
      imageFit: (img && img.fit) || undefined,
      imageBg: (img && img.bg) || undefined,
      imageFocal: (img && img.focal) || undefined,
      // resolved canvas attachments: [{label, url?, bytes?, mime?}] — files
      // live in the public Storage bucket, label-only entries stay as text
      attachments: row.attachments || [],
      relatedTo: row.related_to || [],
      derivedFrom: row.derived_from || null,
      derivedRelation: row.relation_type || undefined,
      derivedNote: row.relation_note || undefined,
      status: row.status || undefined,
      askedTo: row.asked_to || undefined,
      conversation: row.conversation || undefined, // skeleton; texts sit in
                                                   // text.conversation, zipped
                                                   // by getConversationMessages
      keywords: row.keywords || [],
      link: row.link || undefined,
      sourceLang: row.source_lang,
      isRemote: true,
      // One resolved language block: title, summary, body fields, brief,
      // conversation texts — whatever the backfill put in body->{lang}.
      text: row.txt || {},
    };
  }

  /* ---- roster (Designers) ---------------------------------------------------
     persons is publicly readable (RLS read_all from 0001), so this is a plain
     table select — a handful of rows, no RPC needed. Mapped straight into the
     designer shape the feed renders, cached for the session. null = unknown
     (offline/failed): the caller keeps whatever roster it has. */
  let rosterCache = null;

  function rowToDesigner(r) {
    return {
      id: r.id,
      studio: r.studio_id,
      name: r.name,
      roleKey: r.role_key || '',
      photo: r.photo_path || null,
      photoPos: r.photo_pos || null,
      workingOn: r.working_on || '',
      canHelp: r.can_help || '',
      links: r.links || {},
    };
  }

  async function loadRoster() {
    if (!isConfigured()) return null;
    if (rosterCache) return rosterCache;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/persons?on_roster=eq.true' +
          '&select=id,studio_id,name,role_key,photo_path,photo_pos,working_on,can_help,links&order=id',
        {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
          signal: controller.signal,
        }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      if (!Array.isArray(rows)) return null;
      rosterCache = rows.map(rowToDesigner);
      return rosterCache;
    } catch (err) {
      console.warn('[Loom data] roster load failed:', err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- roster writes ---------------------------------------------------------
     Same contract as submitCard: never rejects, {ok:false, reason,
     invalidCode?} on failure, caches updated on success so the screen can
     re-render without refetching. Photos go through the roster-photo Edge
     Function (anon cannot write Storage); text through the RPC. */

  function rosterCachePut(designer) {
    if (!rosterCache) return;
    const i = rosterCache.findIndex((d) => d.id === designer.id);
    if (i >= 0) rosterCache[i] = designer;
    else rosterCache.push(designer);
  }

  async function rosterRpc(payload, code) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/submit_roster_edit', {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payload: payload, code: code }),
        signal: controller.signal,
      });
      const json = await res.json().catch(function () { return null; });
      if (!res.ok) {
        const message = (json && json.message) || '';
        return { ok: false, reason: 'rejected', invalidCode: /invalid code/i.test(message), message: message };
      }
      return { ok: true, row: json };
    } catch (err) {
      return { ok: false, reason: 'network', message: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* Saves one designer (the editor's shape). id null/designer-… = create. */
  async function submitRosterEdit(designer, code) {
    if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
    const payload = {
      action: 'upsert',
      // ids minted locally by the editor ('designer-…') are not persons ids —
      // sending null lets the RPC create the canonical row
      id: designer.id && designer.id.indexOf('designer-') !== 0 ? designer.id : null,
      studio: designer.studio,
      name: designer.name,
      role: designer.role || designer.roleKey || '',
      working_on: designer.workingOn || '',
      can_help: designer.canHelp || '',
      links: designer.links || {},
      photo_pos: designer.photoPos || null,
    };
    const res = await rosterRpc(payload, code);
    if (!res.ok) return res;
    const saved = rowToDesigner(res.row);
    rosterCachePut(saved);
    return { ok: true, person: saved };
  }

  async function removeRosterPerson(id, code) {
    if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
    const res = await rosterRpc({ action: 'remove', id: id }, code);
    if (!res.ok) return res;
    if (rosterCache) rosterCache = rosterCache.filter(function (d) { return d.id !== id; });
    return { ok: true };
  }

  /* Uploads a dataURL photo for an EXISTING person via the roster-photo
     function; resolves {ok, photo_path} and updates the cache. */
  async function uploadRosterPhoto(personId, dataUrl, code) {
    if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000); // an image is bigger than a row
    try {
      const res = await fetch(SUPABASE_URL + '/functions/v1/roster-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, person_id: personId, image: dataUrl }),
        signal: controller.signal,
      });
      const json = await res.json().catch(function () { return null; });
      if (!res.ok || !json || !json.ok) {
        const message = (json && json.error) || '';
        return { ok: false, reason: res.status === 401 ? 'rejected' : 'failed', invalidCode: res.status === 401, message: message };
      }
      if (rosterCache) {
        const p = rosterCache.find(function (d) { return d.id === personId; });
        if (p) p.photo = json.photo_path;
      }
      return { ok: true, photo_path: json.photo_path };
    } catch (err) {
      return { ok: false, reason: 'network', message: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- write path ----------------------------------------------------------
     The tables stay locked for anon; submit_card is the one door in, and it
     opens only to a valid shared write code (checked server-side, value never
     in this repo). Everything here mirrors what the RPC will accept — the
     server whitelist is the real boundary, this just avoids sending junk. */

  // The share form's text object, minus empty/non-string fields.
  function pickText(text) {
    const out = {};
    for (const k of Object.keys(text || {})) {
      const v = text[k];
      if (typeof v === 'string' && v.trim().length) out[k] = v;
    }
    return out;
  }

  /* Folds a just-accepted submission into the per-language caches so the feed
     can swap its localStorage copy for the DB-backed card without refetching.
     The card mirrors what a get_knowledge_items reload will return: one
     source-language block served to every language (the RPC's coalesce), the
     studio team person as author, question conversation split skeleton/text. */
  function registerSubmitted(payload, row) {
    const isQuestion = payload.type === 'question';
    const txt = isQuestion
      ? Object.assign({}, payload.text, {
          conversation: [payload.text.blocked || payload.text.title],
        })
      : payload.text;
    const card = toCard({
      id: row.id,
      type: payload.type,
      studio: payload.studio,
      author: row.author || '',
      shared_by_name: null,
      keywords: payload.keywords,
      related_to: [],
      derived_from: null,
      relation_type: null,
      relation_note: null,
      status: isQuestion ? 'open' : null,
      asked_to: payload.asked_to,
      image: null,
      link: payload.link,
      source_lang: payload.source_lang,
      demo_age: null,
      created_at: row.created_at,
      conversation: isQuestion
        ? [{ author: row.author || payload.studio, studio: payload.studio, justNow: true }]
        : null,
      applied_by: [],
      txt: txt,
    });
    for (const lang of Object.keys(cardCache)) cardCache[lang].unshift(card);
    remoteLive = true;
  }

  /* Submits a card built by the share form. Resolves to:
       { ok: true,  id }                       — saved; caches already updated
       { ok: false, reason, invalidCode?, message? }
         reason 'rejected'     — the RPC said no (bad code, invalid payload)
         reason 'network'      — offline/timeout; nothing reached the server
         reason 'unconfigured' — no Supabase constants
     Never rejects; the caller's localStorage copy is the fallback either way. */
  async function submitCard(entry, code) {
    if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
    const payload = {
      id: entry.id,
      type: entry.type,
      studio: entry.studio,
      source_lang: entry.sourceLang || 'en',
      keywords: (entry.keywords || []).slice(0, 10),
      asked_to: entry.askedTo || null,
      link: entry.link || null,
      text: pickText(entry.text),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/submit_card', {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payload: payload, code: code }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let message = '';
        try { message = (await res.json()).message || ''; } catch (err) { /* no body */ }
        return {
          ok: false,
          reason: 'rejected',
          invalidCode: /invalid code/i.test(message),
          message: message,
        };
      }
      const row = await res.json(); // { id, created_at, author }
      registerSubmitted(payload, row);
      return { ok: true, id: row.id };
    } catch (err) {
      return { ok: false, reason: 'network', message: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- public API ---------------------------------------------------------- */

  /* Loads the knowledge cards for `lang`. Resolves to an array of cards in
     the feed's own shape — possibly EMPTY, which is the truth, not a failure
     (the DB is the source of record; the canvas sync replaces its content
     atomically, so a legitimate empty only happens if the canvas is empty).
     Resolves to null ONLY when the answer is unknown: not configured, offline,
     or the request failed — that is the one case the caller may fall back to
     the hardcoded seed (an offline-demo insurance, knowingly stale). */
  async function loadCards(lang) {
    if (!isConfigured()) return null;
    if (cardCache[lang]) return cardCache[lang];
    try {
      const rows = await rpc('get_knowledge_items', { lang: lang });
      if (!Array.isArray(rows)) return null;
      const cards = rows.map(toCard);
      cardCache[lang] = cards;
      remoteLive = true;
      return cards;
    } catch (err) {
      console.warn('[Loom data] remote load failed (' + lang + '):', err);
      return null;
    }
  }

  function hasRemote() {
    return remoteLive;
  }

  return {
    isConfigured, loadCards, hasRemote, submitCard,
    loadRoster, submitRosterEdit, removeRosterPerson, uploadRosterPhoto,
  };
})();

// Explicit, because a top-level `const` never becomes a window property —
// loom_feed.html probes `window.LoomData` so a missing/failed data.js
// degrades to the seed cards instead of a ReferenceError.
window.LoomData = LoomData;
