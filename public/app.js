// Arayüz ve sohbet akışı.
// Cihaza hiçbir şey yazılmaz: çerez yok, localStorage yok. Her şey bu sekmenin belleğinde yaşar.
import { doorId, newKeys, openSession, randId } from './e2e.js';
import { ICON, Rps, randomMove } from './rps.js';
import { ICE, aliasesOf, codeOf, iceOf } from './words.js';

const API = '/api/a';
const MAX_VISIBLE = 14; // ekranda kalan mesaj sayısı; eskiler uçar
const PING_MS = 8000; // "buradayım" işareti aralığı
const STALE_MS = 20000; // karşı taraf bu kadar sessizse uyarı
const DEAD_MS = 45000; // bu kadar sessizse sohbet biter
const NOSHOW_MS = 12000; // eşleşen kişi hiç görünmezse yeniden ara
const TYPING_MS = 5500; // "yazıyor" balonunun ekranda kalma süresi

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cid = randId(12); // bu sekmenin geçici kimliği; yalnızca çevrimiçi sayacı ve kendinle eşleşmeyi önlemek için
const cryptoOk = Boolean(window.crypto && crypto.subtle);

const S = { view: 'home', run: 0, door: null, tk: null, chat: null, lastHb: 0, admin: '', homePolls: 0 };
try {
  S.admin = sessionStorage.getItem('adm') || ''; // yalnızca yönetici, /admin sayfasından açarsa
} catch {
  /* depolama kapalı olabilir */
}

// ---------- yardımcılar ----------
async function api(op, data = {}, ms = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, ...data }),
      signal: ctl.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function hb() {
  const t = Date.now();
  if (t - S.lastHb < 45000) return 0;
  S.lastHb = t;
  return 1;
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function human(secs) {
  if (secs < 60) return `${secs} sn`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m} dk ${s} sn` : `${m} dk`;
}

const xIntent = (text) => 'https://x.com/intent/post?text=' + encodeURIComponent(text);

const VIEWS = ['home', 'search', 'chat', 'end', 'note'];
function show(view) {
  S.view = view;
  for (const n of VIEWS) $('v-' + n).hidden = n !== view;
  closeSheet();
}

function openSheet(title, text, actions) {
  $('sheet-title').textContent = title;
  $('sheet-text').textContent = text;
  $('sheet-actions').replaceChildren(
    ...actions.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (a.kind || 'ghost');
      b.textContent = a.label;
      b.onclick = () => {
        closeSheet();
        if (a.fn) a.fn();
      };
      return b;
    }),
  );
  $('sheet').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
}

function showNote(title, text) {
  S.run++;
  S.tk = null;
  $('note-title').textContent = title;
  $('note-text').textContent = text;
  show('note');
}

function showBan(until) {
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  const left = mins >= 120 ? `${Math.round(mins / 60)} saat` : `${mins} dakika`;
  showNote('Bu ağ engellendi', `Yaklaşık ${left} sonra yeniden deneyebilirsin.`);
}

// Klavye açılınca yazı alanı görünür kalsın (özellikle uygulama içi tarayıcılarda).
function fit() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty('--vh', (vv ? vv.height : window.innerHeight) + 'px');
  if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
  if (S.view === 'chat') $('msgs').scrollTop = $('msgs').scrollHeight;
}

// ---------- ana sayfa ----------
function renderHome() {
  const inDoor = Boolean(S.door);
  const ready = cryptoOk && $('age').checked; // yaş kutusu işaretlenmeden sohbet açılmaz
  $('door-note').hidden = !inDoor;
  $('btn-find').textContent = inDoor ? 'Sohbete gir' : 'Birini bul';
  $('btn-find').disabled = !ready;
  $('btn-door').disabled = !ready;
  $('btn-door').hidden = inDoor;
  $('btn-random').hidden = !inDoor;
}

function homeErr(text) {
  $('home-err').textContent = text;
  $('home-err').hidden = !text;
}

async function refreshHome() {
  if (S.view !== 'home' || document.hidden || S.homePolls > 20) return;
  S.homePolls++;
  try {
    const r = await api('hello', { cid });
    S.lastHb = Date.now();
    if (!r.ok) {
      if (r.err === 'setup') homeErr('Sunucu kurulumu eksik: Redis bağlı değil.');
      return;
    }
    homeErr('');
    $('online').textContent = `${Math.max(1, r.online)} çevrimiçi`;
  } catch {
    /* sayaç gelmese de site çalışır */
  }
}

function goHome() {
  S.run++;
  S.tk = null;
  S.homePolls = 0;
  show('home');
  renderHome();
  syncDoor();
  refreshHome();
}

// ---------- davet linki ----------
// Davet sırrı linkin # sonrasında durur; tarayıcı bu kısmı sunucuya göndermez.
function readDoorSecret() {
  const h = location.hash.match(/(?:^#|&)o=([A-Za-z0-9_-]{8,40})(?:&|$)/);
  if (h) return h[1];
  const q = new URLSearchParams(location.search).get('o');
  return q && /^[A-Za-z0-9_-]{8,40}$/.test(q) ? q : null;
}

async function setDoor(secret) {
  S.door = secret ? { secret, id: await doorId(secret) } : null;
}

// Adres çubuğundaki davet ile bellekteki aynı kalsın (örn. açık sekmeye davet linki yapıştırılırsa).
async function syncDoor() {
  const secret = readDoorSecret();
  if ((secret || '') === (S.door ? S.door.secret : '')) return;
  await setDoor(secret);
  if (S.view === 'home') renderHome();
}

const doorUrl = () => `${location.origin}/#o=${S.door.secret}`;

async function createDoor() {
  const secret = randId(9);
  await setDoor(secret);
  history.replaceState(null, '', '#o=' + secret);
  startSearch();
}

function leaveDoor() {
  S.door = null;
  history.replaceState(null, '', location.pathname);
  renderHome();
}

// ---------- arama ----------
async function startSearch(notice = '') {
  if (!cryptoOk || !$('age').checked) return goHome();
  const my = ++S.run;
  S.tk = null;
  const door = S.door;
  $('search-title').textContent = door ? 'Davet linkin hazır' : 'Birini arıyorum…';
  $('door-box').hidden = !door;
  $('btn-lonely-door').hidden = true;
  if (door) {
    $('door-link').value = doorUrl();
    $('btn-copy').textContent = 'Kopyala';
    $('btn-share-door').href = xIntent(`Benimle anonim konuş:\n${doorUrl()}`);
  }
  show('search');

  const t0 = Date.now();
  const paint = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    const clock = mmss(s);
    const lonely = !door && s >= 40;
    $('btn-lonely-door').hidden = !lonely;
    $('search-sub').textContent =
      notice && s < 4 ? notice : door ? `Biri açınca sohbet başlar · ${clock}` : lonely ? `Şu an kimse yok · ${clock}` : clock;
  };
  paint();
  const timer = setInterval(paint, 1000);

  try {
    const keys = await newKeys();
    let misses = 0;
    let polls = 0;
    let errs = 0;
    while (my === S.run) {
      let res = null;
      // Yuvada mıyım kontrolü her üç yoklamada bir yapılır; bir kez "değilsin" gelirse sıradaki yoklama da bakar.
      const chk = misses > 0 || polls % 3 === 0;
      try {
        res = S.tk
          ? await api('wait', {
              tk: S.tk,
              chk: chk ? 1 : 0,
              re: misses >= 1 ? 1 : 0,
              keep: polls % 9 === 0 ? 1 : 0,
              hb: hb(),
            })
          : await api('find', { cid, pub: keys.pub, door: door ? door.id : '' });
      } catch {
        /* ağ hatası: aşağıda sayılır */
      }
      if (my !== S.run) {
        // Bu arada vazgeçildi; tam o an eşleştiysek karşı tarafı bekletme.
        if (res && res.matched) api('leave', { tok: res.matched.tok }).catch(() => {});
        return;
      }
      if (!res) {
        if (++errs >= 8) return showNote('Bağlantı kurulamadı', 'İnternetini kontrol edip yeniden dene.');
        await sleep(1500);
        continue;
      }
      errs = 0;
      if (!res.ok) {
        if (res.err === 'ban') return showBan(res.until);
        if (res.err === 'rate') {
          return showNote('Çok fazla arama', `${Math.max(1, Math.ceil(res.retry / 60))} dakika sonra yeniden dene.`);
        }
        if (res.err === 'setup') return showNote('Sunucu kurulumu eksik', 'Redis bağlı değil.');
        if (res.err === 'expired') {
          S.tk = null; // bilet eskidi: yeni aramayla devam
          misses = 0;
          continue;
        }
        await sleep(2000);
        continue;
      }
      if (res.tk) S.tk = res.tk;
      if (res.matched) {
        S.tk = null;
        return startChat(my, keys, res.matched);
      }
      if (res.inSlot !== undefined) misses = res.inSlot ? 0 : misses + 1;
      polls++;
      // Uzun bekleyişte seyrek yokla: yalnız bekleyen kişi sunucuya az yük olsun.
      const waited = Date.now() - t0;
      await sleep(document.hidden ? 4000 : waited < 20000 ? 1400 : waited < 60000 ? 2400 : 3500);
    }
  } catch {
    if (my === S.run) showNote('Bir şey ters gitti', 'Sayfayı yenileyip yeniden dene.');
  } finally {
    clearInterval(timer);
  }
}

function cancelSearch() {
  const tk = S.tk;
  if (tk) api('leave', { tk }).catch(() => {});
  goHome();
}

// ---------- sohbet ----------
const alive = (C) => S.chat === C && !C.over;

async function startChat(my, keys, m) {
  let sess;
  try {
    sess = await openSession({
      priv: keys.priv,
      myPub: keys.pub,
      peerPub: m.peerPub,
      slot: m.slot,
      room: m.room,
      doorSecret: S.door ? S.door.secret : '',
    });
  } catch {
    sess = null;
  }
  if (!sess || my !== S.run) {
    api('leave', { tok: m.tok }).catch(() => {});
    if (my === S.run) startSearch('Eşleşme tutmadı, yeniden arıyorum…');
    return;
  }

  const names = aliasesOf(sess.seed);
  const t = Date.now();
  const C = {
    tok: m.tok,
    sess,
    code: codeOf(sess.seed),
    cur: 0, // karşı tarafın listesinde okuduğumuz yer
    out: [], // gönderilmeyi bekleyen şifreli mesajlar
    q: Promise.resolve(), // şifreleme sırası: mesajlar sıra numarasıyla aynı düzende çıksın
    seq: 0,
    peerMax: 0, // karşıdan görülen en büyük sıra numarası: yinelenenleri ayıklar
    t0: t,
    waitFrom: t,
    peerSeen: 0,
    peerLeft: false,
    lastAct: t,
    lastPing: 0,
    lastTyping: 0,
    typingUntil: 0,
    typingEl: null,
    sent: 0,
    recv: 0,
    fails: 0,
    ice: iceOf(sess.seed),
    peer: m.slot === 'a' ? names.b : names.a,
    game: null,
    over: false,
    wake: null,
    tick: 0,
  };
  C.game = new Rps(
    (g) => enqueue(C, { t: 'g', g }, true),
    (ev) => onGame(C, ev),
  );
  S.chat = C;

  $('peer-name').textContent = C.peer;
  $('btn-code').dataset.code = C.code;
  $('msgs').replaceChildren();
  $('input').value = '';
  setTray(false);
  addMsg('sys', 'Mesajlar uçtan uca şifreli.');
  paintIce(C);
  paintChat(C);
  paintGame(C);
  show('chat');
  fit();
  C.tick = setInterval(() => paintChat(C), 1000);
  $('input').focus({ preventScroll: true });
  chatLoop(C);
}

function paintChat(C) {
  if (!alive(C)) return;
  const now = Date.now();
  const typing = C.typingUntil > now;
  setTyping(C, typing);
  let text = 'çevrimiçi';
  let state = 'on';
  if (C.fails >= 2) [text, state] = ['bağlantın zayıf…', 'off'];
  else if (!C.peerSeen) [text, state] = ['bağlanıyor…', 'off'];
  else if (now - C.peerSeen > STALE_MS) [text, state] = ['bağlantısı bekleniyor…', 'off'];
  else if (typing) [text, state] = ['yazıyor…', 'typing'];
  const el = $('peer-status');
  if (el.textContent !== text) el.textContent = text;
  el.dataset.s = state;
}

function paintIce(C) {
  $('ice-q').textContent = ICE[C.ice % ICE.length];
}

function addMsg(kind, text) {
  const list = $('msgs');
  const li = document.createElement('li');
  li.className = 'msg ' + kind;
  li.textContent = text; // yabancıdan gelen metin asla HTML olarak işlenmez
  const C = S.chat;
  list.insertBefore(li, C && C.typingEl && C.typingEl.isConnected ? C.typingEl : null); // "yazıyor" balonu hep en altta
  const live = list.querySelectorAll('.msg:not(.fly):not(.typing)');
  for (let i = 0; i < live.length - MAX_VISIBLE; i++) fly(live[i]);
  list.scrollTop = list.scrollHeight;
}

function fly(node) {
  node.classList.add('fly');
  const rm = () => node.remove();
  node.addEventListener('animationend', rm, { once: true });
  setTimeout(rm, 1000);
}

// Karşı taraf yazarken mesajların altında üç noktalı balon görünür.
function setTyping(C, on) {
  if (on && !C.typingEl) {
    const li = document.createElement('li');
    li.className = 'msg them typing';
    li.setAttribute('aria-label', 'yazıyor');
    li.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    $('msgs').append(li);
    C.typingEl = li;
    $('msgs').scrollTop = $('msgs').scrollHeight;
  } else if (!on && C.typingEl) {
    C.typingEl.remove();
    C.typingEl = null;
  }
}

// Şifreleyip gönderim kuyruğuna koyar. Tür: m mesaj, t yazıyor, i buz kırıcı, g oyun hamlesi.
function enqueue(C, obj, urgent) {
  C.q = C.q
    .then(async () => {
      const n = ++C.seq;
      C.out.push(await C.sess.seal({ ...obj, n }));
      if (urgent && C.wake) C.wake();
    })
    .catch(() => {});
}

function nap(C, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      C.wake = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    C.wake = done;
  });
}

function syncDelay(C) {
  if (C.out.length) return 60;
  if (document.hidden) return 5000;
  // Her yoklama bir sunucu isteği ve bir Redis komutudur: konuşma canlıyken sık, durgunken seyrek.
  const idle = Date.now() - C.lastAct;
  return idle < 12000 ? 1000 : idle < 60000 ? 1800 : 3000;
}

async function onEntry(C, e) {
  C.peerSeen = Date.now();
  if (e === 'p') return;
  if (e === 'x') {
    C.peerLeft = true;
    return;
  }
  if (e[0] !== 'm') return;
  const msg = await C.sess.open(e.slice(1));
  if (!msg || !Number.isInteger(msg.n) || msg.n <= C.peerMax) return; // açılamadı ya da yinelenen
  C.peerMax = msg.n;
  C.lastAct = Date.now();
  if (msg.t === 'm' && typeof msg.x === 'string') {
    C.recv++;
    C.typingUntil = 0;
    setTyping(C, false);
    addMsg('them', msg.x.slice(0, 2000));
  } else if (msg.t === 't') {
    C.typingUntil = Date.now() + TYPING_MS;
  } else if (msg.t === 'i' && Number.isInteger(msg.i)) {
    C.ice = Math.abs(msg.i) % ICE.length;
    paintIce(C);
  } else if (msg.t === 'g') {
    await C.game.onMsg(msg.g);
  }
  paintChat(C);
}

async function chatLoop(C) {
  while (alive(C)) {
    const batch = C.out.splice(0, 10);
    const t = Date.now();
    const ping = t - C.lastPing >= PING_MS;
    const beat = hb();
    let res = null;
    try {
      res = await api('sync', { tok: C.tok, cur: C.cur, out: batch, ping: ping ? 1 : 0, ...(beat ? { hb: 1, cid } : {}) });
    } catch {
      /* ağ hatası */
    }
    if (!alive(C)) return;

    if (!res || !res.ok) {
      // Gitmiş olabilir de olmayabilir de: yeniden kuyruğa al. Karşı taraf sıra numarasından yineleneni ayıklar.
      C.out.unshift(...batch);
      if (res && (res.err === 'expired' || res.err === 'full')) return endChat('expired');
      C.fails++;
      paintChat(C);
      if (C.fails >= 12) return endChat('net');
      await nap(C, Math.min(1000 * C.fails, 4000));
      continue;
    }

    C.fails = 0;
    if (ping || batch.length) C.lastPing = t; // giden her kayıt karşı taraf için hayat işaretidir
    C.cur = res.cur;
    for (const e of res.in) await onEntry(C, e);
    if (!alive(C)) return;
    if (C.peerLeft) return endChat('peer');

    const now = Date.now();
    if (!C.peerSeen) {
      if (now - C.waitFrom > NOSHOW_MS) return rematch(C);
    } else if (now - C.peerSeen > DEAD_MS) {
      return endChat('timeout');
    }
    paintChat(C);
    await nap(C, syncDelay(C));
  }
}

function rematch(C) {
  C.over = true;
  S.chat = null;
  clearInterval(C.tick);
  api('leave', { tok: C.tok }).catch(() => {});
  startSearch('Eşleşme tutmadı, yeniden arıyorum…');
}

const REASONS = {
  me: 'Sohbeti bitirdin',
  peer: 'Karşı taraf ayrıldı',
  timeout: 'Karşı tarafın bağlantısı koptu',
  net: 'Bağlantın koptu',
  report: 'Bildirildi',
  expired: 'Sohbet süresi doldu',
};

function endChat(reason) {
  const C = S.chat;
  if (!C || C.over) return;
  C.over = true;
  S.chat = null;
  S.run++;
  clearInterval(C.tick);
  if (C.wake) C.wake();
  api('leave', { tok: C.tok }).catch(() => {});

  const secs = Math.max(1, Math.round((Date.now() - C.t0) / 1000));
  const n = C.sent + C.recv;
  $('msgs').replaceChildren(); // ekrandaki her şey gider; anahtarlar da C ile birlikte bellekten düşer
  $('input').value = '';
  $('input').blur();
  setTray(false);
  $('end-title').textContent = REASONS[reason] || 'Sohbet bitti';
  $('end-stats').textContent = `${human(secs)} · ${n} mesaj`;
  $('btn-share').href = xIntent(
    n > 0
      ? `Bir yabancıyla ${human(secs)} anonim konuştum. Mesajlardan iz kalmadı.\n${location.origin}`
      : `Anonim sohbet, iz bırakmaz:\n${location.origin}`,
  );
  show('end');
}

async function report(C, hours) {
  try {
    await api('report', { tok: C.tok, ...(hours ? { adm: S.admin, hours } : {}) });
  } catch {
    /* bildirim gitmese de sohbet biter */
  }
  endChat('report');
}

// ---------- taş kağıt makas ----------
const RESULT = { 1: 'Kazandın', 0: 'Berabere', '-1': 'Kaybettin' };

function setTray(open) {
  $('rps').hidden = !open;
  $('btn-game').setAttribute('aria-expanded', String(open));
  if (!open) $('btn-game').classList.remove('ping');
}

function paintGame(C) {
  const g = C.game;
  const open = !$('rps').hidden;
  let s = 'Taş, kağıt, makas';
  if (g.mine && g.theirHash) s = 'Açılıyor…';
  else if (g.mine) s = `${ICON[g.mine.move]} seçtin. ${C.peer} bekleniyor…`;
  else if (g.theirHash) s = `${C.peer} seçti. Sıra sende.`;
  else if (g.last && g.last.result !== null) {
    s = `${ICON[g.last.mine]} ${ICON[g.last.theirs]} ${RESULT[g.last.result]} · ${g.score.me} – ${g.score.them}`;
  }
  $('rps-status').textContent = s;
  for (const b of $('rps-picks').children) {
    b.disabled = Boolean(g.mine);
    b.classList.toggle('on', Boolean(g.mine) && b.dataset.move === g.mine.move);
  }
  // Karşı taraf seçip bekliyorsa ve panel kapalıysa düğmede nokta yanar.
  $('btn-game').classList.toggle('ping', Boolean(g.theirHash) && !g.mine && !open);
}

function onGame(C, ev) {
  if (!alive(C)) return;
  const g = C.game;
  if (ev === 'invite') addMsg('sys', `${C.peer} taş kağıt makas oynuyor. Sıra sende.`);
  else if (ev === 'cheat') addMsg('sys', 'Geçersiz hamle. Tur iptal.');
  else if (ev === 'result') {
    addMsg('sys', `Sen ${ICON[g.last.mine]} · ${ICON[g.last.theirs]} ${C.peer}: ${RESULT[g.last.result]}`);
  }
  paintGame(C);
}

// ---------- olaylar ----------
$('age').addEventListener('change', renderHome);
$('btn-find').onclick = () => startSearch();
$('btn-door').onclick = createDoor;
$('btn-lonely-door').onclick = () => {
  const tk = S.tk;
  if (tk) api('leave', { tk }).catch(() => {});
  createDoor();
};
$('btn-random').onclick = leaveDoor;
$('btn-cancel').onclick = cancelSearch;
$('btn-again').onclick = () => startSearch();
$('btn-home').onclick = goHome;
$('btn-note-home').onclick = goHome;
$('btn-end').onclick = () => endChat('me');

$('btn-copy').onclick = async () => {
  const inp = $('door-link');
  let ok = false;
  try {
    await navigator.clipboard.writeText(inp.value);
    ok = true;
  } catch {
    inp.focus();
    inp.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
  }
  $('btn-copy').textContent = ok ? 'Kopyalandı' : 'Seçip kopyala';
};

$('btn-ice').onclick = () => {
  const C = S.chat;
  if (!C) return;
  C.ice = (C.ice + 1) % ICE.length;
  paintIce(C);
  enqueue(C, { t: 'i', i: C.ice }, true);
};

$('btn-code').onclick = () => {
  const C = S.chat;
  if (!C) return;
  openSheet('Güvenlik kodu', `${C.code}\n\nKarşı tarafta da aynıysa mesajları aranızda kimse okuyamaz.`, [{ label: 'Tamam' }]);
};

$('btn-report').onclick = () => {
  const C = S.chat;
  if (!C) return;
  const actions = [{ label: 'Bildir ve bitir', kind: 'danger', fn: () => report(C) }];
  if (S.admin) {
    actions.push(
      { label: 'Yönetici: 24 saat engelle', kind: 'danger', fn: () => report(C, 24) },
      { label: 'Yönetici: 30 gün engelle', kind: 'danger', fn: () => report(C, 720) },
    );
  }
  actions.push({ label: 'Vazgeç' });
  openSheet('Bildir', 'Sohbet biter. Çok bildirilen ağ engellenir.', actions);
};

$('btn-game').onclick = () => {
  const C = S.chat;
  if (!C) return;
  setTray($('rps').hidden);
  paintGame(C);
  fit();
};

$('rps-picks').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-move]');
  const C = S.chat;
  if (!b || !C) return;
  C.lastAct = Date.now();
  C.game.pick(b.dataset.move === '?' ? randomMove() : b.dataset.move);
});

$('composer').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const C = S.chat;
  const inp = $('input');
  const text = inp.value.trim();
  if (!C || !text) return;
  inp.value = '';
  C.sent++;
  C.lastAct = Date.now();
  C.lastTyping = 0; // sıradaki mesaja başlar başlamaz "yazıyor" yeniden gitsin
  addMsg('me', text);
  enqueue(C, { t: 'm', x: text }, true);
  inp.focus();
});

$('input').addEventListener('input', () => {
  const C = S.chat;
  if (!C) return;
  const t = Date.now();
  C.lastAct = t;
  if ($('input').value && t - C.lastTyping > 4000) {
    C.lastTyping = t;
    enqueue(C, { t: 't' }, true);
  }
});

$('sheet').addEventListener('click', (ev) => {
  if (ev.target === $('sheet')) closeSheet();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeSheet();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const C = S.chat;
  if (C) {
    // Sekme arka plandayken sayaçlar durur; dönünce karşı tarafa kendini göstermesi için pay bırak.
    const t = Date.now();
    if (C.peerSeen) C.peerSeen = Math.max(C.peerSeen, t - (DEAD_MS - NOSHOW_MS));
    C.waitFrom = Math.max(C.waitFrom, t - NOSHOW_MS / 2);
    if (C.wake) C.wake();
  } else if (S.view === 'home') {
    S.homePolls = 0;
    refreshHome();
  }
});

// Sekme kapanırken karşı tarafı bekletme.
window.addEventListener('pagehide', () => {
  const C = S.chat;
  const body = C ? { op: 'leave', tok: C.tok } : S.tk ? { op: 'leave', tk: S.tk } : null;
  if (body && navigator.sendBeacon) {
    navigator.sendBeacon(API, new Blob([JSON.stringify(body)], { type: 'application/json' }));
  }
});

// Geri tuşuyla önbellekten dönülürse eski sohbet ölüdür: temiz başla.
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted) location.reload();
});

// Arama ya da sohbet sürerken dokunma; ana sayfaya dönünce goHome zaten eşitler.
window.addEventListener('hashchange', () => {
  if (S.view === 'home') syncDoor();
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fit);
  window.visualViewport.addEventListener('scroll', fit);
}
window.addEventListener('resize', fit);

// ---------- başlangıç ----------
(async function boot() {
  fit();
  if (!cryptoOk) {
    homeErr('Bu tarayıcı desteklenmiyor.');
    renderHome();
    return;
  }
  const secret = readDoorSecret();
  if (secret) await setDoor(secret);
  renderHome();
  refreshHome();
  setInterval(refreshHome, 45000);
})();
