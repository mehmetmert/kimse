// Taş kağıt makas. Kimse diğerinin seçimini önceden göremesin diye "önce kilitle, sonra aç" ile oynanır:
//   1. Her taraf seçimini rastgele bir tuzla özetleyip yalnızca özeti gönderir (kilit).
//   2. İki kilit de ulaşınca taraflar seçimi ve tuzu açar.
//   3. Açılan seçim baştaki özete uymuyorsa tur geçersiz sayılır.
// Bu dosya DOM kullanmaz; aynı kod Node testlerinde de çalışır.
import { toB64u } from './e2e.js';

export const MOVES = ['t', 'k', 'm']; // taş, kağıt, makas
export const ICON = { t: '✊', k: '✋', m: '✌️' };
const BEATS = { t: 'm', k: 't', m: 'k' };

/** 1 kazandın, 0 berabere, -1 kaybettin. */
export const outcome = (mine, theirs) => (mine === theirs ? 0 : BEATS[mine] === theirs ? 1 : -1);

export function randomMove() {
  const b = new Uint8Array(1);
  do crypto.getRandomValues(b);
  while (b[0] >= 255); // 255 atılınca üç seçenek tam eşit olasılıklı olur
  return MOVES[b[0] % 3];
}

async function digest(round, move, salt) {
  const data = new TextEncoder().encode(`rps|${round}|${move}|${salt}`);
  return toB64u(await crypto.subtle.digest('SHA-256', data));
}

export class Rps {
  /**
   * @param send   karşı tarafa oyun mesajı yollar: send({ a, r, ... })
   * @param notify durum değişince çağrılır: 'change' | 'invite' | 'result' | 'cheat'
   */
  constructor(send, notify = () => {}) {
    this.send = send;
    this.notify = notify;
    this.round = 1;
    this.mine = null; // { move, salt }: bu turdaki kilitli seçimim
    this.theirHash = null; // karşı tarafın kilidi
    this.revealed = false;
    this.last = null; // { mine, theirs, result }: biten son tur
    this.score = { me: 0, them: 0 };
  }

  /** Seçimi kilitler. Bir turda yalnızca bir kez seçilebilir. */
  async pick(move) {
    if (this.mine || !MOVES.includes(move)) return false;
    const round = this.round;
    const salt = toB64u(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await digest(round, move, salt);
    if (this.mine || round !== this.round) return false;
    this.mine = { move, salt };
    this.send({ a: 'c', r: round, h: hash });
    this._reveal();
    this.notify('change');
    return true;
  }

  _reveal() {
    if (!this.mine || !this.theirHash || this.revealed) return;
    this.revealed = true;
    this.send({ a: 'r', r: this.round, m: this.mine.move, s: this.mine.salt });
  }

  _next() {
    this.round++;
    this.mine = null;
    this.theirHash = null;
    this.revealed = false;
  }

  /** Karşıdan gelen oyun mesajını işler. Başka tura ait ya da sırasız mesajlar yok sayılır. */
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
      if (!this.theirHash || !this.mine) return; // iki kilit de yokken açılan seçim geçersiz
      const mine = this.mine.move;
      const valid =
        MOVES.includes(g.m) &&
        typeof g.s === 'string' &&
        g.s.length <= 64 &&
        (await digest(this.round, g.m, g.s)) === this.theirHash;
      if (!valid) {
        this.last = { mine, theirs: null, result: null };
        this._next();
        this.notify('cheat');
        return;
      }
      const result = outcome(mine, g.m);
      if (result > 0) this.score.me++;
      else if (result < 0) this.score.them++;
      this.last = { mine, theirs: g.m, result };
      this._next();
      this.notify('result');
    }
  }
}
