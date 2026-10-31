import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../api/file.js';

const ID = '16bIZb4WIpf6dNNXQEv3ZQE7RlYGHQFIs';
const req = (id = ID, headers = { 'sec-fetch-site': 'same-origin' }, kind = 'pdf') => new Request(`https://site.test/api/file?id=${id}&kind=${kind}`, { headers });
const withUpstream = async (fake, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};
const pdfBytes = new TextEncoder().encode('%PDF-1.4\n' + 'x'.repeat(5000));

test('relays a PDF and keeps it private', async () => {
  const res = await withUpstream(new Response(pdfBytes, { status: 200, headers: { 'content-length': String(pdfBytes.length) } }), () => handler(req()));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('cache-control'), /private/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), pdfBytes);
});

test('rejects bad ids and requests that do not come from the site', async () => {
  assert.equal((await handler(req('short'))).status, 400);
  assert.equal((await handler(req(ID, {}))).status, 403);
  assert.equal((await handler(req(ID, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  const viaReferer = await withUpstream(new Response(pdfBytes), () => handler(req(ID, { referer: 'https://site.test/?q=x' })));
  assert.equal(viaReferer.status, 200);
  const foreignReferer = await handler(req(ID, { referer: 'https://evil.test/' }));
  assert.equal(foreignReferer.status, 403);
});

test('a private file (redirect to sign-in) is a 404, not a crash', async () => {
  const res = await withUpstream(new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/x' } }), () => handler(req()));
  assert.equal(res.status, 404);
});

test('Google quota / interstitial pages (HTML) are not relayed', async () => {
  const res = await withUpstream(new Response('<!DOCTYPE html><html>Quota exceeded</html>', { status: 200 }), () => handler(req()));
  assert.equal(res.status, 429);
});

test('only the requested kind: a zip is not a PDF, a PDF is not an EPUB', async () => {
  const zip = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0]);
  assert.equal((await withUpstream(new Response(zip, { status: 200 }), () => handler(req()))).status, 415);
  assert.equal((await withUpstream(new Response(pdfBytes, { status: 200 }), () => handler(req(ID, undefined, 'epub')))).status, 415);
});

test('relays an EPUB (zip) with its own content type', async () => {
  const epub = new Uint8Array([0x50, 0x4b, 3, 4, ...new Uint8Array(3000).fill(7)]);
  const res = await withUpstream(new Response(epub, { status: 200 }), () => handler(req(ID, undefined, 'epub')));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/epub+zip');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), epub);
});

test('the kind is required and must be known', async () => {
  assert.equal((await handler(new Request(`https://site.test/api/file?id=${ID}`, { headers: { 'sec-fetch-site': 'same-origin' } }))).status, 400);
  assert.equal((await handler(req(ID, undefined, 'exe'))).status, 400);
});

test('oversized files are refused up front', async () => {
  const res = await withUpstream(new Response(pdfBytes, { status: 200, headers: { 'content-length': String(200 * 1024 * 1024) } }), () => handler(req()));
  assert.equal(res.status, 413);
});

test('upstream errors map to clean statuses', async () => {
  assert.equal((await withUpstream(new Response('', { status: 429 }), () => handler(req()))).status, 429);
  assert.equal((await withUpstream(new Response('', { status: 500 }), () => handler(req()))).status, 502);
});
