// Tek saat kaynağı. Testler zamanı ileri sarabilsin diye değiştirilebilir.
let fn = () => Date.now();

export const now = () => fn();

export function setClock(f) {
  fn = f || (() => Date.now());
}
