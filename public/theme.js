// Sayfa çizilmeden önce çalışır: kayıtlı görünüm tercihi (koyu / açık) varsa onu uygular.
// Tercih yoksa cihazın ayarı geçerlidir. Cihaza yazılan tek şey bu tercihtir.
try {
  var t = localStorage.getItem('theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) {
  /* depolama kapalıysa cihazın ayarı kullanılır */
}
