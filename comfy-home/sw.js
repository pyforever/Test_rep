/* Comfy home — service worker.
 *
 * Strategia stale-while-revalidate: risponde subito dalla cache (offline e
 * velocità) ma aggiorna la cache dalla rete a ogni richiesta, così un deploy
 * nuovo viene raccolto al caricamento successivo senza dover modificare
 * questo file.
 */

const CACHE = 'comfy-home-v8';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/main.js',
  './js/ui.js',
  './js/crypto.js',
  './js/storage.js',
  './js/connection.js',
  './js/sync.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return; // la sincronizzazione non si cache-a mai
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit); // offline: resta valida la copia in cache
      if (hit) {
        e.waitUntil(refresh.catch(() => {})); // aggiorna in background
        return hit;
      }
      return refresh;
    }),
  );
});
