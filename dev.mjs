// Yerel geliştirme sunucusu: public/ klasörünü ve /api/a ucunu Vercel'deki gibi sunar.
// Çalıştır: npm run dev   →   http://localhost:3000
// Redis ortam değişkenleri yoksa veriler bellekte tutulur (tek süreç için yeterli).
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/a.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const cfg = JSON.parse(await readFile(new URL('./vercel.json', import.meta.url), 'utf8'));
const headers = (cfg.headers && cfg.headers[0] && cfg.headers[0].headers) || [];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};
const port = Number(process.env.PORT) || 3000;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for (const h of headers) res.setHeader(h.key, h.value);
    if (url.pathname === '/api/a') return handler(req, res);

    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!extname(p)) p += '.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) {
      res.statusCode = 403;
      return res.end();
    }
    try {
      const buf = await readFile(file);
      res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end('404');
    }
  })
  .listen(port, () => console.log(`kimse → http://localhost:${port}`));
