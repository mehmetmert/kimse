// Sunucunun bütün işi: iki kişiyi eşleştirmek ve şifreli mesajları aktarmak.
// Sunucu mesaj içeriğini göremez; kimin kiminle konuştuğunu da bir yere yazmaz.
//
// Redis anahtarları (hepsi kısa ömürlü):
//   sl:r / sl:t:<konu>  bekleme yuvası: o an bekleyen tek biletin kimliği
//   tk:<bilet>          bekleyenin "buradayım" işareti, eşleşince eşleşme bilgisi
//   m:<oda>:<a|b>       o tarafın gönderdiği şifreli mesajlar
//   ban:<ipözeti>       engel, rep:/bc:/rl:  bildirim ve hız sayaçları
//   g:<oda> / gm:<oda>  oda sohbeti: şifreli mesaj akışı ve üyelerin renkleri
//   on:<dakika>         çevrimiçi sayacı (HyperLogLog, kimlik saklamaz)
import { now } from './clock.js';
import { cmd, hasRedis, pipe } from './store.js';
import { makeSealer, normIp, rid, safeEqual } from './util.js';

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const CFG = {
  reportThreshold: int(process.env.REPORT_THRESHOLD, 3), // kaç farklı ağdan bildirim gelince engel
  findLimit: int(process.env.RL_FIND, 60), // ağ başına 10 dakikadaki arama sayısı
  adminKey: process.env.ADMIN_KEY || '',
};

// Süreler (saniye)
const T = { ticket: 10, slot: 60, match: 30, list: 120, bye: 45, roomTok: 6 * 3600, ticketTok: 15 * 60 };
const BAN_STEPS_H = [1, 6, 24, 72]; // tekrarlayan otomatik engellerin süresi (saat)
const MAX_OUT = 12; // tek istekte en fazla mesaj
const MAX_ENTRY = 4096; // tek şifreli mesajın en fazla uzunluğu
const MAX_LIST = 4000; // bir tarafın bir sohbette biriktirebileceği kayıt
const PAGE = 200; // tek okumada en fazla kayıt
const ROOM_COLORS = 12; // odada herkesin rengi farklıdır: oda en fazla bu kadar kişi alır
const ROOM_STALE_MS = 30000; // bu kadar sessiz kalan üye gitmiş sayılır
const ROOM_LOG = 400; // odanın stream'inde tutulan en fazla kayıt

const ID = /^[A-Za-z0-9_-]+$/;
const BAD = { ok: false, err: 'bad' };
const EXPIRED = { ok: false, err: 'expired' };

const str = (v, min, max) => (typeof v === 'string' && v.length >= min && v.length <= max && ID.test(v) ? v : null);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const exp = (secs) => Math.floor(now() / 1000) + secs;
const bucket = () => Math.floor(now() / 60000);

// --- Sunucu sırrı: ortam değişkeni yoksa ilk kullanımda üretilip Redis'te tutulur ---
let sealerP = null;
function sealer() {
  if (!sealerP) {
    sealerP = (async () => {
      let s = process.env.APP_SECRET;
      if (!s) {
        s = await cmd(['GET', 'cfg:secret']);
        if (!s) {
          await cmd(['SET', 'cfg:secret', rid(32), 'NX']);
          s = await cmd(['GET', 'cfg:secret']);
        }
      }
      return makeSealer(s);
    })().catch((e) => {
      sealerP = null;
      throw e;
    });
  }
  return sealerP;
}

/** Testler için: sırrı yeniden okutur. */
export function resetCore() {
  sealerP = null;
  hits.clear();
}

// --- Kaba sel koruması (sunucu örneği başına, Redis harcamaz) ---
const hits = new Map();
function allow(iph) {
  const w = Math.floor(now() / 5000);
  let h = hits.get(iph);
  if (!h || h.w !== w) {
    h = { w, n: 0 };
    hits.set(iph, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.w !== w) hits.delete(k);
  }
  return ++h.n <= 300;
}

function banUntil(v) {
  if (!v) return 0;
  const u = parseInt(v, 10);
  return u > now() ? u : 0;
}

async function setBan(id, secs, why) {
  await cmd(['SET', 'ban:' + id, `${now() + secs * 1000}|${why}`, 'EX', secs]);
}

function hbCmds(cid) {
  const k = 'on:' + bucket();
  return [
    ['PFADD', k, cid],
    ['EXPIRE', k, 180],
  ];
}

async function onlineCount() {
  const bk = bucket();
  return Number(await cmd(['PFCOUNT', 'on:' + bk, 'on:' + (bk - 1)])) || 0;
}

async function adminOk(key, iph) {
  if (CFG.adminKey.length < 12 || typeof key !== 'string' || !key) return false;
  const k = 'rl:a:' + iph;
  if ((Number(await cmd(['GET', k])) || 0) >= 8) return false; // deneme kilidi
  if (safeEqual(key, CFG.adminKey)) return true;
  await pipe([
    ['INCR', k],
    ['EXPIRE', k, 900],
  ]);
  return false;
}

// --- Eşleştirme ---
// Rastgele 1'e 1 eşleşmede aynı anda en fazla bir kişi bekler: ikinci gelen onu alır.
// Bu yüzden kuyruk yerine tek bir "yuva" yeter ve her adım tek atomik Redis komutudur.
// Konu ya da ruh hali seçenler o seçimin yuvasında, seçmeyenler genel yuvada bekler.
const TAGS = new Set(['oyun', 'muzik', 'dert', 'film', 'spor']);
const MOODS = new Set(['mutlu', 'uzgun', 'moralsiz', 'sikilmis', 'yalniz', 'heyecanli']);
const slotOf = (tick) =>
  tick.door ? 'sl:d:' + tick.door : tick.tag || tick.mood ? `sl:t:${tick.tag || ''}|${tick.mood || ''}` : 'sl:r';
const waitVal = (tick) => 'W' + JSON.stringify({ pub: tick.pub, i: tick.i, cid: tick.cid });

async function rendezvous(tick, S) {
  const slotKey = slotOf(tick);
  let [, w] = await pipe([
    ['SET', 'tk:' + tick.t, waitVal(tick), 'EX', T.ticket],
    ['GETDEL', slotKey],
  ]);
  for (let i = 0; i < 4; i++) {
    if (i > 0) w = await cmd(['GETDEL', slotKey]);
    if (w && w !== tick.t) {
      // Yuvadaki bileti yalnızca biz aldık. Sahibi hâlâ bekliyor mu?
      const wv = await cmd(['GET', 'tk:' + w]);
      const o = wv && wv[0] === 'W' ? parse(wv.slice(1)) : null;
      if (o && o.cid !== tick.cid && typeof o.pub === 'string' && typeof o.i === 'string') {
        const room = rid(12);
        const e = exp(T.roomTok);
        // Jeton karşı tarafın IP özetini şifreli taşır: bildirim için sunucuda oda kaydı tutmak gerekmez.
        const tokA = S.seal({ k: 'r', r: room, s: 'a', p: tick.i, e });
        const tokB = S.seal({ k: 'r', r: room, s: 'b', p: o.i, e });
        await pipe([
          ['SET', 'tk:' + w, 'M' + JSON.stringify({ tok: tokA, slot: 'a', room, peerPub: tick.pub }), 'EX', T.match],
          ['DEL', 'tk:' + tick.t],
        ]);
        return { matched: { tok: tokB, slot: 'b', room, peerPub: o.pub } };
      }
      continue; // bilet ölü (sahibi gitmiş): at, yuvaya yeniden bak
    }
    const ok = await cmd(['SET', slotKey, tick.t, 'NX', 'EX', T.slot]);
    if (ok) return { waiting: true, inSlot: true };
  }
  return { waiting: true, inSlot: false };
}

async function find(b, S, iph) {
  const cid = str(b.cid, 8, 40);
  const pub = str(b.pub, 40, 140);
  const door = b.door == null || b.door === '' ? '' : str(b.door, 16, 32);
  const tag = b.tag == null || b.tag === '' ? '' : TAGS.has(b.tag) ? b.tag : null;
  const mood = b.mood == null || b.mood === '' ? '' : MOODS.has(b.mood) ? b.mood : null;
  if (!cid || !pub || door === null || tag === null || mood === null) return BAD;

  const win = Math.floor(now() / 600000);
  const rl = `rl:f:${iph}:${win}`;
  const [ban, n] = await pipe([
    ['GET', 'ban:' + iph],
    ['INCR', rl],
    ['EXPIRE', rl, 660],
  ]);
  const until = banUntil(ban);
  if (until) return { ok: false, err: 'ban', until };
  if (Number(n) > CFG.findLimit) {
    return { ok: false, err: 'rate', retry: Math.ceil(((win + 1) * 600000 - now()) / 1000) };
  }

  const tick = { k: 't', t: rid(12), cid, pub, door, tag, mood, i: iph, e: exp(T.ticketTok) };
  return { ok: true, tk: S.seal(tick), ...(await rendezvous(tick, S)) };
}

async function wait(b, S) {
  const tick = S.open(b.tk);
  if (!tick || tick.k !== 't') return EXPIRED;
  const slotKey = slotOf(tick);
  // Yuvada mıyım kontrolü istemci isteyince yapılır (her yoklamada değil): bekleyen kişi az komut harcasın.
  const chk = Boolean(b.chk || b.re);
  const cmds = [['SET', 'tk:' + tick.t, waitVal(tick), 'EX', T.ticket, 'GET']]; // "buradayım" + varsa eşleşmeyi al
  if (chk) cmds.push(['GET', slotKey]);
  if (b.hb) cmds.push(...hbCmds(tick.cid));
  const [old, slot] = await pipe(cmds);

  if (old && old[0] === 'M') {
    const m = parse(old.slice(1));
    if (m) {
      await cmd(['DEL', 'tk:' + tick.t]);
      return { ok: true, matched: m };
    }
  }
  if (!chk) return { ok: true, waiting: true };
  if (slot === tick.t) {
    if (b.keep) await cmd(['EXPIRE', slotKey, T.slot]);
    return { ok: true, waiting: true, inSlot: true };
  }
  // Yuvada değiliz. İstemci bunu art arda iki kez görürse (yoldaki bir eşleşmeye pay bırakıp) yeniden girer.
  if (b.re) return { ok: true, ...(await rendezvous(tick, S)) };
  return { ok: true, waiting: true, inSlot: false };
}

// --- Sohbet aktarımı ---
// Her tarafın bir listesi var. Kayıt türleri: 'm…' şifreli mesaj, 'p' hayattayım, 'x' ayrıldım.
async function sync(b, S) {
  const tok = S.open(b.tok);
  if (!tok || tok.k !== 'r') return EXPIRED;
  const cur = Number.isInteger(b.cur) && b.cur >= 0 ? b.cur : 0;
  const out = Array.isArray(b.out) ? b.out : [];
  if (out.length > MAX_OUT) return BAD;
  const entries = [];
  for (const x of out) {
    if (!str(x, 1, MAX_ENTRY)) return BAD;
    entries.push('m' + x);
  }
  if (b.ping) entries.push('p');

  const mine = `m:${tok.r}:${tok.s}`;
  const peer = `m:${tok.r}:${tok.s === 'a' ? 'b' : 'a'}`;
  const cmds = [];
  if (entries.length) cmds.push(['RPUSH', mine, ...entries], ['EXPIRE', mine, T.list]);
  cmds.push(['LRANGE', peer, cur, cur + PAGE - 1]);
  const cid = b.hb ? str(b.cid, 8, 40) : null;
  if (cid) cmds.push(...hbCmds(cid));

  const res = await pipe(cmds);
  if (entries.length && Number(res[0]) > MAX_LIST) return { ok: false, err: 'full' };
  const list = res[entries.length ? 2 : 0] || [];
  return { ok: true, in: list, cur: cur + list.length };
}

async function leave(b, S) {
  if (b.tk) {
    const tick = S.open(b.tk);
    if (tick && tick.k === 't') await cmd(['DEL', 'tk:' + tick.t]);
  }
  if (b.tok) {
    const tok = S.open(b.tok);
    if (tok && tok.k === 'r') {
      const mine = `m:${tok.r}:${tok.s}`;
      const peer = `m:${tok.r}:${tok.s === 'a' ? 'b' : 'a'}`;
      // Veda işaretini bırak, iki listeyi de kısa süre sonra kendiliğinden sildir.
      await pipe([
        ['RPUSH', mine, 'x'],
        ['EXPIRE', mine, T.bye],
        ['EXPIRE', peer, T.bye],
      ]);
    }
    if (tok && tok.k === 'g') await roomLeave(tok);
  }
  return { ok: true };
}

// --- Oda sohbeti: aynı linki açan birden fazla kişi ---
// Üyeler bir hash'te durur: alan = renk sırası, değer = "üye|sonGörülme". Renk alanı tek kişiye
// verildiği için (HSETNX) odada iki kişi aynı rengi alamaz; oda en fazla renk sayısı kadar kişi alır.
// Mesajlar bir stream'e eklenir; herkes kendi kaldığı yerden okur. Sunucu içeriği göremez,
// yalnızca her kaydın başına gönderen üyenin kimliğini yazar.
const roomKeys = (r) => ({ log: 'g:' + r, mem: 'gm:' + r });

function roomMembers(flat) {
  const list = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [m, t] = String(flat[i + 1]).split('|');
    list.push({ c: Number(flat[i]), m, t: Number(t) });
  }
  return list;
}

const roomAlive = (x) => now() - x.t < ROOM_STALE_MS;
const logAdd = (K, d) => ['XADD', K.log, 'MAXLEN', '~', ROOM_LOG, '*', 'd', d];

async function roomJoin(b, S, iph) {
  const cid = str(b.cid, 8, 40);
  const room = str(b.room, 16, 32);
  if (!cid || !room) return BAD;

  const win = Math.floor(now() / 600000);
  const rl = `rl:f:${iph}:${win}`;
  const K = roomKeys(room);
  const [ban, n, , flat] = await pipe([
    ['GET', 'ban:' + iph],
    ['INCR', rl],
    ['EXPIRE', rl, 660],
    ['HGETALL', K.mem],
  ]);
  const until = banUntil(ban);
  if (until) return { ok: false, err: 'ban', until };
  if (Number(n) > CFG.findLimit) {
    return { ok: false, err: 'rate', retry: Math.ceil(((win + 1) * 600000 - now()) / 1000) };
  }

  const all = roomMembers(flat || []);
  const live = all.filter(roomAlive);
  const dead = all.filter((x) => !roomAlive(x));
  if (dead.length) await cmd(['HDEL', K.mem, ...dead.map((x) => x.c)]); // sessizce gidenlerin rengini boşalt

  const taken = new Set(live.map((x) => x.c));
  const free = [...Array(ROOM_COLORS).keys()].filter((c) => !taken.has(c));
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  const me = rid(6);
  let color = -1;
  for (const c of free) {
    // Aynı anda giren iki kişi aynı renge uzanırsa yalnızca biri alır, diğeri sıradakini dener.
    if (await cmd(['HSETNX', K.mem, c, `${me}|${now()}`])) {
      color = c;
      break;
    }
  }
  if (color < 0) return { ok: false, err: 'full' };

  const [id] = await pipe([logAdd(K, `j${me}|${color}`), ['EXPIRE', K.log, T.list], ['EXPIRE', K.mem, T.list], ...hbCmds(cid)]);
  return {
    ok: true,
    tok: S.seal({ k: 'g', r: room, m: me, c: color, e: exp(T.roomTok) }),
    me,
    color,
    cur: id, // yeni gelen yalnızca girdiği andan sonrasını görür
    members: [...live.map((x) => ({ m: x.m, c: x.c })), { m: me, c: color }],
  };
}

async function roomSync(b, S) {
  const tok = S.open(b.tok);
  if (!tok || tok.k !== 'g') return EXPIRED;
  const cur = typeof b.cur === 'string' && /^\d{1,15}-\d{1,6}$/.test(b.cur) ? b.cur : '0-0';
  const out = Array.isArray(b.out) ? b.out : [];
  if (out.length > MAX_OUT) return BAD;
  for (const x of out) if (!str(x, 1, MAX_ENTRY)) return BAD;
  const K = roomKeys(tok.r);

  let members = null;
  if (b.ping) {
    // Rengim hâlâ bende mi? Uzun süre sessiz kalanın rengi başkasına verilmiş olabilir.
    const mine = await cmd(['HGET', K.mem, tok.c]);
    if (!mine || String(mine).split('|')[0] !== tok.m) return { ok: false, err: 'gone' };
    const res = await pipe([
      ['HSET', K.mem, tok.c, `${tok.m}|${now()}`],
      ['EXPIRE', K.mem, T.list],
      ['HGETALL', K.mem],
    ]);
    members = roomMembers(res[2] || [])
      .filter(roomAlive)
      .map(({ m, c }) => ({ m, c }));
  }

  const cmds = out.map((x) => logAdd(K, `m${tok.m}|${x}`));
  if (out.length) cmds.push(['EXPIRE', K.log, T.list]);
  cmds.push(['XRANGE', K.log, '(' + cur, '+', 'COUNT', PAGE]);
  const cid = b.hb ? str(b.cid, 8, 40) : null;
  if (cid) cmds.push(...hbCmds(cid));
  const res = await pipe(cmds);
  const rows = res[out.length ? out.length + 1 : 0] || [];
  const list = rows.map(([id, f]) => ({ id, d: f[1] }));
  return { ok: true, in: list, cur: list.length ? list[list.length - 1].id : cur, ...(members ? { members } : {}) };
}

async function roomLeave(tok) {
  const K = roomKeys(tok.r);
  const mine = await cmd(['HGET', K.mem, tok.c]);
  if (!mine || String(mine).split('|')[0] !== tok.m) return;
  await pipe([['HDEL', K.mem, tok.c], logAdd(K, 'x' + tok.m), ['EXPIRE', K.log, T.list]]);
}

// --- Bildirim ve engel ---
async function report(b, S, iph) {
  const tok = S.open(b.tok);
  if (!tok || tok.k !== 'r') return EXPIRED;
  const peer = tok.p;

  if (b.adm) {
    // Yönetici: karşı tarafı beklemeden engeller.
    if (!(await adminOk(b.adm, iph))) return { ok: false, err: 'auth' };
    if (peer === iph) return { ok: false, err: 'self' };
    const hours = Math.min(int(b.hours, 24), 24 * 365);
    await setBan(peer, hours * 3600, 'admin');
    return { ok: true, banned: true };
  }

  const first = await cmd(['SET', `rp:${tok.r}:${tok.s}`, '1', 'NX', 'EX', 7200]);
  if (!first || peer === iph) return { ok: true }; // aynı sohbetten ikinci bildirim ya da aynı ağ: sayma
  const [, , n] = await pipe([
    ['SADD', 'rep:' + peer, iph],
    ['EXPIRE', 'rep:' + peer, 86400],
    ['SCARD', 'rep:' + peer],
  ]);
  if (Number(n) >= CFG.reportThreshold) {
    const count = Number(await cmd(['INCR', 'bc:' + peer]));
    await pipe([
      ['EXPIRE', 'bc:' + peer, 30 * 86400],
      ['DEL', 'rep:' + peer],
    ]);
    const hours = BAN_STEPS_H[Math.min(count, BAN_STEPS_H.length) - 1];
    await setBan(peer, hours * 3600, 'auto');
  }
  return { ok: true };
}

async function admin(b, S, iph) {
  if (CFG.adminKey.length < 12) return { ok: false, err: 'noadmin' };
  if (!(await adminOk(b.key, iph))) return { ok: false, err: 'auth' };
  switch (b.act) {
    case 'check':
      return { ok: true };
    case 'list': {
      const keys = [];
      let cur = '0';
      for (let i = 0; i < 20; i++) {
        const [next, part] = await cmd(['SCAN', cur, 'MATCH', 'ban:*', 'COUNT', 200]);
        keys.push(...part);
        cur = String(next);
        if (cur === '0') break;
      }
      const uniq = [...new Set(keys)].slice(0, 500);
      const vals = await pipe(uniq.map((k) => ['GET', k]));
      const bans = uniq
        .map((k, i) => {
          if (!vals[i]) return null;
          const [u, why] = String(vals[i]).split('|');
          return { id: k.slice(4), until: Number(u), why: why || '' };
        })
        .filter((x) => x && x.until > now())
        .sort((a, z) => a.until - z.until);
      return { ok: true, bans, online: await onlineCount() };
    }
    case 'unban': {
      const id = str(b.id, 22, 22);
      if (!id) return BAD;
      await cmd(['DEL', 'ban:' + id, 'bc:' + id, 'rep:' + id]);
      return { ok: true };
    }
    case 'ban': {
      if (typeof b.ip !== 'string' || normIp(b.ip) === 'unknown') return { ok: false, err: 'ip' };
      const id = S.iph(b.ip);
      if (id === iph) return { ok: false, err: 'self' };
      await setBan(id, Math.min(int(b.hours, 24), 24 * 365) * 3600, 'admin');
      return { ok: true, id };
    }
    default:
      return BAD;
  }
}

async function hello(b, iph) {
  const cid = str(b.cid, 8, 40);
  const bk = bucket();
  const res = await pipe([...(cid ? hbCmds(cid) : []), ['PFCOUNT', 'on:' + bk, 'on:' + (bk - 1)], ['GET', 'ban:' + iph]]);
  return { ok: true, online: Number(res[res.length - 2]) || 0, ban: banUntil(res[res.length - 1]) };
}

/** Tek giriş noktası. body: { op, ... }, ctx: { ip } */
export async function handle(body, ctx) {
  if (!body || typeof body !== 'object' || typeof body.op !== 'string') return BAD;
  if (process.env.VERCEL && !hasRedis) return { ok: false, err: 'setup' };
  const S = await sealer();
  const iph = S.iph(ctx.ip);
  if (!allow(iph)) return { ok: false, err: 'slow' };
  switch (body.op) {
    case 'hello':
      return hello(body, iph);
    case 'find':
      return find(body, S, iph);
    case 'wait':
      return wait(body, S);
    case 'sync':
      return sync(body, S);
    case 'leave':
      return leave(body, S);
    case 'rjoin':
      return roomJoin(body, S, iph);
    case 'rsync':
      return roomSync(body, S);
    case 'report':
      return report(body, S, iph);
    case 'admin':
      return admin(body, S, iph);
    default:
      return BAD;
  }
}
