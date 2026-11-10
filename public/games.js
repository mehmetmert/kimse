// İki kişilik oyunlar: zar ve sıralı tahta oyunları (XOX, Dört bağla).
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

// ---------- Sıralı tahta oyunları ----------
// Biri çağırır, diğeri kabul eder; çağıran başlar. İki taraf aynı kuralları uygular,
// karşıdan gelen geçersiz hamle (sırası değilken, dolu kareye, yanlış sırayla) yok sayılır.
export const BOARDS = {
  xox: { name: 'XOX', cols: 3, rows: 3, win: 3, drop: false },
  c4: { name: 'Dört bağla', cols: 7, rows: 6, win: 4, drop: true }, // taş sütunun en altına düşer
};

const ID = /^[A-Za-z0-9_-]{4,16}$/;

export class Match {
  /**
   * @param send   karşı tarafa yollar: send({ a, id, ... })
   * @param notify 'change' | 'invite' | 'withdrawn' | 'declined' | 'start' | 'move' | 'over'
   */
  constructor(send, notify) {
    this.send = send;
    this.notify = notify || (() => {});
    this.score = {};
    for (const k of Object.keys(BOARDS)) this.score[k] = { me: 0, them: 0 };
    this.reset();
  }

  /** state: idle | inviting (ben çağırdım) | invited (beni çağırdılar) | playing | over */
  reset() {
    this.state = 'idle';
    this.kind = null;
    this.id = null;
    this.board = null; // hücre → null | 'me' | 'them'; sıra sıra, üst satır önce
    this.first = null; // 'me' | 'them': kim başladı (XOX'ta X olan)
    this.turn = null;
    this.n = 0; // oynanan hamle sayısı
    this.result = null; // win | lose | draw | quit (ben bıraktım) | gone (o bıraktı)
    this.line = null; // kazanan sıranın hücreleri
    this.lastCell = -1;
  }

  get spec() {
    return BOARDS[this.kind];
  }

  invite(kind) {
    if (!BOARDS[kind] || this.state === 'inviting' || this.state === 'playing') return false;
    if (this.state === 'invited') this.send({ a: 'dec', id: this.id }); // bekleyen daveti geri çevir
    this.reset();
    this.kind = kind;
    this.id = randId(6);
    this.state = 'inviting';
    this.send({ a: 'inv', id: this.id, k: kind });
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
    const { cols, rows } = this.spec;
    this.state = 'playing';
    this.first = first;
    this.turn = first;
    this.board = Array(cols * rows).fill(null);
    this.n = 0;
    this.result = null;
    this.line = null;
    this.lastCell = -1;
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
    if (this.state !== 'playing' || this.turn !== 'me') return false;
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

  onMsg(m) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !ID.test(m.id)) return;
    switch (m.a) {
      case 'inv':
        if (!BOARDS[m.k] || this.state === 'playing') return;
        if (this.state === 'inviting') {
          // İki taraf aynı anda çağırdı: kimliği büyük olan, karşı tarafın davetini kabul eder.
          if (this.id < m.id) return;
          this.reset();
          this.kind = m.k;
          this.id = m.id;
          this.state = 'invited';
          this.accept();
          return;
        }
        this.reset();
        this.kind = m.k;
        this.id = m.id;
        this.state = 'invited';
        this.notify('invite');
        return;
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
        if (this.state !== 'playing' || m.id !== this.id || this.turn !== 'them' || m.n !== this.n) return;
        const cell = this.target(m.i);
        if (cell >= 0) this._place(cell, 'them');
        return;
      }
      case 'quit':
        if (this.state === 'playing' && m.id === this.id) this._end('gone', null);
        return;
      default:
    }
  }
}
