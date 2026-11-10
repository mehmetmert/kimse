// Uçtan uca şifreleme. Anahtarlar her sohbet için tarayıcıda üretilir, sayfa kapanınca yok olur.
// Sunucu yalnızca açık anahtarları ve şifreli metni görür.
// Bu dosya DOM kullanmaz; aynı kod Node testlerinde de çalışır.
const te = new TextEncoder();
const td = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export function toB64u(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

export function randId(n = 12) {
  return toB64u(crypto.getRandomValues(new Uint8Array(n)));
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text)));
}

/** Oda sırrından sunucuya gönderilen oda kimliği. Sır linkte (# sonrası) kalır, sunucuya gitmez. */
export async function doorId(secret) {
  return toB64u(await sha256('door:' + secret)).slice(0, 22);
}

/**
 * Oda sohbetinin anahtarı linkteki sırdan türetilir: linki bilen herkes okur, sunucu okuyamaz.
 * Gönderenin üye kimliği şifreye bağlanır; sunucu bir mesajı başka üyeye mal edemez.
 */
export async function openRoom(secret) {
  const subtle = crypto.subtle;
  const ikm = await subtle.importKey('raw', te.encode('room/v1|' + secret), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('room-salt'), info: te.encode('keys') }, ikm, 256);
  const key = await subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return {
    async seal(obj, member) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(member) }, key, te.encode(JSON.stringify(obj))),
      );
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      return toB64u(out);
    },
    async open(str, member) {
      try {
        const raw = fromB64u(str);
        const pt = await subtle.decrypt(
          { name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: te.encode(member) },
          key,
          raw.subarray(12),
        );
        const o = JSON.parse(td.decode(pt));
        return o && typeof o === 'object' ? o : null;
      } catch {
        return null;
      }
    },
  };
}

/** Sohbet başına tek kullanımlık anahtar çifti. */
export async function newKeys() {
  const kp = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  return { priv: kp.privateKey, pub: toB64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}

/**
 * İki tarafın açık anahtarlarından ortak sohbet anahtarını türetir.
 * seed: iki tarafta da aynı çıkan rastgele baytlar (güvenlik kodu ve renkler için).
 */
export async function openSession({ priv, myPub, peerPub, slot, room, doorSecret = '' }) {
  const subtle = crypto.subtle;
  const peerKey = await subtle.importKey('raw', fromB64u(peerPub), ECDH, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peerKey }, priv, 256);
  const [pa, pb] = slot === 'a' ? [myPub, peerPub] : [peerPub, myPub];
  const salt = await sha256(`chat/v1|${room}|${pa}|${pb}|${doorSecret}`);
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('keys') }, ikm, 512),
  );
  const key = await subtle.importKey('raw', okm.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  // Gönderenin tarafı şifreye bağlanır: sunucu kendi mesajını sana karşıdan gelmiş gibi geri yollayamaz.
  const mine = te.encode(slot);
  const theirs = te.encode(slot === 'a' ? 'b' : 'a');

  return {
    seed: okm.slice(32),
    async seal(obj) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: mine }, key, te.encode(JSON.stringify(obj))),
      );
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      return toB64u(out);
    },
    async open(str) {
      try {
        const raw = fromB64u(str);
        const pt = await subtle.decrypt(
          { name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: theirs },
          key,
          raw.subarray(12),
        );
        const o = JSON.parse(td.decode(pt));
        return o && typeof o === 'object' ? o : null;
      } catch {
        return null;
      }
    },
  };
}
