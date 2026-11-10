// Redis erişimi. Canlıda Upstash REST, yerelde aynı komutları anlayan bellek içi taklit.
// Kod her iki durumda da ham Redis komut dizileri gönderir: ['SET', anahtar, değer, 'EX', 8]
import { now } from './clock.js';

const URL_ = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const hasRedis = Boolean(URL_ && TOKEN);

async function rest(cmds) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error('redis: ' + ((j && j.error) || r.status));
  return j.map((x) => {
    if (x && x.error) throw new Error('redis: ' + x.error);
    return x ? x.result : null;
  });
}

// --- Bellek içi taklit: yalnızca bu projenin kullandığı komutlar, Redis davranışıyla ---
class Mem {
  constructor() {
    this.d = new Map();
  }

  _get(k) {
    const e = this.d.get(k);
    if (!e) return undefined;
    if (e.x && e.x <= now()) {
      this.d.delete(k);
      return undefined;
    }
    return e;
  }

  _coll(k, type, make) {
    let e = this._get(k);
    if (!e) {
      e = { t: type, v: make(), x: 0 };
      this.d.set(k, e);
    }
    return e;
  }

  exec(c) {
    const op = String(c[0]).toUpperCase();
    const k = c[1] === undefined ? undefined : String(c[1]);
    switch (op) {
      case 'GET': {
        const e = this._get(k);
        return e ? e.v : null;
      }
      case 'SET': {
        let nx = false;
        let get = false;
        let ex = 0;
        for (let i = 3; i < c.length; i++) {
          const o = String(c[i]).toUpperCase();
          if (o === 'NX') nx = true;
          else if (o === 'GET') get = true;
          else if (o === 'EX') ex = Number(c[++i]);
        }
        const old = this._get(k);
        if (nx && old) return get ? old.v : null;
        this.d.set(k, { t: 's', v: String(c[2]), x: ex ? now() + ex * 1000 : 0 });
        return get ? (old ? old.v : null) : 'OK';
      }
      case 'GETDEL': {
        const e = this._get(k);
        if (!e) return null;
        this.d.delete(k);
        return e.v;
      }
      case 'DEL': {
        let n = 0;
        for (const key of c.slice(1)) {
          if (this._get(String(key))) {
            this.d.delete(String(key));
            n++;
          }
        }
        return n;
      }
      case 'EXISTS':
        return this._get(k) ? 1 : 0;
      case 'INCR': {
        const e = this._get(k);
        if (!e) {
          this.d.set(k, { t: 's', v: '1', x: 0 });
          return 1;
        }
        e.v = String(Number(e.v) + 1);
        return Number(e.v);
      }
      case 'EXPIRE': {
        const e = this._get(k);
        if (!e) return 0;
        e.x = now() + Number(c[2]) * 1000;
        return 1;
      }
      case 'TTL': {
        const e = this._get(k);
        if (!e) return -2;
        return e.x ? Math.max(0, Math.ceil((e.x - now()) / 1000)) : -1;
      }
      case 'RPUSH': {
        const e = this._coll(k, 'l', () => []);
        e.v.push(...c.slice(2).map(String));
        return e.v.length;
      }
      case 'LRANGE': {
        const e = this._get(k);
        const a = e ? e.v : [];
        const n = a.length;
        let s = Number(c[2]);
        let t = Number(c[3]);
        if (s < 0) s = Math.max(n + s, 0);
        if (t < 0) t = n + t;
        t = Math.min(t, n - 1);
        return s > t ? [] : a.slice(s, t + 1);
      }
      case 'SADD':
      case 'PFADD': {
        const e = this._coll(k, op === 'SADD' ? 'S' : 'h', () => new Set());
        let n = 0;
        for (const m of c.slice(2).map(String)) {
          if (!e.v.has(m)) {
            e.v.add(m);
            n++;
          }
        }
        return op === 'SADD' ? n : n ? 1 : 0;
      }
      case 'SCARD': {
        const e = this._get(k);
        return e ? e.v.size : 0;
      }
      case 'PFCOUNT': {
        const u = new Set();
        for (const key of c.slice(1)) {
          const e = this._get(String(key));
          if (e) for (const m of e.v) u.add(m);
        }
        return u.size;
      }
      case 'SCAN': {
        let pat = '*';
        for (let i = 2; i < c.length; i++) if (String(c[i]).toUpperCase() === 'MATCH') pat = String(c[i + 1]);
        const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        const keys = [];
        for (const key of [...this.d.keys()]) if (this._get(key) && re.test(key)) keys.push(key);
        return ['0', keys];
      }
      default:
        throw new Error('mem: desteklenmeyen komut ' + op);
    }
  }
}

let mem = new Mem();

/** Testler için: bellek içi veriyi sıfırlar. */
export function resetMem() {
  mem = new Mem();
}

export async function pipe(cmds) {
  if (!cmds.length) return [];
  return hasRedis ? rest(cmds) : cmds.map((c) => mem.exec(c));
}

export async function cmd(c) {
  return (await pipe([c]))[0];
}
