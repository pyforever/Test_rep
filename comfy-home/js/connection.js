/**
 * Comfy home — gestione connessioni WebSocket verso i device ESP.
 *
 * Un DeviceLink per device: mantiene la connessione aperta (ascolto
 * continuo delle trasmissioni cifrate), riconnette con backoff
 * esponenziale, cifra in uscita e decifra in ingresso.
 *
 * Protocollo di conferma: dopo l'invio di "p1|p2$" il device deve
 * rispondere (cifrato) con "[nome_device]_p1|p2$" entro il timeout
 * configurato. Esito: 'ok' (checkmark verde) se coincide, 'fail'
 * (X rossa) se diverso o scaduto.
 */

import { createCipher } from './crypto.js';
import { appendLog } from './storage.js';

const MAX_BACKOFF_MS = 30000;
const CONNECT_WAIT_MS = 6000;
const MAX_WS_MESSAGE = 8192;

function emitStatus(deviceId, status) {
  document.dispatchEvent(new CustomEvent('ch:status', { detail: { deviceId, status } }));
}

function emitConn(deviceId, connected) {
  document.dispatchEvent(new CustomEvent('ch:conn', { detail: { deviceId, connected } }));
}

class DeviceLink {
  constructor(device) {
    this.device = device;
    this.ws = null;
    this.cipher = null;
    this.cipherError = null;
    this.attempts = 0;
    this.reconnectTimer = 0;
    this.disposed = false;
    this.connected = false;
    // esito ultimo comando: 'idle' | 'pending' | 'ok' | 'fail'
    this.status = 'idle';
    this.pending = null; // { expected, timer }
    this._initCipher();
    this._connect();
  }

  async _initCipher() {
    try {
      this.cipher = await createCipher(this.device.key);
    } catch (e) {
      this.cipherError = e.message;
      appendLog(this.device.id, 'error', `Cifratura non inizializzata: ${e.message}`);
    }
  }

  get url() {
    return `ws://${this.device.host}:${this.device.port}/`;
  }

  _connect() {
    if (this.disposed) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.disposed || this.ws !== ws) return;
      this.attempts = 0;
      this.connected = true;
      emitConn(this.device.id, true);
    };
    ws.onmessage = (ev) => {
      if (this.disposed || this.ws !== ws) return;
      this._onMessage(ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      if (wasConnected) emitConn(this.device.id, false);
      this._scheduleReconnect();
    };
    ws.onerror = () => { /* onclose segue sempre */ };
  }

  _scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempts, 5))
      + Math.floor(Math.random() * 500);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      this._connect();
    }, delay);
  }

  /** Forza un tentativo immediato (es. al ritorno in foreground). */
  nudge() {
    if (this.disposed || this.connected || this.ws) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
    this.attempts = 0;
    this._connect();
  }

  async _onMessage(data) {
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_WS_MESSAGE) {
      appendLog(this.device.id, 'error', 'Messaggio ricevuto non valido (scartato).');
      return;
    }
    if (!this.cipher) return;
    let text;
    try {
      text = await this.cipher.decrypt(data.trim());
    } catch {
      appendLog(this.device.id, 'error', 'Messaggio non decifrabile (chiave errata o dati manomessi).');
      if (this.pending) this._settle('fail', 'Conferma non decifrabile');
      return;
    }
    appendLog(this.device.id, 'rx', text);
    if (this.pending) {
      if (text === this.pending.expected) {
        this._settle('ok', 'Conferma corretta');
      } else {
        this._settle('fail', 'Conferma NON coincidente con la stringa inviata');
      }
    }
    // messaggi non sollecitati: restano registrati nel log (ascolto continuo)
  }

  _settle(status, note) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
    this.status = status;
    appendLog(this.device.id, status === 'ok' ? 'ok' : 'fail', note);
    emitStatus(this.device.id, status);
  }

  _waitOpen() {
    if (this.connected && this.ws) return Promise.resolve();
    this.nudge();
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (this.disposed) { reject(new Error('connessione chiusa')); return; }
        if (this.connected && this.ws) { resolve(); return; }
        if (Date.now() - started >= CONNECT_WAIT_MS) {
          reject(new Error('device non raggiungibile'));
          return;
        }
        setTimeout(poll, 150);
      };
      poll();
    });
  }

  /**
   * Invia una stringa di comando ("p1|p2|...$") e attende la conferma.
   * Un solo comando in volo per device.
   */
  async sendCommand(commandString) {
    // guardia sincrona contro il doppio invio (pending viene creato solo
    // dopo await: this.status invece è impostato subito)
    if (this.status === 'pending') {
      emitStatus(this.device.id, 'pending');
      return;
    }
    this.status = 'pending';
    emitStatus(this.device.id, 'pending');

    if (!this.cipher && !this.cipherError) await this._initCipher();
    if (this.cipherError || !this.cipher) {
      appendLog(this.device.id, 'error', `Invio bloccato: ${this.cipherError || 'cifratura non disponibile'}`);
      this.status = 'fail';
      emitStatus(this.device.id, 'fail');
      return;
    }
    try {
      await this._waitOpen();
      const payload = await this.cipher.encrypt(commandString);
      this.ws.send(payload);
      appendLog(this.device.id, 'tx', commandString);
      const expected = `${this.device.name}_${commandString}`;
      const timer = setTimeout(() => {
        this._settle('fail', `Timeout: nessuna conferma entro ${this.device.timeout} s`);
      }, this.device.timeout * 1000);
      this.pending = { expected, timer };
    } catch (e) {
      appendLog(this.device.id, 'error', `Invio fallito: ${e.message}`);
      this.status = 'fail';
      emitStatus(this.device.id, 'fail');
    }
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignora */ }
      this.ws = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

const links = new Map(); // deviceId -> DeviceLink

/** Allinea i collegamenti alla configurazione corrente dei device. */
export function syncLinks(devices) {
  const wanted = new Map(devices.map((d) => [d.id, d]));
  for (const [id, link] of links) {
    const dev = wanted.get(id);
    if (!dev) {
      link.dispose();
      links.delete(id);
    } else if (dev.host !== link.device.host || dev.port !== link.device.port
        || dev.key !== link.device.key) {
      // configurazione di rete/chiave cambiata: ricrea il collegamento
      link.dispose();
      links.set(id, new DeviceLink(dev));
    } else {
      link.device = dev; // aggiorna nome/timeout senza riconnettere
    }
  }
  for (const [id, dev] of wanted) {
    if (!links.has(id)) links.set(id, new DeviceLink(dev));
  }
}

export function getLink(deviceId) {
  return links.get(deviceId) || null;
}

export function linkState(deviceId) {
  const l = links.get(deviceId);
  return l ? { connected: l.connected, status: l.status } : { connected: false, status: 'idle' };
}

// al ritorno in foreground riprova subito le connessioni cadute
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    for (const link of links.values()) link.nudge();
  }
});
