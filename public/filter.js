// Küfür filtresi. Mesajlar uçtan uca şifreli olduğu için sunucu süzemez; süzme tarayıcıda yapılır:
// giden mesaj gönderilmeden, gelen mesaj gösterilmeden önce. Küfürlü kelime yıldızlanır.
// Kelime listesine dayanır; her yazımı yakalayamaz, nadiren masum kelimeyi de yıldızlayabilir.
// Bu dosya DOM kullanmaz; aynı kod Node testlerinde de çalışır.

// Harf yerine kullanılan rakam ve simgeler.
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

// Kalıplar sadeleştirilmiş kelimeye uygulanır: küçük harf, simgeler ayıklanmış, yinelenen harfler teke inmiş
// (yarrak → yarak). Kelime başına demirlidir ki "klasik", "eksik" gibi masum kelimeler takılmasın.
// "sık", "sıkıldım" (ı ile) ve "götür" bilerek dışarıda.
const BAD = [
  /^(amk|aq|amq|mk|mq|oç)$/,
  /^am[ıi]na/,
  /^am[ıi]n[ıi]/,
  /^amc[ıi][kğg]/,
  /^sik(tir|ti|er|ey|iy|ic|ec|ik|im|i[şs]|sin|m[ei]|$)/,
  /^si?kti?r/,
  /^yara[kğg]/,
  /^oro?s[pb]u/,
  /^piç/,
  /^göt(?!ür)/,
  /^[iı][bp]ne/,
  /^pezeven[kg]/,
  /^kahpe/,
  /^kaltak/,
  /^s[üu]rt[üu][kğg]/,
  /^fahi[şs]e/,
  /^gavat/,
  /^godo[şs]/,
  /^dalyara/,
  /^[td]a[şs]a[kğg]/,
  /^yav[şs]a[kğg]/,
  /^pu[şs]t/,
  /^(fuck|motherf|bitch|shit|ashole|cunt|nig[ea])/,
];

function simplify(word) {
  let s = '';
  for (const ch of word.toLocaleLowerCase('tr')) s += LEET[ch] || ch;
  s = s.replace(/[^a-zçğıöşü]/g, ''); // a.m.k, s*k gibi araya konan işaretleri at
  return s.replace(/(.)\1+/g, '$1'); // siiiktir → siktir, yarrak → yarak
}

const isBad = (word) => {
  const s = simplify(word);
  return s.length > 1 && BAD.some((re) => re.test(s));
};

/** Küfürlü kelimeleri yıldızlar; gerisine dokunmaz. */
export function clean(text) {
  // Boşlukla ayrılan her parçada baştaki ve sondaki noktalama korunur, ortadaki kelime sınanır.
  return String(text).replace(/\S+/g, (chunk) => {
    const m = chunk.match(/^([^\p{L}\p{N}@$]*)(.*?)([^\p{L}\p{N}@$]*)$/su);
    if (!m || !m[2] || !isBad(m[2])) return chunk;
    return m[1] + '*'.repeat(Math.min([...m[2]].length, 8)) + m[3];
  });
}
