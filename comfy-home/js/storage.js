/**
 * Comfy home — persistenza (localStorage) e validazione input.
 *
 * Tutti i dati scritti sono validati sia in ingresso (form) sia in lettura
 * (difesa da localStorage manomesso o corrotto). Le icone sono ri-codificate
 * via canvas in PNG/JPEG data-URL: qualunque contenuto attivo (es. SVG con
 * script) viene eliminato dalla rasterizzazione.
 */

const K_DEVICES = 'ch_devices_v1';
const K_COMMANDS = 'ch_commands_v1';
const K_LOG_PREFIX = 'ch_log_v1_';

const MAX_LOG_ENTRIES = 300;
const MAX_ICON_DATAURL = 60 * 1024; // ~60 KB per icona
const ID_RE = /^[a-f0-9]{16}$/;

/* ------------------------------------------------------------------ */
/* Utilità                                                             */
/* ------------------------------------------------------------------ */

export function newId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
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

export function isValidIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255 && (o.length === 1 || o[0] !== '0'));
}

export function isValidHost(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 253) return false;
  // una stringa di sole cifre e punti è un tentativo di IPv4: dev'essere valido
  if (/^[\d.]+$/.test(s)) return isValidIPv4(s);
  return HOSTNAME_RE.test(s);
}

export function validateDeviceInput({ name, host, port, key, timeout }) {
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
  return errors;
}

export function validateParam(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 0 && PARAM_RE.test(v) && !v.includes('|') && !v.includes('$');
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
  if (!ID_RE.test(cmd.id) || !ID_RE.test(cmd.deviceId)) return null;
  if (!cmd.label || cmd.label.length > 40) return null;
  if (cmd.params.length < 1 || cmd.params.length > 16) return null;
  if (!cmd.params.every(validateParam)) return null;
  if (cmd.icon && !isSafeIcon(cmd.icon)) cmd.icon = '';
  return cmd;
}

/** Stringa di comando trasmessa: "p1|p2|...|pn$" */
export function buildCommandString(params) {
  return params.join('|') + '$';
}

/* ------------------------------------------------------------------ */
/* Device                                                              */
/* ------------------------------------------------------------------ */

export function getDevices() {
  const list = readJson(K_DEVICES, []);
  return Array.isArray(list) ? list.map(sanitizeDevice).filter(Boolean) : [];
}

export function getDevice(id) {
  return getDevices().find((d) => d.id === id) || null;
}

export function saveDevice(device) {
  const clean = sanitizeDevice(device);
  if (!clean) return false;
  const list = getDevices();
  const i = list.findIndex((d) => d.id === clean.id);
  if (i >= 0) list[i] = clean;
  else list.push(clean);
  return writeJson(K_DEVICES, list);
}

export function deleteDevice(id) {
  const list = getDevices().filter((d) => d.id !== id);
  const ok = writeJson(K_DEVICES, list);
  // rimuove anche i comandi e il log associati
  const cmds = getCommands().filter((c) => c.deviceId !== id);
  writeJson(K_COMMANDS, cmds);
  try { localStorage.removeItem(K_LOG_PREFIX + id); } catch { /* ignora */ }
  return ok;
}

/* ------------------------------------------------------------------ */
/* Comandi                                                             */
/* ------------------------------------------------------------------ */

export function getCommands() {
  const list = readJson(K_COMMANDS, []);
  return Array.isArray(list) ? list.map(sanitizeCommand).filter(Boolean) : [];
}

export function saveCommand(command) {
  const clean = sanitizeCommand(command);
  if (!clean) return false;
  const list = getCommands();
  const i = list.findIndex((c) => c.id === clean.id);
  if (i >= 0) list[i] = clean;
  else list.push(clean);
  return writeJson(K_COMMANDS, list);
}

export function deleteCommand(id) {
  return writeJson(K_COMMANDS, getCommands().filter((c) => c.id !== id));
}

/* ------------------------------------------------------------------ */
/* Log per device                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {string} deviceId
 * @param {'tx'|'rx'|'ok'|'fail'|'info'|'error'} kind
 * @param {string} text
 */
export function appendLog(deviceId, kind, text) {
  if (!ID_RE.test(deviceId)) return;
  const key = K_LOG_PREFIX + deviceId;
  const log = readJson(key, []);
  const list = Array.isArray(log) ? log : [];
  list.push({ ts: Date.now(), kind: String(kind), text: String(text).slice(0, 512) });
  if (list.length > MAX_LOG_ENTRIES) list.splice(0, list.length - MAX_LOG_ENTRIES);
  if (!writeJson(key, list)) {
    // quota esaurita: dimezza e riprova una volta
    list.splice(0, Math.floor(list.length / 2));
    writeJson(key, list);
  }
  document.dispatchEvent(new CustomEvent('ch:log', { detail: { deviceId } }));
}

export function getLog(deviceId) {
  if (!ID_RE.test(deviceId)) return [];
  const log = readJson(K_LOG_PREFIX + deviceId, []);
  if (!Array.isArray(log)) return [];
  return log.filter((e) => e && typeof e === 'object' && Number.isFinite(e.ts) && typeof e.text === 'string');
}

export function clearLog(deviceId) {
  if (!ID_RE.test(deviceId)) return;
  try { localStorage.removeItem(K_LOG_PREFIX + deviceId); } catch { /* ignora */ }
  document.dispatchEvent(new CustomEvent('ch:log', { detail: { deviceId } }));
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
      } catch (e) {
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
