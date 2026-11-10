// Taş kağıt makas protokolü: iki oyuncu birbirine bağlanıp sınanır.
import assert from 'node:assert/strict';
import test from 'node:test';

const { Rps, MOVES, outcome, randomMove } = await import('../public/rps.js');

/** İki oyuncuyu sıralı bir "kablo" ile bağlar; mesajlar pump() çağrılınca teslim edilir. */
function table() {
  const wire = { toA: [], toB: [], log: [] };
  const evA = [];
  const evB = [];
  const a = new Rps((g) => (wire.toB.push(g), wire.log.push(['a', g])), (e) => evA.push(e));
  const b = new Rps((g) => (wire.toA.push(g), wire.log.push(['b', g])), (e) => evB.push(e));
  async function pump() {
    while (wire.toA.length || wire.toB.length) {
      if (wire.toB.length) await b.onMsg(wire.toB.shift());
      if (wire.toA.length) await a.onMsg(wire.toA.shift());
    }
  }
  return { a, b, wire, evA, evB, pump };
}

test('kurallar: taş makası, makas kağıdı, kağıt taşı yener', () => {
  assert.equal(outcome('t', 'm'), 1);
  assert.equal(outcome('m', 'k'), 1);
  assert.equal(outcome('k', 't'), 1);
  assert.equal(outcome('m', 't'), -1);
  assert.equal(outcome('k', 'k'), 0);
});

test('rastgele seçim üç hamleyi de üretir', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(randomMove());
  assert.deepEqual([...seen].sort(), [...MOVES].sort());
});

test('tur: seçim kilitlenir, iki taraf seçince açılır, sonuç iki tarafta tutarlı çıkar', async () => {
  const { a, b, wire, evA, evB, pump } = table();
  assert.equal(await a.pick('t'), true);
  assert.equal(await a.pick('k'), false, 'kilitlenen seçim değiştirilemez');

  // A'nın gönderdiği kilit seçimi ele vermez.
  assert.equal(wire.toB.length, 1);
  assert.equal(wire.toB[0].a, 'c');
  assert.equal(JSON.stringify(wire.toB[0]).includes('"m"'), false);

  await pump();
  assert.deepEqual(evB, ['invite']);
  assert.equal(b.theirHash !== null && b.mine === null, true);
  assert.equal(a.last, null, 'B seçmeden sonuç çıkmaz');
  assert.equal(wire.log.filter(([, g]) => g.a === 'r').length, 0, 'iki kilit olmadan kimse seçimini açmaz');

  await b.pick('m');
  await pump();
  assert.deepEqual(a.last, { mine: 't', theirs: 'm', result: 1 });
  assert.deepEqual(b.last, { mine: 'm', theirs: 't', result: -1 });
  assert.deepEqual(a.score, { me: 1, them: 0 });
  assert.deepEqual(b.score, { me: 0, them: 1 });
  assert.equal(evA.at(-1), 'result');
  assert.equal(evB.at(-1), 'result');
  assert.equal(a.round, 2);
  assert.equal(b.round, 2);
});

test('iki taraf aynı anda seçerse de tur tamamlanır; art arda turlar skoru biriktirir', async () => {
  const { a, b, pump } = table();
  await Promise.all([a.pick('k'), b.pick('k')]);
  await pump();
  assert.equal(a.last.result, 0);
  assert.equal(b.last.result, 0);

  await b.pick('m');
  await a.pick('k');
  await pump();
  assert.equal(a.last.result, -1);
  assert.equal(b.last.result, 1);
  assert.deepEqual(a.score, { me: 0, them: 1 });
  assert.deepEqual(b.score, { me: 1, them: 0 });
  assert.equal(a.round, 3);
});

test('hile: kilitten sonra seçimini değiştiren yakalanır, tur geçersiz sayılır', async () => {
  const { a, b, wire, evA, pump } = table();
  await a.pick('t');
  await b.pick('m'); // B makas dedi, kaybedecek
  // B'nin açıklamasını yolda "kağıt"a çevir (değiştirilmiş istemci gibi).
  const origSend = b.send;
  b.send = (g) => origSend(g.a === 'r' ? { ...g, m: 'k' } : g);
  await pump();
  assert.equal(evA.at(-1), 'cheat');
  assert.equal(a.last.result, null);
  assert.deepEqual(a.score, { me: 0, them: 0 });
  assert.equal(a.round, 2);
  assert.ok(wire);
});

test('sırasız ve eski mesajlar yok sayılır', async () => {
  const { a, b, pump } = table();
  // Kilit yokken gelen açıklama etkisizdir.
  await a.onMsg({ a: 'r', r: 1, m: 't', s: 'tuz' });
  assert.equal(a.last, null);
  // Bozuk kilit kabul edilmez.
  await a.onMsg({ a: 'c', r: 1, h: 'kısa' });
  assert.equal(a.theirHash, null);
  await a.onMsg(null);
  await a.onMsg({ a: 'c', r: 99, h: 'x'.repeat(43) });
  assert.equal(a.theirHash, null, 'başka turun kilidi alınmaz');

  await a.pick('t');
  await b.pick('k');
  await pump();
  assert.equal(a.round, 2);
  // Biten turun mesajı yeniden gelirse durum bozulmaz.
  await a.onMsg({ a: 'c', r: 1, h: 'x'.repeat(43) });
  assert.equal(a.theirHash, null);
});
