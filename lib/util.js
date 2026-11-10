import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { now } from './clock.js';

export const rid = (n = 16) => randomBytes(n).toString('base64url');

function expand6(ip) {
  let s = ip;
  const tail = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    s = s.slice(0, tail.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const parts = s.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  if (parts.length === 1) return head.map((x) => (parseInt(x, 16) || 0).toString(16));
  const rest = parts[1] ? parts[1].split(':') : [];
  const fill = Array(Math.max(0, 8 - head.length - rest.length)).fill('0');
  return [...head, ...fill, ...rest].map((x) => (parseInt(x, 16) || 0).toString(16));
}

/**
 * IP'yi engelleme birimine indirger: IPv4 olduğu gibi, IPv6 /64 ağ öneki olarak.
 * (IPv6'da tek kullanıcı aynı /64 içinde sınırsız adres değiştirebilir.)
 */
export function normIp(raw) {
  let ip = String(raw ?? '').trim().toLowerCase();
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  }
  const pct = ip.indexOf('%');
  if (pct >= 0) ip = ip.slice(0, pct);
  if (isIP(ip) === 0 && /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) ip = mapped[1];
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v === 6) return expand6(ip).slice(0, 4).join(':') + '::/64';
  return 'unknown';
}

/** Sunucu sırrından türetilen araçlar: mühürlü jeton, IP özeti. */
export function makeSealer(secret) {
  const key = Buffer.from(hkdfSync('sha256', secret, 'chat', 'seal', 32));
  const macKey = Buffer.from(hkdfSync('sha256', secret, 'chat', 'iph', 32));
  return {
    /** Nesneyi şifreleyip imzalar; istemci içeriğini okuyamaz, değiştiremez. */
    seal(obj) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
      return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
    },
    /** Geçersiz, oynanmış ya da süresi dolmuş jeton için null döner. */
    open(tok) {
      try {
        if (typeof tok !== 'string' || tok.length > 2000) return null;
        const b = Buffer.from(tok, 'base64url');
        if (b.length < 30) return null;
        const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        d.setAuthTag(b.subarray(b.length - 16));
        const pt = Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
        const o = JSON.parse(pt.toString('utf8'));
        if (!o || typeof o.e !== 'number' || o.e * 1000 < now()) return null;
        return o;
      } catch {
        return null;
      }
    },
    /** IP'nin geri döndürülemez özeti. Ham IP hiçbir yere yazılmaz. */
    iph(ip) {
      return createHmac('sha256', macKey).update(normIp(ip)).digest('base64url').slice(0, 22);
    },
  };
}

export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}
