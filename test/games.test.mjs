// Zar ve sıralı tahta oyunları: iki oyuncu birbirine bağlanıp sınanır.
import assert from 'node:assert/strict';
import test from 'node:test';

const { Dice, Match, BOARDS } = await import('../public/games.js');

/** İki oyuncuyu sıralı bir "kablo" ile bağlar; mesajlar pump() çağrılınca teslim edilir. */
function table(make) {
  const q = { toA: [], toB: [] };
  const ev = { a: [], b: [] };
  const a = make('a', (m) => q.toB.push(m), (e) => ev.a.push(e));
  const b = make('b', (m) => q.toA.push(m), (e) => ev.b.push(e));
  async function pump() {
    while (q.toA.length || q.toB.length) {
      if (q.toB.length) await b.onMsg(q.toB.shift());
      if (q.toA.length) await a.onMsg(q.toA.shift());
    }
  }
  return { a, b, q, ev, pump };
}

const dice = () => table((slot, send, notify) => new Dice(send, notify, slot));
const match = () => table((slot, send, notify) => new Match(send, notify));
const flip = (board) => board.map((v) => (v === 'me' ? 'them' : v === 'them' ? 'me' : null));

// ---------------- Zar ----------------

test('zar: iki taraf atınca aynı zarları görür, sonuç ve skor tutarlı', async () => {
  const { a, b, q, ev, pump } = dice();
  await a.roll();
  assert.equal(q.toB[0].a, 'c');
  assert.equal('v' in q.toB[0], false, 'kilit gizli sayıyı ele vermemeli');
  assert.equal(await a.roll(), false, 'aynı turda ikinci atış olmaz');
  await pump();
  assert.deepEqual(ev.b, ['invite']);
  assert.equal(a.last, null);
  await b.roll();
  await pump();
  assert.deepEqual(a.last.mine, b.last.theirs);
  assert.deepEqual(a.last.theirs, b.last.mine);
  assert.equal(a.last.result + b.last.result, 0, 'biri kazanınca öbürü kaybeder');
  for (const v of [...a.last.mine, ...a.last.theirs]) assert.ok(v >= 1 && v <= 6);
  const s1 = a.last.mine[0] + a.last.mine[1];
  const s2 = a.last.theirs[0] + a.last.theirs[1];
  assert.equal(a.last.result, s1 === s2 ? 0 : s1 > s2 ? 1 : -1);
  assert.deepEqual(a.score, { me: b.score.them, them: b.score.me });
  assert.equal(a.round, 2);
});

test('zar: art arda turlar farklı sonuçlar verir', async () => {
  const { a, b, pump } = dice();
  const sums = new Set();
  for (let i = 0; i < 40; i++) {
    await a.roll();
    await b.roll();
    await pump();
    sums.add(a.last.mine[0] + a.last.mine[1]);
  }
  assert.ok(sums.size >= 6, `toplamlar çeşitli olmalı (${[...sums]})`);
  assert.equal(a.score.me + a.score.them <= 40, true);
});

test('zar: kilitten sonra sayısını değiştiren yakalanır', async () => {
  const { a, b, ev, pump } = dice();
  await a.roll();
  await b.roll();
  const send = b.send;
  b.send = (g) => send(g.a === 'r' ? { ...g, v: 'A'.repeat(22) } : g);
  await pump();
  assert.equal(ev.a.at(-1), 'cheat');
  assert.deepEqual(a.score, { me: 0, them: 0 });
});

// ---------------- Tahta oyunları ----------------

test('davet: çağıran bekler, kabul edince oyun başlar ve çağıran ilk oynar', async () => {
  const { a, b, ev, pump } = match();
  assert.equal(a.invite('xox'), true);
  assert.equal(a.state, 'inviting');
  assert.equal(a.invite('c4'), false, 'beklerken ikinci davet olmaz');
  await pump();
  assert.equal(b.state, 'invited');
  assert.equal(b.kind, 'xox');
  assert.deepEqual(ev.b, ['invite']);
  b.accept();
  await pump();
  assert.equal(a.state, 'playing');
  assert.equal(b.state, 'playing');
  assert.equal(a.turn, 'me');
  assert.equal(b.turn, 'them');
  assert.equal(a.first, 'me');
  assert.equal(b.first, 'them');
});

test('XOX: sıra kuralı, geçersiz hamleler yok sayılır, üçlü sıra kazanır', async () => {
  const { a, b, ev, pump } = match();
  a.invite('xox');
  await pump();
  b.accept();
  await pump();
  assert.equal(b.move(4), false, 'sırası olmayan oynayamaz');
  assert.equal(a.move(0), true);
  assert.equal(a.move(1), false, 'iki kez üst üste oynanmaz');
  await pump();
  assert.equal(b.move(0), false, 'dolu kareye oynanmaz');
  b.move(3);
  await pump();
  a.move(1);
  await pump();
  // Sahte hamle: sırası değilken ve yanlış numarayla gelen mesajlar etkisiz.
  a.onMsg({ a: 'mv', id: a.id, n: 99, i: 8 });
  b.onMsg({ a: 'mv', id: b.id, n: 3, i: 4 });
  assert.equal(b.board[4], null);
  b.move(4);
  await pump();
  a.move(2);
  await pump();
  assert.equal(a.result, 'win');
  assert.equal(b.result, 'lose');
  assert.deepEqual([...a.line].sort(), [0, 1, 2]);
  assert.deepEqual(b.board, flip(a.board), 'iki tahta aynı olmalı');
  assert.deepEqual(a.score.xox, { me: 1, them: 0 });
  assert.deepEqual(b.score.xox, { me: 0, them: 1 });
  assert.equal(ev.a.at(-1), 'over');
  assert.equal(a.move(5), false, 'biten oyunda hamle olmaz');
});

test('XOX: tahta dolup kimse kazanamazsa berabere', async () => {
  const { a, b, pump } = match();
  a.invite('xox');
  await pump();
  b.accept();
  await pump();
  const seq = [0, 1, 2, 4, 3, 5, 7, 6, 8];
  for (let k = 0; k < seq.length; k++) {
    assert.equal((k % 2 === 0 ? a : b).move(seq[k]), true, `hamle ${k + 1}`);
    await pump();
  }
  assert.equal(a.result, 'draw');
  assert.equal(b.result, 'draw');
  assert.deepEqual(a.score.xox, { me: 0, them: 0 });
});

test('Dört bağla: taş sütunun dibine düşer, dikey dörtlü kazanır, dolu sütuna oynanmaz', async () => {
  const { a, b, pump } = match();
  a.invite('c4');
  await pump();
  b.accept();
  await pump();
  const { cols, rows } = BOARDS.c4;
  a.move(0);
  await pump();
  assert.equal(a.board[(rows - 1) * cols], 'me', 'taş en alt satıra düşmeli');
  assert.equal(b.board[(rows - 1) * cols], 'them');
  for (const [p, c] of [
    [b, 1],
    [a, 0],
    [b, 1],
    [a, 0],
    [b, 1],
  ]) {
    p.move(c);
    await pump();
  }
  a.move(0);
  await pump();
  assert.equal(a.result, 'win');
  assert.equal(a.line.length, 4);
  assert.equal(b.result, 'lose');

  // Yeni oyun: sütunu doldur, yedinci taş kabul edilmez.
  const t = match();
  t.a.invite('c4');
  await t.pump();
  t.b.accept();
  await t.pump();
  for (let k = 0; k < 6; k++) {
    (k % 2 === 0 ? t.a : t.b).move(0);
    await t.pump();
  }
  assert.equal(t.a.move(0), false, 'dolu sütuna taş konmaz');
  assert.equal(t.a.state, 'playing');
});

test('Dört bağla: çapraz dörtlü kazanır', async () => {
  const { a, b, pump } = match();
  a.invite('c4');
  await pump();
  b.accept();
  await pump();
  const seq = [0, 1, 1, 2, 3, 2, 2, 3, 4, 3, 3]; // a, b, a, b, ... sırayla sütunlar
  for (let k = 0; k < seq.length; k++) {
    assert.equal((k % 2 === 0 ? a : b).move(seq[k]), true, `hamle ${k + 1}`);
    await pump();
  }
  assert.equal(a.result, 'win');
  assert.deepEqual([...a.line].sort((x, y) => x - y), [17, 23, 29, 35]);
});

test('davet: geri çevirme, geri çekme ve bırakma iki tarafa da yansır', async () => {
  const { a, b, ev, pump } = match();
  a.invite('xox');
  await pump();
  b.decline();
  await pump();
  assert.equal(a.state, 'idle');
  assert.equal(ev.a.at(-1), 'declined');

  a.invite('c4');
  await pump();
  a.decline(); // çağıran vazgeçti
  await pump();
  assert.equal(b.state, 'idle');
  assert.equal(ev.b.at(-1), 'withdrawn');

  a.invite('xox');
  await pump();
  b.accept();
  await pump();
  b.quit();
  await pump();
  assert.equal(b.result, 'quit');
  assert.equal(a.result, 'gone');
  assert.equal(a.state, 'over');
  assert.deepEqual(a.score.xox, { me: 0, them: 0 }, 'bırakma skoru değiştirmez');

  // Rövanş: biten oyundan sonra yeniden çağrılabilir; bu kez çağıran b başlar.
  assert.equal(b.invite('xox'), true);
  await pump();
  a.accept();
  await pump();
  assert.equal(b.turn, 'me');
  assert.equal(a.turn, 'them');
});

test('davet: iki taraf aynı anda çağırırsa tek oyun başlar', async () => {
  const { a, b, pump } = match();
  a.invite('xox');
  b.invite('c4');
  await pump();
  assert.equal(a.state, 'playing');
  assert.equal(b.state, 'playing');
  assert.equal(a.id, b.id);
  assert.equal(a.kind, b.kind);
  assert.notEqual(a.turn, b.turn);
});

test('bozuk ya da yabancı mesajlar yok sayılır', async () => {
  const { a } = match();
  for (const m of [null, 'x', {}, { a: 'inv', id: 'kısa!', k: 'xox' }, { a: 'inv', id: 'abcdef', k: 'satranç' }, { a: 'acc', id: 'abcdef' }, { a: 'mv', id: 'abcdef', n: 0, i: 0 }]) {
    a.onMsg(m);
  }
  assert.equal(a.state, 'idle');
});
