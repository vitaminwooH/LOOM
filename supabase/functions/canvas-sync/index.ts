/* ============================================================================
   Loom — canvas-sync Edge Function (stage 1: DRY RUN).

   Reads the Slack channel canvas and parses its entries into Loom-card-shaped
   JSON, returning the result to the caller. Nothing is written anywhere —
   there is deliberately NO database code in this file; the write decision
   (submit_card vs service role) belongs to the next stage.

   Canvas entry template this parses (one entry per block):

     [Aug 14] Title of the entry (Whow · Bengt Ott)
     Type: Project
     What: ...
     How: ...
     Learned: ...
     Next: ...
     Open question: ...
     Related: ...
     Relation: ...
     📎 ...

   Anything that does not match the template is returned in `unparsable`
   with its raw text and a reason — the point of the dry run is to SEE which
   entries the canvas authors wrote off-template, not to hide them.

   Secrets (set in Dashboard → Edge Functions → Secrets, never in this repo):
     SLACK_BOT_TOKEN     xoxb-… — new Loom-only app: channels:read,
                         files:read, canvases:read; bot invited to the channel
     SLACK_CANVAS_ID     F… — the channel canvas's file id (from its URL)
     CANVAS_SYNC_SECRET  shared secret; callers must send it in the
                         x-canvas-sync-secret header

   Slack read path (see the stage-1 research report): canvases.* has no
   content-read method, so the content comes from the file layer —
   files.info → url_private_download → HTML, fetched with the bot token.
   ============================================================================ */

const SLACK_API = 'https://slack.com/api';

/* ---- template vocabulary --------------------------------------------------
   Labels are matched case-insensitively at line starts, with ':' '-' '–' '—'
   or nothing after the label. 📎 marks an attachment line. */
const FIELD_LABELS = [
  'type', 'what', 'how', 'learned', 'next', 'open question', 'related', 'relation',
] as const;
type FieldLabel = (typeof FIELD_LABELS)[number];

// canvas label → Loom card field (the Loom names the write stage will use)
const FIELD_TO_CARD: Record<FieldLabel, string> = {
  'type': 'type',
  'what': 'what',
  'how': 'how',
  'learned': 'learned',
  'next': 'next',
  'open question': 'openQuestion',
  'related': 'related',
  'relation': 'relation',
};

const TYPES = ['update', 'project', 'experiment', 'question'];

// studio names as written by humans → studio ids in the Loom DB
const STUDIO_ALIASES: Record<string, string> = {
  'doubleu': 'doubleu', 'doubleu games': 'doubleu', 'double u': 'doubleu',
  'whow': 'whow', 'whow games': 'whow',
  'paxie': 'paxie',
};

/* ---- HTML → plain text lines ----------------------------------------------
   The canvas downloads as an HTML document. We only need readable lines in
   document order, so: drop non-content subtrees, turn block boundaries into
   newlines, strip the rest of the tags, decode the common entities. */
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

/* ---- entry parsing --------------------------------------------------------
   A block starts at a line that opens with '[', and runs until the next such
   line. The header must be `[date] title (Studio · Name)`; '·', '•', '|' or
   ',' are all accepted between studio and name, because people will type
   whatever their keyboard offers. */
const HEADER_RE = /^\[(.+?)\]\s*(.+?)\s*\((.+?)\s*[·•|,]\s*(.+?)\)\s*$/;
const LABEL_RE = new RegExp(
  '^(' + FIELD_LABELS.map((l) => l.replace(' ', '\\s+')).join('|') + ')\\s*[:：\\-–—]?\\s*(.*)$',
  'i',
);

interface ParsedEntry {
  date: string;
  title: string;
  studioRaw: string;
  studio: string | null;   // normalised id, null when the name isn't a known studio
  author: string;
  isTemplate: boolean;     // the blank "copy me" template block that lives in the canvas
  type: string | null;     // normalised, null when missing/unknown
  fields: Record<string, string>;
  attachments: string[];
  warnings: string[];      // template kept, but something is off (missing type, …)
}

interface UnparsableEntry {
  reason: string;
  raw: string;             // what the author actually wrote, for eyeballing
}

function parseEntries(lines: string[]) {
  // group into blocks: every '['-opening line starts one
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
      preamble.push(line); // canvas title/intro above the first entry
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
      // The template stays in the canvas as the thing people copy, so it
      // will parse forever — mark it so the write stage can filter it by
      // name rather than by accident (its null studio/type would also catch
      // it, but an explicit flag reads better in the review output).
      isTemplate: header[3].trim() === 'Studio' && header[4].trim() === 'Name',
      type: null,
      fields: {},
      attachments: [],
      warnings: [],
    };

    let currentField: string | null = null;
    for (const line of block.slice(1)) {
      // The canvas export is inconsistent about the paperclip: most entries
      // carry the 📎 character, but some come out as the :paperclip:
      // shortcode text (seen in the Aug 12 entry of the real canvas).
      const attach = line.match(/^(?:📎|:paperclip:)\s*(.*)$/);
      if (attach) {
        if (attach[1]) entry.attachments.push(attach[1].trim());
        currentField = null;
        continue;
      }
      const m = line.match(LABEL_RE);
      if (m) {
        const label = m[1].toLowerCase().replace(/\s+/g, ' ') as FieldLabel;
        currentField = FIELD_TO_CARD[label];
        const v = m[2].trim();
        entry.fields[currentField] = v;
      } else if (currentField) {
        // continuation line of the field above
        entry.fields[currentField] = (entry.fields[currentField] + '\n' + line).trim();
      } else {
        entry.warnings.push('line before any field label: "' + line.slice(0, 120) + '"');
      }
    }

    // normalise type out of the fields
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

/* ---- Slack ---------------------------------------------------------------- */
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
  const html = await res.text();
  return { html, title: info.file?.title ?? null };
}

/* ---- handler --------------------------------------------------------------- */
Deno.serve(async (req: Request) => {
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  // Own gate first: nobody reads our Slack content just by knowing the URL.
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

  try {
    const { html, title } = await fetchCanvasHtml(token, canvasId);
    const lines = htmlToLines(html);
    const result = parseEntries(lines);
    return jsonResponse(200, {
      dryRun: true, // stage 1: nothing was written anywhere
      canvas: { id: canvasId, title },
      counts: { parsed: result.parsed.length, unparsable: result.unparsable.length },
      preamble: result.preamble,
      parsed: result.parsed,
      unparsable: result.unparsable,
    });
  } catch (err) {
    return jsonResponse(502, { error: String(err instanceof Error ? err.message : err) });
  }
});
