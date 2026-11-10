// İki kişilik oyunlar: zar ve davetli oyunlar (XOX, Dört bağla, Hızlı düello, Bu mu şu mu, Adam asmaca).
// Taş kağıt makas ayrı dosyada (rps.js). Bu dosya DOM kullanmaz; aynı kod Node testlerinde de çalışır.
import { randId, toB64u } from './e2e.js';

const te = new TextEncoder();
const sha = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text)));

// ---------- Zar ----------
// Kimse kendi zarını seçemez: iki taraf gizli birer rastgele sayı kilitler (yalnızca özetini yollar),
// ikisi de kilitlenince sayılar açılır ve zarlar iki sayıdan birlikte türetilir.
export class Dice {
  /**
   * @param send   karşı tarafa yollar: send({ a, r, ... })
   * @param notify 'change' | 'invite' (karşı taraf attı) | 'result' | 'cheat'
   * @param slot   'a' ya da 'b': iki tarafın sayıları her iki ekranda aynı sırayla birleşsin
   */
  constructor(send, notify, slot) {
    this.send = send;
    this.notify = notify || (() => {});
    this.slot = slot;
    this.round = 1;
    this.mine = null; // bu turdaki gizli sayım
    this.theirHash = null;
    this.revealed = false;
    this.last = null; // { mine: [z1, z2], theirs: [z1, z2], result }
    this.score = { me: 0, them: 0 };
  }

  async roll() {
    if (this.mine) return false;
    const round = this.round;
    const nonce = randId(16);
    const h = toB64u(await sha(`dice|${round}|${nonce}`));
    if (this.mine || round !== this.round) return false;
    this.mine = nonce;
    this.send({ a: 'c', r: round, h });
    this._reveal();
    this.notify('change');
    return true;
  }

  _reveal() {
    if (!this.mine || !this.theirHash || this.revealed) return;
    this.revealed = true;
    this.send({ a: 'r', r: this.round, v: this.mine });
  }

  _next() {
    this.round++;
    this.mine = null;
    this.theirHash = null;
    this.revealed = false;
  }

  async onMsg(g) {
    if (!g || typeof g !== 'object' || g.r !== this.round) return;
    if (g.a === 'c') {
      if (this.theirHash || typeof g.h !== 'string' || g.h.length !== 43) return;
      this.theirHash = g.h;
      const invite = !this.mine;
      this._reveal();
      this.notify(invite ? 'invite' : 'change');
      return;
    }
    if (g.a === 'r') {
      if (!this.theirHash || !this.mine) return;
      const ok =
        typeof g.v === 'string' && /^[A-Za-z0-9_-]{16,32}$/.test(g.v) && toB64u(await sha(`dice|${this.round}|${g.v}`)) === this.theirHash;
      if (!ok) {
        this.last = null;
        this._next();
        this.notify('cheat');
        return;
      }
      const [na, nb] = this.slot === 'a' ? [this.mine, g.v] : [g.v, this.mine];
      const b = await sha(`dice-roll|${this.round}|${na}|${nb}`);
      const die = (i) => 1 + ((((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0) % 6);
      const A = [die(0), die(4)];
      const B = [die(8), die(12)];
      const mine = this.slot === 'a' ? A : B;
      const theirs = this.slot === 'a' ? B : A;
      const s1 = mine[0] + mine[1];
      const s2 = theirs[0] + theirs[1];
      const result = s1 === s2 ? 0 : s1 > s2 ? 1 : -1;
      if (result > 0) this.score.me++;
      else if (result < 0) this.score.them++;
      this.last = { mine, theirs, result };
      this._next();
      this.notify('result');
    }
  }
}

// ---------- Davetli oyunlar: XOX, Dört bağla, Hızlı düello, Bu mu şu mu, Adam asmaca ----------
// Biri çağırır, diğeri kabul eder. İki taraf aynı kuralları uygular; karşıdan gelen geçersiz hamle yok sayılır.
export const KINDS = {
  xox: { name: 'XOX', type: 'board', cols: 3, rows: 3, win: 3, drop: false },
  c4: { name: 'Dört bağla', type: 'board', cols: 7, rows: 6, win: 4, drop: true }, // taş sütunun en altına düşer
  quiz: { name: 'Hızlı düello', type: 'quiz', secs: 20 }, // aynı sorular, 20 saniye, çok doğru yapan kazanır
  pick: { name: 'Bu mu şu mu', type: 'pick', count: 7 }, // ikisi de gizlice seçer, sonunda uyum yüzdesi
  hang: { name: 'Adam asmaca', type: 'hang', lives: 6 }, // çağıran kelimeyi kilitler, diğeri tahmin eder
};
export const BOARDS = KINDS; // eski ad

export const ALPHABET = [...'abcçdefgğhıijklmnoöprsştuüvyz'];

export const PAIRS = [
  ['Çay', 'Kahve'],
  ['Kedi', 'Köpek'],
  ['Yaz', 'Kış'],
  ['Deniz', 'Dağ'],
  ['Sabah', 'Gece'],
  ['Film', 'Dizi'],
  ['Tatlı', 'Tuzlu'],
  ['Şehir', 'Köy'],
  ['Mesaj', 'Arama'],
  ['Kitap', 'Podcast'],
  ['Pizza', 'Lahmacun'],
  ['Evde kalmak', 'Dışarı çıkmak'],
  ['Plan', 'Doğaçlama'],
  ['Erken kalkmak', 'Geç yatmak'],
  ['Konser', 'Sinema'],
  ['Yağmur', 'Güneş'],
  ['Sessizlik', 'Kalabalık'],
  ['Kahvaltı', 'Akşam yemeği'],
  ['Araba', 'Bisiklet'],
  ['Sahil', 'Orman'],
];

const ID = /^[A-Za-z0-9_-]{4,16}$/;

/** Adam asmaca kelimesi: Türkçe harfler, 3–12 harf. Geçersizse ''. */
export function normWord(raw) {
  const w = String(raw == null ? '' : raw).trim().toLocaleLowerCase('tr');
  const chars = [...w];
  return chars.length >= 3 && chars.length <= 12 && chars.every((c) => ALPHABET.includes(c)) ? w : '';
}

// Oyun kimliğinden iki tarafta aynı çıkan rastgele sayılar (mulberry32).
function prng(text) {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  let seed = h >>> 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const shuffle = (list) => {
    for (let j = list.length - 1; j > 0; j--) {
      const k = int(0, j);
      [list[j], list[k]] = [list[k], list[j]];
    }
    return list;
  };
  return { rnd, int, shuffle };
}

/** Hızlı düello soruları: dört işlem, dört şık. İki tarafta aynı sırayla çıkar. */
export function quizQuestions(id, count = 40) {
  const { rnd, int, shuffle } = prng('quiz|' + id);
  const qs = [];
  for (let i = 0; i < count; i++) {
    const type = int(0, 3);
    let text;
    let ans;
    if (type === 0) {
      const a = int(12, 89);
      const b = int(11, 79);
      text = `${a} + ${b}`;
      ans = a + b;
    } else if (type === 1) {
      const a = int(30, 99);
      const b = int(11, a - 5);
      text = `${a} − ${b}`;
      ans = a - b;
    } else if (type === 2) {
      const a = int(3, 12);
      const b = int(3, 9);
      text = `${a} × ${b}`;
      ans = a * b;
    } else {
      const b = int(2, 9);
      const q = int(3, 12);
      text = `${b * q} ÷ ${b}`;
      ans = q;
    }
    const opts = new Set([ans]);
    while (opts.size < 4) {
      const d = int(1, 10) * (rnd() < 0.5 ? -1 : 1);
      if (ans + d > 0) opts.add(ans + d);
    }
    const list = shuffle([...opts]);
    qs.push({ text, opts: list, ans: list.indexOf(ans) });
  }
  return qs;
}

/** Bu mu şu mu soruları: listeden karışık seçilir, iki tarafta aynı. */
export function pickQuestions(id, count) {
  return prng('pick|' + id)
    .shuffle(PAIRS.map((p) => [...p]))
    .slice(0, count);
}

export class Match {
  /**
   * @param send   karşı tarafa yollar: send({ a, id, ... })
   * @param notify 'change' | 'invite' | 'withdrawn' | 'declined' | 'start' | 'move' | 'over' | 'reveal' | 'cheat'
   */
  constructor(send, notify) {
    this.send = send;
    this.notify = notify || (() => {});
    this.score = {};
    for (const k of Object.keys(KINDS)) this.score[k] = { me: 0, them: 0 };
    this.reset();
  }

  /** state: idle | inviting (ben çağırdım) | invited (beni çağırdılar) | playing | over */
  reset() {
    this.state = 'idle';
    this.kind = null;
    this.id = null;
    this.first = null; // 'me' | 'them': çağıran başlar
    this.turn = null;
    this.n = 0; // oynanan hamle sayısı
    this.result = null; // win | lose | draw | quit | gone | pick | cheat
    // tahta
    this.board = null; // hücre → null | 'me' | 'them'; sıra sıra, üst satır önce
    this.line = null;
    this.lastCell = -1;
    // hızlı düello ve bu mu şu mu
    this.qs = null;
    this.qi = 0;
    this.right = 0;
    this.wrong = 0;
    this.t0 = 0;
    this.mineDone = false;
    this.theirs = null; // düello: { c, w }
    this.answers = [];
    this.theirAns = null;
    this.same = 0;
    // adam asmaca
    this.role = null; // setter (kelimeyi yazan) | guesser (tahmin eden)
    this.word = null;
    this.salt = null;
    this.hash = null;
    this.len = 0;
    this.mask = null;
    this.tried = [];
    this.miss = 0;
    this.pend = null;
    this.hist = [];
    this.revealed = null;
  }

  get spec() {
    return KINDS[this.kind];
  }

  /** Hızlı düelloda kalan süre (ms). */
  get left() {
    const spec = this.spec;
    return spec && spec.type === 'quiz' && this.t0 ? this.t0 + spec.secs * 1000 - Date.now() : 0;
  }

  invite(kind) {
    if (!KINDS[kind] || kind === 'hang') return false; // adam asmaca kelimeyle çağrılır: inviteHang
    return this._invite(kind, randId(6), {});
  }

  /** Adam asmaca: kelime kilitlenir (yalnızca özeti gider), oyun bitince açılır. */
  async inviteHang(raw) {
    const word = normWord(raw);
    if (!word || this.state === 'inviting' || this.state === 'playing') return false;
    const id = randId(6);
    const salt = randId(12);
    const h = toB64u(await sha(`hang|${id}|${word}|${salt}`));
    const len = [...word].length;
    if (!this._invite('hang', id, { h, len })) return false;
    this.word = word;
    this.salt = salt;
    this.hash = h;
    this.len = len;
    return true;
  }

  _invite(kind, id, extra) {
    if (this.state === 'inviting' || this.state === 'playing') return false;
    if (this.state === 'invited') this.send({ a: 'dec', id: this.id }); // bekleyen daveti geri çevir
    this.reset();
    this.kind = kind;
    this.id = id;
    this.state = 'inviting';
    this.send({ a: 'inv', id, k: kind, ...extra });
    this.notify('change');
    return true;
  }

  accept() {
    if (this.state !== 'invited') return false;
    this.send({ a: 'acc', id: this.id });
    this._begin('them');
    this.notify('start');
    return true;
  }

  /** Gelen daveti geri çevirir ya da kendi davetimi geri çeker. */
  decline() {
    if (this.state !== 'invited' && this.state !== 'inviting') return false;
    this.send({ a: 'dec', id: this.id });
    this.reset();
    this.notify('change');
    return true;
  }

  quit() {
    if (this.state !== 'playing') return false;
    this.send({ a: 'quit', id: this.id });
    this._end('quit', null);
    return true;
  }

  /** Biten oyunun tahtasını kapatır. */
  close() {
    if (this.state !== 'over') return false;
    this.reset();
    this.notify('change');
    return true;
  }

  _begin(first) {
    const spec = this.spec;
    this.state = 'playing';
    this.first = first;
    this.turn = first;
    this.n = 0;
    this.result = null;
    this.line = null;
    this.lastCell = -1;
    if (spec.type === 'board') {
      this.board = Array(spec.cols * spec.rows).fill(null);
    } else if (spec.type === 'quiz') {
      this.qs = quizQuestions(this.id);
      this.qi = 0;
      this.right = 0;
      this.wrong = 0;
      this.mineDone = false;
      this.theirs = null;
      this.t0 = Date.now(); // iki taraf da kendi 20 saniyesini alır
    } else if (spec.type === 'pick') {
      this.qs = pickQuestions(this.id, spec.count);
      this.answers = [];
      this.theirAns = null;
      this.mineDone = false;
    } else if (spec.type === 'hang') {
      this.role = first === 'me' ? 'setter' : 'guesser';
      this.mask = Array(this.len).fill('');
      this.tried = [];
      this.miss = 0;
      this.pend = null;
      this.hist = [];
      this.revealed = null;
    }
  }

  _end(result, line) {
    this.state = 'over';
    this.result = result;
    this.line = line;
    this.turn = null;
    if (result === 'win') this.score[this.kind].me++;
    else if (result === 'lose') this.score[this.kind].them++;
    this.notify('over');
  }

  // ---------- tahta ----------

  /** Hamle hedefini hücreye çevirir: Dört bağla'da sütun, XOX'ta hücre. Geçersizse -1. */
  target(i) {
    if (!this.board || !Number.isInteger(i)) return -1;
    const { cols, rows, drop } = this.spec;
    if (drop) {
      if (i < 0 || i >= cols) return -1;
      for (let r = rows - 1; r >= 0; r--) if (!this.board[r * cols + i]) return r * cols + i;
      return -1;
    }
    return i >= 0 && i < cols * rows && !this.board[i] ? i : -1;
  }

  move(i) {
    if (this.state !== 'playing' || this.spec.type !== 'board' || this.turn !== 'me') return false;
    const cell = this.target(i);
    if (cell < 0) return false;
    this.send({ a: 'mv', id: this.id, n: this.n, i });
    this._place(cell, 'me');
    return true;
  }

  _place(cell, who) {
    this.board[cell] = who;
    this.n++;
    this.lastCell = cell;
    const line = this._line(cell, who);
    if (line) return this._end(who === 'me' ? 'win' : 'lose', line);
    if (this.board.every(Boolean)) return this._end('draw', null);
    this.turn = who === 'me' ? 'them' : 'me';
    this.notify('move');
  }

  // Son konan taştan dört yöne bakar: yatay, dikey, iki çapraz.
  _line(cell, who) {
    const { cols, rows, win } = this.spec;
    const r0 = Math.floor(cell / cols);
    const c0 = cell % cols;
    for (const [dr, dc] of [
      [0, 1],
      [1, 0],
      [1, 1],
      [1, -1],
    ]) {
      const line = [cell];
      for (const s of [1, -1]) {
        let r = r0 + dr * s;
        let c = c0 + dc * s;
        while (r >= 0 && r < rows && c >= 0 && c < cols && this.board[r * cols + c] === who) {
          line.push(r * cols + c);
          r += dr * s;
          c += dc * s;
        }
      }
      if (line.length >= win) return line;
    }
    return null;
  }

  // ---------- hızlı düello ----------

  /** Şık seçer; doğruysa true, yanlışsa false, oynanamıyorsa null. */
  answer(i) {
    if (this.state !== 'playing' || this.spec.type !== 'quiz' || this.mineDone || this.left <= 0) return null;
    const q = this.qs[this.qi];
    if (!q || !Number.isInteger(i)) return null;
    const ok = i === q.ans;
    if (ok) this.right++;
    else this.wrong++;
    this.qi++;
    if (this.qi >= this.qs.length) this.finish();
    return ok;
  }

  /** Süre bitince (ya da sorular bitince) sonucumu yollar. */
  finish() {
    if (this.state !== 'playing' || this.spec.type !== 'quiz' || this.mineDone) return false;
    this.mineDone = true;
    this.send({ a: 'done', id: this.id, c: this.right, w: this.wrong });
    if (this.theirs) this._settleQuiz();
    else this.notify('move');
    return true;
  }

  _settleQuiz() {
    const a = this.right;
    const b = this.theirs.c;
    let r = 'draw';
    if (a !== b) r = a > b ? 'win' : 'lose';
    else if (this.wrong !== this.theirs.w) r = this.wrong < this.theirs.w ? 'win' : 'lose'; // eşitse az yanlış yapan
    this._end(r, null);
  }

  // ---------- bu mu şu mu ----------

  choose(side) {
    if (this.state !== 'playing' || this.spec.type !== 'pick' || this.mineDone || (side !== 0 && side !== 1)) return false;
    this.answers.push(side);
    if (this.answers.length >= this.spec.count) {
      this.mineDone = true;
      this.send({ a: 'done', id: this.id, v: this.answers });
      if (this.theirAns) this._settlePick();
      else this.notify('move');
    } else this.notify('move');
    return true;
  }

  _settlePick() {
    this.same = this.answers.filter((v, i) => v === this.theirAns[i]).length;
    this._end('pick', null);
  }

  // ---------- adam asmaca ----------

  guess(l) {
    if (this.state !== 'playing' || this.spec.type !== 'hang' || this.role !== 'guesser') return false;
    if (this.pend || !ALPHABET.includes(l) || this.tried.includes(l)) return false;
    this.pend = l;
    this.send({ a: 'g', id: this.id, n: this.n, l });
    this.notify('move');
    return true;
  }

  _applyGuess(l, pos) {
    this.tried.push(l);
    this.hist.push([l, pos]);
    this.n++;
    if (pos.length) for (const p of pos) this.mask[p] = l;
    else this.miss++;
    const solved = this.mask.every(Boolean);
    const dead = this.miss >= this.spec.lives;
    if (!solved && !dead) return this.notify('move');
    if (this.role === 'setter') this.send({ a: 'rev', id: this.id, w: this.word, s: this.salt }); // kelimeyi aç
    this._end((this.role === 'guesser') === solved ? 'win' : 'lose', null);
  }

  // Tahmin eden: açılan kelime baştaki kilide ve verilen bütün cevaplara uymalı.
  async _verify(w, s) {
    const word = normWord(w);
    if (!word || typeof s !== 'string' || s.length > 32 || [...word].length !== this.len) return null;
    if (toB64u(await sha(`hang|${this.id}|${word}|${s}`)) !== this.hash) return null;
    const chars = [...word];
    const fits = this.hist.every(([l, pos]) => {
      const real = chars.flatMap((c, i) => (c === l ? [i] : []));
      return real.length === pos.length && real.every((v, i) => v === pos[i]);
    });
    return fits ? word : null;
  }

  onMsg(m) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !ID.test(m.id)) return;
    switch (m.a) {
      case 'inv': {
        if (!KINDS[m.k] || this.state === 'playing') return;
        if (m.k === 'hang' && (typeof m.h !== 'string' || m.h.length !== 43 || !Number.isInteger(m.len) || m.len < 3 || m.len > 12)) return;
        const collide = this.state === 'inviting';
        // İki taraf aynı anda çağırdı: kimliği büyük olan, karşı tarafın davetini kabul eder.
        if (collide && this.id < m.id) return;
        this.reset();
        this.kind = m.k;
        this.id = m.id;
        this.state = 'invited';
        if (m.k === 'hang') {
          this.hash = m.h;
          this.len = m.len;
        }
        if (collide) this.accept();
        else this.notify('invite');
        return;
      }
      case 'acc':
        if (this.state !== 'inviting' || m.id !== this.id) return;
        this._begin('me');
        this.notify('start');
        return;
      case 'dec':
        if (m.id !== this.id) return;
        if (this.state === 'inviting') {
          this.reset();
          this.notify('declined');
        } else if (this.state === 'invited') {
          this.reset();
          this.notify('withdrawn');
        }
        return;
      case 'mv': {
        if (this.state !== 'playing' || m.id !== this.id || this.spec.type !== 'board' || this.turn !== 'them' || m.n !== this.n) return;
        const cell = this.target(m.i);
        if (cell >= 0) this._place(cell, 'them');
        return;
      }
      case 'done': {
        if (this.state !== 'playing' || m.id !== this.id) return;
        const type = this.spec.type;
        if (type === 'quiz') {
          const ok = Number.isInteger(m.c) && Number.isInteger(m.w) && m.c >= 0 && m.w >= 0 && m.c <= 200 && m.w <= 200;
          if (this.theirs || !ok) return;
          this.theirs = { c: m.c, w: m.w };
          if (this.mineDone) this._settleQuiz();
          else this.notify('change');
        } else if (type === 'pick') {
          const n = this.spec.count;
          if (this.theirAns || !Array.isArray(m.v) || m.v.length !== n || !m.v.every((x) => x === 0 || x === 1)) return;
          this.theirAns = m.v;
          if (this.mineDone) this._settlePick();
          else this.notify('change');
        }
        return;
      }
      case 'g': {
        if (this.state !== 'playing' || m.id !== this.id || this.spec.type !== 'hang' || this.role !== 'setter') return;
        if (m.n !== this.n || !ALPHABET.includes(m.l) || this.tried.includes(m.l)) return;
        const pos = [...this.word].flatMap((c, i) => (c === m.l ? [i] : []));
        this.send({ a: 'res', id: this.id, n: m.n, l: m.l, p: pos });
        this._applyGuess(m.l, pos);
        return;
      }
      case 'res': {
        if (this.state !== 'playing' || m.id !== this.id || this.spec.type !== 'hang' || this.role !== 'guesser') return;
        if (m.n !== this.n || m.l !== this.pend || !Array.isArray(m.p)) return;
        const p = m.p;
        const ok = p.every((x, i) => Number.isInteger(x) && x >= 0 && x < this.len && !this.mask[x] && (i === 0 || x > p[i - 1]));
        if (!ok) return;
        this.pend = null;
        this._applyGuess(m.l, p);
        return;
      }
      case 'rev': {
        if (m.id !== this.id || this.state !== 'over' || !this.spec || this.spec.type !== 'hang' || this.role !== 'guesser' || this.revealed) return;
        const id = this.id;
        this._verify(m.w, m.s).then((word) => {
          if (this.id !== id) return;
          if (word) {
            this.revealed = word;
            this.notify('reveal');
          } else {
            if (this.result === 'lose') this.score.hang.them--; // hileyle kazanılan sayılmaz
            this.result = 'cheat';
            this.notify('cheat');
          }
        });
        return;
      }
      case 'quit':
        if (this.state === 'playing' && m.id === this.id) this._end('gone', null);
        return;
      default:
    }
  }
}
