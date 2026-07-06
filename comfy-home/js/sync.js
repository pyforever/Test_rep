/**
 * Comfy home — sincronizzazione con il server (server.py).
 *
 * Tiene in comune dispositivi, comandi e log tra tutti i client (PC e
 * smartphone) tramite la mini-API /api. localStorage resta la cache
 * offline: se il server non risponde l'app continua a funzionare in
 * locale e una coda persistente (outbox) ri-invia le modifiche appena
 * il server torna raggiungibile. Conflitti: vince l'ultima scrittura.
 *
 * Nessuna dipendenza da storage.js (le funzioni di lettura/applicazione
 * vengono iniettate da main.js): il grafo dei moduli resta senza cicli.
 */

import { emit } from './ui.js';

const API = 'api';
const POLL_MS = 4000;
const K_OUTBOX = 'ch_outbox_v1';
const MAX_OUTBOX = 200;

let hooks = null;        // { getDevices, getCommands, getLog, applyState, applyLog }
let lastStateRev = -1;
let lastLogRevs = {};
let online = null;       // null = mai contattato
let busy = false;

/* ------------------------------------------------------------------ */
/* Outbox persistente                                                  */
/* ------------------------------------------------------------------ */

function loadOutbox() {
  try {
    const raw = JSON.parse(localStorage.getItem(K_OUTBOX) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveOutbox(list) {
  try {
    localStorage.setItem(K_OUTBOX, JSON.stringify(list.slice(-MAX_OUTBOX)));
  } catch { /* quota: al peggio si perde la coda, non i dati locali */ }
}

// id univoco per operazione: la rimozione post-invio avviene per id sullo
// stato corrente di localStorage, mai su snapshot presi prima di un await
let qSeq = 0;
const qBase = Math.random().toString(36).slice(2);

function enqueue(op) {
  op.q = `${qBase}:${++qSeq}`;
  const box = loadOutbox();
  if (op.op === 'put') {
    // per le liste conta solo l'ultima versione: una sola PUT per tipo
    const i = box.findIndex((o) => o.op === 'put' && o.kind === op.kind);
    if (i >= 0) box.splice(i, 1);
  }
  if (op.op === 'logclear') {
    // uno svuotamento rende inutili gli append precedenti dello stesso device
    for (let i = box.length - 1; i >= 0; i--) {
      if ((box[i].op === 'logadd' || box[i].op === 'logclear') && box[i].id === op.id) box.splice(i, 1);
    }
  }
  box.push(op);
  saveOutbox(box);
}

function removeFromOutbox(q) {
  const box = loadOutbox();
  const i = box.findIndex((o) => o.q === q);
  if (i >= 0) {
    box.splice(i, 1);
    saveOutbox(box);
  }
}

/** Modifica locale di una lista da propagare al server. */
export function queuePush(kind) { // 'devices' | 'commands'
  enqueue({ op: 'put', kind });
  kick();
}

/** Nuova voce di log locale da propagare al server. */
export function queueLogAppend(deviceId, entry) {
  enqueue({ op: 'logadd', id: deviceId, entry });
  kick();
}

/** Svuotamento log da propagare al server. */
export function queueLogClear(deviceId) {
  enqueue({ op: 'logclear', id: deviceId });
  kick();
}

/* ------------------------------------------------------------------ */
/* Rete                                                                */
/* ------------------------------------------------------------------ */

async function api(path, method = 'GET', body = undefined) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function setOnline(v) {
  if (online === v) return;
  online = v;
  emit('ch:sync', { online: v });
}

export function isOnline() {
  return online === true;
}

async function flushOutbox() {
  // ricarica lo stato a ogni giro: durante gli await possono arrivare
  // nuove operazioni (mai lavorare su snapshot attraverso un await)
  for (;;) {
    const box = loadOutbox();
    if (box.length === 0) return;
    const op = box[0];
    try {
      let res;
      if (op.op === 'put') {
        const list = op.kind === 'devices' ? hooks.getDevices() : hooks.getCommands();
        res = await api(op.kind, 'PUT', list);
        lastStateRev = res.rev; // eco della propria scrittura: niente ri-fetch
      } else if (op.op === 'logadd') {
        res = await api(`log/${op.id}`, 'POST', op.entry);
        lastLogRevs[op.id] = res.rev;
      } else if (op.op === 'logclear') {
        res = await api(`log/${op.id}`, 'DELETE');
        lastLogRevs[op.id] = res.rev;
      } else if (op.op === 'logput') {
        res = await api(`log/${op.id}`, 'PUT', op.entries);
        lastLogRevs[op.id] = res.rev;
      }
    } catch (e) {
      // un rifiuto definitivo (4xx) non guarirà mai da solo: scartare
      // l'operazione, altrimenti resta in testa e blocca l'intera coda
      if (e && e.status >= 400 && e.status < 500) {
        console.warn('Sync: operazione rifiutata dal server, scartata.', op.op, e.status);
        removeFromOutbox(op.q);
        continue;
      }
      throw e; // errore di rete/5xx: si riprova al prossimo ciclo
    }
    removeFromOutbox(op.q);
  }
}

function watchedLogId() {
  const m = /^#\/log\/([a-f0-9]{16})$/.exec(location.hash);
  return m ? m[1] : null;
}

async function poll() {
  if (busy || !hooks) return;
  busy = true;
  try {
    await flushOutbox();
    const state = await api('state');
    setOnline(true);
    if (state.rev !== lastStateRev) {
      lastStateRev = state.rev;
      hooks.applyState(state.devices, state.commands);
    }
    // il log viene scaricato solo per la pagina attualmente aperta
    const logId = watchedLogId();
    if (logId !== null) {
      const serverRev = (state.logRevs || {})[logId] || 0;
      if (serverRev !== (lastLogRevs[logId] || -1)) {
        const log = await api(`log/${logId}`);
        lastLogRevs[logId] = log.rev;
        hooks.applyLog(logId, log.entries);
      }
    }
  } catch {
    setOnline(false);
  } finally {
    busy = false;
  }
}

/** Sollecita un ciclo di sync appena possibile (senza aspettare il timer). */
export function kick() {
  Promise.resolve().then(poll);
}

/* ------------------------------------------------------------------ */
/* Avvio                                                               */
/* ------------------------------------------------------------------ */

export async function initSync(h) {
  hooks = h;
  // primo contatto: se il server è vuoto e in locale ci sono dati,
  // il locale fa da seme (migrazione dalla versione senza sync)
  try {
    const state = await api('state');
    setOnline(true);
    const serverEmpty = state.devices.length === 0 && state.commands.length === 0;
    const localDevices = hooks.getDevices();
    if (serverEmpty && localDevices.length > 0) {
      enqueue({ op: 'put', kind: 'devices' });
      enqueue({ op: 'put', kind: 'commands' });
      for (const d of localDevices) {
        const entries = hooks.getLog(d.id);
        if (entries.length) enqueue({ op: 'logput', id: d.id, entries: entries.slice() });
      }
      await flushOutbox();
    } else {
      lastStateRev = state.rev;
      hooks.applyState(state.devices, state.commands);
    }
  } catch {
    setOnline(false);
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  // il cambio pagina può aprire un log: va scaricato subito
  window.addEventListener('hashchange', kick);
}
