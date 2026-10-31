import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { Readable } from 'node:stream';
import relay from './api/pdf.js';

// `vite dev` / `vite preview` don't run Vercel functions: serve the PDF relay from the same code.
const localRelay = {
  name: 'local-pdf-relay',
  configureServer: (server) => mount(server.middlewares),
  configurePreviewServer: (server) => mount(server.middlewares),
};
function mount(middlewares) {
  middlewares.use('/api/pdf', async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const out = await relay(new Request(`http://${req.headers.host}${req.originalUrl}`, { headers }));
    res.statusCode = out.status;
    out.headers.forEach((v, k) => res.setHeader(k, v));
    if (out.body) Readable.fromWeb(out.body).pipe(res);
    else res.end();
  });
}

export default defineConfig({
  plugins: [react(), localRelay],
  base: './',
});
