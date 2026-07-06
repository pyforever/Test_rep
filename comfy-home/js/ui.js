/**
 * Comfy home — helper DOM.
 *
 * Regola di sicurezza: il contenuto dinamico (nomi, comandi, log, ecc.)
 * entra nel DOM SOLO tramite textContent/attributi impostati via API,
 * mai tramite innerHTML. innerHTML è ammesso esclusivamente per template
 * statici costanti definiti nel codice.
 */

/**
 * Crea un elemento: el('div', { class: 'card', dataset: {...} }, child1, 'testo', ...)
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    } else if (k === 'class') {
      node.className = v;
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Bus eventi dell'app: unico punto di emissione degli eventi "ch:*". */
export function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Mostra una lista di errori di validazione in un contenitore dedicato. */
export function showErrors(box, errors) {
  clear(box);
  for (const msg of errors) box.append(el('p', {}, msg));
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer = 0;

export function toast(message, kind = 'info') {
  let host = document.getElementById('toast');
  if (!host) {
    host = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  host.textContent = message;
  host.className = `toast toast-${kind} toast-show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.className = 'toast'; }, 4000);
}

/* ------------------------------------------------------------------ */
/* Indicatori di stato                                                 */
/* ------------------------------------------------------------------ */

/**
 * Indicatore esito comando accanto al nome del device:
 * ✓ verde (conferma corretta), ✗ rossa (errore/timeout), ⏳ in attesa.
 */
export function statusBadge(deviceId, status = 'idle') {
  const b = el('span', {
    class: 'status-badge',
    dataset: { devStatus: deviceId },
    role: 'img',
  });
  applyStatus(b, status);
  return b;
}

export function applyStatus(node, status) {
  const map = {
    ok: ['✓', 'Conferma ricevuta', 'st-ok'],
    fail: ['✗', 'Errore o timeout', 'st-fail'],
    pending: ['…', 'In attesa di conferma', 'st-pending'],
    idle: ['', '', 'st-idle'],
  };
  const [glyph, label, cls] = map[status] || map.idle;
  node.textContent = glyph;
  node.setAttribute('aria-label', label);
  node.title = label;
  node.className = `status-badge ${cls}`;
}

/** Pallino stato connessione WebSocket. */
export function connDot(deviceId, connected) {
  const d = el('span', { dataset: { devConn: deviceId } });
  applyConn(d, connected);
  return d;
}

export function applyConn(node, connected) {
  node.className = `conn-dot ${connected ? 'conn-on' : 'conn-off'}`;
  node.title = connected ? 'Connesso' : 'Non connesso';
}

// formattatori cachati: crearli per ogni riga di log costerebbe ~10x
const DATE_FMT = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Formatta data e ora per il log (locale it). */
export function fmtDateTime(ts) {
  return `${DATE_FMT.format(ts)} ${TIME_FMT.format(ts)}`;
}
