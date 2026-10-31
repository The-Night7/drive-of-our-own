// Relay for the in-site PDF reader (Vercel Edge Function): GET /api/pdf?id=<Drive file id>
//
// Google answers a browser's own request for a Drive file with a 403 (it looks at the
// Sec-Fetch-* headers browsers add), so the browser can't read the PDF itself. This function
// fetches it server-side and streams it back. Nothing is stored or cached on our side
// (Cache-Control: private), and only PDFs are relayed.
//
// Keep this file free of imports and in /api only: every file in /api becomes a function.

export const config = { runtime: 'edge' };

const MAX_BYTES = 80 * 1024 * 1024;
const ID = /^[\w-]{20,80}$/;

const fail = (status, message) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export default async function handler(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!ID.test(id)) return fail(400, 'bad id');

  // Only the site's own pages may use the relay (a browser sets Sec-Fetch-Site; otherwise fall back to Referer).
  const site = request.headers.get('sec-fetch-site');
  const referer = request.headers.get('referer') || '';
  if (!(site === 'same-origin' || (!site && referer.startsWith(`${url.origin}/`)))) return fail(403, 'forbidden');

  let upstream;
  try {
    upstream = await fetch(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; drive-of-our-own reader)' },
      redirect: 'manual',
    });
  } catch {
    return fail(502, 'could not reach Google Drive');
  }
  // A redirect means Google wants a sign-in: the file isn't public.
  if (upstream.status >= 300 && upstream.status < 400) return fail(404, 'not public');
  if (upstream.status === 429) return fail(429, 'download limit reached');
  if (upstream.status === 404) return fail(404, 'not found');
  if (!upstream.ok || !upstream.body) return fail(502, `Google answered ${upstream.status}`);

  const declared = Number(upstream.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) {
    upstream.body.cancel();
    return fail(413, 'file too large');
  }

  // Check the first bytes: Google's quota and virus-scan pages are HTML, not a PDF.
  const reader = upstream.body.getReader();
  const first = await reader.read();
  const head = first.value ? new TextDecoder('latin1').decode(first.value.subarray(0, 64)) : '';
  if (!head.startsWith('%PDF')) {
    reader.cancel();
    return fail(/^\s*<(!doctype|html)/i.test(head) ? 429 : 415, 'not a PDF (quota page or another format)');
  }

  let sent = first.value.length;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      sent += value.length;
      if (sent > MAX_BYTES) {
        reader.cancel();
        return controller.error(new Error('file too large'));
      }
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });

  const headers = {
    'content-type': 'application/pdf',
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  };
  if (declared) headers['content-length'] = String(declared);
  return new Response(body, { headers });
}
