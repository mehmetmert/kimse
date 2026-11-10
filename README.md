# kimse

Anonim 1'e 1 sohbet. Kayıt yok, çerez yok, sohbet geçmişi yok. X'te paylaşılan linkle anında açılacak şekilde tek sayfa olarak yazıldı.

Adı değiştirmek için `public/index.html`, `public/admin.html` ve bu dosyadaki "kimse" yazılarını düzenlemek yeter.

## Neler var

- **Rastgele eşleşme:** "Birini bul" ile o an bekleyen biriyle eşleşirsin. Girişte tek koşul "18 yaşından büyüğüm" kutusudur.
- **Davet linki:** Bir link üretirsin; aynı linki açanlar birbiriyle eşleşir.
- **Uçtan uca şifreleme:** Mesajlar tarayıcıda şifrelenir, sunucu içeriği okuyamaz. Kilit simgesi iki tarafta aynı çıkan güvenlik kodunu gösterir.
- **"Yazıyor" bildirimi:** Karşı taraf yazarken mesajların altında üç noktalı balon ve üstte "yazıyor…" görünür.
- **Taş kağıt makas:** Yazı alanının solundaki ✊ düğmesi. Seçimler kilitlenir ve iki taraf da seçince aynı anda açılır; kimse diğerinin seçimini önceden göremez. 🎲 rastgele seçer.
- **Uçan mesajlar:** Ekranda son 14 mesaj kalır, sohbet bitince hepsi silinir.
- **Bildirme ve engel:** Üç farklı ağdan bildirilen ağ otomatik ve geçici olarak engellenir (1 saat, tekrarında 6, 24, 72 saat). Yönetici anında engelleyebilir.

## Yerelde çalıştır

Kurulacak bağımlılık yok. Node 22 ya da üstü yeterli.

```
npm run dev
```

Sonra `http://localhost:3000` adresini **iki sekmede** aç, ikisinde de kutuyu işaretleyip "Birini bul"a bas. Yerelde veriler bellekte tutulur, Redis gerekmez.

Testler: `npm test`

Yönetim sayfası `http://localhost:3000/admin` adresindedir. Anahtar `.env` dosyasındaki `ADMIN_KEY` değeridir (`.env.example` dosyasına bak).

## Vercel'e yayınla

1. Projeyi Vercel'e gönder: klasörde `npx vercel` çalıştır ya da GitHub'a itip Vercel'den içe aktar. Framework "Other" kalır, build komutu yoktur.
2. Vercel panelinde proje → **Storage** → **Upstash** → **Redis** oluştur ve projeye bağla. Bölge olarak Frankfurt'u seç (fonksiyonlar da `fra1`'de çalışır). `KV_REST_API_URL` ve `KV_REST_API_TOKEN` kendiliğinden eklenir.
3. **Settings → Environment Variables** altına `ADMIN_KEY` ekle (en az 12 karakter, tahmin edilemez olsun).
4. Yeniden yayınla: `npx vercel --prod`
5. Alan adın belli olunca `public/index.html` içindeki `og:image` satırlarını aç; X'te büyük görselli link kartı çıkar.

Redis bağlı değilse site açılır ama "Sunucu kurulumu eksik" uyarısı gösterir.

## Ortam değişkenleri

| Ad | Zorunlu | Ne işe yarar |
|---|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Canlıda evet | Upstash Redis bağlantısı. `UPSTASH_REDIS_REST_URL` ve `UPSTASH_REDIS_REST_TOKEN` adları da kabul edilir. |
| `ADMIN_KEY` | Hayır | Yönetim sayfasının anahtarı. Yoksa yönetim kapalıdır. |
| `APP_SECRET` | Hayır | Jeton ve IP özeti için sunucu sırrı. Yoksa ilk kullanımda üretilip Redis'te tutulur. |
| `REPORT_THRESHOLD` | Hayır | Kaç farklı ağdan bildirim gelince otomatik engel (varsayılan 3). |
| `RL_FIND` | Hayır | Bir ağın 10 dakikada yapabileceği arama sayısı (varsayılan 60). |

## Yönetim

`/admin` sayfasında:

- Engelli ağları görür ve engeli kaldırırsın.
- Bir IP'yi elle engellersin.
- "Sohbette anında engelleme"yi açarsın. Açıkken o sekmede girdiğin sohbetlerde bayrak menüsüne 24 saat ve 30 gün engelleme seçenekleri eklenir.

Sekiz yanlış anahtar denemesinden sonra o ağ 15 dakika kilitlenir.

## Ne saklanır

| Veri | Nerede | Ne kadar |
|---|---|---|
| Mesaj içeriği (düz metin) | Hiçbir yerde | Sunucu göremez |
| Şifreli mesajlar ve oyun hamleleri | Redis | Sohbet bitince 45 saniye, her durumda son etkinlikten 2 dakika sonra silinir |
| Ham IP adresi | Hiçbir yerde | Yazılmaz |
| IP özeti (geri döndürülemez) | Redis | Arama sayacı 11 dakika, bildirim sayacı 24 saat, engel kaydı engel süresi kadar, tekrar engel sayacı 30 gün |
| Kimin kiminle konuştuğu | Hiçbir yerde | Oda kaydı tutulmaz; bildirim için gereken bilgi istemcideki şifreli jetonda taşınır |
| Çevrimiçi sayacı | Redis | 3 dakika; kimlik değil yalnızca yaklaşık sayı tutar |
| Cihazda | Hiçbir şey | Çerez ve localStorage kullanılmaz |

Sitenin denetiminde olmayanlar: Vercel her site gibi erişim kaydı tutabilir, X de linke kimin tıkladığını görür.

## Sınırlar ve maliyet

Vercel fonksiyonları kalıcı bağlantı tutmadığı için istemci sunucuyu saniyede bir yoklar. Her yoklama bir fonksiyon çağrısı ve bir Redis komutudur. Yerelde ölçülen değerler (iki kişinin toplamı):

| Durum | Redis komutu | Fonksiyon çağrısı |
|---|---|---|
| Canlı sohbet, 1 dakika | yaklaşık 200 | yaklaşık 135 |
| Durgun sohbet, 1 dakika | yaklaşık 100 | yaklaşık 70 |
| Tek kişinin yalnız beklemesi, ilk dakika | yaklaşık 45 | yaklaşık 35 |
| Tek kişinin yalnız beklemesi, sonraki her dakika | yaklaşık 27 | yaklaşık 19 |

3 dakikalık canlı bir sohbet yaklaşık 600 Redis komutu ve 400 fonksiyon çağrısı harcar. Upstash'in ücretsiz katmanı ayda 500 bin komut; bu kabaca 800 böyle sohbete yeter. Aşılırsa kullandıkça öde fiyatı 100 bin komut başına 0,20 dolar, yani her 1.000 sohbet yaklaşık 1,20 dolar. Vercel planının aylık çağrı sınırını da aynı hesapla kontrol et.

Trafik büyürse aktarımı kalıcı bağlantıya taşımak gerekir. Vercel fonksiyonları Ekim 2026'dan beri WebSocket destekliyor; istemcide değişecek yer `public/app.js` içindeki `chatLoop`, sunucuda `lib/core.js` içindeki `sync`.

IP engeli kusursuz değildir: mobil operatörlerde ve ortak ağlarda birçok kişi aynı IP'yi paylaşır, IP de sık değişir. Bu yüzden otomatik engeller kısa sürelidir.

## Dosyalar

```
api/a.js         Vercel fonksiyonu: tek API ucu
lib/core.js      eşleştirme, mesaj aktarımı, bildirim, engel, yönetim
lib/store.js     Redis erişimi (canlıda Upstash REST, yerelde bellek)
lib/util.js      jeton mühürleme, IP özeti
public/app.js    arayüz ve sohbet akışı
public/e2e.js    uçtan uca şifreleme
public/rps.js    taş kağıt makas (kilitle, sonra aç)
public/words.js  buz kırıcı sorular, takma adlar, güvenlik kodu simgeleri
public/fonts/    Open Sans (siteden sunulur, dış istek yok)
test/            sunucu, şifreleme ve oyun testleri
dev.mjs          yerel geliştirme sunucusu
```

## Yeni oyun eklemek

Sohbet mesajları şifreli bir zarfın içinde tür etiketiyle gider: `m` mesaj, `t` yazıyor, `i` buz kırıcı, `g` oyun hamlesi. Sunucu türleri ayırt edemez, yalnızca aktarır; yeni oyun için sunucuda değişiklik gerekmez.

`public/rps.js` örnek alınabilir: oyun mantığı DOM'dan bağımsız bir sınıftır, `send` ile hamle yollar, `onMsg` ile karşı hamleyi alır. `public/app.js` içinde `onEntry` gelen hamleyi oyuna iletir.

Eşleşen iki tarafta aynı çıkan `seed` baytları (`public/e2e.js`) ortak rastgelelik kaynağıdır: iki tarafa aynı soruları üretmek için kullanılabilir.
