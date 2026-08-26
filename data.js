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

  /* ---- public API ---------------------------------------------------------- */

  /* Loads the knowledge cards for `lang`. Resolves to an array of cards in
     the feed's own shape, or null when the table is empty, unreachable, or
     not configured — null tells the caller to keep the hardcoded seed cards
     (the safety net until the backfill lands). Never rejects. */
  async function loadCards(lang) {
    if (!isConfigured()) return null;
    if (cardCache[lang]) return cardCache[lang];
    try {
      const rows = await rpc('get_knowledge_items', { lang: lang });
      if (!Array.isArray(rows) || rows.length === 0) return null;
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

  return { isConfigured, loadCards, hasRemote };
})();

// Explicit, because a top-level `const` never becomes a window property —
// loom_feed.html probes `window.LoomData` so a missing/failed data.js
// degrades to the seed cards instead of a ReferenceError.
window.LoomData = LoomData;
