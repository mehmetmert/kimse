// Arayüz ve sohbet akışı. İki tür sohbet aynı ekranı kullanır:
//   duo  rastgele eşleşen iki kişi
//   room aynı linki açan birden fazla kişi (oda)
// Çerez yok; cihaza yazılan tek şey görünüm tercihidir (koyu / açık). Sohbetle ilgili her şey bu sekmenin belleğinde yaşar.
import { doorId, newKeys, openRoom, openSession, randId } from './e2e.js';
import { clean } from './filter.js';
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
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']; // menüdeki tepkiler; başka bir şey kabul edilmez
const KEY_RE = /^[A-Za-z0-9_-]{1,16}:\d{1,9}$/; // mesaj anahtarı: "kimlik:sıra"
const LONG_MS = 450; // bu kadar basılı tutunca menü açılır

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
  $('app').dataset.view = view;
  if (view !== 'chat') $('strip').style.background = ''; // sohbet dışında şerit bütün renkleri gösterir
  closeSheet();
  closeMenu();
}

// input verilirse pencerede bir yazı alanı çıkar; değeri düğmelerin işlevine geçer.
function openSheet(title, text, actions, input) {
  const box = $('sheet-input');
  $('sheet-title').textContent = title;
  $('sheet-text').textContent = text;
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
  $('search-title').textContent = 'Aranıyor';
  $('btn-lonely-door').hidden = true;
  show('search');

  const t0 = Date.now();
  const paint = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    const lonely = s >= 40;
    $('btn-lonely-door').hidden = !lonely;
    $('search-sub').textContent = notice && s < 4 ? notice : lonely ? `Şu an kimse yok · ${mmss(s)}` : mmss(s);
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
          : await api('find', { cid, pub: keys.pub });
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
        return startDuo(my, keys, res.matched);
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
    people: new Map(), // kimlik → { name (renk adı), hex, c, gone, nick }
    cur: kind === 'duo' ? 0 : '0-0', // okuduğumuz yer
    out: [], // gönderilmeyi bekleyen şifreli mesajlar
    q: Promise.resolve(), // şifreleme sırası: mesajlar sıra numarasıyla aynı düzende çıksın
    seq: 0,
    last: new Map(), // kimlik → görülen en büyük sıra numarası: yinelenenleri ayıklar
    log: new Map(), // "kimlik:sıra" → { text, el }: yanıtlanan mesajı bulmak için
    reacts: new Map(), // "kimlik:sıra" → Map(kimlik → emoji): kim hangi tepkiyi verdi
    menuKey: null, // menüsü açık olan mesaj
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
  $('btn-game').hidden = room;
  $('btn-code').hidden = room;
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
    text = 'çevrimiçi';
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
  return !s || s.includes('*') || RESERVED.has(s.toLocaleLowerCase('tr')) ? '' : s;
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

// ---------- emoji tepkisi ----------
// Herkes bir mesaja tek tepki verir; aynı tepkiye yeniden basmak geri alır. Tepki şifreli zarfla gider.
function applyReact(C, key, id, e) {
  if (!C.log.has(key)) return; // ekranda olmayan mesaja gelen tepki yok sayılır
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
  if (!rec || !rec.el.isConnected) return;
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
  if (!C.log.has(key)) return;
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
  li.classList.add('picked');
  $('menu').hidden = false;
  menuAt = Date.now();
  placeMenu(C);
}

// Menüyü mesajın üstüne, sığmazsa altına koyar; ekranın dışına taşırmaz.
function placeMenu(C) {
  const rec = C && C.menuKey ? C.log.get(C.menuKey) : null;
  if (!rec || !rec.el.isConnected) return closeMenu();
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
    if (rec) rec.el.classList.remove('picked');
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

// ---------- mesaj yanıtlama ----------
function setReply(C, key) {
  C.reply = key && C.log.has(key) ? key : null;
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
  if (!rec || !rec.el.isConnected) return;
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
    addMsg('them', clean(msg.x.slice(0, 2000)), { id, n: msg.n, quoteKey: ok ? `${r.w}:${r.n}` : null });
  } else if (msg.t === 't') {
    C.typers.set(id, Date.now() + TYPING_MS);
  } else if (msg.t === 'r' && msg.s && typeof msg.s === 'object') {
    const seen = msg.s[C.meId]; // benim mesajlarımdan hangisine kadar gördü
    if (Number.isInteger(seen) && seen > (C.seenBy.get(id) || 0)) C.seenBy.set(id, seen);
    paintSeen(C);
  } else if (msg.t === 'n') {
    setNick(C, id, msg.x);
  } else if (msg.t === 'e' && typeof msg.k === 'string' && KEY_RE.test(msg.k) && (msg.e === '' || REACTIONS.includes(msg.e))) {
    applyReact(C, msg.k, id, msg.e);
  } else if (msg.t === 'g' && C.game) {
    await C.game.onMsg(msg.g);
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
  $('end-title').textContent = REASONS[reason] || 'Sohbet bitti';
  $('end-stats').textContent = `${human(secs)} · ${n} mesaj · hepsi silindi`;
  $('btn-again').textContent = S.door ? 'Odaya dön' : 'Yeni sohbet';
  $('btn-share').href = xIntent(
    n > 0
      ? `${C.kind === 'room' ? 'Anonim bir odada' : 'Bir yabancıyla'} ${human(secs)} konuştum. Mesajlardan iz kalmadı.\n${location.origin}`
      : `Anonim sohbet, iz bırakmaz:\n${location.origin}`,
  );
  show('end');
}

// ---------- 1'e 1 sohbet ----------
async function startDuo(my, keys, m) {
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
  $('btn-code').dataset.code = C.code;
  openChatView(C, 'Mesajlar uçtan uca şifreli.');
  paintGame(C);
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

// ---------- taş kağıt makas (yalnızca 1'e 1) ----------
// Düğmeye basan rastgele atar. Atış kilitlenir; iki taraf da basınca aynı anda açılır.
const RESULT = { 1: 'Kazandın', 0: 'Berabere', '-1': 'Kaybettin' };

function paintGame(C) {
  const g = C.game;
  const b = $('btn-game');
  b.disabled = Boolean(g.mine); // attım, karşı tarafı bekliyorum
  b.textContent = g.mine ? 'Bekleniyor…' : 'Taş kağıt makas';
  b.classList.toggle('ping', Boolean(g.theirHash) && !g.mine); // karşı taraf attı, sıra bende
}

function onGame(C, ev) {
  if (!alive(C)) return;
  const g = C.game;
  const peer = whoOf(C, C.peerId).name;
  if (ev === 'invite') addMsg('sys', `${peer} taş kağıt makas attı. Sıra sende.`);
  else if (ev === 'cheat') addMsg('sys', 'Geçersiz hamle. Tur iptal.');
  else if (ev === 'result') {
    const l = g.last;
    addMsg('sys', `Sen ${NAME[l.mine]}, ${peer} ${NAME[l.theirs]}. ${RESULT[l.result]}. Skor ${g.score.me} – ${g.score.them}`);
  }
  paintGame(C);
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
  const C = S.chat;
  if (!C) return;
  const actions = [{ label: 'Kaydet', kind: 'primary', fn: (v) => setMyNick(C, v) }];
  if (C.nick) actions.push({ label: 'Rengime dön', fn: () => setMyNick(C, '') });
  actions.push({ label: 'Vazgeç' });
  openSheet('Adın', 'Yalnızca bu sohbette görünür. Boş bırakırsan rengin kalır.', actions, {
    value: C.nick,
    placeholder: C.me.name,
    max: 16,
  });
};

$('sheet-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('sheet-actions').firstElementChild.click(); // Enter ilk düğmeyle aynı
});

$('btn-code').onclick = () => {
  const C = S.chat;
  if (!C || C.kind !== 'duo') return;
  openSheet('Güvenlik kodu', `${C.code}\n\nKarşı tarafta da aynıysa mesajları aranızda kimse okuyamaz.`, [{ label: 'Tamam' }]);
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

$('btn-game').onclick = async () => {
  const C = S.chat;
  if (!C || !C.game || C.game.mine) return;
  C.lastAct = Date.now();
  const first = !C.game.theirHash;
  const move = randomMove();
  const done = await C.game.pick(move);
  if (done && first && alive(C)) addMsg('sys', `${NAME[move]} attın. Karşı taraf bekleniyor.`);
};

$('composer').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const C = S.chat;
  const inp = $('input');
  const text = clean(inp.value.trim()); // küfür gönderilmeden yıldızlanır
  if (!C || !text) return;
  inp.value = '';
  C.sent++;
  C.lastAct = Date.now();
  C.lastTyping = 0; // sıradaki mesaja başlar başlamaz "yazıyor" yeniden gitsin
  const quoteKey = C.reply;
  const cut = quoteKey ? quoteKey.lastIndexOf(':') : -1;
  const r = quoteKey ? { w: quoteKey.slice(0, cut), n: Number(quoteKey.slice(cut + 1)) } : null;
  const n = enqueue(C, r ? { t: 'm', x: text, r } : { t: 'm', x: text }, true);
  addMsg('me', text, { id: C.meId, n, quoteKey });
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
  else if (!$('sheet').hidden) closeSheet();
  else if (S.chat && S.chat.reply) setReply(S.chat, null);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const C = S.chat;
  if (C) {
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
