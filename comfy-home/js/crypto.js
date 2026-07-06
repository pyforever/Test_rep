/**
 * Comfy home — modulo crittografico.
 *
 * Formato messaggio (identico in TX e RX, interoperabile con la libreria
 * open source rweather/Crypto usata sugli ESP8266/ESP32):
 *
 *     base64( IV[12] || CIPHERTEXT[n] || TAG[16] )
 *
 * Cifrario: AES-256-GCM. Chiave = SHA-256(passphrase del device).
 *
 * Backend: WebCrypto (crypto.subtle) quando disponibile (contesto sicuro),
 * altrimenti implementazione JS pura (necessaria perché l'app viene servita
 * su origini http:// della rete locale, dove crypto.subtle non esiste).
 * L'implementazione JS viene auto-verificata con vettori di test NIST
 * prima di poter essere usata.
 */

const te = new TextEncoder();
const td = new TextDecoder();

const IV_LEN = 12;
const TAG_LEN = 16;
export const MAX_PAYLOAD_B64 = 8192; // limite anti-abuso sui messaggi in ingresso

/* ------------------------------------------------------------------ */
/* Utilità byte/base64                                                 */
/* ------------------------------------------------------------------ */

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64) {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > MAX_PAYLOAD_B64) {
    throw new Error('payload non valido');
  }
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error('base64 non valido');
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  // crypto.getRandomValues è disponibile anche in contesti non sicuri.
  (globalThis.crypto || {}).getRandomValues
    ? globalThis.crypto.getRandomValues(out)
    : (() => { throw new Error('CSPRNG non disponibile'); })();
  return out;
}

/* ------------------------------------------------------------------ */
/* SHA-256 (JS puro, per derivazione chiave senza crypto.subtle)       */
/* ------------------------------------------------------------------ */

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Js(data) {
  const len = data.length;
  const bitLen = len * 8;
  // padding: 0x80, zeri, lunghezza a 64 bit big-endian
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
  return out;
}

function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

/* ------------------------------------------------------------------ */
/* AES-256 (solo cifratura di blocco: basta per CTR/GCM)               */
/* ------------------------------------------------------------------ */

const SBOX = (() => {
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    // x *= 3 in GF(2^8) con polinomio 0x11b
    x = (x ^ ((x << 1) ^ ((x & 0x80) ? 0x1b : 0))) & 0xff;
  }
  exp[255] = exp[0]; // g^255 = g^0 = 1 (necessario per inv(1) = exp[255 - log[1]])
  const rotl8 = (v, n) => ((v << n) | (v >>> (8 - n))) & 0xff;
  const sbox = new Uint8Array(256);
  sbox[0] = 0x63;
  for (let i = 1; i < 256; i++) {
    const inv = exp[255 - log[i]];
    sbox[i] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63) & 0xff;
  }
  return sbox;
})();

const xtime = (v) => ((v << 1) ^ ((v & 0x80) ? 0x1b : 0)) & 0xff;

function expandKey256(key) {
  if (key.length !== 32) throw new Error('chiave AES-256 non valida');
  const Nk = 8;
  const w = new Uint32Array(60); // 4 * (14 + 1)
  for (let i = 0; i < Nk; i++) {
    w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  }
  const subWord = (t) =>
    ((SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) |
     (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
  const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];
  for (let i = Nk; i < 60; i++) {
    let t = w[i - 1];
    if (i % Nk === 0) {
      t = (subWord(((t << 8) | (t >>> 24)) >>> 0) ^ (RCON[i / Nk - 1] << 24)) >>> 0;
    } else if (i % Nk === 4) {
      t = subWord(t);
    }
    w[i] = (w[i - Nk] ^ t) >>> 0;
  }
  return w;
}

function encryptBlock(w, inp, out) {
  const Nr = 14;
  const a = new Uint8Array(16);
  const t = new Uint8Array(16);
  for (let c = 0; c < 4; c++) {
    const k = w[c];
    a[4 * c] = inp[4 * c] ^ (k >>> 24);
    a[4 * c + 1] = inp[4 * c + 1] ^ ((k >>> 16) & 0xff);
    a[4 * c + 2] = inp[4 * c + 2] ^ ((k >>> 8) & 0xff);
    a[4 * c + 3] = inp[4 * c + 3] ^ (k & 0xff);
  }
  for (let round = 1; round <= Nr; round++) {
    // SubBytes + ShiftRows (stato in colonna: indice = 4*colonna + riga)
    for (let c = 0; c < 4; c++) {
      t[4 * c] = SBOX[a[4 * c]];
      t[4 * c + 1] = SBOX[a[(4 * c + 5) & 15]];
      t[4 * c + 2] = SBOX[a[(4 * c + 10) & 15]];
      t[4 * c + 3] = SBOX[a[(4 * c + 15) & 15]];
    }
    if (round < Nr) {
      for (let c = 0; c < 4; c++) {
        const i = 4 * c;
        const a0 = t[i], a1 = t[i + 1], a2 = t[i + 2], a3 = t[i + 3];
        const x = a0 ^ a1 ^ a2 ^ a3;
        a[i] = a0 ^ x ^ xtime(a0 ^ a1);
        a[i + 1] = a1 ^ x ^ xtime(a1 ^ a2);
        a[i + 2] = a2 ^ x ^ xtime(a2 ^ a3);
        a[i + 3] = a3 ^ x ^ xtime(a3 ^ a0);
      }
    } else {
      a.set(t);
    }
    for (let c = 0; c < 4; c++) {
      const k = w[4 * round + c];
      a[4 * c] ^= k >>> 24;
      a[4 * c + 1] ^= (k >>> 16) & 0xff;
      a[4 * c + 2] ^= (k >>> 8) & 0xff;
      a[4 * c + 3] ^= k & 0xff;
    }
  }
  out.set(a);
}

/* ------------------------------------------------------------------ */
/* GCM (JS puro)                                                       */
/* ------------------------------------------------------------------ */

// Moltiplicazione in GF(2^128), Z = X * H (NIST SP 800-38D, right-shift)
function gmul(X, H) {
  let z0 = 0, z1 = 0, z2 = 0, z3 = 0;
  let v0 = ((H[0] << 24) | (H[1] << 16) | (H[2] << 8) | H[3]) >>> 0;
  let v1 = ((H[4] << 24) | (H[5] << 16) | (H[6] << 8) | H[7]) >>> 0;
  let v2 = ((H[8] << 24) | (H[9] << 16) | (H[10] << 8) | H[11]) >>> 0;
  let v3 = ((H[12] << 24) | (H[13] << 16) | (H[14] << 8) | H[15]) >>> 0;
  for (let i = 0; i < 128; i++) {
    if ((X[i >> 3] >>> (7 - (i & 7))) & 1) {
      z0 ^= v0; z1 ^= v1; z2 ^= v2; z3 ^= v3;
    }
    const lsb = v3 & 1;
    v3 = ((v3 >>> 1) | (v2 << 31)) >>> 0;
    v2 = ((v2 >>> 1) | (v1 << 31)) >>> 0;
    v1 = ((v1 >>> 1) | (v0 << 31)) >>> 0;
    v0 = v0 >>> 1;
    if (lsb) v0 = (v0 ^ 0xe1000000) >>> 0;
  }
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, z0 >>> 0); dv.setUint32(4, z1 >>> 0);
  dv.setUint32(8, z2 >>> 0); dv.setUint32(12, z3 >>> 0);
  return out;
}

// GHASH con AAD vuoto: blocchi del ciphertext + blocco lunghezze
function ghash(H, C) {
  let Y = new Uint8Array(16);
  const block = new Uint8Array(16);
  for (let off = 0; off < C.length; off += 16) {
    block.fill(0);
    block.set(C.subarray(off, Math.min(off + 16, C.length)));
    for (let i = 0; i < 16; i++) Y[i] ^= block[i];
    Y = gmul(Y, H);
  }
  block.fill(0);
  const bits = C.length * 8;
  const dv = new DataView(block.buffer);
  dv.setUint32(8, Math.floor(bits / 0x100000000));
  dv.setUint32(12, bits >>> 0);
  for (let i = 0; i < 16; i++) Y[i] ^= block[i];
  return gmul(Y, H);
}

function inc32(ctr) {
  for (let i = 15; i >= 12; i--) {
    ctr[i] = (ctr[i] + 1) & 0xff;
    if (ctr[i] !== 0) break;
  }
}

class GcmJs {
  constructor(keyBytes) {
    this._w = expandKey256(keyBytes);
    this._H = new Uint8Array(16);
    encryptBlock(this._w, new Uint8Array(16), this._H);
  }

  _ctr(j0, data) {
    const out = new Uint8Array(data.length);
    const ctr = j0.slice();
    const ks = new Uint8Array(16);
    for (let off = 0; off < data.length; off += 16) {
      inc32(ctr);
      encryptBlock(this._w, ctr, ks);
      const end = Math.min(16, data.length - off);
      for (let i = 0; i < end; i++) out[off + i] = data[off + i] ^ ks[i];
    }
    return out;
  }

  _tag(j0, ciphertext) {
    const s = ghash(this._H, ciphertext);
    const e = new Uint8Array(16);
    encryptBlock(this._w, j0, e);
    for (let i = 0; i < 16; i++) s[i] ^= e[i];
    return s;
  }

  encrypt(iv, plaintext) {
    const j0 = new Uint8Array(16);
    j0.set(iv);
    j0[15] = 1;
    const ct = this._ctr(j0, plaintext);
    const tag = this._tag(j0, ct);
    const out = new Uint8Array(ct.length + TAG_LEN);
    out.set(ct);
    out.set(tag, ct.length);
    return out; // ciphertext || tag (stesso layout di crypto.subtle)
  }

  decrypt(iv, data) {
    if (data.length < TAG_LEN) throw new Error('messaggio troppo corto');
    const ct = data.subarray(0, data.length - TAG_LEN);
    const tag = data.subarray(data.length - TAG_LEN);
    const j0 = new Uint8Array(16);
    j0.set(iv);
    j0[15] = 1;
    const calc = this._tag(j0, ct);
    let diff = 0;
    for (let i = 0; i < TAG_LEN; i++) diff |= calc[i] ^ tag[i]; // confronto a tempo costante
    if (diff !== 0) throw new Error('autenticazione fallita');
    return this._ctr(j0, ct);
  }
}

/* ------------------------------------------------------------------ */
/* Auto-test con vettori NIST (obbligatorio prima dell'uso del JS puro)*/
/* ------------------------------------------------------------------ */

let selfTestPassed = null;

export function runSelfTest() {
  if (selfTestPassed !== null) return selfTestPassed;
  try {
    // SHA-256("abc")
    if (bytesToHex(sha256Js(te.encode('abc'))) !==
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') {
      throw new Error('sha256');
    }
    // NIST AES-256-GCM, caso 13: K=0*32, IV=0*12, PT vuoto
    const g = new GcmJs(new Uint8Array(32));
    const t13 = g.encrypt(new Uint8Array(IV_LEN), new Uint8Array(0));
    if (bytesToHex(t13) !== '530f8afbc74536b9a963b4f1c4cb738b') throw new Error('gcm tc13');
    // NIST AES-256-GCM, caso 14: PT=0*16
    const t14 = g.encrypt(new Uint8Array(IV_LEN), new Uint8Array(16));
    if (bytesToHex(t14) !== 'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919') {
      throw new Error('gcm tc14');
    }
    // Ciclo completo cifra/decifra + rifiuto di un tag manomesso
    const key = sha256Js(te.encode('test'));
    const g2 = new GcmJs(key);
    const iv = hexToBytes('000102030405060708090a0b');
    const msg = te.encode('accendi|luce|salotto$');
    const enc = g2.encrypt(iv, msg);
    const dec = g2.decrypt(iv, enc);
    if (td.decode(dec) !== 'accendi|luce|salotto$') throw new Error('roundtrip');
    const tampered = enc.slice();
    tampered[0] ^= 1;
    let rejected = false;
    try { g2.decrypt(iv, tampered); } catch { rejected = true; }
    if (!rejected) throw new Error('tamper non rifiutato');
    selfTestPassed = true;
  } catch (e) {
    selfTestPassed = false;
    console.error('Auto-test crittografico fallito:', e);
  }
  return selfTestPassed;
}

/* ------------------------------------------------------------------ */
/* API pubblica                                                        */
/* ------------------------------------------------------------------ */

const subtle = globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto.subtle : null;

export function cryptoBackendName() {
  return subtle ? 'WebCrypto (AES-256-GCM)' : 'JS integrato (AES-256-GCM, auto-testato NIST)';
}

/** True se è attivo il backend WebCrypto (contesto sicuro). */
export function usesWebCrypto() {
  return subtle !== null;
}

async function deriveKeyBytes(passphrase) {
  const data = te.encode(passphrase);
  if (subtle) return new Uint8Array(await subtle.digest('SHA-256', data));
  return sha256Js(data);
}

/**
 * Crea un cifratore per una passphrase di device.
 * Ritorna { encrypt(testo) -> base64, decrypt(base64) -> testo }.
 */
export async function createCipher(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('passphrase troppo corta (minimo 8 caratteri)');
  }
  const keyBytes = await deriveKeyBytes(passphrase);

  if (subtle) {
    const key = await subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    keyBytes.fill(0);
    return {
      async encrypt(text) {
        const iv = randomBytes(IV_LEN);
        const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text)));
        const out = new Uint8Array(IV_LEN + ct.length);
        out.set(iv);
        out.set(ct, IV_LEN);
        return bytesToB64(out);
      },
      async decrypt(b64) {
        const data = b64ToBytes(b64);
        if (data.length < IV_LEN + TAG_LEN) throw new Error('messaggio troppo corto');
        const iv = data.subarray(0, IV_LEN);
        const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, data.subarray(IV_LEN));
        return td.decode(pt);
      },
    };
  }

  if (!runSelfTest()) {
    throw new Error('auto-test crittografico fallito: invio disabilitato');
  }
  const gcm = new GcmJs(keyBytes);
  keyBytes.fill(0);
  return {
    async encrypt(text) {
      const iv = randomBytes(IV_LEN);
      const ct = gcm.encrypt(iv, te.encode(text));
      const out = new Uint8Array(IV_LEN + ct.length);
      out.set(iv);
      out.set(ct, IV_LEN);
      return bytesToB64(out);
    },
    async decrypt(b64) {
      const data = b64ToBytes(b64);
      if (data.length < IV_LEN + TAG_LEN) throw new Error('messaggio troppo corto');
      return td.decode(gcm.decrypt(data.subarray(0, IV_LEN), data.subarray(IV_LEN)));
    },
  };
}
