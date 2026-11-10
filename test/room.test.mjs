// Oda sohbeti: birden fazla kişi, herkese farklı renk, şifreli mesajlar.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.APP_SECRET = 'test-secret';
process.env.ADMIN_KEY = 'test-admin-key-123';
delete process.env.VERCEL;
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const { setClock } = await import('../lib/clock.js');
const { handle, resetCore } = await import('../lib/core.js');
const { resetMem } = await import('../lib/store.js');
const { doorId, openRoom, randId } = await import('../public/e2e.js');

let T = 1_900_000_000_000;
setClock(() => T);
const tick = (secs) => {
  T += secs * 1000;
};
function fresh() {
  resetMem();
  resetCore();
  tick(86400);
}

class Member {
  constructor(ip, secret) {
    this.ip = ip;
    this.secret = secret;
    this.cid = randId(12);
    this.seq = 0;
  }
  call(op, data = {}) {
    return handle({ op, ...data }, { ip: this.ip });
  }
  async join() {
    this.crypt = await openRoom(this.secret);
    const r = await this.call('rjoin', { cid: this.cid, room: await doorId(this.secret) });
    if (r.ok) Object.assign(this, { tok: r.tok, me: r.me, color: r.color, cur: r.cur, members: r.members });
    return r;
  }
  async sync(texts = [], extra = {}) {
    const out = [];
    for (const x of texts) out.push(await this.crypt.seal({ t: 'm', n: ++this.seq, x }, this.me));
    const r = await this.call('rsync', { tok: this.tok, cur: this.cur, out, ...extra });
    if (r.ok) this.cur = r.cur;
    return r;
  }
  /** Gelen kayıtları çözer: [{ kind, from, text }] */
  async read(r) {
    const list = [];
    for (const { d } of r.in) {
      const kind = d[0];
      const sep = d.indexOf('|');
      const from = sep < 0 ? d.slice(1) : d.slice(1, sep);
      if (kind !== 'm') list.push({ kind, from, text: sep < 0 ? '' : d.slice(sep + 1) });
      else list.push({ kind, from, text: ((await this.crypt.open(d.slice(sep + 1), from)) || {}).x });
    }
    return list;
  }
}

test('üç kişi aynı odada: herkese farklı renk, mesaj herkese ulaşır, sunucu düz metin görmez', async () => {
  fresh();
  const [a, b, c] = ['10.0.0.1', '10.0.0.2', '10.0.0.3'].map((ip) => new Member(ip, 'odaSirri-123'));
  assert.equal((await a.join()).ok, true);
  assert.equal((await b.join()).ok, true);
  assert.equal((await c.join()).ok, true);
  assert.equal(new Set([a.color, b.color, c.color]).size, 3, 'renkler çakışmamalı');
  assert.equal(c.members.length, 3);
  assert.deepEqual(new Set(c.members.map((m) => m.m)), new Set([a.me, b.me, c.me]));

  // a, sonradan girenlerin katılma kayıtlarını görür.
  const joins = await a.read(await a.sync());
  assert.deepEqual(joins.map((e) => e.kind + e.from), ['j' + b.me, 'j' + c.me]);

  const sent = await a.sync(['herkese selam']);
  assert.equal(sent.ok, true);
  const gb = await b.sync();
  assert.ok(gb.in.every((e) => !e.d.includes('herkese selam')), 'sunucudan düz metin geçmemeli');
  const rb = (await b.read(gb)).filter((e) => e.kind === 'm');
  const rc = (await c.read(await c.sync())).filter((e) => e.kind === 'm');
  assert.deepEqual(rb, [{ kind: 'm', from: a.me, text: 'herkese selam' }]);
  assert.deepEqual(rc, [{ kind: 'm', from: a.me, text: 'herkese selam' }]);

  // İmleç ilerler: aynı mesaj ikinci kez gelmez.
  assert.deepEqual((await b.sync()).in, []);
});

test('yeni gelen, girmeden önce yazılanları göremez', async () => {
  fresh();
  const a = new Member('10.0.0.1', 'odaSirri-123');
  const b = new Member('10.0.0.2', 'odaSirri-123');
  await a.join();
  await a.sync(['eski mesaj']);
  await b.join();
  await a.sync(['yeni mesaj']);
  const got = (await b.read(await b.sync())).filter((e) => e.kind === 'm').map((e) => e.text);
  assert.deepEqual(got, ['yeni mesaj']);
});

test('farklı linkler farklı odadır; yanlış sırla mesaj açılmaz', async () => {
  fresh();
  const a = new Member('10.0.0.1', 'birinciOda-1');
  const x = new Member('10.0.0.2', 'ikinciOda-22');
  await a.join();
  await x.join();
  assert.equal(x.members.length, 1, 'başka odanın üyesi görünmemeli');
  await a.sync(['yalnızca birinci oda']);
  assert.deepEqual((await x.sync()).in, []);

  const k1 = await openRoom('birinciOda-1');
  const k2 = await openRoom('ikinciOda-22');
  const ct = await k1.seal({ x: 'gizli' }, 'uye1');
  assert.equal((await k1.open(ct, 'uye1')).x, 'gizli');
  assert.equal(await k2.open(ct, 'uye1'), null);
  assert.equal(await k1.open(ct, 'uye2'), null, 'mesaj başka üyeye mal edilememeli');
});

test('oda en fazla 12 kişi alır; biri çıkınca yer açılır ve çıkış duyurulur', async () => {
  fresh();
  const people = [];
  for (let i = 0; i < 12; i++) {
    const m = new Member('10.1.0.' + i, 'kalabalikOda');
    assert.equal((await m.join()).ok, true, `${i + 1}. kişi girebilmeli`);
    people.push(m);
  }
  assert.equal(new Set(people.map((p) => p.color)).size, 12, '12 kişi, 12 farklı renk');
  const late = new Member('10.1.0.99', 'kalabalikOda');
  assert.equal((await late.join()).err, 'full');

  await people[3].call('leave', { tok: people[3].tok });
  assert.equal((await late.join()).ok, true);
  assert.equal(late.color, people[3].color, 'boşalan renk yeni gelene verilir');
  const seen = await people[0].read(await people[0].sync());
  assert.ok(seen.some((e) => e.kind === 'x' && e.from === people[3].me), 'çıkış kaydı görünmeli');
});

test('sessizce giden üyenin rengi boşalır; dönerse "gone" alır', async () => {
  fresh();
  const a = new Member('10.0.0.1', 'odaSirri-123');
  const b = new Member('10.0.0.2', 'odaSirri-123');
  await a.join();
  await b.join();
  tick(20);
  const alive = await a.sync([], { ping: 1 });
  assert.equal(alive.members.length, 2);
  tick(20); // b 40 sn'dir sessiz, a 20 sn önce işaret verdi
  const now = await a.sync([], { ping: 1 });
  assert.deepEqual(now.members.map((m) => m.m), [a.me], 'sessiz üye listeden düşmeli');

  // Oda dolana kadar yeni gelenler b'nin rengini de alabilir.
  for (let i = 0; i < 11; i++) assert.equal((await new Member('10.2.0.' + i, 'odaSirri-123').join()).ok, true);
  assert.equal((await b.sync([], { ping: 1 })).err, 'gone');
});

test('oda jetonu ile 1’e 1 jetonu birbirinin yerine geçmez; bozuk istekler reddedilir', async () => {
  fresh();
  const a = new Member('10.0.0.1', 'odaSirri-123');
  await a.join();
  const call = (op, d) => handle({ op, ...d }, { ip: '10.0.0.1' });
  assert.equal((await call('sync', { tok: a.tok, cur: 0 })).err, 'expired');
  assert.equal((await call('rsync', { tok: 'uydurma', cur: '0-0' })).err, 'expired');
  assert.equal((await call('rsync', { tok: a.tok, cur: '0-0', out: ['boşluk var'] })).err, 'bad');
  assert.equal((await call('rjoin', { cid: a.cid, room: 'kısa' })).err, 'bad');
  // Geçersiz imleç baştan okutur ama hata vermez.
  assert.equal((await call('rsync', { tok: a.tok, cur: 'saçma' })).ok, true);
});

test('engelli ağ odaya giremez', async () => {
  fresh();
  const banned = await handle({ op: 'admin', key: 'test-admin-key-123', act: 'ban', ip: '66.6.6.6', hours: 1 }, { ip: '10.0.0.50' });
  assert.equal(banned.ok, true);
  assert.equal((await new Member('66.6.6.6', 'odaSirri-123').join()).err, 'ban');
  assert.equal((await new Member('10.0.0.7', 'odaSirri-123').join()).ok, true);
});
