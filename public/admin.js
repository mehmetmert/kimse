// Yönetim sayfası: engelleri listele, kaldır, IP ile engelle, sohbette anında engellemeyi aç.
const $ = (id) => document.getElementById(id);

let key = '';
try {
  key = sessionStorage.getItem('adm') || '';
} catch {
  /* depolama kapalı olabilir */
}

const ERRORS = {
  auth: 'Anahtar yanlış ya da çok fazla deneme yapıldı (15 dakika bekle).',
  noadmin: 'Yönetim kapalı: ADMIN_KEY ortam değişkeni tanımlı değil (en az 12 karakter olmalı).',
  setup: 'Sunucu kurulumu eksik: Redis bağlı değil.',
  self: 'Bu senin şu anki ağın; kendini engelleyemezsin.',
  ip: 'Geçerli bir IP adresi yaz.',
};
const errText = (r) => ERRORS[r && r.err] || 'İstek başarısız oldu.';

async function call(act, data = {}) {
  try {
    const r = await fetch('/api/a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'admin', key, act, ...data }),
      cache: 'no-store',
      credentials: 'omit',
    });
    return await r.json();
  } catch {
    return { ok: false, err: 'net' };
  }
}

function modeOn() {
  try {
    return Boolean(sessionStorage.getItem('adm'));
  } catch {
    return false;
  }
}

function paintMode() {
  $('btn-mode').textContent = modeOn() ? 'Açık · kapat' : 'Kapalı · aç';
}

function left(until) {
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  if (mins < 120) return `${mins} dk`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} saat`;
  return `${Math.round(mins / 1440)} gün`;
}

async function refresh() {
  const r = await call('list');
  if (!r.ok) return false;
  $('stat').textContent = `Son iki dakikada ${r.online} ziyaretçi · ${r.bans.length} engelli ağ`;
  const list = $('bans');
  if (!r.bans.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Engelli ağ yok.';
    list.replaceChildren(li);
    return true;
  }
  list.replaceChildren(
    ...r.bans.map((b) => {
      const li = document.createElement('li');
      const info = document.createElement('span');
      const id = document.createElement('code');
      id.textContent = b.id.slice(0, 8);
      info.append(id, ` · ${b.why === 'auto' ? 'otomatik' : 'yönetici'} · ${left(b.until)} kaldı`);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn sm ghost';
      btn.textContent = 'Kaldır';
      btn.onclick = async () => {
        btn.disabled = true;
        await call('unban', { id: b.id });
        refresh();
      };
      li.append(info, btn);
      return li;
    }),
  );
  return true;
}

async function enter() {
  const r = await call('check');
  if (!r.ok) {
    $('login-err').textContent = errText(r);
    $('login-err').hidden = false;
    return;
  }
  $('login').hidden = true;
  $('panel').hidden = false;
  paintMode();
  refresh();
}

$('login').addEventListener('submit', (ev) => {
  ev.preventDefault();
  key = $('key').value;
  $('login-err').hidden = true;
  enter();
});

$('btn-mode').onclick = () => {
  try {
    if (modeOn()) sessionStorage.removeItem('adm');
    else sessionStorage.setItem('adm', key);
  } catch {
    /* depolama kapalıysa mod açılamaz */
  }
  paintMode();
};

$('ban-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const r = await call('ban', { ip: $('ban-ip').value.trim(), hours: Number($('ban-hours').value) });
  $('ban-msg').textContent = r.ok ? 'Engellendi.' : errText(r);
  if (r.ok) {
    $('ban-ip').value = '';
    refresh();
  }
});

$('btn-refresh').onclick = refresh;

if (key) enter();
