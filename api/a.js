// Vercel Function: sitenin tek API ucu. Bütün işlemler POST /api/a { op, ... } ile gelir.
import { handle } from '../lib/core.js';

function clientIp(req) {
  const h = req.headers;
  const real = h['x-real-ip'];
  if (real) return String(Array.isArray(real) ? real[0] : real);
  const fwd = h['x-forwarded-for'];
  if (fwd) return String(Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

async function readBody(req) {
  let b;
  try {
    b = req.body; // Vercel gövdeyi hazır verebilir; bozuk JSON'da erişim hata fırlatır
  } catch {
    return null;
  }
  if (b === undefined) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 100_000) return null;
      chunks.push(c);
    }
    b = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  return b && typeof b === 'object' ? b : null;
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('{"ok":false,"err":"method"}');
    return;
  }
  let out;
  try {
    out = await handle(await readBody(req), { ip: clientIp(req) });
  } catch (e) {
    // Günlüğe yalnızca hata metni düşer; IP ya da istek içeriği yazılmaz.
    console.error('api hata:', (e && e.message) || e);
    res.statusCode = 500;
    res.end('{"ok":false,"err":"server"}');
    return;
  }
  res.statusCode = out.err === 'bad' ? 400 : out.err === 'slow' ? 429 : 200;
  res.end(JSON.stringify(out));
}
