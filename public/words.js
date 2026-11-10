// Ortak anahtardan türetilen, iki tarafta da aynı çıkan küçük şeyler:
// güvenlik kodu (emoji), takma adlar ve buz kırıcı soru.

export const ICE = [
  'Son zamanlarda seni en çok ne güldürdü?',
  'Bir süper gücün olsa hangisini seçerdin?',
  'Şu an neredesin: ev, iş, yol?',
  'Hiç bıkmadan yiyebileceğin yemek ne?',
  'En son izlediğin dizi ya da film neydi?',
  'Sabah insanı mısın, gece kuşu mu?',
  'Çay mı kahve mi? Gerekçeli karar lütfen.',
  'Bir günlüğüne herhangi bir şehirde olabilsen neresi olurdu?',
  'Telefonunda en çok kullandığın uygulama hangisi?',
  'Çocukken ne olmak istiyordun?',
  'Dinlemekten utandığın ama sevdiğin bir şarkı var mı?',
  'Bugün başına gelen en iyi şey neydi?',
  'Kedi mi köpek mi?',
  'Zamanda yolculuk: geçmişe mi, geleceğe mi?',
  'Herkesin sevdiği ama senin sevmediğin şey ne?',
  'En saçma korkun ne?',
  'Bir yemeği dünyadan silebilsen hangisini silerdin?',
  'Hayatın bir film olsa adı ne olurdu?',
  'Lahmacuna limon sıkılır mı, sıkılmaz mı?',
  'Menemen soğanlı mı olur, soğansız mı?',
  'Şu an kafanda çalan şarkı hangisi?',
  'Piyangodan büyük ikramiye çıksa ilk ne yapardın?',
  'Hiç unutamadığın bir tatil anın var mı?',
  'En son ne zaman yeni bir şey denedin?',
  'Sence en gereksiz icat ne?',
  'Issız adaya üç şey götürebilsen neler olurdu?',
  'Yaz mı kış mı?',
  'İnsanların hakkında yanlış bildiği bir şey ne?',
  'En iyi yaptığın yemek ne?',
  'Bir gün 25 saat olsa fazladan saatte ne yapardın?',
  'Okulda en sevdiğin ders hangisiydi?',
  'Son okuduğun kitap neydi?',
  'Şu an canın ne çekiyor?',
  'Hangi dönemde yaşamak isterdin?',
  'Uyanınca ilk yaptığın şey ne?',
  'Seni anında mutlu eden küçük şey ne?',
];

// 64 emoji: her biri 6 bit. Eski cihazlarda da görünen, birbirine benzemeyen simgeler.
export const EMOJI = [
  '🐙', '🍋', '🚲', '🌙', '⭐', '🍉', '🎈', '🐢', '🦊', '🍄', '🌵', '🎸', '🚀', '🧩', '🎁', '🐝',
  '🍒', '🥐', '⛄', '🔔', '🎲', '🧲', '🌷', '🐳', '🦉', '🍩', '🥝', '🌻', '⚓', '🎩', '🧦', '🌍',
  '🐌', '🍇', '🥕', '🌈', '🔑', '🎯', '🧭', '🛶', '🐧', '🦋', '🍓', '🥨', '🌴', '⛵', '🎺', '🧵',
  '📌', '🐞', '🍍', '🥥', '🌋', '🔭', '🎻', '🧸', '🛹', '🐬', '🦔', '🍑', '🥦', '🌊', '⏰', '🎨',
];

const COLORS = [
  'Mor', 'Sarı', 'Mavi', 'Yeşil', 'Turuncu', 'Pembe', 'Lacivert', 'Kırmızı',
  'Turkuaz', 'Gri', 'Beyaz', 'Bordo', 'Eflatun', 'Bej', 'Altın', 'Gümüş',
];

const NOUNS = [
  'Kirpi', 'Vapur', 'Martı', 'Simit', 'Lale', 'Kedi', 'Baykuş', 'Çınar',
  'Nar', 'Bulut', 'Fener', 'Uçurtma', 'Karınca', 'Yunus', 'Leylek', 'Semaver',
  'Tavşan', 'Papatya', 'Sincap', 'Kaplumbağa', 'Deniz', 'Rüzgar', 'Yıldız', 'Çaydanlık',
  'Penguen', 'Kelebek', 'Serçe', 'Zeytin', 'Kavun', 'Limon', 'Tren', 'Balon',
];

/** Beş emojilik güvenlik kodu (30 bit). İki tarafta aynıysa araya giren yok. */
export function codeOf(seed) {
  return [0, 1, 2, 3, 4].map((i) => EMOJI[seed[i] & 63]).join(' ');
}

/** Sohbet boyunca geçerli iki takma ad: a ve b tarafı için. */
export function aliasesOf(seed) {
  const na = seed[6] & 31;
  let nb = seed[8] & 31;
  if (nb === na) nb = (nb + 1) & 31;
  return { a: `${COLORS[seed[5] & 15]} ${NOUNS[na]}`, b: `${COLORS[seed[7] & 15]} ${NOUNS[nb]}` };
}

/** İlk buz kırıcı sorunun sırası. */
export function iceOf(seed) {
  return ((seed[9] << 8) | seed[10]) % ICE.length;
}
