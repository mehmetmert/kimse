// Sunucu mantığı + şifreleme, bellek içi Redis taklidiyle uçtan uca sınanır.
// Çalıştır: npm test
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ADMIN_KEY = 'test-admin-key-123';
process.env.APP_SECRET = 'test-secret';
delete process.env.VERCEL;
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const { setClock } = await import('../lib/clock.js');
const { handle, resetCore } = await import('../lib/core.js');
const { resetMem } = await import('../lib/store.js');
const { normIp } = await import('../lib/util.js');
const { newKeys, openSession, doorId, randId } = await import('../public/e2e.js');
const { EMOJI, ICE, codeOf, aliasesOf, iceOf } = await import('../public/words.js');

let T = 1_800_000_000_000;
setClock(() => T);
const tick = (secs) => {
  T += secs * 1000;
};
function fresh() {
  resetMem();
  resetCore();
  tick(86400);
}

class Client {
  constructor(ip, doorSecret = '') {
    this.ip = ip;
    this.cid = randId(12);
    this.doorSecret = doorSecret;
  }
  call(op, data = {}) {
    return handle({ op, ...data }, { ip: this.ip });
  }
  async find() {
    this.keys = await newKeys();
    const door = this.doorSecret ? await doorId(this.doorSecret) : undefined;
    const r = await this.call('find', { cid: this.cid, pub: this.keys.pub, door });
    if (r.tk) this.tk = r.tk;
    if (r.matched) await this.enter(r.matched);
    return r;
  }
  async wait(extra = {}) {
    const r = await this.call('wait', { tk: this.tk, ...extra });
    if (r.matched) await this.enter(r.matched);
    return r;
  }
  async enter(m) {
    this.m = m;
    this.cur = 0;
    this.seq = 0;
    this.sess = await openSession({
      priv: this.keys.priv,
      myPub: this.keys.pub,
      peerPub: m.peerPub,
      slot: m.slot,
      room: m.room,
      doorSecret: this.doorSecret,
    });
  }
  async sync(texts = [], extra = {}) {
    const out = [];
    for (const x of texts) out.push(await this.sess.seal({ t: 'm', n: ++this.seq, x }));
    const r = await this.call('sync', { tok: this.m.tok, cur: this.cur, out, ...extra });
    if (r.ok) this.cur = r.cur;
    return r;
  }
  async texts(r) {
    const list = [];
    for (const e of r.in) if (e[0] === 'm') list.push((await this.sess.open(e.slice(1)))?.x);
    return list;
  }
}

async function pair(ipA = '10.0.0.1', ipB = '10.0.0.2') {
  const a = new Client(ipA);
  const b = new Client(ipB);
  assert.equal((await a.find()).waiting, true);
  assert.ok((await b.find()).matched);
  assert.ok((await a.wait()).matched);
  return [a, b];
}

test('iki kişi eşleşir, mesajlar şifreli gider ve iki yönde okunur', async () => {
  fresh();
  const [a, b] = await pair();
  assert.equal(a.m.slot, 'a');
  assert.equal(b.m.slot, 'b');
  assert.equal(a.m.room, b.m.room);

  // İki taraf aynı güvenlik kodunu, takma adları ve buz kırıcıyı türetir.
  assert.equal(codeOf(a.sess.seed), codeOf(b.sess.seed));
  assert.deepEqual(aliasesOf(a.sess.seed), aliasesOf(b.sess.seed));
  assert.equal(iceOf(a.sess.seed), iceOf(b.sess.seed));
  const names = aliasesOf(a.sess.seed);
  assert.notEqual(names.a, names.b);

  const sent = await a.sync(['merhaba', 'nasılsın? çğıöşü 🙂']);
  assert.equal(sent.ok, true);
  // Sunucudan geçen metin düz yazı içermez.
  const got = await b.sync(['iyiyim']);
  assert.ok(got.in.every((e) => !e.includes('merhaba')));
  assert.deepEqual(await b.texts(got), ['merhaba', 'nasılsın? çğıöşü 🙂']);
  assert.deepEqual(await a.texts(await a.sync()), ['iyiyim']);

  // İmleç ilerler: aynı mesaj ikinci kez gelmez.
  assert.deepEqual((await b.sync()).in, []);
});

test('yanıt kaybolursa aynı imleçle tekrar okumak mesajı geri getirir', async () => {
  fresh();
  const [a, b] = await pair();
  await a.sync(['bir']);
  const first = await b.call('sync', { tok: b.m.tok, cur: 0, out: [] });
  const again = await b.call('sync', { tok: b.m.tok, cur: 0, out: [] });
  assert.deepEqual(first.in, again.in);
  assert.equal(first.in.length, 1);
});

test('hayat işareti ve veda karşı tarafa ulaşır, veda sonrası liste kendiliğinden silinir', async () => {
  fresh();
  const [a, b] = await pair();
  await a.sync([], { ping: 1 });
  assert.deepEqual((await b.sync()).in, ['p']);
  await a.call('leave', { tok: a.m.tok });
  assert.deepEqual((await b.sync()).in, ['x']);
  tick(46);
  const late = await b.call('sync', { tok: b.m.tok, cur: 0, out: [] });
  assert.deepEqual(late.in, []);
});

test('mesaj listesi son etkinlikten 2 dakika sonra sunucudan silinir', async () => {
  fresh();
  const [a, b] = await pair();
  await a.sync(['kalıcı değil']);
  tick(121);
  assert.deepEqual((await b.sync()).in, []);
});

test('ayrılmış bekleyenle eşleşilmez, yeni gelen yuvayı alır', async () => {
  fresh();
  const a = new Client('10.0.0.1');
  const b = new Client('10.0.0.2');
  const c = new Client('10.0.0.3');
  await a.find();
  tick(11); // a artık "buradayım" demiyor
  assert.equal((await b.find()).waiting, true);
  assert.ok((await c.find()).matched);
  assert.ok((await b.wait()).matched);
  assert.equal(b.m.room, c.m.room);
});

test('yuvadan düşen bekleyen iki yoklamada yeniden girer ve eşleşir', async () => {
  fresh();
  const a = new Client('10.0.0.1');
  const b = new Client('10.0.0.2');
  await a.find();
  tick(11); // a'nın bileti ölü sayıldı
  await b.find(); // b, a'yı atıp yuvaya girdi
  assert.equal((await a.wait()).inSlot, undefined, 'kontrol istenmeyen yoklama yuvaya bakmaz');
  const miss = await a.wait({ chk: 1 });
  assert.equal(miss.inSlot, false);
  const back = await a.wait({ re: 1 });
  assert.ok(back.matched, 'a yeniden girince b ile eşleşmeli');
  assert.ok((await b.wait()).matched);
  assert.equal(a.m.room, b.m.room);
  await a.sync(['selam']);
  assert.deepEqual(await b.texts(await b.sync()), ['selam']);
});

test('vazgeçen bekleyenle eşleşilmez', async () => {
  fresh();
  const a = new Client('10.0.0.1');
  const b = new Client('10.0.0.2');
  await a.find();
  await a.call('leave', { tk: a.tk });
  assert.equal((await b.find()).waiting, true);
});

test('oda linki ayrı eşleşir: aynı sırrı bilenler buluşur, rastgele havuza karışmaz', async () => {
  fresh();
  const host = new Client('10.0.0.1', 'gizliOdaSirri1');
  const stranger = new Client('10.0.0.2');
  const guest = new Client('10.0.0.3', 'gizliOdaSirri1');
  assert.equal((await host.find()).waiting, true);
  assert.equal((await stranger.find()).waiting, true);
  assert.ok((await guest.find()).matched);
  assert.ok((await host.wait()).matched);
  assert.equal(host.m.room, guest.m.room);
  await guest.sync(['odadayım']);
  assert.deepEqual(await host.texts(await host.sync()), ['odadayım']);
  assert.equal((await stranger.wait()).waiting, true);
});

test('şifre: yansıtılan, oynanan ya da yanlış oda sırrıyla gelen mesaj açılmaz', async () => {
  fresh();
  const [a, b] = await pair();
  const ct = await a.sess.seal({ t: 'm', n: 1, x: 'gizli' });
  assert.equal((await b.sess.open(ct)).x, 'gizli');
  assert.equal(await a.sess.open(ct), null, 'kendi mesajı karşıdan gelmiş gibi açılmamalı');
  const flipped = ct.slice(0, -2) + (ct.endsWith('A') ? 'BB' : 'AA');
  assert.equal(await b.sess.open(flipped), null);

  const k1 = await newKeys();
  const k2 = await newKeys();
  const base = { room: 'r', slot: 'a', priv: k1.priv, myPub: k1.pub, peerPub: k2.pub };
  const s1 = await openSession({ ...base, doorSecret: 'sir-bir' });
  const s2 = await openSession({ room: 'r', slot: 'b', priv: k2.priv, myPub: k2.pub, peerPub: k1.pub, doorSecret: 'sir-iki' });
  assert.equal(await s2.open(await s1.seal({ x: 1 })), null);
});

test('üç farklı ağdan bildirim otomatik engel getirir, süre dolunca kalkar', async () => {
  fresh();
  const botIp = '66.6.6.6';
  for (let i = 0; i < 3; i++) {
    const bot = new Client(botIp);
    const victim = new Client('10.1.0.' + i);
    await bot.find();
    await victim.find();
    await bot.wait();
    assert.equal((await victim.call('report', { tok: victim.m.tok })).ok, true);
    // Aynı sohbetten ikinci bildirim sayılmaz.
    await victim.call('report', { tok: victim.m.tok });
  }
  const blocked = await new Client(botIp).find();
  assert.equal(blocked.err, 'ban');
  assert.ok(blocked.until > T);
  assert.equal((await new Client(botIp).call('hello', { cid: randId(12) })).ban, blocked.until);
  assert.ok((await new Client('10.9.9.9').find()).ok, 'başka ağ etkilenmemeli');
  tick(3601);
  assert.equal((await new Client(botIp).find()).ok, true);
});

test('iki bildirim engel getirmez; aynı ağdan gelen bildirim sayılmaz', async () => {
  fresh();
  for (let i = 0; i < 2; i++) {
    const x = new Client('77.7.7.7');
    const v = new Client('10.2.0.' + i);
    await x.find();
    await v.find();
    await v.call('report', { tok: v.m.tok });
  }
  for (let i = 0; i < 4; i++) {
    const x = new Client('77.7.7.7');
    const same = new Client('77.7.7.7');
    await x.find();
    await same.find();
    await same.call('report', { tok: same.m.tok });
  }
  assert.equal((await new Client('77.7.7.7').find()).ok, true);
});

test('arama hız sınırı ağ başına uygulanır', async () => {
  fresh();
  let last;
  for (let i = 0; i < 61; i++) {
    const c = new Client('88.8.8.8');
    last = await c.find();
    await c.call('leave', { tk: c.tk });
  }
  assert.equal(last.err, 'rate');
  assert.ok(last.retry > 0 && last.retry <= 600);
  assert.equal((await new Client('88.8.8.9').find()).ok, true);
  tick(601);
  assert.equal((await new Client('88.8.8.8').find()).ok, true);
});

test('sahte, oynanmış, türü yanlış ya da süresi dolmuş jeton reddedilir', async () => {
  fresh();
  const [a] = await pair();
  const call = (op, d) => handle({ op, ...d }, { ip: '10.0.0.1' });
  assert.equal((await call('sync', { tok: 'uydurma', cur: 0 })).err, 'expired');
  assert.equal((await call('sync', { tok: a.m.tok.slice(0, -3) + 'AAA', cur: 0 })).err, 'expired');
  assert.equal((await call('sync', { tok: a.tk, cur: 0 })).err, 'expired', 'bilet oda jetonu yerine geçmemeli');
  assert.equal((await call('wait', { tk: a.m.tok })).err, 'expired');
  tick(6 * 3600 + 1);
  assert.equal((await call('sync', { tok: a.m.tok, cur: 0 })).err, 'expired');
});

test('bozuk istekler reddedilir', async () => {
  fresh();
  const [a] = await pair();
  const call = (b) => handle(b, { ip: '10.0.0.1' });
  assert.equal((await call(null)).err, 'bad');
  assert.equal((await call({ op: 'yok' })).err, 'bad');
  assert.equal((await call({ op: 'find', cid: 'kısa', pub: 'x' })).err, 'bad');
  assert.equal((await call({ op: 'sync', tok: a.m.tok, cur: 0, out: ['boşluk var'] })).err, 'bad');
  assert.equal((await call({ op: 'sync', tok: a.m.tok, cur: 0, out: Array(13).fill('abc') })).err, 'bad');
  assert.equal((await call({ op: 'sync', tok: a.m.tok, cur: 0, out: ['a'.repeat(4097)] })).err, 'bad');
});

test('yönetici: yanlış anahtar kilitlenir, doğru anahtar listeler, engeller, kaldırır', async () => {
  fresh();
  const adm = (d, ip = '10.0.0.50') => handle({ op: 'admin', ...d }, { ip });
  const key = 'test-admin-key-123';
  assert.equal((await adm({ key: 'yanlis', act: 'check' })).err, 'auth');
  assert.equal((await adm({ key, act: 'check' })).ok, true);

  const banned = await adm({ key, act: 'ban', ip: '99.9.9.9', hours: 2 });
  assert.equal(banned.ok, true);
  assert.equal((await new Client('99.9.9.9').find()).err, 'ban');
  assert.equal((await adm({ key, act: 'ban', ip: '10.0.0.50' })).err, 'self');
  assert.equal((await adm({ key, act: 'ban', ip: 'ip-degil' })).err, 'ip');

  const list = await adm({ key, act: 'list' });
  assert.equal(list.bans.length, 1);
  assert.equal(list.bans[0].id, banned.id);
  assert.equal(list.bans[0].why, 'admin');

  assert.equal((await adm({ key, act: 'unban', id: banned.id })).ok, true);
  assert.equal((await new Client('99.9.9.9').find()).ok, true);

  // Sekiz yanlış denemeden sonra doğru anahtar da 15 dakika kabul edilmez.
  for (let i = 0; i < 8; i++) await adm({ key: 'yanlis' + i, act: 'check' }, '10.0.0.60');
  assert.equal((await adm({ key, act: 'check' }, '10.0.0.60')).err, 'auth');
  tick(901);
  assert.equal((await adm({ key, act: 'check' }, '10.0.0.60')).ok, true);
});

test('yönetici sohbet içinden tek adımda engeller', async () => {
  fresh();
  const [bot, me] = await pair('55.5.5.5', '10.0.0.70');
  assert.equal((await me.call('report', { tok: me.m.tok, adm: 'yanlis-anahtar' })).err, 'auth');
  const r = await me.call('report', { tok: me.m.tok, adm: 'test-admin-key-123', hours: 24 });
  assert.equal(r.banned, true);
  assert.equal((await new Client('55.5.5.5').find()).err, 'ban');
  assert.ok(bot);
});

test('çevrimiçi sayacı son iki dakikadaki farklı ziyaretçileri sayar', async () => {
  fresh();
  const hello = (cid) => handle({ op: 'hello', cid }, { ip: '10.0.0.1' });
  assert.equal((await hello('ziyaretci-aaaa')).online, 1);
  assert.equal((await hello('ziyaretci-bbbb')).online, 2);
  assert.equal((await hello('ziyaretci-aaaa')).online, 2);
  tick(60);
  assert.equal((await hello('ziyaretci-cccc')).online, 3);
  tick(120);
  assert.equal((await hello('ziyaretci-dddd')).online, 1);
});

test('IP indirgeme: IPv4 aynen, IPv6 /64, haritalı adres IPv4 olarak', () => {
  assert.equal(normIp('1.2.3.4'), '1.2.3.4');
  assert.equal(normIp(' 1.2.3.4:5678 '), '1.2.3.4');
  assert.equal(normIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normIp('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
  assert.equal(normIp('2001:0db8:00aa:00bb:ffff:ffff:ffff:ffff'), '2001:db8:aa:bb::/64');
  assert.equal(normIp('[2001:db8::1]:443'), '2001:db8:0:0::/64');
  assert.equal(normIp('::1'), '0:0:0:0::/64');
  assert.equal(normIp('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(normIp(''), 'unknown');
  assert.equal(normIp('saçma'), 'unknown');
});

test('sözcük listeleri tutarlı', () => {
  assert.equal(EMOJI.length, 64);
  assert.equal(new Set(EMOJI).size, 64);
  assert.ok(ICE.length >= 30);
  const seed = new Uint8Array(32).fill(255);
  assert.equal(codeOf(seed).split(' ').length, 5);
  const n = aliasesOf(new Uint8Array(32)); // bütün baytlar aynıyken bile adlar farklı çıkmalı
  assert.notEqual(n.a, n.b);
});
