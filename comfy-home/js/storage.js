/**
 * Comfy home — persistenza (localStorage) e validazione input.
 *
 * Tutti i dati scritti sono validati sia in ingresso (form) sia in lettura
 * (difesa da localStorage manomesso o corrotto). Le icone sono ri-codificate
 * via canvas in PNG/JPEG data-URL: qualunque contenuto attivo (es. SVG con
 * script) viene eliminato dalla rasterizzazione.
 *
 * Le liste e i log sono memoizzati in RAM: localStorage viene ri-letto solo
 * alla prima richiesta, le scritture aggiornano cache e storage insieme.
 */

import { bytesToHex, randomBytes } from './crypto.js';
import { emit } from './ui.js';
import { queuePush, queueLogAppend, queueLogClear } from './sync.js';

const K_DEVICES = 'ch_devices_v1';
const K_COMMANDS = 'ch_commands_v1';
const K_LOG_PREFIX = 'ch_log_v1_';

const MAX_LOG_ENTRIES = 300;
const MAX_ICON_DATAURL = 60 * 1024; // ~60 KB per icona
export const MAX_PARAMS = 16;
const ID_RE = /^[a-f0-9]{16}$/;

/* ------------------------------------------------------------------ */
/* Utilità                                                             */
/* ------------------------------------------------------------------ */

export function newId() {
  return bytesToHex(randomBytes(8));
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const val = JSON.parse(raw);
    return val === null || val === undefined ? fallback : val;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('Scrittura storage fallita:', e);
    return false;
  }
}

function isSafeIcon(dataUrl) {
  return typeof dataUrl === 'string' &&
    dataUrl.length <= MAX_ICON_DATAURL &&
    (/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl));
}

/* ------------------------------------------------------------------ */
/* Validazione                                                         */
/* ------------------------------------------------------------------ */

// Nome device: usato nel protocollo di conferma "[nome]_[stringa]".
// Vietati: underscore (separatore del protocollo), pipe, dollaro, controlli.
const NAME_RE = /^[A-Za-z0-9À-ÖØ-öø-ÿ][A-Za-z0-9À-ÖØ-öø-ÿ .\-]{0,31}$/;

const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9\-]{0,62})?(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,62})?)*$/;

// Parametri comando: alfanumerici + punteggiatura comune; vietati i
// caratteri del protocollo ("|" separatore, "$" terminatore) e i controlli.
const PARAM_RE = /^[A-Za-z0-9À-ÖØ-öø-ÿ .,;:+\-*/=_@#%&()!?]{1,64}$/;

function isValidIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255 && (o.length === 1 || o[0] !== '0'));
}

function isValidHost(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 253) return false;
  // una stringa di sole cifre e punti è un tentativo di IPv4: dev'essere valido
  if (/^[\d.]+$/.test(s)) return isValidIPv4(s);
  return HOSTNAME_RE.test(s);
}

/**
 * Valida i dati di un device. Se `others` è fornito (lista degli altri
 * device configurati), rifiuta anche nomi e indirizzi duplicati: nomi uguali
 * renderebbero ambigue le conferme "[nome]_[stringa]".
 */
export function validateDeviceInput({ name, host, port, key, timeout }, others = null) {
  const errors = [];
  if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
    errors.push('Nome: 1–32 caratteri (lettere, numeri, spazi, punto, trattino). Vietati "_", "|", "$".');
  }
  if (!isValidHost(String(host || '').trim())) {
    errors.push('Indirizzo: inserire un IPv4 valido (es. 192.168.1.50) o un hostname.');
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    errors.push('Porta: numero intero tra 1 e 65535.');
  }
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    errors.push('Chiave di cifratura: da 8 a 128 caratteri.');
  }
  const t = Number(timeout);
  if (!Number.isFinite(t) || t < 1 || t > 120) {
    errors.push('Timeout: da 1 a 120 secondi.');
  }
  if (Array.isArray(others)) {
    const n = String(name || '').trim().toLowerCase();
    if (others.some((d) => d.name.toLowerCase() === n)) {
      errors.push('Nome già usato da un altro dispositivo.');
    }
    if (others.some((d) => d.host === String(host || '').trim() && d.port === p)) {
      errors.push('Indirizzo e porta già usati da un altro dispositivo.');
    }
  }
  return errors;
}

export function validateParam(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 0 && PARAM_RE.test(v) && !v.includes('|') && !v.includes('$');
}

/** Valida i dati di un comando; ritorna la lista (vuota se ok) degli errori. */
export function validateCommandInput({ deviceId, label, params }) {
  const errors = [];
  if (!ID_RE.test(String(deviceId || ''))) {
    errors.push('Selezionare un dispositivo valido.');
  }
  const l = String(label || '').trim();
  if (!l || l.length > 40) errors.push('Descrizione: da 1 a 40 caratteri.');
  if (!Array.isArray(params) || params.length < 1) {
    errors.push('Inserire almeno un parametro.');
  } else {
    if (params.length > MAX_PARAMS) errors.push(`Massimo ${MAX_PARAMS} parametri.`);
    const bad = params.filter((p) => !validateParam(p));
    if (bad.length) {
      errors.push(`Parametri non validi (vietati "|", "$" e caratteri di controllo): ${bad.join(', ')}`);
    }
  }
  return errors;
}

function sanitizeDevice(d) {
  if (!d || typeof d !== 'object') return null;
  const dev = {
    id: String(d.id || ''),
    name: String(d.name || '').trim(),
    host: String(d.host || '').trim(),
    port: Number(d.port),
    key: String(d.key || ''),
    timeout: Number(d.timeout),
  };
  if (!ID_RE.test(dev.id)) return null;
  if (validateDeviceInput(dev).length > 0) return null;
  return dev;
}

function sanitizeCommand(c) {
  if (!c || typeof c !== 'object') return null;
  const cmd = {
    id: String(c.id || ''),
    deviceId: String(c.deviceId || ''),
    label: String(c.label || '').trim(),
    params: Array.isArray(c.params) ? c.params.map((p) => String(p).trim()) : [],
    icon: typeof c.icon === 'string' ? c.icon : '',
  };
  if (!ID_RE.test(cmd.id)) return null;
  if (validateCommandInput(cmd).length > 0) return null;
  if (cmd.icon && !isSafeIcon(cmd.icon)) cmd.icon = '';
  return cmd;
}

/** Stringa di comando trasmessa: "p1|p2|...|pn$" */
export function buildCommandString(params) {
  return params.join('|') + '$';
}

/* ------------------------------------------------------------------ */
/* Liste memoizzate (device e comandi)                                 */
/* ------------------------------------------------------------------ */

const listCache = new Map(); // chiave storage -> array sanificato

function readList(key, sanitize) {
  let list = listCache.get(key);
  if (!list) {
    const raw = readJson(key, []);
    const input = Array.isArray(raw) ? raw : [];
    list = input.map(sanitize).filter(Boolean);
    if (list.length < input.length) {
      console.warn(`${key}: ${input.length - list.length} voci non valide ignorate.`);
    }
    listCache.set(key, list);
  }
  return [...list]; // copia: la cache non è mutabile dall'esterno
}

function writeList(key, list, { push = true } = {}) {
  if (!writeJson(key, list)) return false;
  listCache.set(key, list);
  // propaga al server condiviso (coda offline se non raggiungibile)
  if (push) queuePush(key === K_DEVICES ? 'devices' : 'commands');
  return true;
}

/**
 * Applica lo stato ricevuto dal server (sanificato come ogni lettura),
 * senza ri-accodarlo verso il server. Emette 'ch:remote' se qualcosa
 * è cambiato davvero.
 */
export function applyRemoteState(devices, commands) {
  const devs = (Array.isArray(devices) ? devices : []).map(sanitizeDevice).filter(Boolean);
  const cmds = (Array.isArray(commands) ? commands : []).map(sanitizeCommand).filter(Boolean);
  const changed = JSON.stringify(devs) !== JSON.stringify(getDevices())
    || JSON.stringify(cmds) !== JSON.stringify(getCommands());
  if (!changed) return;
  writeJson(K_DEVICES, devs);
  listCache.set(K_DEVICES, devs);
  writeJson(K_COMMANDS, cmds);
  listCache.set(K_COMMANDS, cmds);
  emit('ch:remote', {});
}

/** Applica il log di un device ricevuto dal server (fusione fatta dal server). */
export function applyRemoteLog(deviceId, entries) {
  if (!ID_RE.test(deviceId)) return;
  const clean = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e === 'object' && Number.isFinite(e.ts) && typeof e.text === 'string',
  );
  logCache.set(deviceId, clean);
  writeJson(K_LOG_PREFIX + deviceId, clean);
  emit('ch:log', { deviceId });
}

function upsertItem(key, sanitize, item) {
  const clean = sanitize(item);
  if (!clean) return false;
  const list = readList(key, sanitize);
  const i = list.findIndex((x) => x.id === clean.id);
  if (i >= 0) list[i] = clean;
  else list.push(clean);
  return writeList(key, list);
}

/* ------------------------------------------------------------------ */
/* Device                                                              */
/* ------------------------------------------------------------------ */

export function getDevices() {
  return readList(K_DEVICES, sanitizeDevice);
}

export function getDevice(id) {
  return getDevices().find((d) => d.id === id) || null;
}

export function saveDevice(device) {
  return upsertItem(K_DEVICES, sanitizeDevice, device);
}

export function deleteDevice(id) {
  const ok = writeList(K_DEVICES, getDevices().filter((d) => d.id !== id));
  // rimuove anche i comandi e il log associati (il server elimina i propri
  // log dei device rimossi quando riceve la PUT della lista dispositivi)
  writeList(K_COMMANDS, getCommands().filter((c) => c.deviceId !== id));
  logCache.delete(id);
  try { localStorage.removeItem(K_LOG_PREFIX + id); } catch { /* ignora */ }
  return ok;
}

/* ------------------------------------------------------------------ */
/* Comandi                                                             */
/* ------------------------------------------------------------------ */

export function getCommands() {
  return readList(K_COMMANDS, sanitizeCommand);
}

export function saveCommand(command) {
  return upsertItem(K_COMMANDS, sanitizeCommand, command);
}

export function deleteCommand(id) {
  return writeList(K_COMMANDS, getCommands().filter((c) => c.id !== id));
}

/* ------------------------------------------------------------------ */
/* Log per device                                                      */
/* ------------------------------------------------------------------ */

const logCache = new Map(); // deviceId -> array di voci

function loadLog(deviceId) {
  let list = logCache.get(deviceId);
  if (!list) {
    const raw = readJson(K_LOG_PREFIX + deviceId, []);
    list = (Array.isArray(raw) ? raw : []).filter(
      (e) => e && typeof e === 'object' && Number.isFinite(e.ts) && typeof e.text === 'string',
    );
    logCache.set(deviceId, list);
  }
  return list;
}

/**
 * @param {string} deviceId
 * @param {'tx'|'rx'|'ok'|'fail'|'info'|'error'} kind
 * @param {string} text
 */
export function appendLog(deviceId, kind, text) {
  if (!ID_RE.test(deviceId)) return;
  const entry = { ts: Date.now(), kind: String(kind), text: String(text).slice(0, 512) };
  const list = loadLog(deviceId);
  list.push(entry);
  if (list.length > MAX_LOG_ENTRIES) list.splice(0, list.length - MAX_LOG_ENTRIES);
  if (!writeJson(K_LOG_PREFIX + deviceId, list)) {
    // quota esaurita: dimezza e riprova una volta
    list.splice(0, Math.floor(list.length / 2));
    writeJson(K_LOG_PREFIX + deviceId, list);
  }
  queueLogAppend(deviceId, entry);
  emit('ch:log', { deviceId });
}

/** Ritorna le voci di log (array condiviso: non modificarlo, usare slice()). */
export function getLog(deviceId) {
  if (!ID_RE.test(deviceId)) return [];
  return loadLog(deviceId);
}

export function clearLog(deviceId) {
  if (!ID_RE.test(deviceId)) return;
  logCache.set(deviceId, []);
  try { localStorage.removeItem(K_LOG_PREFIX + deviceId); } catch { /* ignora */ }
  queueLogClear(deviceId);
  emit('ch:log', { deviceId });
}

/* ------------------------------------------------------------------ */
/* Icone dalla gallery                                                 */
/* ------------------------------------------------------------------ */

/**
 * Converte un file immagine scelto dalla gallery in una piccola icona
 * quadrata (data-URL). La rasterizzazione su canvas neutralizza qualunque
 * payload attivo e limita la dimensione memorizzata.
 */
export function fileToIcon(file) {
  return new Promise((resolve, reject) => {
    if (!(file instanceof File) || !/^image\//.test(file.type)) {
      reject(new Error('Selezionare un file immagine.'));
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      reject(new Error('Immagine troppo grande (max 15 MB).'));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const SIDE = 96;
        const canvas = document.createElement('canvas');
        canvas.width = SIDE;
        canvas.height = SIDE;
        const ctx = canvas.getContext('2d');
        // ritaglio quadrato centrale (cover)
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - s) / 2;
        const sy = (img.naturalHeight - s) / 2;
        ctx.drawImage(img, sx, sy, s, s, 0, 0, SIDE, SIDE);
        let out = canvas.toDataURL('image/png');
        if (out.length > MAX_ICON_DATAURL) out = canvas.toDataURL('image/jpeg', 0.82);
        if (!isSafeIcon(out)) {
          reject(new Error('Impossibile elaborare l\'immagine.'));
          return;
        }
        resolve(out);
      } catch {
        reject(new Error('Impossibile elaborare l\'immagine.'));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('File immagine non leggibile.'));
    };
    img.src = url;
  });
}
