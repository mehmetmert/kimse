// Ortak anahtardan türetilen, iki tarafta da aynı çıkan küçük şeyler:
// tarafların renkleri ve sayısal güvenlik kodu.

// Takma ad yerine renk. Birbirinden kolay ayrılan 12 düz renk.
export const COLORS = [
  { name: 'Kırmızı', hex: '#d2504b' },
  { name: 'Turuncu', hex: '#e07f37' },
  { name: 'Sarı', hex: '#d1a11a' },
  { name: 'Yeşil', hex: '#4c9a5e' },
  { name: 'Turkuaz', hex: '#2c9a8d' },
  { name: 'Mavi', hex: '#3f82c0' },
  { name: 'Lacivert', hex: '#35477c' },
  { name: 'Mor', hex: '#7a58b8' },
  { name: 'Pembe', hex: '#cf6594' },
  { name: 'Bordo', hex: '#8a3046' },
  { name: 'Kahve', hex: '#8a674a' },
  { name: 'Gri', hex: '#78818c' },
];

/**
 * İki tarafın renkleri (a ve b). İkisi asla aynı olmaz; ayrıca listede en az dört sıra uzaktan
 * seçilir ki yeşil ile turkuaz gibi birbirine yakın iki renk aynı sohbete düşmesin.
 */
export function colorsOf(seed) {
  const n = COLORS.length;
  const a = seed[5] % n;
  const b = (a + 4 + (seed[7] % (n - 7))) % n;
  return { a: COLORS[a], b: COLORS[b] };
}

/** Altı haneli güvenlik kodu. İki tarafta aynıysa araya giren yok. */
export function codeOf(seed) {
  const v = ((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0;
  const s = String(v % 1000000).padStart(6, '0');
  return s.slice(0, 3) + ' ' + s.slice(3);
}
