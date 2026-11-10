# kimse

Anonim sohbet. Kayıt yok, çerez yok, sohbet geçmişi yok. Herkese ad yerine bir renk verilir. X'te paylaşılan linkle anında açılacak şekilde tek sayfa olarak yazıldı.

Canlı adres: https://kimse.vercel.app

## Neler var

- **Rastgele eşleşme:** "Birini bul" ile o an bekleyen biriyle 1'e 1 eşleşirsin. Girişte tek koşul "18 yaşından büyüğüm" kutusudur.
- **Oda sohbeti:** "Oda oluştur" bir link üretir. Linki açan herkes aynı odaya girer; bir odada en fazla 12 kişi olur.
- **Renkler ve ad:** Herkes bir renkle başlar; aynı sohbette iki kişi aynı rengi alamaz. Üstteki şerit o an sohbette olanların renklerini gösterir. İsteyen, başlıktaki "Sen" etiketine dokunup o sohbet için kendine bir ad yazar. Ad yalnızca o sohbette geçerlidir, yeni sohbette yine renk gelir. Küfürlü ya da renk adlarıyla karışacak adlar kabul edilmez.
- **Koyu mod:** Üstteki ay/güneş düğmesi koyu ve açık görünüm arasında geçer. Seçim yapılmamışsa cihazın ayarı geçerlidir.
- **Uçtan uca şifreleme:** Mesajlar tarayıcıda şifrelenir, sunucu içeriği okuyamaz. 1'e 1 sohbette "Güvenlik kodu" iki tarafta aynı çıkan altı haneli sayıyı gösterir.
- **Mesaj menüsü:** Mesaja basılı tutunca (bilgisayarda tıklayınca ya da sağ tıklayınca) WhatsApp'taki gibi bir menü açılır: üstte emoji tepkileri, altında "Yanıtla" ve "Kopyala". Dokunmatikte kısa dokunuş bir şey yapmaz.
- **Emoji tepkisi:** Herkes bir mesaja tek tepki verir (👍 ❤️ 😂 😮 😢 🙏). Tepki mesajın altında görünür, iki kişi tepki verince sayı çıkar. Aynı tepkiye yeniden basmak geri alır.
- **Yanıtlama:** Menüden "Yanıtla" ya da mesajı sağa kaydırmak. Alıntıya dokunmak asıl mesaja götürür.
- **"Yazıyor" ve "Görüldü":** Karşı taraf yazarken üç noktalı balon çıkar. Son mesajın görülünce altında "Görüldü" (odada "2 kişi gördü") yazar.
- **Küfür filtresi:** Küfürlü kelimeler gönderilmeden ve gösterilmeden önce yıldızlanır.
- **Taş kağıt makas:** 1'e 1 sohbette düğmeye basan rastgele atar. Atış kilitlenir ve iki taraf da basınca aynı anda açılır; kimse diğerininkini önceden göremez.
- **Bildirme ve engel:** Üç farklı ağdan bildirilen ağ otomatik ve geçici olarak engellenir (1 saat, tekrarında 6, 24, 72 saat). Yönetici anında engelleyebilir.

## Yerelde çalıştır

Kurulacak bağımlılık yok. Node 22 ya da üstü yeterli.

```
npm run dev
```

Sonra `http://localhost:3000` adresini **iki sekmede** aç, ikisinde de kutuyu işaretleyip "Birini bul"a bas. Yerelde veriler bellekte tutulur, Redis gerekmez.

Testler: `npm test`

Yönetim sayfası `http://localhost:3000/admin` adresindedir. Anahtar `.env` dosyasındaki `ADMIN_KEY` değeridir (`.env.example` dosyasına bak). `.env` GitHub'a gönderilmez.

## Yayın

Site Vercel'de, GitHub'daki `main` dalından yayınlanır: `git push` yeni sürümü kendiliğinden canlıya alır.

Vercel tarafında gerekenler:

1. **Storage → Upstash → Redis** projeye bağlı olmalı (bölge Frankfurt; fonksiyonlar da `fra1`'de çalışır). `KV_REST_API_URL` ve `KV_REST_API_TOKEN` kendiliğinden eklenir.
2. **Settings → Environment Variables** altında `ADMIN_KEY` tanımlı olmalı (en az 12 karakter). Yoksa yönetim sayfası kapalıdır.
3. Ortam değişkeni ekledikten ya da değiştirdikten sonra **Redeploy** gerekir.

Redis bağlı değilse site açılır ama "Sunucu kurulumu eksik" uyarısı gösterir.

## Ortam değişkenleri

| Ad | Zorunlu | Ne işe yarar |
|---|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Canlıda evet | Upstash Redis bağlantısı. `UPSTASH_REDIS_REST_URL` ve `UPSTASH_REDIS_REST_TOKEN` adları da kabul edilir. |
| `ADMIN_KEY` | Hayır | Yönetim sayfasının anahtarı. Yoksa yönetim kapalıdır. |
| `APP_SECRET` | Hayır | Jeton ve IP özeti için sunucu sırrı. Yoksa ilk kullanımda üretilip Redis'te tutulur. |
| `REPORT_THRESHOLD` | Hayır | Kaç farklı ağdan bildirim gelince otomatik engel (varsayılan 3). |
| `RL_FIND` | Hayır | Bir ağın 10 dakikada yapabileceği arama ve odaya giriş sayısı (varsayılan 60). |

## Yönetim

`/admin` sayfasında:

- Engelli ağları görür ve engeli kaldırırsın.
- Bir IP'yi elle engellersin.
- "Sohbette anında engelleme"yi açarsın. Açıkken o sekmede girdiğin 1'e 1 sohbetlerde "Bildir" menüsüne 24 saat ve 30 gün engelleme seçenekleri eklenir.

Sekiz yanlış anahtar denemesinden sonra o ağ 15 dakika kilitlenir.

## Ne saklanır

| Veri | Nerede | Ne kadar |
|---|---|---|
| Mesaj içeriği (düz metin) | Hiçbir yerde | Sunucu göremez |
| Şifreli mesajlar, tepkiler, sohbete özel adlar, oyun hamleleri, "yazıyor" ve "görüldü" bilgileri | Redis | Son etkinlikten 2 dakika sonra silinir; 1'e 1 sohbet bitince 45 saniye içinde |
| Odadaki üyelerin rengi ve son görülme zamanı | Redis | Oda boşalınca 2 dakika içinde silinir |
| Ham IP adresi | Hiçbir yerde | Yazılmaz |
| IP özeti (geri döndürülemez) | Redis | Arama sayacı 11 dakika, bildirim sayacı 24 saat, engel kaydı engel süresi kadar, tekrar engel sayacı 30 gün |
| Kimin kiminle konuştuğu | Hiçbir yerde | 1'e 1 sohbette oda kaydı tutulmaz; bildirim için gereken bilgi istemcideki şifreli jetonda taşınır |
| Çevrimiçi sayacı | Redis | 3 dakika; kimlik değil yalnızca yaklaşık sayı tutar |
| Cihazda | Yalnızca koyu/açık görünüm tercihi | Düğmeye basılınca localStorage'a yazılır; çerez yok, sohbetle ilgili hiçbir şey cihaza yazılmaz |

Sitenin denetiminde olmayanlar: Vercel her site gibi erişim kaydı tutabilir, X de linke kimin tıkladığını görür.

## Sınırlar ve maliyet

Vercel fonksiyonları kalıcı bağlantı tutmadığı için istemci sunucuyu saniyede bir yoklar. Her yoklama bir fonksiyon çağrısı ve bir Redis komutudur. 1'e 1 sohbet için yerelde ölçülen değerler (iki kişinin toplamı; "görüldü" bilgisi eklenmeden önce ölçüldü, canlı sohbette biraz artırır):

| Durum | Redis komutu | Fonksiyon çağrısı |
|---|---|---|
| Canlı sohbet, 1 dakika | yaklaşık 200 | yaklaşık 135 |
| Durgun sohbet, 1 dakika | yaklaşık 100 | yaklaşık 70 |
| Tek kişinin yalnız beklemesi, ilk dakika | yaklaşık 45 | yaklaşık 35 |
| Tek kişinin yalnız beklemesi, sonraki her dakika | yaklaşık 27 | yaklaşık 19 |

3 dakikalık canlı bir 1'e 1 sohbet yaklaşık 600 Redis komutu ve 400 fonksiyon çağrısı harcar. Upstash'in ücretsiz katmanı ayda 500 bin komut; bu kabaca 800 böyle sohbete yeter. Aşılırsa kullandıkça öde fiyatı 100 bin komut başına 0,20 dolar. Odada her üye ayrı yoklar: 5 kişilik bir oda dakikada kabaca 5 kişilik komut harcar; odalar için ayrı ölçüm yapılmadı.

Trafik büyürse aktarımı kalıcı bağlantıya taşımak gerekir. Vercel fonksiyonları Ekim 2026'dan beri WebSocket destekliyor; istemcide değişecek yer `public/app.js` içindeki `duoLoop` ve `roomLoop`, sunucuda `lib/core.js` içindeki `sync` ve `roomSync`.

Bilinen sınırlar:

- IP engeli kusursuz değildir: mobil operatörlerde ve ortak ağlarda birçok kişi aynı IP'yi paylaşır, IP de sık değişir. Bu yüzden otomatik engeller kısa sürelidir.
- Küfür filtresi kelime listesine dayanır ve tarayıcıda çalışır: her yazımı yakalayamaz, nadiren masum bir kelimeyi yıldızlayabilir.
- Odada "Bildir" ve taş kağıt makas yoktur. Linki bilen herkes odaya girebilir ve mesajları okuyabilir.

## Dosyalar

```
api/a.js          Vercel fonksiyonu: tek API ucu
lib/core.js       eşleştirme, mesaj aktarımı, oda, bildirim, engel, yönetim
lib/store.js      Redis erişimi (canlıda Upstash REST, yerelde bellek)
lib/util.js       jeton mühürleme, IP özeti
public/app.js     arayüz ve sohbet akışı (1'e 1 ve oda)
public/e2e.js     uçtan uca şifreleme
public/filter.js  küfür filtresi
public/rps.js     taş kağıt makas (kilitle, sonra aç)
public/words.js   renkler ve güvenlik kodu
public/style.css  görünüm; renkler dosyanın başındaki değişkenlerden değişir (açık ve koyu)
public/theme.js   kayıtlı koyu/açık tercihini sayfa çizilmeden uygular
public/fonts/     Open Sans (siteden sunulur, dış istek yok)
test/             sunucu, oda, şifreleme, oyun ve filtre testleri
dev.mjs           yerel geliştirme sunucusu
```

## Yeni oyun eklemek

Sohbet mesajları şifreli bir zarfın içinde tür etiketiyle gider: `m` mesaj, `t` yazıyor, `r` görüldü, `n` ad, `e` tepki, `g` oyun hamlesi. Sunucu türleri ayırt edemez, yalnızca aktarır; yeni oyun için sunucuda değişiklik gerekmez.

`public/rps.js` örnek alınabilir: oyun mantığı DOM'dan bağımsız bir sınıftır, `send` ile hamle yollar, `onMsg` ile karşı hamleyi alır. `public/app.js` içinde `onPayload` gelen hamleyi oyuna iletir.

1'e 1 sohbette iki tarafta aynı çıkan `seed` baytları (`public/e2e.js`) ortak rastgelelik kaynağıdır: iki tarafa aynı soruları üretmek için kullanılabilir.
