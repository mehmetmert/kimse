// Arayüz ve sohbet akışı. İki tür sohbet aynı ekranı kullanır:
//   duo  rastgele eşleşen iki kişi
//   room aynı linki açan birden fazla kişi (oda)
// Çerez yok; cihaza yazılan tek şey görünüm tercihidir (koyu / açık). Sohbetle ilgili her şey bu sekmenin belleğinde yaşar.
import { doorId, newKeys, openRoom, openSession, randId } from './e2e.js';
import { clean, hasLink, stripLinks } from './filter.js';
import { BOARDS, Dice, Match } from './games.js';
import { NAME, Rps, randomMove } from './rps.js';
import { COLORS, codeOf, colorsOf } from './words.js';

const API = '/api/a';
const MAX_MSGS = 200; // ekranda tutulan en fazla mesaj
const PING_MS = 8000; // "buradayım" işareti aralığı
const STALE_MS = 20000; // karşı taraf bu kadar sessizse uyarı
const DEAD_MS = 45000; // bu kadar sessizse sohbet biter
const NOSHOW_MS = 12000; // eşleşen kişi hiç görünmezse yeniden ara
const TYPING_MS = 5500; // "yazıyor" balonunun ekranda kalma süresi
const UNKNOWN = { name: 'Biri', hex: '#78818c' };
const TAG_NAMES = { oyun: 'Oyun', muzik: 'Müzik', dert: 'Dertleşme', film: 'Dizi film', spor: 'Spor' };
const TAG_WAIT_MS = 20000; // seçilen konu/ruh halinde bu kadar kimse çıkmazsa herkesle eşleş
const MOODS = { mutlu: 'Mutlu', uzgun: 'Üzgün', moralsiz: 'Moralsiz', sikilmis: 'Sıkılmış', yalniz: 'Yalnız', heyecanli: 'Heyecanlı' };
const NUDGE_GAP = 10000; // iki titreşim arası en az
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']; // menüdeki tepkiler; başka bir şey kabul edilmez
const KEY_RE = /^[A-Za-z0-9_-]{1,16}:\d{1,9}$/; // mesaj anahtarı: "kimlik:sıra"
const LONG_MS = 450; // bu kadar basılı tutunca menü açılır

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cid = randId(12); // bu sekmenin geçici kimliği; yalnızca çevrimiçi sayacı ve kendinle eşleşmeyi önlemek için
const cryptoOk = Boolean(window.crypto && crypto.subtle);

const S = { view: 'home', run: 0, door: null, tk: null, chat: null, lastHb: 0, admin: '', homePolls: 0, tag: '', mood: '', listen: '' };

// Sekme arkadayken gelen mesaj: başlıkta sayı ve kısa bir ses. Ses için tarayıcı bir dokunuş ister.
const TITLE = document.title;
let unread = 0;
let audio = null;

function unlockAudio() {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

function beep() {
  if (!audio || audio.state !== 'running') return;
  try {
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(740, t);
    o.frequency.setValueAtTime(988, t + 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.22);
  } catch {
    /* ses çalınamazsa sessiz geç */
  }
}

function alertTab(label) {
  if (!document.hidden) return;
  if (label) document.title = `${label} · ${TITLE}`;
  else document.title = `(${++unread}) ${TITLE}`;
  beep();
}
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
  $('app').dataset.view = view;
  if (view !== 'chat') $('strip').style.background = ''; // sohbet dışında şerit bütün renkleri gösterir
  closeSheet();
  closeMenu();
  $('profile').hidden = true;
}

// input verilirse pencerede bir yazı alanı çıkar; değeri düğmelerin işlevine geçer.
function openSheet(title, text, actions, input) {
  const box = $('sheet-input');
  $('sheet-title').textContent = title;
  $('sheet-text').textContent = text;
  $('sheet-text').hidden = !text;
  box.hidden = !input;
  if (input) {
    box.value = input.value || '';
    box.placeholder = input.placeholder || '';
    box.maxLength = input.max || 100;
  }
  $('sheet-actions').replaceChildren(
    ...actions.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (a.kind || 'ghost');
      b.textContent = a.label;
      b.disabled = Boolean(a.disabled);
      b.onclick = () => {
        closeSheet();
        if (a.fn) a.fn(box.value);
      };
      return b;
    }),
  );
  $('sheet').hidden = false;
  if (input) box.focus();
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

// Sunucunun "olmaz" yanıtlarını ekrana çevirir. Tanıdığı bir hata ise true döner.
function refused(res) {
  if (res.err === 'ban') showBan(res.until);
  else if (res.err === 'rate') showNote('Çok fazla deneme', `${Math.max(1, Math.ceil(res.retry / 60))} dakika sonra yeniden dene.`);
  else if (res.err === 'setup') showNote('Sunucu kurulumu eksik', 'Redis bağlı değil.');
  else if (res.err === 'full') showNote('Oda dolu', 'Bir odada en fazla 12 kişi olabilir.');
  else return false;
  return true;
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
  const inRoom = Boolean(S.door);
  const ready = cryptoOk && $('age').checked; // yaş kutusu işaretlenmeden sohbet açılmaz
  $('home-title').textContent = inRoom ? 'Oda sohbeti' : 'Anonim sohbet';
  $('btn-find').textContent = inRoom ? 'Odaya gir' : 'Birini bul';
  $('btn-find').disabled = !ready;
  $('btn-door').disabled = !ready;
  $('btn-door').hidden = inRoom;
  $('btn-random').hidden = !inRoom;
  $('tags-box').hidden = inRoom;
  $('moods-box').hidden = inRoom;
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

// ---------- oda linki ----------
// Oda sırrı linkin # sonrasında durur; tarayıcı bu kısmı sunucuya göndermez.
function readDoorSecret() {
  const h = location.hash.match(/(?:^#|&)o=([A-Za-z0-9_-]{8,40})(?:&|$)/);
  if (h) return h[1];
  const q = new URLSearchParams(location.search).get('o');
  return q && /^[A-Za-z0-9_-]{8,40}$/.test(q) ? q : null;
}

async function setDoor(secret) {
  S.door = secret ? { secret, id: await doorId(secret) } : null;
}

// Adres çubuğundaki oda ile bellekteki aynı kalsın (örn. açık sekmeye oda linki yapıştırılırsa).
async function syncDoor() {
  const secret = readDoorSecret();
  if ((secret || '') === (S.door ? S.door.secret : '')) return;
  await setDoor(secret);
  if (S.view === 'home') renderHome();
}

const doorUrl = () => `${location.origin}/#o=${S.door.secret}`;

async function createRoom() {
  const tk = S.tk;
  if (tk) api('leave', { tk }).catch(() => {}); // aramadan odaya geçiliyorsa sırayı bırak
  const secret = randId(9);
  await setDoor(secret);
  history.replaceState(null, '', '#o=' + secret);
  startRoom();
}

function leaveDoor() {
  S.door = null;
  history.replaceState(null, '', location.pathname);
  renderHome();
}

// ---------- rastgele arama ----------
async function startSearch(notice = '') {
  if (!cryptoOk || !$('age').checked) return goHome();
  const my = ++S.run;
  S.tk = null;
  let tag = S.tag; // konu seçildiyse önce o konuda arar
  let mood = S.mood; // ruh hali de
  $('search-title').textContent = ['Aranıyor', TAG_NAMES[tag], MOODS[mood]].filter(Boolean).join(' · ');
  $('btn-lonely-door').hidden = true;
  show('search');

  const t0 = Date.now();
  let note = notice;
  let noteUntil = t0 + 4000;
  const paint = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    const lonely = s >= 40;
    $('btn-lonely-door').hidden = !lonely;
    $('search-sub').textContent = note && Date.now() < noteUntil ? note : lonely ? `Şu an kimse yok · ${mmss(s)}` : mmss(s);
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
          : await api('find', { cid, pub: keys.pub, tag, mood });
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
        if (refused(res)) return;
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
        return startDuo(my, keys, res.matched, tag, mood);
      }
      if ((tag || mood) && Date.now() - t0 > TAG_WAIT_MS && S.tk) {
        // Bu konuda kimse yok: sıradan çık, herkesle eşleş.
        api('leave', { tk: S.tk }).catch(() => {});
        S.tk = null;
        tag = '';
        mood = '';
        misses = 0;
        $('search-title').textContent = 'Aranıyor';
        note = 'Aynı seçimi yapan yok, herkesle eşleşiyorsun';
        noteUntil = Date.now() + 6000;
        paint();
        continue;
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

// ---------- sohbet: ortak kısım ----------
const alive = (C) => S.chat === C && !C.over;

function newChat(kind, tok) {
  const t = Date.now();
  return {
    kind,
    tok,
    seal: null, // (nesne) → şifreli metin
    meId: '', // duo: 'a' ya da 'b'; oda: sunucunun verdiği üye kimliği
    me: UNKNOWN, // benim rengim
    nick: '', // bu sohbet için seçtiğim ad; boşsa rengim görünür
    mood: S.mood, // ruh halim
    listen: S.listen, // ne dinliyorum
    lastNudge: 0,
    nudgeIn: 0,
    people: new Map(), // kimlik → { name (renk adı), hex, c, gone, nick }
    cur: kind === 'duo' ? 0 : '0-0', // okuduğumuz yer
    out: [], // gönderilmeyi bekleyen şifreli mesajlar
    q: Promise.resolve(), // şifreleme sırası: mesajlar sıra numarasıyla aynı düzende çıksın
    seq: 0,
    last: new Map(), // kimlik → görülen en büyük sıra numarası: yinelenenleri ayıklar
    log: new Map(), // "kimlik:sıra" → { text, el }: yanıtlanan mesajı bulmak için
    reacts: new Map(), // "kimlik:sıra" → Map(kimlik → emoji): kim hangi tepkiyi verdi
    menuKey: null, // menüsü açık olan mesaj
    vanish: false, // kaybolan mesaj açık mı
    vanishQ: [], // sekme arkadayken gelen kaybolan mesajlar: görünce sayaç başlar
    reply: null,
    lastAuthor: '',
    typers: new Map(), // kimlik → "yazıyor" bitiş zamanı
    typingEl: null,
    toAck: new Map(), // kimlik → gördüğüm ama henüz "gördüm" demediğim son mesajın sırası
    seenBy: new Map(), // kimlik → o kişinin benim mesajlarımdan gördüğü son sıra
    seenEl: null,
    t0: t,
    lastAct: t,
    lastPing: 0,
    lastTyping: 0,
    sent: 0,
    recv: 0,
    fails: 0,
    over: false,
    wake: null,
    tick: 0,
    game: null,
  };
}

// Bir kişinin görünen adı: kendine ad verdiyse o, vermediyse rengi.
function whoOf(C, id) {
  if (id === C.meId) return { name: C.nick || C.me.name, hex: C.me.hex, mine: true };
  const p = C.people.get(id) || UNKNOWN;
  return { name: p.nick || p.name, hex: p.hex, mine: false };
}
const present = (C) => [...C.people.values()].filter((p) => !p.gone);

// Şerit o an sohbette olanların renklerini gösterir: 1'e 1'de iki renk, odada kaç kişi varsa.
function paintStrip(C) {
  const cols =
    C.kind === 'duo'
      ? [...present(C).map((p) => p.hex), C.me.hex]
      : [...present(C), { ...C.me, c: C.myColor }].sort((a, b) => a.c - b.c).map((p) => p.hex);
  const step = 100 / cols.length;
  $('strip').style.background = `linear-gradient(90deg, ${cols.map((c, i) => `${c} 0 ${((i + 1) * step).toFixed(3)}%`).join(', ')})`;
}

function openChatView(C, firstLine) {
  S.chat = C;
  const room = C.kind === 'room';
  $('peer-dot').hidden = room;
  $('room-bar').hidden = !room;
  $('btn-end').textContent = room ? 'Çık' : 'Bitir';
  $('btn-games').hidden = room;
  setVanish(C, false);
  $('game').hidden = true;
  $('btn-nudge').hidden = room;
  $('btn-nudge').disabled = false;
  $('peer-mood').hidden = true;
  $('btn-report').hidden = room;
  document.querySelector('.chat-foot').hidden = room;
  $('me-name').textContent = C.nick || C.me.name;
  $('me-dot').style.backgroundColor = C.me.hex;
  $('msgs').replaceChildren();
  $('input').value = '';
  setReply(C, null);
  addMsg('sys', firstLine);
  paintChat(C);
  show('chat');
  paintStrip(C);
  fit();
  C.tick = setInterval(() => paintChat(C), 1000);
  $('input').focus({ preventScroll: true });
}

function paintChat(C) {
  if (!alive(C)) return;
  const now = Date.now();
  for (const [id, until] of C.typers) if (until <= now) C.typers.delete(id);
  const typers = [...C.typers.keys()];
  setTyping(C, typers.length ? whoOf(C, typers[0]) : null);

  let text;
  let state = 'on';
  if (C.kind === 'duo') {
    const peer = whoOf(C, C.peerId);
    $('peer-name').textContent = peer.name;
    $('peer-dot').style.backgroundColor = peer.hex;
    const pp = C.people.get(C.peerId) || {};
    const chip = $('peer-mood');
    chip.hidden = !pp.mood;
    if (pp.mood && chip.textContent !== MOODS[pp.mood]) chip.textContent = MOODS[pp.mood];
    text = pp.listen ? `çevrimiçi · Dinliyor: ${pp.listen}` : 'çevrimiçi';
    if (C.fails >= 2) [text, state] = ['bağlantın zayıf…', 'off'];
    else if (!C.peerSeen) [text, state] = ['bağlanıyor…', 'off'];
    else if (now - C.peerSeen > STALE_MS) [text, state] = ['bağlantısı bekleniyor…', 'off'];
    else if (typers.length) [text, state] = ['yazıyor…', 'typing'];
  } else {
    $('peer-name').textContent = 'Oda';
    text = `${present(C).length + 1} kişi`;
    if (C.fails >= 2) [text, state] = ['bağlantın zayıf…', 'off'];
    else if (typers.length === 1) [text, state] = [`${whoOf(C, typers[0]).name} yazıyor…`, 'typing'];
    else if (typers.length > 1) [text, state] = [`${typers.length} kişi yazıyor…`, 'typing'];
  }
  const el = $('peer-status');
  if (el.textContent !== text) el.textContent = text;
  el.dataset.s = state;
}

// Bir alıntı kutusunu doldurur: kimin mesajı, ne yazıyordu. Metin karşıdan değil kendi kaydımızdan gelir;
// böylece kimse söylemediğin bir şeyi sana söyletemez.
function fillQuote(C, box, key) {
  const who = whoOf(C, key.slice(0, key.lastIndexOf(':')));
  const rec = C.log.get(key);
  box.style.borderLeftColor = who.hex;
  box.querySelector('b').textContent = who.mine ? 'Sen' : who.name;
  box.querySelector('span').textContent = rec ? rec.text : 'Mesaj';
}

// kind: 'me' | 'them' | 'sys'. from: { id, n, quoteKey } (sistem satırında yok)
function addMsg(kind, text, from) {
  const list = $('msgs');
  const C = S.chat;
  const li = document.createElement('li');
  li.className = 'msg ' + kind;
  if (C && from) {
    const who = whoOf(C, from.id);
    li.style.setProperty('--c', who.hex);
    if (C.kind === 'room' && kind === 'them' && C.lastAuthor !== from.id) {
      const by = document.createElement('b'); // odada gönderen değişince adı yazılır
      by.className = 'by';
      by.textContent = who.name;
      li.append(by);
    }
    if (from.quoteKey) {
      const q = document.createElement('button');
      q.type = 'button';
      q.className = 'quote';
      q.dataset.q = from.quoteKey;
      q.append(document.createElement('b'), document.createElement('span'));
      fillQuote(C, q, from.quoteKey);
      li.append(q);
    }
    const key = `${from.id}:${from.n}`;
    li.dataset.k = key;
    C.log.set(key, { text, el: li });
  }
  if (C) C.lastAuthor = from ? from.id : '';
  const body = document.createElement('span');
  body.textContent = text; // yabancıdan gelen metin asla HTML olarak işlenmez
  li.append(body);
  list.insertBefore(li, C && C.typingEl && C.typingEl.isConnected ? C.typingEl : null); // "yazıyor" balonu hep en altta
  while (list.children.length > MAX_MSGS) {
    const old = list.firstElementChild;
    if (C && old.dataset.k) {
      C.log.delete(old.dataset.k);
      C.reacts.delete(old.dataset.k);
    }
    old.remove();
  }
  if (C) paintSeen(C);
  list.scrollTop = list.scrollHeight;
  if (C && C.menuKey) placeMenu(C); // menü açıkken mesaj kaydıysa menü de onu izlesin
  return li;
}

// ---------- okundu bilgisi ----------
// Son mesaj benimse ve karşı taraf gördüyse altında "Görüldü" yazar (odada kaç kişinin gördüğü).
function paintSeen(C) {
  const all = $('msgs').querySelectorAll('.msg.me, .msg.them:not(.typing)');
  const last = all[all.length - 1];
  let label = '';
  if (last && last.classList.contains('me')) {
    const key = last.dataset.k;
    const n = Number(key.slice(key.lastIndexOf(':') + 1));
    let count = 0;
    for (const seen of C.seenBy.values()) if (seen >= n) count++;
    if (count) label = C.kind === 'duo' ? 'Görüldü' : `${count} kişi gördü`;
  }
  if (!label) {
    if (C.seenEl) C.seenEl.remove();
    C.seenEl = null;
    return;
  }
  if (!C.seenEl) {
    C.seenEl = document.createElement('li');
    C.seenEl.className = 'seen';
  }
  C.seenEl.textContent = label;
  if (last.nextElementSibling !== C.seenEl) last.after(C.seenEl);
}

// Ekrana düşen mesajlar için "gördüm" bilgisini yollar. Sekme arka plandayken gitmez:
// görmediğin mesaja "Görüldü" denmez; dönünce gider.
function flushAcks(C) {
  if (!C.toAck.size || document.hidden) return;
  const s = Object.fromEntries(C.toAck);
  C.toAck.clear();
  enqueue(C, { t: 'r', s }, false);
}

// Biri yazarken mesajların altında, onun renginde üç noktalı balon görünür.
function setTyping(C, who) {
  if (who && !C.typingEl) {
    const li = document.createElement('li');
    li.className = 'msg them typing';
    li.setAttribute('aria-label', 'yazıyor');
    li.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    $('msgs').append(li);
    C.typingEl = li;
    $('msgs').scrollTop = $('msgs').scrollHeight;
  } else if (!who && C.typingEl) {
    C.typingEl.remove();
    C.typingEl = null;
  }
  if (who && C.typingEl) C.typingEl.style.setProperty('--c', who.hex);
}

// ---------- sohbete özel ad ----------
// Herkes rengiyle başlar; isteyen o sohbet için kendine bir ad yazar. Yeni sohbette yine renk gelir.
const RESERVED = new Set(['sen', 'oda', 'biri', ...COLORS.map((c) => c.name.toLocaleLowerCase('tr'))]);

// Geçerli adı döner; boş, küfürlü ya da başkasıyla karışacak adlar için '' (renk kalır).
function tidyNick(raw) {
  const s = clean(String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 16));
  return !s || s.includes('*') || hasLink(s) || RESERVED.has(s.toLocaleLowerCase('tr')) ? '' : s;
}

// Ekrandaki eski mesaj ve alıntılarda adı günceller.
function relabel(C, id) {
  const name = whoOf(C, id).name;
  for (const li of $('msgs').querySelectorAll('.msg[data-k]')) {
    const key = li.dataset.k;
    const by = li.querySelector('.by');
    if (by && key.slice(0, key.lastIndexOf(':')) === id) by.textContent = name;
  }
  for (const q of $('msgs').querySelectorAll('.quote[data-q]')) fillQuote(C, q, q.dataset.q);
  if (C.reply) fillQuote(C, $('reply-quote'), C.reply);
  for (const key of C.reacts.keys()) paintReacts(C, key);
}

function setNick(C, id, raw) {
  const p = C.people.get(id);
  if (!p) return;
  const nick = tidyNick(raw);
  if ((p.nick || '') === nick) return;
  const old = p.nick || p.name;
  p.nick = nick;
  addMsg('sys', nick ? `${old} artık ${nick}` : `${old} yeniden ${p.name}`);
  relabel(C, id);
}

function setMyNick(C, raw) {
  if (!alive(C)) return;
  C.nick = tidyNick(raw);
  $('me-name').textContent = C.nick || C.me.name;
  enqueue(C, { t: 'n', x: C.nick }, true);
}

// ---------- ruh hali, ne dinliyorum, titreşim ----------
const tidyListen = (raw) =>
  clean(
    stripLinks(String(raw == null ? '' : raw))
      .replace(/\[link\]/g, ' ') // şarkı linki yazılırsa link kısmı atılır
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60),
  );

function sendProfile(C, urgent = true) {
  if (C.mood || C.listen) enqueue(C, { t: 'p', m: C.mood, l: C.listen }, urgent);
}

// Karşı tarafın ruh hali ve ne dinlediği: değişince sohbete bir satır düşer.
function setProfile(C, id, m, l) {
  const p = C.people.get(id);
  if (!p) return;
  const mood = typeof m === 'string' && MOODS[m] ? m : '';
  const listen = tidyListen(l);
  const name = p.nick || p.name;
  if (mood !== (p.mood || '')) {
    p.mood = mood;
    if (mood) addMsg('sys', `${name} şu an ${MOODS[mood].toLocaleLowerCase('tr')}`);
  }
  if (listen !== (p.listen || '')) {
    p.listen = listen;
    if (listen) addMsg('sys', `${name} dinliyor: ${listen}`);
  }
}

// Profil penceresi: ad (yalnızca bu sohbette), ne dinliyorum, ruh hali ve güvenlik kodu.
let pMood = '';
function paintPMoods() {
  for (const b of $('p-moods').children) b.setAttribute('aria-pressed', String(b.dataset.mood === pMood));
}

function openProfile(C) {
  $('p-nick').value = C.nick;
  $('p-nick').placeholder = C.me.name;
  $('p-listen').value = C.listen;
  pMood = C.mood;
  paintPMoods();
  $('p-code').hidden = C.kind !== 'duo';
  if (C.kind === 'duo') $('p-code').textContent = `Güvenlik kodu: ${C.code}. Karşı tarafta da aynıysa mesajlarınızı aranızda kimse okuyamaz.`;
  $('profile').hidden = false;
}

function saveProfile(C) {
  $('profile').hidden = true;
  if (!alive(C)) return;
  const nick = tidyNick($('p-nick').value);
  if (nick !== C.nick) setMyNick(C, nick);
  const listen = tidyListen($('p-listen').value);
  if (listen === C.listen && pMood === C.mood) return;
  C.listen = listen;
  C.mood = pMood;
  S.listen = listen; // sonraki sohbetlerde de kalsın
  S.mood = pMood;
  for (const x of $('moods').children) x.setAttribute('aria-pressed', String(x.dataset.mood === S.mood));
  enqueue(C, { t: 'p', m: C.mood, l: C.listen }, true);
}

// Titreşim: MSN'deki gibi ekran sallanır, telefon titrer.
function shake() {
  const card = document.querySelector('.card');
  card.classList.remove('shake');
  void card.offsetWidth; // animasyonu yeniden başlat
  card.classList.add('shake');
  if (navigator.vibrate) navigator.vibrate([90, 50, 90]);
  beep();
}

function gotNudge(C, id) {
  const now = Date.now();
  if (now - C.nudgeIn < 5000) return; // art arda gelen titreşim yok sayılır
  C.nudgeIn = now;
  shake();
  addMsg('sys', `${whoOf(C, id).name} titreşim gönderdi`);
  if (document.hidden) document.title = `Titreşim · ${TITLE}`;
}

// ---------- emoji tepkisi ----------
// Herkes bir mesaja tek tepki verir; aynı tepkiye yeniden basmak geri alır. Tepki şifreli zarfla gider.
function applyReact(C, key, id, e) {
  const target = C.log.get(key);
  if (!target || !target.el) return; // ekranda olmayan mesaja gelen tepki yok sayılır
  let map = C.reacts.get(key);
  if (!map) {
    map = new Map();
    C.reacts.set(key, map);
  }
  if (e) map.set(id, e);
  else map.delete(id);
  if (!map.size) C.reacts.delete(key);
  paintReacts(C, key);
}

function react(C, key, e) {
  const map = C.reacts.get(key);
  const next = map && map.get(C.meId) === e ? '' : e;
  applyReact(C, key, C.meId, next);
  enqueue(C, { t: 'e', k: key, e: next }, true);
}

// Tepkiler balonun alt köşesinde küçük bir hap olarak görünür: "❤️😂 3".
function paintReacts(C, key) {
  const rec = C.log.get(key);
  if (!rec || !rec.el || !rec.el.isConnected) return;
  const map = C.reacts.get(key);
  let pill = rec.el.querySelector(':scope > .reacts');
  if (!map || !map.size) {
    if (pill) pill.remove();
    rec.el.classList.remove('has-r');
    return;
  }
  if (!pill) {
    pill = document.createElement('span');
    pill.className = 'reacts';
    rec.el.prepend(pill); // konumu CSS'ten; metin hep balonun son öğesi kalsın
  }
  const kinds = [...new Set(map.values())].sort((x, y) => REACTIONS.indexOf(x) - REACTIONS.indexOf(y)); // menüdeki sırayla
  pill.textContent = kinds.slice(0, 3).join('') + (map.size > 1 ? ` ${map.size}` : '');
  pill.classList.toggle('mine', map.has(C.meId));
  const who = [...map].map(([id, e]) => {
    const w = whoOf(C, id);
    return `${w.mine ? 'Sen' : w.name} ${e}`;
  });
  pill.title = who.join(', ');
  pill.setAttribute('aria-label', 'Tepkiler: ' + who.join(', '));
  rec.el.classList.add('has-r');
}

// ---------- mesaj menüsü: basılı tut (fareyle tıkla) → tepki, yanıtla, kopyala ----------
let menuAt = 0;

function openMenu(C, li) {
  const key = li.dataset.k;
  if (!C.log.has(key) || li.classList.contains('gone') || li.classList.contains('fade')) return;
  closeMenu();
  C.menuKey = key;
  const map = C.reacts.get(key);
  const mine = (map && map.get(C.meId)) || '';
  $('menu-reacts').replaceChildren(
    ...REACTIONS.map((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.e = e;
      b.textContent = e;
      b.setAttribute('aria-label', e + ' tepkisi');
      b.setAttribute('aria-pressed', String(e === mine));
      return b;
    }),
  );
  $('menu-unsend').hidden = !li.classList.contains('me'); // yalnızca kendi mesajını geri alabilirsin
  li.classList.add('picked');
  $('menu').hidden = false;
  menuAt = Date.now();
  placeMenu(C);
}

// Menüyü mesajın üstüne, sığmazsa altına koyar; ekranın dışına taşırmaz.
function placeMenu(C) {
  const rec = C && C.menuKey ? C.log.get(C.menuKey) : null;
  if (!rec || !rec.el || !rec.el.isConnected) return closeMenu();
  const panel = $('menu-panel');
  const r = rec.el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  top = Math.max(8, Math.min(top, vh - h - 8));
  let left = rec.el.classList.contains('me') ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  panel.style.top = top + 'px';
  panel.style.left = left + 'px';
}

function closeMenu() {
  const C = S.chat;
  if (C && C.menuKey) {
    const rec = C.log.get(C.menuKey);
    if (rec && rec.el) rec.el.classList.remove('picked');
    C.menuKey = null;
  }
  $('menu').hidden = true;
}

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1600);
}

// ---------- geri alma ve kaybolan mesaj ----------
function refreshQuotes(C, key) {
  for (const q of $('msgs').querySelectorAll('.quote[data-q]')) if (q.dataset.q === key) fillQuote(C, q, key);
  if (C.reply === key) setReply(C, null);
}

// Mesaj iki tarafta da "Mesaj geri alındı" olur; tepkileri ve alıntısı kalkar.
function unsend(C, key) {
  const rec = C.log.get(key);
  if (!rec || !rec.el) return;
  if (C.menuKey === key) closeMenu();
  const li = rec.el;
  rec.text = 'Mesaj geri alındı';
  li.classList.add('gone');
  li.classList.remove('vanishing', 'has-r');
  for (const el of li.querySelectorAll(':scope > .quote, :scope > .reacts')) el.remove();
  li.lastElementChild.textContent = rec.text;
  C.reacts.delete(key);
  refreshQuotes(C, key);
}

// Kaybolan mesaj: gösterildikten belli süre sonra iki ekrandan da silinir. Sekme arkadaysa süre dönünce başlar.
function vanishLater(C, key, secs) {
  const rec = C.log.get(key);
  if (rec && rec.el) rec.el.classList.add('vanishing');
  if (document.hidden) C.vanishQ.push([key, secs]);
  else setTimeout(() => vanish(C, key), secs * 1000);
}

function vanish(C, key) {
  if (!alive(C)) return;
  const rec = C.log.get(key);
  if (!rec || !rec.el) return;
  if (C.menuKey === key) closeMenu();
  const li = rec.el;
  C.log.set(key, { text: 'Kaybolan mesaj', el: null }); // alıntılarda bu yazı görünür
  C.reacts.delete(key);
  li.classList.add('fade');
  const rm = () => {
    if (!li.isConnected) return;
    li.remove();
    paintSeen(C);
  };
  li.addEventListener('animationend', rm, { once: true });
  setTimeout(rm, 700);
  refreshQuotes(C, key);
}

function setVanish(C, on) {
  C.vanish = on;
  $('btn-vanish').setAttribute('aria-pressed', String(on));
  $('input').placeholder = on ? '10 sn sonra kaybolur' : 'Mesajını yaz';
}

// ---------- mesaj yanıtlama ----------
function setReply(C, key) {
  const rec = key ? C.log.get(key) : null;
  C.reply = rec && rec.el ? key : null;
  $('reply-bar').hidden = !C.reply;
  if (C.reply) {
    fillQuote(C, $('reply-quote'), C.reply);
    $('input').focus({ preventScroll: true });
  }
  fit();
}

// Alıntıya dokununca asıl mesaja gider ve kısaca vurgular.
function jumpTo(C, key) {
  const rec = C.log.get(key);
  if (!rec || !rec.el || !rec.el.isConnected) return;
  rec.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  rec.el.classList.remove('flash');
  void rec.el.offsetWidth; // animasyonu yeniden başlat
  rec.el.classList.add('flash');
}

// Şifreleyip gönderim kuyruğuna koyar ve mesajın sıra numarasını döner.
// Tür: m mesaj, t yazıyor, r gördüm, g oyun hamlesi.
function enqueue(C, obj, urgent) {
  const n = ++C.seq;
  C.q = C.q
    .then(async () => {
      C.out.push(await C.seal({ ...obj, n }));
      if (urgent && C.wake) C.wake();
    })
    .catch(() => {});
  return n;
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

// Şifresi çözülmüş bir kaydı işler. id: gönderenin kimliği.
async function onPayload(C, id, msg) {
  if (!msg || !Number.isInteger(msg.n) || msg.n <= (C.last.get(id) || 0)) return; // açılamadı ya da yinelenen
  C.last.set(id, msg.n);
  C.lastAct = Date.now();
  if (msg.t === 'm' && typeof msg.x === 'string') {
    C.recv++;
    C.typers.delete(id);
    const r = msg.r;
    const ok = r && typeof r.w === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(r.w) && Number.isInteger(r.n);
    C.toAck.set(id, msg.n);
    addMsg('them', clean(stripLinks(msg.x.slice(0, 2000))), { id, n: msg.n, quoteKey: ok ? `${r.w}:${r.n}` : null });
    if (Number.isInteger(msg.z) && msg.z >= 1 && msg.z <= 60) vanishLater(C, `${id}:${msg.n}`, msg.z);
    alertTab();
  } else if (msg.t === 't') {
    C.typers.set(id, Date.now() + TYPING_MS);
  } else if (msg.t === 'r' && msg.s && typeof msg.s === 'object') {
    const seen = msg.s[C.meId]; // benim mesajlarımdan hangisine kadar gördü
    if (Number.isInteger(seen) && seen > (C.seenBy.get(id) || 0)) C.seenBy.set(id, seen);
    paintSeen(C);
  } else if (msg.t === 'n') {
    setNick(C, id, msg.x);
  } else if (msg.t === 'p') {
    setProfile(C, id, msg.m, msg.l);
  } else if (msg.t === 'z' && C.kind === 'duo') {
    gotNudge(C, id);
  } else if (msg.t === 'u' && typeof msg.k === 'string' && KEY_RE.test(msg.k) && msg.k.slice(0, msg.k.lastIndexOf(':')) === id) {
    unsend(C, msg.k); // yalnızca kendi mesajını geri alabilir
  } else if (msg.t === 'e' && typeof msg.k === 'string' && KEY_RE.test(msg.k) && (msg.e === '' || REACTIONS.includes(msg.e))) {
    applyReact(C, msg.k, id, msg.e);
  } else if (msg.t === 'g' && C.game) {
    await C.game.onMsg(msg.g);
  } else if (msg.t === 'd' && C.dice) {
    await C.dice.onMsg(msg.d);
  } else if (msg.t === 'b' && C.match) {
    C.match.onMsg(msg.b);
  }
  paintChat(C);
}

const REASONS = {
  me: 'Sohbeti bitirdin',
  peer: 'Karşı taraf ayrıldı',
  timeout: 'Karşı tarafın bağlantısı koptu',
  net: 'Bağlantın koptu',
  report: 'Bildirildi',
  expired: 'Sohbet süresi doldu',
  left: 'Odadan çıktın',
  gone: 'Odadan düştün',
};

function endChat(reason) {
  const C = S.chat;
  if (!C || C.over) return;
  closeMenu();
  C.over = true;
  S.chat = null;
  S.run++;
  clearInterval(C.tick);
  if (C.wake) C.wake();
  api('leave', { tok: C.tok }).catch(() => {});

  const secs = Math.max(1, Math.round((Date.now() - C.t0) / 1000));
  const n = C.sent + C.recv;
  $('msgs').replaceChildren(); // ekrandaki her şey gider; anahtarlar da C ile birlikte bellekten düşer
  C.log.clear();
  C.reacts.clear();
  $('input').value = '';
  $('input').blur();
  $('reply-bar').hidden = true;
  $('game').hidden = true;
  $('end-title').textContent = REASONS[reason] || 'Sohbet bitti';
  $('end-stats').textContent = `${human(secs)} · ${n} mesaj · hepsi silindi`;
  $('btn-again').textContent = S.door ? 'Odaya dön' : 'Yeni sohbet';
  $('btn-share').href = xIntent(
    n > 0
      ? `${C.kind === 'room' ? 'Anonim bir odada' : 'Bir yabancıyla'} ${human(secs)} konuştum. Mesajlardan iz kalmadı.\n${location.origin}`
      : `Anonim sohbet, iz bırakmaz:\n${location.origin}`,
  );
  show('end');
  $('end-auto').hidden = true;
  $('auto-wrap').hidden = C.kind !== 'duo';
  if (C.kind === 'duo' && $('auto').checked && (reason === 'peer' || reason === 'timeout')) autoAgain();
}

// Karşı taraf çıkınca 3 sn sonra yeniden arar; kutunun işaretini kaldırmak ya da ekrandan çıkmak durdurur.
let autoTimer = 0;
function autoAgain() {
  clearInterval(autoTimer);
  let left = 3;
  const tick = () => {
    const el = $('end-auto');
    if (S.view !== 'end' || !$('auto').checked) {
      clearInterval(autoTimer);
      el.hidden = true;
      return;
    }
    if (left === 0) {
      clearInterval(autoTimer);
      el.hidden = true;
      startSearch();
      return;
    }
    el.hidden = false;
    el.textContent = `${left} sn içinde yeni sohbet`;
    left--;
  };
  tick();
  autoTimer = setInterval(tick, 1000);
}

// ---------- 1'e 1 sohbet ----------
async function startDuo(my, keys, m, topic, mood) {
  let sess;
  try {
    sess = await openSession({ priv: keys.priv, myPub: keys.pub, peerPub: m.peerPub, slot: m.slot, room: m.room });
  } catch {
    sess = null;
  }
  if (!sess || my !== S.run) {
    api('leave', { tok: m.tok }).catch(() => {});
    if (my === S.run) startSearch('Eşleşme tutmadı, yeniden arıyorum…');
    return;
  }

  const cols = colorsOf(sess.seed); // iki tarafın rengi; asla aynı çıkmaz
  const C = newChat('duo', m.tok);
  C.sess = sess;
  C.seal = (obj) => sess.seal(obj);
  C.meId = m.slot;
  C.peerId = m.slot === 'a' ? 'b' : 'a';
  C.me = m.slot === 'a' ? cols.a : cols.b;
  C.people.set(C.peerId, { ...(m.slot === 'a' ? cols.b : cols.a), nick: '' });
  C.code = codeOf(sess.seed);
  C.waitFrom = C.t0;
  C.peerSeen = 0;
  C.peerLeft = false;
  C.game = new Rps(
    (g) => enqueue(C, { t: 'g', g }, true),
    (ev) => onGame(C, ev),
  );
  C.dice = new Dice((d) => enqueue(C, { t: 'd', d }, true), (ev) => onDice(C, ev), m.slot);
  C.match = new Match((b) => enqueue(C, { t: 'b', b }, true), (ev) => onMatch(C, ev));
  C.pend = { rps: null, dice: null, inv: null }; // karşı tarafın beklettiği düğmeli satırlar
  $('p-code').dataset.code = C.code;
  openChatView(C, 'Mesajlar uçtan uca şifreli.');
  alertTab('Biri bulundu');
  const common = [topic && `Ortak konu: ${TAG_NAMES[topic]}`, mood && `${topic ? 'Ruh hali' : 'Ortak ruh hali'}: ${MOODS[mood]}`];
  if (topic || mood) addMsg('sys', common.filter(Boolean).join(' · '));
  sendProfile(C);
  paintGames(C);
  duoLoop(C);
}

async function duoLoop(C) {
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
    for (const e of res.in) {
      C.peerSeen = Date.now();
      if (e === 'x') C.peerLeft = true;
      else if (e[0] === 'm') await onPayload(C, C.peerId, await C.sess.open(e.slice(1)));
    }
    if (!alive(C)) return;
    if (C.peerLeft) return endChat('peer');

    const now = Date.now();
    if (!C.peerSeen) {
      if (now - C.waitFrom > NOSHOW_MS) return rematch(C);
    } else if (now - C.peerSeen > DEAD_MS) {
      return endChat('timeout');
    }
    flushAcks(C);
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

async function report(C, hours) {
  try {
    await api('report', { tok: C.tok, ...(hours ? { adm: S.admin, hours } : {}) });
  } catch {
    /* bildirim gitmese de sohbet biter */
  }
  endChat('report');
}

// ---------- oda sohbeti ----------
function addPerson(C, id, c, announce) {
  const known = C.people.get(id);
  if (id === C.meId || (known && !known.gone)) return;
  const col = COLORS[c] || UNKNOWN;
  C.people.set(id, { name: col.name, hex: col.hex, c, gone: false, nick: '' });
  if (announce) {
    addMsg('sys', `${col.name} katıldı`);
    if (C.nick) enqueue(C, { t: 'n', x: C.nick }, false); // yeni gelen geçmişi görmez: adımı yeniden duyur
    sendProfile(C, false);
  }
}

function dropPerson(C, id) {
  const p = C.people.get(id);
  if (!p || p.gone) return;
  p.gone = true; // adı ve rengi eski mesajlarda kalsın diye kayıt silinmez
  C.typers.delete(id);
  addMsg('sys', `${p.nick || p.name} ayrıldı`);
}

async function startRoom() {
  if (!cryptoOk || !$('age').checked || !S.door) return goHome();
  const my = ++S.run;
  S.tk = null;
  $('search-title').textContent = 'Odaya giriliyor';
  $('search-sub').textContent = '';
  $('btn-lonely-door').hidden = true;
  show('search');

  let crypt = null;
  let res = null;
  try {
    crypt = await openRoom(S.door.secret);
    res = await api('rjoin', { cid, room: S.door.id });
  } catch {
    /* aşağıda ele alınır */
  }
  if (my !== S.run) {
    if (res && res.ok) api('leave', { tok: res.tok }).catch(() => {});
    return;
  }
  if (!res || !crypt) return showNote('Bağlantı kurulamadı', 'İnternetini kontrol edip yeniden dene.');
  if (!res.ok) {
    if (!refused(res)) showNote('Bir şey ters gitti', 'Sayfayı yenileyip yeniden dene.');
    return;
  }

  const C = newChat('room', res.tok);
  C.seal = (obj) => crypt.seal(obj, res.me);
  C.crypt = crypt;
  C.meId = res.me;
  C.myColor = res.color;
  C.me = COLORS[res.color] || UNKNOWN;
  C.cur = res.cur;
  for (const m of res.members) addPerson(C, m.m, m.c, false);
  $('btn-copy').textContent = 'Kopyala';
  $('btn-share-door').href = xIntent(`Anonim odaya gel:\n${doorUrl()}`);
  openChatView(C, present(C).length ? 'Mesajlar uçtan uca şifreli.' : 'Odada şimdilik yalnızsın. Linki paylaş.');
  sendProfile(C);
  roomLoop(C);
}

async function roomLoop(C) {
  while (alive(C)) {
    const batch = C.out.splice(0, 10);
    const t = Date.now();
    const ping = t - C.lastPing >= PING_MS;
    const beat = hb();
    let res = null;
    try {
      res = await api('rsync', { tok: C.tok, cur: C.cur, out: batch, ping: ping ? 1 : 0, ...(beat ? { hb: 1, cid } : {}) });
    } catch {
      /* ağ hatası */
    }
    if (!alive(C)) return;

    if (!res || !res.ok) {
      C.out.unshift(...batch);
      if (res && res.err === 'gone') return endChat('gone'); // uzun süre sessiz kalınca renk başkasına geçmiş
      if (res && res.err === 'expired') return endChat('expired');
      C.fails++;
      paintChat(C);
      if (C.fails >= 12) return endChat('net');
      await nap(C, Math.min(1000 * C.fails, 4000));
      continue;
    }

    C.fails = 0;
    if (ping) C.lastPing = t;
    C.cur = res.cur;
    if (res.members) {
      // Sunucunun listesi esastır: listede olmayan sessizce gitmiştir.
      const ids = new Set(res.members.map((m) => m.m));
      for (const [id, p] of C.people) if (!p.gone && !ids.has(id)) dropPerson(C, id);
      for (const m of res.members) addPerson(C, m.m, m.c, true);
    }
    for (const e of res.in) {
      const d = String(e.d);
      const sep = d.indexOf('|');
      const id = sep < 0 ? d.slice(1) : d.slice(1, sep);
      if (d[0] === 'j') addPerson(C, id, Number(d.slice(sep + 1)), true);
      else if (d[0] === 'x') dropPerson(C, id);
      else if (d[0] === 'm' && id !== C.meId) await onPayload(C, id, await C.crypt.open(d.slice(sep + 1), id));
    }
    if (!alive(C)) return;
    paintStrip(C);
    flushAcks(C);
    paintChat(C);
    await nap(C, syncDelay(C));
  }
}

// ---------- oyunlar (yalnızca 1'e 1) ----------
// Taş kağıt makas ve zar: basan rastgele atar, atış kilitlenir, iki taraf da atınca aynı anda açılır.
// XOX ve Dört bağla: biri çağırır, diğeri kabul edince sırayla oynanır; çağıran başlar.
const RESULT = { 1: 'Kazandın', 0: 'Berabere', '-1': 'Kaybettin' };

// Sohbete düğmeli bir sistem satırı ekler ("Sen de at", "Oyna"). Düğmeye basılınca ya da iş bitince düğmeler kalkar.
function addAction(C, text, actions) {
  const li = addMsg('sys', text);
  const row = document.createElement('span');
  row.className = 'acts-inline';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn xs ' + (a.kind || 'ghost');
    b.textContent = a.label;
    b.onclick = () => {
      clearActions(li);
      a.fn();
    };
    row.append(b);
  }
  li.append(row);
  return li;
}

function clearActions(li) {
  const row = li && li.querySelector('.acts-inline');
  if (row) row.remove();
}

const rpsChoices = (C) => [
  { label: 'Taş', fn: () => playRps(C, 't') },
  { label: 'Kağıt', fn: () => playRps(C, 'k') },
  { label: 'Makas', fn: () => playRps(C, 'm') },
  { label: 'Rastgele', fn: () => playRps(C, '?') },
];

// "Oyunlar" düğmesinde nokta: karşı taraf attı ya da çağırdı, sıra bende.
function paintGames(C) {
  const waiting = (C.game.theirHash && !C.game.mine) || (C.dice.theirHash && !C.dice.mine) || C.match.state === 'invited';
  $('btn-games').classList.toggle('ping', Boolean(waiting));
  paintMatch(C);
}

// choice: 't' | 'k' | 'm' ya da '?' (rastgele)
async function playRps(C, choice) {
  if (!alive(C) || C.game.mine) return;
  C.lastAct = Date.now();
  const first = !C.game.theirHash;
  const move = choice && choice !== '?' ? choice : randomMove();
  clearActions(C.pend.rps);
  C.pend.rps = null;
  const ok = await C.game.pick(move);
  if (ok && first && alive(C)) addMsg('sys', `${NAME[move]} attın. Karşı taraf bekleniyor.`);
  if (alive(C)) paintGames(C);
}

function onGame(C, ev) {
  if (!alive(C)) return;
  const g = C.game;
  const peer = whoOf(C, C.peerId).name;
  if (ev === 'invite') {
    C.pend.rps = addAction(C, `${peer} taş kağıt makas attı.`, rpsChoices(C));
  } else if (ev === 'cheat' || ev === 'result') {
    clearActions(C.pend.rps);
    C.pend.rps = null;
    if (ev === 'cheat') addMsg('sys', 'Geçersiz hamle. Tur iptal.');
    else {
      const l = g.last;
      addMsg('sys', `Sen ${NAME[l.mine]}, ${peer} ${NAME[l.theirs]}. ${RESULT[l.result]}. Skor ${g.score.me} – ${g.score.them}`);
    }
  }
  paintGames(C);
}

async function playDice(C) {
  if (!alive(C) || C.dice.mine) return;
  C.lastAct = Date.now();
  const first = !C.dice.theirHash;
  clearActions(C.pend.dice);
  C.pend.dice = null;
  const ok = await C.dice.roll();
  if (ok && first && alive(C)) addMsg('sys', 'Zar attın. Karşı taraf bekleniyor.');
  if (alive(C)) paintGames(C);
}

function onDice(C, ev) {
  if (!alive(C)) return;
  const d = C.dice;
  const peer = whoOf(C, C.peerId).name;
  if (ev === 'invite') {
    C.pend.dice = addAction(C, `${peer} zar attı.`, [{ label: 'Sen de at', kind: 'primary', fn: () => playDice(C) }]);
  } else if (ev === 'cheat' || ev === 'result') {
    clearActions(C.pend.dice);
    C.pend.dice = null;
    if (ev === 'cheat') addMsg('sys', 'Geçersiz zar. Tur iptal.');
    else {
      const { mine, theirs, result } = d.last;
      addMsg(
        'sys',
        `Zar: sen ${mine[0]} + ${mine[1]} = ${mine[0] + mine[1]}, ${peer} ${theirs[0]} + ${theirs[1]} = ${theirs[0] + theirs[1]}. ${RESULT[result]}. Skor ${d.score.me} – ${d.score.them}`,
      );
    }
  }
  paintGames(C);
}

// Tahta oyunu seç: bekleyen aynı oyun daveti varsa kabul eder, yoksa çağırır.
function chooseBoard(C, kind) {
  if (!alive(C)) return;
  if (C.match.state === 'invited' && C.match.kind === kind) return acceptBoard(C);
  clearActions(C.pend.inv);
  C.pend.inv = null;
  C.match.invite(kind);
  paintGames(C);
}

function acceptBoard(C) {
  clearActions(C.pend.inv);
  C.pend.inv = null;
  C.match.accept();
  paintGames(C);
}

function declineBoard(C) {
  clearActions(C.pend.inv);
  C.pend.inv = null;
  C.match.decline();
  paintGames(C);
}

const OUTCOME = (m, peer) =>
  ({ win: 'Kazandın', lose: 'Kaybettin', draw: 'Berabere', quit: 'Bıraktın', gone: `${peer} bıraktı` })[m.result] || '';

function onMatch(C, ev) {
  if (!alive(C)) return;
  const m = C.match;
  const peer = whoOf(C, C.peerId).name;
  if (ev === 'invite') {
    clearActions(C.pend.inv);
    C.pend.inv = addAction(C, `${peer} seni ${BOARDS[m.kind].name} oynamaya çağırıyor.`, [
      { label: 'Oyna', kind: 'primary', fn: () => acceptBoard(C) },
      { label: 'Hayır', fn: () => declineBoard(C) },
    ]);
  } else if (ev === 'withdrawn') {
    clearActions(C.pend.inv);
    C.pend.inv = null;
    addMsg('sys', 'Oyun daveti geri çekildi.');
  } else if (ev === 'declined') {
    addMsg('sys', `${peer} oyun davetini geri çevirdi.`);
  } else if (ev === 'start') {
    clearActions(C.pend.inv);
    C.pend.inv = null;
  } else if (ev === 'over') {
    const s = m.score[m.kind];
    addMsg('sys', `${BOARDS[m.kind].name}: ${OUTCOME(m, peer)}. Skor ${s.me} – ${s.them}`);
  } else if (ev === 'move' && m.turn === 'me' && navigator.vibrate && document.hidden === false) {
    navigator.vibrate(8); // sıra bana geçti
  }
  paintGames(C);
}

// Tahta: XOX'ta X ve O, Dört bağla'da taşlar; ikisi de oyuncunun renginde.
function paintMatch(C) {
  const m = C.match;
  const box = $('game');
  const wasHidden = box.hidden;
  const open = m.state === 'inviting' || m.state === 'playing' || m.state === 'over';
  box.hidden = !open;
  if (wasHidden !== box.hidden) fit(); // tahta açılıp kapanınca mesajlar en altta kalsın
  if (!open) return;

  const spec = BOARDS[m.kind];
  const peer = whoOf(C, C.peerId);
  const score = m.score[m.kind];
  $('game-title').textContent = spec.name;
  let status;
  if (m.state === 'inviting') status = `${peer.name} bekleniyor…`;
  else if (m.state === 'playing') status = m.turn === 'me' ? 'Sıra sende' : `${peer.name} oynuyor…`;
  else status = `${OUTCOME(m, peer.name)} · ${score.me} – ${score.them}`;
  $('game-status').textContent = status;
  $('game-status').dataset.turn = m.state === 'playing' && m.turn === 'me' ? '1' : '';
  $('game-x').hidden = m.state === 'over';
  $('game-x').textContent = m.state === 'inviting' ? 'Vazgeç' : 'Bırak';
  $('game-acts').hidden = m.state !== 'over';

  const grid = $('game-grid');
  grid.hidden = m.state === 'inviting';
  box.dataset.kind = m.kind;
  if (m.state === 'inviting') return;
  const total = spec.cols * spec.rows;
  if (grid.dataset.kind !== m.kind || grid.children.length !== total) {
    grid.dataset.kind = m.kind;
    grid.replaceChildren(
      ...Array.from({ length: total }, (_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cell';
        b.dataset.i = String(i);
        const r = Math.floor(i / spec.cols) + 1;
        const c = (i % spec.cols) + 1;
        b.setAttribute('aria-label', spec.drop ? `Sütun ${c}` : `Satır ${r}, sütun ${c}`);
        return b;
      }),
    );
  }
  const mark = { me: m.first === 'me' ? 'X' : 'O', them: m.first === 'me' ? 'O' : 'X' };
  const line = new Set(m.line || []);
  const myTurn = m.state === 'playing' && m.turn === 'me';
  for (const b of grid.children) {
    const i = Number(b.dataset.i);
    const v = m.board[i];
    b.dataset.v = v || '';
    b.style.setProperty('--c', v === 'me' ? C.me.hex : v === 'them' ? peer.hex : 'transparent');
    if (!spec.drop) b.textContent = v ? mark[v] : '';
    b.classList.toggle('win', line.has(i));
    b.classList.toggle('last', i === m.lastCell && !line.size);
    b.disabled = !myTurn || (spec.drop ? m.target(i % spec.cols) < 0 : Boolean(v));
  }
}

// ---------- olaylar ----------
// Koyu / açık görünüm: seçim yoksa cihazın ayarı geçerlidir; seçilince hatırlanır.
$('btn-theme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('theme', next);
  } catch {
    /* depolama kapalıysa seçim yalnızca bu sekmede geçerli olur */
  }
};

$('age').addEventListener('change', renderHome);

// Konu: birine dokun seçilsin, yeniden dokun kalksın.
$('tags').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tag]');
  if (!b) return;
  S.tag = S.tag === b.dataset.tag ? '' : b.dataset.tag;
  for (const x of $('tags').children) x.setAttribute('aria-pressed', String(x.dataset.tag === S.tag));
});

$('moods').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mood]');
  if (!b) return;
  S.mood = S.mood === b.dataset.mood ? '' : b.dataset.mood;
  for (const x of $('moods').children) x.setAttribute('aria-pressed', String(x.dataset.mood === S.mood));
});
$('btn-find').onclick = () => (S.door ? startRoom() : startSearch());
$('btn-door').onclick = createRoom;
$('btn-lonely-door').onclick = createRoom;
$('btn-random').onclick = leaveDoor;
$('btn-cancel').onclick = cancelSearch;
$('btn-again').onclick = () => (S.door ? startRoom() : startSearch());
$('btn-home').onclick = goHome;
$('btn-note-home').onclick = goHome;
$('btn-end').onclick = () => endChat(S.chat && S.chat.kind === 'room' ? 'left' : 'me');

$('btn-copy').onclick = async () => {
  let ok = false;
  try {
    await navigator.clipboard.writeText(doorUrl());
    ok = true;
  } catch {
    ok = false;
  }
  if (ok) $('btn-copy').textContent = 'Kopyalandı';
  else openSheet('Oda linki', doorUrl(), [{ label: 'Tamam' }]); // pano kapalıysa linki göster, elle kopyalansın
};

$('btn-nick').onclick = () => {
  if (S.chat) openProfile(S.chat);
};

$('p-moods').replaceChildren(
  ...Object.entries(MOODS).map(([k, v]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mood = k;
    b.textContent = v;
    b.setAttribute('aria-pressed', 'false');
    return b;
  }),
);

$('p-moods').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mood]');
  if (!b) return;
  pMood = pMood === b.dataset.mood ? '' : b.dataset.mood;
  paintPMoods();
});

$('profile-form').addEventListener('submit', (ev) => {
  ev.preventDefault(); // Enter da kaydeder
  if (S.chat) saveProfile(S.chat);
  else $('profile').hidden = true;
});

$('p-cancel').onclick = () => {
  $('profile').hidden = true;
};

$('profile').addEventListener('click', (ev) => {
  if (ev.target === $('profile')) $('profile').hidden = true;
});

$('sheet-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('sheet-actions').firstElementChild.click(); // Enter ilk düğmeyle aynı
});

$('btn-nudge').onclick = () => {
  const C = S.chat;
  if (!C || C.kind !== 'duo' || Date.now() - C.lastNudge < NUDGE_GAP) return;
  C.lastNudge = Date.now();
  enqueue(C, { t: 'z' }, true);
  shake();
  addMsg('sys', 'Titreşim gönderdin');
  const b = $('btn-nudge');
  b.disabled = true;
  setTimeout(() => {
    if (S.chat === C) b.disabled = false;
  }, NUDGE_GAP);
};

$('btn-report').onclick = () => {
  const C = S.chat;
  if (!C || C.kind !== 'duo') return;
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

$('btn-games').onclick = () => {
  const C = S.chat;
  if (!C || C.kind !== 'duo') return;
  const busy = C.match.state === 'inviting' || C.match.state === 'playing';
  openSheet('Oyunlar', '', [
    { label: C.game.mine ? 'Taş kağıt makas · bekleniyor' : 'Taş kağıt makas', disabled: Boolean(C.game.mine), fn: () => openSheet('Taş kağıt makas', '', [...rpsChoices(C), { label: 'Vazgeç', kind: 'text' }]) },
    { label: C.dice.mine ? 'Zar at · bekleniyor' : 'Zar at', disabled: Boolean(C.dice.mine), fn: () => playDice(C) },
    { label: 'XOX', disabled: busy, fn: () => chooseBoard(C, 'xox') },
    { label: 'Dört bağla', disabled: busy, fn: () => chooseBoard(C, 'c4') },
    { label: 'Vazgeç', kind: 'text' },
  ]);
};

$('game-grid').addEventListener('click', (ev) => {
  const b = ev.target.closest('.cell');
  const C = S.chat;
  if (!b || !C || !C.match || !C.match.kind) return;
  const spec = BOARDS[C.match.kind];
  const i = Number(b.dataset.i);
  C.lastAct = Date.now();
  C.match.move(spec.drop ? i % spec.cols : i); // Dört bağla'da sütunun herhangi bir yerine dokunmak yeter
});

$('game-x').onclick = () => {
  const C = S.chat;
  if (!C) return;
  if (C.match.state === 'inviting') C.match.decline();
  else C.match.quit();
  paintGames(C);
};

$('game-again').onclick = () => {
  const C = S.chat;
  if (C && C.match.kind) chooseBoard(C, C.match.kind);
};

$('game-close').onclick = () => {
  const C = S.chat;
  if (!C) return;
  C.match.close();
  paintGames(C);
};

$('composer').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const C = S.chat;
  const inp = $('input');
  const text = clean(inp.value.trim()); // küfür gönderilmeden yıldızlanır
  if (!C || !text) return;
  if (hasLink(text)) {
    toast('Link gönderilemez'); // yazı kutuda kalır, düzeltilebilir
    return;
  }
  inp.value = '';
  C.sent++;
  C.lastAct = Date.now();
  C.lastTyping = 0; // sıradaki mesaja başlar başlamaz "yazıyor" yeniden gitsin
  const quoteKey = C.reply;
  const cut = quoteKey ? quoteKey.lastIndexOf(':') : -1;
  const r = quoteKey ? { w: quoteKey.slice(0, cut), n: Number(quoteKey.slice(cut + 1)) } : null;
  const payload = { t: 'm', x: text };
  if (r) payload.r = r;
  if (C.vanish) payload.z = 10;
  const n = enqueue(C, payload, true);
  addMsg('me', text, { id: C.meId, n, quoteKey });
  if (C.vanish) vanishLater(C, `${C.meId}:${n}`, 10);
  setReply(C, null);
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

$('btn-reply-x').onclick = () => {
  if (S.chat) setReply(S.chat, null);
};

// Mesaja basılı tutmak (fareyle tıklamak ya da sağ tıklamak) tepki ve yanıt menüsünü açar.
// Sağa kaydırmak doğrudan yanıtlar; alıntıya dokunmak asıl mesaja götürür.
let touch = null; // { li, x, y, dx, swipe, timer }
let lastTouch = 0; // dokunmatikte parmak kalkınca gelen tıklama menü açmasın

$('msgs').addEventListener('click', (ev) => {
  const C = S.chat;
  if (!C) return;
  const q = ev.target.closest('.quote[data-q]');
  if (q) return jumpTo(C, q.dataset.q);
  if (Date.now() - lastTouch < 800) return; // dokunmatikte kısa dokunuş bir şey yapmaz
  const li = ev.target.closest('.msg[data-k]');
  if (!li) return;
  if (window.getSelection && String(window.getSelection())) return; // metin seçiliyorsa karışma
  openMenu(C, li);
});

$('msgs').addEventListener('contextmenu', (ev) => {
  const C = S.chat;
  const li = ev.target.closest('.msg[data-k]');
  if (!C || !li) return;
  ev.preventDefault(); // tarayıcının kendi menüsü yerine bizimki
  if (C.menuKey !== li.dataset.k) openMenu(C, li);
});

$('msgs').addEventListener(
  'touchstart',
  (ev) => {
    if (touch) clearTimeout(touch.timer);
    const li = ev.target.closest('.msg[data-k]');
    if (!li || ev.touches.length !== 1) {
      touch = null;
      return;
    }
    const t = { li, x: ev.touches[0].clientX, y: ev.touches[0].clientY, dx: 0, swipe: false, timer: 0 };
    t.timer = setTimeout(() => {
      if (touch !== t || t.swipe || !S.chat) return;
      touch = null;
      if (navigator.vibrate) navigator.vibrate(12);
      if (S.chat.menuKey !== li.dataset.k) openMenu(S.chat, li);
    }, LONG_MS);
    touch = t;
  },
  { passive: true },
);

$('msgs').addEventListener(
  'touchmove',
  (ev) => {
    const t = touch;
    if (!t) return;
    const dx = ev.touches[0].clientX - t.x;
    const dy = ev.touches[0].clientY - t.y;
    if (!t.swipe) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(t.timer); // parmak kaydı: basılı tutma değil
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        touch = null; // dikey kaydırma: listeyi kaydırıyor
        return;
      }
      if (dx < 12) return;
      t.swipe = true;
      t.li.style.transition = 'none';
    }
    t.dx = Math.max(0, Math.min(dx, 72));
    t.li.style.transform = `translateX(${t.dx}px)`;
  },
  { passive: true },
);

function endTouch() {
  lastTouch = Date.now();
  const t = touch;
  touch = null;
  if (!t) return;
  clearTimeout(t.timer);
  if (!t.swipe) return;
  t.li.style.transition = 'transform 0.15s ease';
  t.li.style.transform = '';
  if (t.dx >= 48 && S.chat) setReply(S.chat, t.li.dataset.k);
}
$('msgs').addEventListener('touchend', endTouch);
$('msgs').addEventListener('touchcancel', endTouch);

// Menü: boş yere dokununca kapanır. Basılı tutup bırakınca gelebilecek tıklama hemen kapatmasın.
$('menu').addEventListener('click', (ev) => {
  if (ev.target === $('menu') && Date.now() - menuAt > 600) closeMenu();
});
$('menu').addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  closeMenu();
});

$('menu-reacts').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-e]');
  const C = S.chat;
  if (!b || !C || !C.menuKey) return;
  const key = C.menuKey;
  closeMenu();
  react(C, key, b.dataset.e);
});

$('menu-reply').onclick = () => {
  const C = S.chat;
  if (!C || !C.menuKey) return;
  const key = C.menuKey;
  closeMenu();
  setReply(C, key);
};

$('menu-unsend').onclick = () => {
  const C = S.chat;
  if (!C || !C.menuKey) return;
  const key = C.menuKey;
  closeMenu();
  unsend(C, key);
  enqueue(C, { t: 'u', k: key }, true);
};

$('btn-vanish').onclick = () => {
  const C = S.chat;
  if (!C) return;
  setVanish(C, !C.vanish);
  $('input').focus({ preventScroll: true });
};

document.addEventListener('pointerdown', unlockAudio, { passive: true });
document.addEventListener('keydown', unlockAudio);

$('menu-copy').onclick = async () => {
  const C = S.chat;
  const rec = C && C.menuKey ? C.log.get(C.menuKey) : null;
  closeMenu();
  if (!rec) return;
  try {
    await navigator.clipboard.writeText(rec.text);
    toast('Kopyalandı');
  } catch {
    openSheet('Mesaj', rec.text, [{ label: 'Tamam' }]); // pano kapalıysa metni göster, elle kopyalansın
  }
};

$('sheet').addEventListener('click', (ev) => {
  if (ev.target === $('sheet')) closeSheet();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!$('menu').hidden) closeMenu();
  else if (!$('profile').hidden) $('profile').hidden = true;
  else if (!$('sheet').hidden) closeSheet();
  else if (S.chat && S.chat.reply) setReply(S.chat, null);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  unread = 0;
  document.title = TITLE;
  const C = S.chat;
  if (C) {
    for (const [k, secs] of C.vanishQ.splice(0)) setTimeout(() => vanish(C, k), secs * 1000);
    if (C.kind === 'duo') {
      // Sekme arka plandayken sayaçlar durur; dönünce karşı tarafa kendini göstermesi için pay bırak.
      const t = Date.now();
      if (C.peerSeen) C.peerSeen = Math.max(C.peerSeen, t - (DEAD_MS - NOSHOW_MS));
      C.waitFrom = Math.max(C.waitFrom, t - NOSHOW_MS / 2);
    }
    flushAcks(C); // arka plandayken gelenleri şimdi gördüm
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
window.addEventListener('resize', () => {
  fit();
  if (S.chat && S.chat.menuKey) placeMenu(S.chat);
});

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
