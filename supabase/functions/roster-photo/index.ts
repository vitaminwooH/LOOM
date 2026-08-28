/* ============================================================================
   Loom — roster-photo Edge Function.

   The one thing the Designers editor cannot do through PostgREST: put a
   photo in Storage (anon has no write there, by design). The browser sends
   { code, person_id, image: dataURL }; the shared write code is checked
   against write_codes FIRST (same gate as submit_card / submit_roster_edit),
   the image is resized to ≤800px JPEG regardless of what the client did,
   stored at roster/<person-id>.jpg (the migration's path rule), and
   persons.photo_path gets the public URL with a ?v=<now> cache-buster —
   the path is stable and cached for a year, so the query string is what
   makes a replaced photo actually show up.

   CORS is handled here because this is the first function the BROWSER calls
   directly (canvas-sync only ever hears from curl, pg_net and Slack).
   Deployed with verify_jwt off; the write code is the gate.
   ============================================================================ */

import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';

const BUCKET = 'attachments';
const MAX_EDGE = 800;
const MAX_IMAGE_CHARS = 3_000_000; // ~2.2MB of binary as base64
const PERSON_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json(500, { error: 'service credentials unavailable' });
  const sHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  let body: { code?: string; person_id?: string; image?: string };
  try {
    body = await req.json();
  } catch (_) {
    return json(400, { error: 'invalid json' });
  }
  const { code, person_id, image } = body;
  if (typeof image !== 'string' || image.length > MAX_IMAGE_CHARS) {
    return json(400, { error: 'image missing or too large' });
  }
  if (typeof person_id !== 'string' || !PERSON_ID_RE.test(person_id)) {
    return json(400, { error: 'invalid person_id' });
  }

  /* The gate, before anything else is looked at. Two doors, same as the
     RPCs' write_gate (stage 3, parallel period):
       - a signed-in member's JWT in the Authorization header — the person's
         studio must own the person whose photo this is;
       - the shared code in the body — the previous behaviour, until 0014. */
  let callerStudio: string | null = null;
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer) {
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${bearer}` },
    });
    if (userRes.ok) {
      const user = await userRes.json();
      const profRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?select=studio_id&id=eq.${user.id}&limit=1`,
        { headers: sHeaders },
      );
      const profRows = profRes.ok ? await profRes.json() : [];
      if (Array.isArray(profRows) && profRows.length === 1) callerStudio = profRows[0].studio_id;
    }
  }
  if (!callerStudio) {
    if (typeof code !== 'string' || !code) return json(401, { error: 'invalid code' });
    const gateRes = await fetch(
      `${supabaseUrl}/rest/v1/write_codes?select=code&code=eq.${encodeURIComponent(code)}&active=is.true&limit=1`,
      { headers: sHeaders },
    );
    const gateRows = gateRes.ok ? await gateRes.json() : [];
    if (!Array.isArray(gateRows) || gateRows.length !== 1) return json(401, { error: 'invalid code' });
  }

  // the person must exist — a photo for nobody is a stray file — and on the
  // auth door, must belong to the caller's own studio
  const personRes = await fetch(
    `${supabaseUrl}/rest/v1/persons?select=id,studio_id&id=eq.${encodeURIComponent(person_id)}&limit=1`,
    { headers: sHeaders },
  );
  const personRows = personRes.ok ? await personRes.json() : [];
  if (!Array.isArray(personRows) || personRows.length !== 1) return json(404, { error: 'unknown person' });
  if (callerStudio && personRows[0].studio_id !== callerStudio) {
    return json(403, { error: 'wrong studio' });
  }

  try {
    const m = image.match(/^data:(image\/[a-z+]+);base64,(.+)$/s);
    if (!m) return json(400, { error: 'image must be a base64 data URL' });
    const raw = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));

    // server-side guarantee, whatever the client resized to
    const img = await Image.decode(raw);
    const long = Math.max(img.width, img.height);
    if (long > MAX_EDGE) {
      const scale = MAX_EDGE / long;
      img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
    }
    const jpeg = await img.encodeJPEG(82);

    const path = `roster/${person_id}.jpg`;
    const form = new FormData();
    form.append('cacheControl', '31536000');
    form.append('', new Blob([jpeg as unknown as BlobPart], { type: 'image/jpeg' }), `${person_id}.jpg`);
    const upload = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { ...sHeaders, 'x-upsert': 'true' },
      body: form,
    });
    if (!upload.ok) {
      return json(502, { error: `storage upload failed: ${(await upload.text()).slice(0, 120)}` });
    }

    // stable path + long cache → the version query is what busts the old photo
    const url = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}?v=${Date.now()}`;
    const patch = await fetch(`${supabaseUrl}/rest/v1/persons?id=eq.${encodeURIComponent(person_id)}`, {
      method: 'PATCH',
      headers: { ...sHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_path: url }),
    });
    if (!patch.ok) return json(502, { error: 'photo stored but persons update failed' });

    return json(200, { ok: true, photo_path: url });
  } catch (err) {
    return json(502, { error: String(err instanceof Error ? err.message : err).slice(0, 200) });
  }
});
