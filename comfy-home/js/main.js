/**
 * Comfy home — applicazione principale (router + viste).
 */

import { cryptoBackendName, runSelfTest } from './crypto.js';
import * as store from './storage.js';
import { syncLinks, getLink, linkState } from './connection.js';
import { el, clear, toast, statusBadge, applyStatus, connDot, applyConn, fmtDateTime } from './ui.js';

const view = document.getElementById('view');

/* ------------------------------------------------------------------ */
/* Hero (SVG statico, nessun dato dinamico)                            */
/* ------------------------------------------------------------------ */

const HERO_SVG = `
<svg viewBox="0 0 800 340" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Alba serena sulle colline">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fde8c8"/><stop offset=".55" stop-color="#f8d3a5"/><stop offset="1" stop-color="#f2b98c"/>
    </linearGradient>
    <linearGradient id="h1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d9a878"/><stop offset="1" stop-color="#c98f63"/>
    </linearGradient>
    <linearGradient id="h2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b97f56"/><stop offset="1" stop-color="#a86f4b"/>
    </linearGradient>
    <radialGradient id="sun" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#fff3d6"/><stop offset=".6" stop-color="#ffd98a"/><stop offset="1" stop-color="#ffd98a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="800" height="340" fill="url(#sky)"/>
  <circle cx="545" cy="150" r="115" fill="url(#sun)"/>
  <circle cx="545" cy="150" r="46" fill="#ffe9b3"/>
  <path d="M0 250 Q 190 165 400 235 T 800 225 V 340 H 0 Z" fill="url(#h1)"/>
  <path d="M0 295 Q 230 225 470 285 T 800 280 V 340 H 0 Z" fill="url(#h2)" opacity=".95"/>
  <g transform="translate(345 212)">
    <rect x="-34" y="0" width="68" height="46" rx="3" fill="#f7ead6"/>
    <path d="M-44 4 L0 -30 L44 4 Z" fill="#b96b4a"/>
    <rect x="-9" y="18" width="18" height="28" rx="2" fill="#a86f4b"/>
    <rect x="-27" y="12" width="13" height="13" rx="2" fill="#ffe9b3"/>
    <rect x="14" y="12" width="13" height="13" rx="2" fill="#ffe9b3"/>
  </g>
  <g fill="#fdf6ec" opacity=".8">
    <ellipse cx="130" cy="72" rx="46" ry="13"/><ellipse cx="168" cy="62" rx="30" ry="10"/>
    <ellipse cx="660" cy="55" rx="52" ry="13"/><ellipse cx="700" cy="46" rx="30" ry="9"/>
  </g>
</svg>`;

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function route() {
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\//, '').split('/').filter(Boolean);
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === (parts[0] ? `#/${parts[0]}` : '#/'));
  });
  clear(view);
  switch (parts[0]) {
    case undefined: renderHome(); break;
    case 'devices': renderDevices(); break;
    case 'commands': renderCommands(); break;
    case 'log':
      if (parts[1]) renderDeviceLog(parts[1]);
      else renderLogIndex();
      break;
    default: renderHome();
  }
  view.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */

function renderHome() {
  const devices = store.getDevices();
  const commands = store.getCommands();
  const connected = devices.filter((d) => linkState(d.id).connected).length;

  const hero = el('section', { class: 'hero' });
  hero.innerHTML = HERO_SVG; // markup statico costante
  hero.append(
    el('div', { class: 'hero-text' },
      el('h1', {}, 'Comfy home'),
      el('p', {}, 'La tua casa, serena e connessa.')),
  );

  const stats = el('section', { class: 'cards' },
    statCard(String(devices.length), 'Dispositivi configurati', '#/devices'),
    statCard(String(commands.length), 'Comandi salvati', '#/commands'),
    statCard(`${connected}/${devices.length}`, 'Dispositivi connessi', '#/devices'),
  );

  const info = el('section', { class: 'panel soft' },
    el('h2', {}, 'Benvenuto'),
    el('p', {}, 'Comfy home invia comandi cifrati ai tuoi dispositivi ESP8266 ed ESP32 e resta in ascolto delle loro trasmissioni.'),
    el('p', { class: 'muted' }, `Cifratura: ${cryptoBackendName()}`),
  );

  view.append(hero, stats, info);
}

function statCard(value, label, href) {
  return el('a', { class: 'card stat', href },
    el('span', { class: 'stat-value' }, value),
    el('span', { class: 'stat-label' }, label));
}

/* ------------------------------------------------------------------ */
/* Dispositivi                                                         */
/* ------------------------------------------------------------------ */

function renderDevices() {
  const head = el('div', { class: 'page-head' },
    el('h1', {}, 'Dispositivi'),
    el('button', { class: 'btn primary', onclick: () => openDeviceForm(null) }, '+ Aggiungi dispositivo'));

  const formHost = el('div', { id: 'device-form-host' });
  const list = el('div', { class: 'stack', id: 'device-list' });
  view.append(head, formHost, list);
  paintDeviceList();
}

function paintDeviceList() {
  const list = document.getElementById('device-list');
  if (!list) return;
  clear(list);
  const devices = store.getDevices();
  if (devices.length === 0) {
    list.append(el('p', { class: 'empty' }, 'Nessun dispositivo configurato. Aggiungine uno per iniziare.'));
    return;
  }
  for (const d of devices) {
    const st = linkState(d.id);
    list.append(
      el('div', { class: 'card row' },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' },
            connDot(d.id, st.connected),
            el('strong', {}, d.name),
            statusBadge(d.id, st.status)),
          el('div', { class: 'muted mono' }, `${d.host}:${d.port}`),
          el('div', { class: 'muted small' }, `Timeout conferma: ${d.timeout} s`)),
        el('div', { class: 'row-actions' },
          el('button', { class: 'btn', onclick: () => openDeviceForm(d) }, 'Modifica'),
          el('a', { class: 'btn', href: `#/log/${d.id}` }, 'Log'),
          el('button', {
            class: 'btn danger',
            onclick: () => {
              if (confirm(`Eliminare "${d.name}"? Verranno rimossi anche i suoi comandi e il log.`)) {
                store.deleteDevice(d.id);
                syncLinks(store.getDevices());
                paintDeviceList();
                toast('Dispositivo eliminato.');
              }
            },
          }, 'Elimina'))),
    );
  }
}

function openDeviceForm(device) {
  const host = document.getElementById('device-form-host');
  if (!host) return;
  clear(host);
  const isNew = !device;
  const d = device || { name: '', host: '', port: '', key: '', timeout: 5 };

  const errBox = el('div', { class: 'errors' });
  const fName = field('Nome dispositivo', 'text', d.name, { maxlength: 32, placeholder: 'es. Caldaia' });
  const fHost = field('Indirizzo IP / host', 'text', d.host, { maxlength: 253, placeholder: 'es. 192.168.1.50', inputmode: 'decimal' });
  const fPort = field('Porta', 'number', d.port, { min: 1, max: 65535, placeholder: 'es. 81' });
  const fKey = field('Chiave di cifratura', 'password', d.key, { maxlength: 128, placeholder: 'minimo 8 caratteri', autocomplete: 'off' });
  const fTimeout = field('Timeout conferma (secondi)', 'number', d.timeout, { min: 1, max: 120, step: 1 });

  const showKey = el('label', { class: 'inline-check' },
    el('input', {
      type: 'checkbox',
      onchange: (e) => { fKey.input.type = e.target.checked ? 'text' : 'password'; },
    }),
    ' Mostra chiave');

  const form = el('form', {
    class: 'panel form',
    novalidate: true, // validazione gestita in JS: tutti gli errori mostrati insieme
    onsubmit: (e) => {
      e.preventDefault();
      const data = {
        id: isNew ? store.newId() : d.id,
        name: fName.input.value.trim(),
        host: fHost.input.value.trim(),
        port: Number(fPort.input.value),
        key: fKey.input.value,
        timeout: Number(fTimeout.input.value),
      };
      const errors = store.validateDeviceInput(data);
      clear(errBox);
      if (errors.length) {
        errors.forEach((msg) => errBox.append(el('p', {}, msg)));
        return;
      }
      if (!store.saveDevice(data)) {
        toast('Salvataggio non riuscito (spazio esaurito?).', 'error');
        return;
      }
      syncLinks(store.getDevices());
      clear(host);
      paintDeviceList();
      toast(isNew ? 'Dispositivo aggiunto.' : 'Dispositivo aggiornato.');
    },
  },
  el('h2', {}, isNew ? 'Nuovo dispositivo' : `Modifica: ${d.name}`),
  fName.wrap, fHost.wrap, fPort.wrap, fKey.wrap, showKey, fTimeout.wrap, errBox,
  el('div', { class: 'form-actions' },
    el('button', { class: 'btn primary', type: 'submit' }, 'Salva'),
    el('button', { class: 'btn', type: 'button', onclick: () => clear(host) }, 'Annulla')));

  host.append(form);
  fName.input.focus();
}

function field(labelText, type, value, extra = {}) {
  const input = el('input', { type, value: value ?? '', ...extra });
  const wrap = el('label', { class: 'field' }, el('span', {}, labelText), input);
  return { wrap, input };
}

/* ------------------------------------------------------------------ */
/* Comandi                                                             */
/* ------------------------------------------------------------------ */

function renderCommands() {
  const head = el('div', { class: 'page-head' },
    el('h1', {}, 'Comandi'),
    el('button', { class: 'btn primary', onclick: () => openCommandForm(null) }, '+ Nuovo comando'));
  const formHost = el('div', { id: 'command-form-host' });
  const list = el('div', { class: 'stack', id: 'command-list' });
  view.append(head, formHost, list);
  paintCommandList();
}

function paintCommandList() {
  const list = document.getElementById('command-list');
  if (!list) return;
  clear(list);
  const commands = store.getCommands();
  const devices = new Map(store.getDevices().map((d) => [d.id, d]));
  if (commands.length === 0) {
    list.append(el('p', { class: 'empty' }, 'Nessun comando salvato. Creane uno con "+ Nuovo comando".'));
    return;
  }
  for (const c of commands) {
    const dev = devices.get(c.deviceId);
    const st = dev ? linkState(dev.id) : { connected: false, status: 'idle' };
    const commandString = store.buildCommandString(c.params);

    const sendBtn = el('button', {
      class: 'btn primary send',
      dataset: dev ? { sendDev: dev.id } : {},
      disabled: !dev || st.status === 'pending',
      onclick: async () => {
        if (!dev) return;
        const link = getLink(dev.id);
        if (!link) return;
        setSendDisabled(dev.id, true);
        await link.sendCommand(commandString);
      },
    }, 'Send');

    list.append(
      el('div', { class: 'card row' },
        el('div', { class: 'row-icon' },
          c.icon
            ? el('img', { src: c.icon, alt: '', class: 'cmd-icon' })
            : el('span', { class: 'cmd-icon placeholder', 'aria-hidden': 'true' }, '⌂')),
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' },
            el('strong', {}, c.label),
            dev ? connDot(dev.id, st.connected) : null,
            el('span', { class: 'muted' }, dev ? dev.name : 'dispositivo eliminato'),
            dev ? statusBadge(dev.id, st.status) : null),
          el('code', { class: 'cmd-string' }, commandString)),
        el('div', { class: 'row-actions' },
          sendBtn,
          el('button', { class: 'btn', onclick: () => openCommandForm(c) }, 'Modifica'),
          el('button', {
            class: 'btn danger',
            onclick: () => {
              if (confirm(`Eliminare il comando "${c.label}"?`)) {
                store.deleteCommand(c.id);
                paintCommandList();
                toast('Comando eliminato.');
              }
            },
          }, 'Elimina'))),
    );
  }
}

function setSendDisabled(deviceId, disabled) {
  document.querySelectorAll(`[data-send-dev="${CSS.escape(deviceId)}"]`)
    .forEach((b) => { b.disabled = disabled; });
}

function openCommandForm(command) {
  const host = document.getElementById('command-form-host');
  if (!host) return;
  clear(host);
  const devices = store.getDevices();
  if (devices.length === 0) {
    toast('Configura prima un dispositivo.', 'error');
    location.hash = '#/devices';
    return;
  }
  const isNew = !command;
  const c = command || { deviceId: devices[0].id, label: '', params: [''], icon: '' };
  let icon = c.icon || '';

  const errBox = el('div', { class: 'errors' });

  const select = el('select', { class: 'input' },
    ...devices.map((d) => el('option', { value: d.id, selected: d.id === c.deviceId }, d.name)));
  const selWrap = el('label', { class: 'field' }, el('span', {}, 'Dispositivo target'), select);

  const fLabel = field('Descrizione comando', 'text', c.label, { maxlength: 40, placeholder: 'es. Accendi luce salotto' });

  // --- icona dalla gallery ---
  const preview = el('img', { class: 'cmd-icon preview', alt: 'Anteprima icona' });
  if (icon) preview.src = icon; else preview.style.display = 'none';
  const fileInput = el('input', {
    type: 'file', accept: 'image/*', class: 'file-input',
    onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        icon = await store.fileToIcon(f);
        preview.src = icon;
        preview.style.display = '';
      } catch (err) {
        toast(err.message, 'error');
        e.target.value = '';
      }
    },
  });
  const iconWrap = el('div', { class: 'field' },
    el('span', {}, 'Icona (dalla gallery)'),
    el('div', { class: 'icon-row' }, preview, fileInput));

  // --- parametri ---
  const paramsBox = el('div', { class: 'params' });
  const previewStr = el('code', { class: 'cmd-string preview-str' });

  function refreshPreview() {
    const params = paramInputs().map((i) => i.value.trim()).filter((v) => v.length > 0);
    previewStr.textContent = params.length ? store.buildCommandString(params) : '—';
  }
  function paramInputs() {
    return Array.from(paramsBox.querySelectorAll('input'));
  }
  function addParamField(value = '') {
    const input = el('input', {
      type: 'text', value, maxlength: 64,
      placeholder: `Parametro ${paramsBox.children.length + 1}`,
      oninput: refreshPreview,
    });
    const row = el('div', { class: 'param-row' },
      input,
      el('button', {
        class: 'btn small danger', type: 'button', title: 'Rimuovi parametro',
        onclick: () => {
          if (paramsBox.children.length > 1) { row.remove(); refreshPreview(); }
        },
      }, '−'));
    paramsBox.append(row);
    return input;
  }
  c.params.forEach((p) => addParamField(p));
  refreshPreview();

  const addBtn = el('button', {
    class: 'btn', type: 'button',
    onclick: () => {
      if (paramsBox.children.length >= 16) { toast('Massimo 16 parametri.', 'error'); return; }
      addParamField().focus();
    },
  }, '+ Inserisci parametro');

  const form = el('form', {
    class: 'panel form',
    novalidate: true,
    onsubmit: (e) => {
      e.preventDefault();
      const params = paramInputs().map((i) => i.value.trim()).filter((v) => v.length > 0);
      clear(errBox);
      const errors = [];
      const label = fLabel.input.value.trim();
      if (!label || label.length > 40) errors.push('Descrizione: da 1 a 40 caratteri.');
      if (params.length === 0) errors.push('Inserire almeno un parametro.');
      const bad = params.filter((p) => !store.validateParam(p));
      if (bad.length) errors.push(`Parametri non validi (vietati "|", "$" e caratteri di controllo): ${bad.join(', ')}`);
      if (errors.length) {
        errors.forEach((m) => errBox.append(el('p', {}, m)));
        return;
      }
      const data = {
        id: isNew ? store.newId() : c.id,
        deviceId: select.value,
        label,
        params,
        icon,
      };
      if (!store.saveCommand(data)) {
        toast('Salvataggio non riuscito.', 'error');
        return;
      }
      clear(host);
      paintCommandList();
      toast(isNew ? 'Comando salvato.' : 'Comando aggiornato.');
    },
  },
  el('h2', {}, isNew ? 'Nuovo comando' : `Modifica: ${c.label}`),
  selWrap, fLabel.wrap, iconWrap,
  el('div', { class: 'field' }, el('span', {}, 'Parametri (concatenati con "|", terminati da "$")'), paramsBox),
  addBtn,
  el('div', { class: 'field' }, el('span', {}, 'Stringa risultante'), previewStr),
  errBox,
  el('div', { class: 'form-actions' },
    el('button', { class: 'btn primary', type: 'submit' }, 'Conferma'),
    el('button', { class: 'btn', type: 'button', onclick: () => clear(host) }, 'Annulla')));

  host.append(form);
  fLabel.input.focus();
}

/* ------------------------------------------------------------------ */
/* Log                                                                 */
/* ------------------------------------------------------------------ */

function renderLogIndex() {
  view.append(el('div', { class: 'page-head' }, el('h1', {}, 'Log')));
  const devices = store.getDevices();
  if (devices.length === 0) {
    view.append(el('p', { class: 'empty' }, 'Nessun dispositivo configurato.'));
    return;
  }
  const list = el('div', { class: 'stack' });
  for (const d of devices) {
    const entries = store.getLog(d.id);
    list.append(el('a', { class: 'card row link', href: `#/log/${d.id}` },
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title' }, connDot(d.id, linkState(d.id).connected), el('strong', {}, d.name)),
        el('div', { class: 'muted small' }, `${entries.length} voci di log`)),
      el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›')));
  }
  view.append(list);
}

const KIND_LABEL = {
  tx: ['→ Inviato', 'k-tx'],
  rx: ['← Ricevuto', 'k-rx'],
  ok: ['✓ Conferma', 'k-ok'],
  fail: ['✗ Errore', 'k-fail'],
  error: ['✗ Errore', 'k-fail'],
  info: ['ℹ Info', 'k-info'],
};

function renderDeviceLog(deviceId) {
  const d = store.getDevice(deviceId);
  if (!d) {
    view.append(el('p', { class: 'empty' }, 'Dispositivo non trovato.'),
      el('a', { class: 'btn', href: '#/log' }, '‹ Torna al log'));
    return;
  }
  view.append(
    el('div', { class: 'page-head' },
      el('h1', {}, `Log — ${d.name}`),
      el('div', { class: 'row-actions' },
        el('a', { class: 'btn', href: '#/log' }, '‹ Indietro'),
        el('button', {
          class: 'btn danger',
          onclick: () => {
            if (confirm(`Svuotare il log di "${d.name}"?`)) store.clearLog(d.id);
          },
        }, 'Svuota log'))),
    el('div', { id: 'log-table-host' }),
  );
  paintLogTable(deviceId);
}

function paintLogTable(deviceId) {
  const host = document.getElementById('log-table-host');
  if (!host) return;
  clear(host);
  const entries = store.getLog(deviceId);
  if (entries.length === 0) {
    host.append(el('p', { class: 'empty' }, 'Nessuna voce di log.'));
    return;
  }
  const table = el('table', { class: 'log-table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Data e ora'),
      el('th', {}, 'Tipo'),
      el('th', {}, 'Contenuto'))));
  const tbody = el('tbody');
  for (const entry of entries.slice().reverse()) {
    const [label, cls] = KIND_LABEL[entry.kind] || KIND_LABEL.info;
    tbody.append(el('tr', {},
      el('td', { class: 'mono small' }, fmtDateTime(entry.ts)),
      el('td', {}, el('span', { class: `kind ${cls}` }, label)),
      el('td', { class: 'mono small wrap' }, entry.text)));
  }
  table.append(tbody);
  host.append(table);
}

/* ------------------------------------------------------------------ */
/* Eventi live                                                         */
/* ------------------------------------------------------------------ */

document.addEventListener('ch:status', (e) => {
  const { deviceId, status } = e.detail;
  document.querySelectorAll(`[data-dev-status="${CSS.escape(deviceId)}"]`)
    .forEach((n) => applyStatus(n, status));
  if (status !== 'pending') setSendDisabled(deviceId, false);
});

document.addEventListener('ch:conn', (e) => {
  const { deviceId, connected } = e.detail;
  document.querySelectorAll(`[data-dev-conn="${CSS.escape(deviceId)}"]`)
    .forEach((n) => applyConn(n, connected));
});

document.addEventListener('ch:log', (e) => {
  const m = /^#\/log\/(.+)$/.exec(location.hash);
  if (m && m[1] === e.detail.deviceId) paintLogTable(e.detail.deviceId);
});

/* ------------------------------------------------------------------ */
/* Avvio                                                               */
/* ------------------------------------------------------------------ */

function init() {
  if (!runSelfTest()) {
    toast('Attenzione: auto-test crittografico fallito. Invio disabilitato.', 'error');
  }
  syncLinks(store.getDevices());
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline non critico */ });
  }
}

init();
