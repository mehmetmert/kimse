// Küfür filtresi: yakalaması gerekenler ve dokunmaması gerekenler.
import assert from 'node:assert/strict';
import test from 'node:test';

const { clean } = await import('../public/filter.js');

const masked = (s) => clean(s) !== s;

test('yaygın küfürler ve yazım oyunları yıldızlanır', () => {
  const bad = [
    'amk', 'AMK', 'aq', 'a.m.k', 'amına', 'amina', 'amını', 'amcık',
    'siktir', 'SİKTİR', 'siktirgit', 'sikeyim', 'sikerim', 'sikik', 'sikim', 'sikiş', 'sik',
    'siiiktir', 's1kt1r', 's.i.k.t.i.r', 'sktr', 's*ktir',
    'yarrak', 'yarak', 'yarağım', 'orospu', 'orospuçocuğu', 'orosbu', 'oç',
    'piç', 'piçlik', 'göt', 'götü', 'götveren', 'ibne', 'pezevenk', 'kahpe', 'kaltak',
    'sürtük', 'surtuk', 'gavat', 'godoş', 'dalyarak', 'taşak', 'taşşak', 'yavşak', 'puşt',
    'fuck', 'fucking', 'bitch', 'shit',
  ];
  for (const w of bad) assert.ok(masked(w), `yıldızlanmalıydı: ${w}`);
});

test('masum kelimelere dokunulmaz', () => {
  const ok = [
    'sık', 'sıkıldım', 'sıkı', 'sıkıntı', 'sikildim', 'klasik', 'eksik', 'kesik', 'fizik', 'müzik', 'siklet', 'siklon',
    'götür', 'götürdüm', 'götürür', 'amca', 'amcam', 'amin', 'Amine', 'ama', 'aman', 'kamera',
    'yara', 'yarasa', 'yarar', 'yaratık', 'yarın', 'pilav', 'pide', 'picture', 'pic', 'got', 'gotten',
    'taşı', 'taşıdım', 'daha', 'kasık', 'aşık', 'ışık', 'mk3', 'merhaba', 'nasılsın', 'iyiyim', 'oç.',
    'push', 'put', 'kalabalık', 'gavur', 'sürtünme', 'assassin', 'night', 'shirt',
  ].filter((w) => w !== 'oç.');
  for (const w of ok) assert.equal(clean(w), w, `dokunulmamalıydı: ${w}`);
});

test('cümlede yalnızca küfürlü kelime yıldızlanır, noktalama ve gerisi korunur', () => {
  assert.equal(clean('ne diyon amk, anlamadım'), 'ne diyon ***, anlamadım');
  assert.equal(clean('Siktir git!'), '****** git!');
  assert.equal(clean('(orospu)'), '(******)');
  assert.equal(clean('canım sıkıldı, klasik müzik dinliyorum'), 'canım sıkıldı, klasik müzik dinliyorum');
  assert.equal(clean('beni eve götür lütfen'), 'beni eve götür lütfen');
  assert.equal(clean(''), '');
  assert.equal(clean('   '), '   ');
  // Çok uzun küfür en fazla sekiz yıldız olur; satır sonları korunur.
  assert.equal(clean('orospuçocuğusun\ntamam'), '********\ntamam');
  // İki kez süzmek sonucu değiştirmez.
  const once = clean('amk ya siktir');
  assert.equal(clean(once), once);
});

const { hasLink, stripLinks } = await import('../public/filter.js');

test('link: yaygın biçimler ve kaçamaklar yakalanır', () => {
  const links = [
    'https://site.com', 'http://a.b', 'www.google.com', 'site.com', 'SİTE.COM', 'instagram.com/kullanici', 'bit.ly/abc',
    't.me/kanal', 'wa.me/905551112233', 'mail@site.com.tr', 'güzel.com.tr', 'site[.]com', 'site (dot) com', 'site nokta com',
    'bak buraya: x.xyz', 'discord.gg/abc', 'ornek.net/yol?x=1',
  ];
  for (const l of links) assert.ok(hasLink(l), `yakalanmalıydı: ${l}`);
});

test('link: sıradan yazılar link sayılmaz', () => {
  const ok = [
    'saat 3.30', 'fiyat 1.5 tl', 'Tamam. Top oynadık', 'Evet. Me dedim', 'a.m.k', 'nasılsın?', 'son nokta', 'ben de', 'dot', 'com',
    'v1.2.3', 'merhaba...', 'tamam.peki', 'ok.', 'Bir. İki. Üç.', 'cokdan.comerttir',
  ];
  for (const t of ok) assert.equal(hasLink(t), false, `link sayılmamalıydı: ${t}`);
});

test('link: yalnızca link kısmı gizlenir', () => {
  assert.equal(stripLinks('bak site.com çok güzel'), 'bak [link] çok güzel');
  assert.equal(stripLinks('https://x.com/a ve www.y.org'), '[link] ve [link]');
  assert.equal(stripLinks('link yok burada'), 'link yok burada');
});
