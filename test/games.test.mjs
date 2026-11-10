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

// ---------------- Hızlı düello, Bu mu şu mu, Adam asmaca ----------------
const { quizQuestions, pickQuestions, normWord, ALPHABET, KINDS } = await import('../public/games.js');
const tick = () => new Promise((r) => setTimeout(r, 20));

async function started(kind) {
  const t = match();
  t.a.invite(kind);
  await t.pump();
  t.b.accept();
  await t.pump();
  return t;
}

test('hızlı düello: iki tarafa aynı sorular gelir, şıklar tutarlı', () => {
  const q1 = quizQuestions('oyun123');
  const q2 = quizQuestions('oyun123');
  assert.deepEqual(q1, q2);
  assert.notDeepEqual(quizQuestions('baska99'), q1);
  for (const q of q1) {
    assert.equal(q.opts.length, 4);
    assert.equal(new Set(q.opts).size, 4);
    assert.ok(q.ans >= 0 && q.ans < 4);
    const [a, op, b] = q.text.split(' ');
    const v = { '+': +a + +b, '−': a - b, '×': a * b, '÷': a / b }[op];
    assert.equal(q.opts[q.ans], v, `doğru şık hesapla uyuşmalı: ${q.text}`);
  }
});

test('hızlı düello: çok doğru yapan kazanır, eşitlikte az yanlış yapan', async () => {
  const { a, b, pump } = await started('quiz');
  assert.equal(a.qs[0].text, b.qs[0].text);
  for (let k = 0; k < 5; k++) assert.equal(a.answer(a.qs[a.qi].ans), true);
  for (let k = 0; k < 3; k++) b.answer(b.qs[b.qi].ans);
  b.answer((b.qs[b.qi].ans + 1) % 4); // bir yanlış
  assert.equal(a.right, 5);
  assert.equal(b.wrong, 1);
  a.finish();
  await pump();
  assert.equal(a.state, 'playing', 'karşı taraf bitirene kadar sonuç yok');
  assert.equal(a.answer(0), null, 'bitirdikten sonra cevap verilmez');
  b.finish();
  await pump();
  assert.equal(a.result, 'win');
  assert.equal(b.result, 'lose');
  assert.deepEqual(a.score.quiz, { me: 1, them: 0 });

  const t = await started('quiz');
  t.a.answer(t.a.qs[0].ans);
  t.b.answer(t.b.qs[0].ans);
  t.b.answer((t.b.qs[1].ans + 1) % 4);
  t.a.finish();
  t.b.finish();
  await t.pump();
  assert.equal(t.a.result, 'win', 'eşit doğruda az yanlış yapan kazanır');
  assert.equal(t.b.result, 'lose');
});

test('bu mu şu mu: aynı sorular, uyum sayısı iki tarafta aynı', async () => {
  assert.deepEqual(pickQuestions('x1y2z3', 7), pickQuestions('x1y2z3', 7));
  const { a, b, pump } = await started('pick');
  assert.deepEqual(a.qs, b.qs);
  assert.equal(a.qs.length, KINDS.pick.count);
  const mine = [0, 0, 1, 1, 0, 1, 0];
  const theirs = [0, 1, 1, 0, 0, 1, 1];
  mine.forEach((v) => a.choose(v));
  assert.equal(a.choose(0), false, 'cevaplar bitince yeni seçim olmaz');
  await pump();
  assert.equal(a.state, 'playing');
  theirs.forEach((v) => b.choose(v));
  await pump();
  assert.equal(a.result, 'pick');
  assert.equal(a.same, 4);
  assert.equal(b.same, 4);
});

test('adam asmaca: kelime kilitlenir, harfler açılır, bilen kazanır', async () => {
  const { a, b, q, ev, pump } = match();
  assert.equal(normWord('Elma'), 'elma');
  assert.equal(normWord('el'), '', 'çok kısa');
  assert.equal(normWord('elma1'), '', 'rakam olmaz');
  assert.equal(await a.inviteHang('ÇİÇEK'), true);
  assert.equal(JSON.stringify(q.toB).includes('çiçek'), false, 'kelime davetle gitmez');
  await pump();
  assert.equal(b.len, 5);
  b.accept();
  await pump();
  assert.equal(b.role, 'guesser');
  assert.equal(a.role, 'setter');
  assert.equal(a.guess('ç'), false, 'kelimeyi yazan tahmin etmez');
  b.guess('ç');
  assert.equal(b.guess('i'), false, 'cevap gelmeden ikinci tahmin olmaz');
  await pump();
  assert.deepEqual(b.mask, ['ç', '', 'ç', '', '']);
  for (const l of ['z', 'i', 'e', 'k']) {
    b.guess(l);
    await pump();
  }
  assert.equal(b.miss, 1);
  assert.equal(b.result, 'win');
  assert.equal(a.result, 'lose');
  await tick();
  assert.equal(b.revealed, 'çiçek', 'oyun bitince kelime açılır ve doğrulanır');
  assert.ok(ev.b.includes('reveal'));
});

test('adam asmaca: hak bitince kelimeyi yazan kazanır; yanlış cevap veren yakalanır', async () => {
  const t = match();
  await t.a.inviteHang('kalem');
  await t.pump();
  t.b.accept();
  await t.pump();
  for (const l of ['z', 'ş', 'ğ', 'ü', 'ö', 'ç']) {
    t.b.guess(l);
    await t.pump();
  }
  assert.equal(t.b.result, 'lose');
  assert.equal(t.a.result, 'win');
  await tick();
  assert.equal(t.b.revealed, 'kalem');

  // Kelimeyi yazan "e yok" diye yalan söylerse oyun sonunda yakalanır.
  const u = match();
  await u.a.inviteHang('ev');
  assert.equal(u.a.state, 'idle', 'iki harfli kelime kabul edilmez');
  await u.a.inviteHang('eve');
  await u.pump();
  u.b.accept();
  await u.pump();
  const send = u.a.send;
  u.a.send = (m) => send(m.a === 'res' && m.l === 'e' ? { ...m, p: [] } : m);
  for (const l of ['e', 'z', 'ş', 'ğ', 'ü', 'ö']) {
    u.b.guess(l);
    await u.pump();
  }
  assert.equal(u.b.result, 'lose');
  // Kilide uyması için gerçek kelimeyi açmak zorunda; açınca yalanı ortaya çıkar.
  u.b.onMsg({ a: 'rev', id: u.b.id, w: 'eve', s: u.a.salt });
  await tick();
  assert.equal(u.b.result, 'cheat', 'açılan kelime verilen cevaplarla uyuşmuyor');
  assert.deepEqual(u.b.score.hang, { me: 0, them: 0 }, 'hileyle kazanılan sayılmaz');
  assert.ok(ALPHABET.length === 29);
});
