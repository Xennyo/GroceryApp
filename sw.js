/* Service worker de « Liste de courses ».
   Rôle : rendre l'application disponible hors ligne, et ne jamais imposer une
   mise à jour au milieu d'une session — la page décide quand basculer.
   Bump de VERSION à chaque livraison : c'est ce qui déclenche une réinstallation. */
'use strict';

const VERSION = 'v11';
const CACHE = 'liste-courses-' + VERSION;

const COQUILLE = [
  './',
  './index.html',
  './liste-courses.html',
  './manifest.webmanifest',
  './icone-180.png',
  './icone-192.png',
  './icone-512.png',
  './icone-maskable-512.png',
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (c) {
      // On n'échoue pas l'installation entière si une ressource secondaire manque.
      return Promise.all(COQUILLE.map(function (url) {
        return c.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    })
  );
  // Pas de skipWaiting ici : la page propose « Recharger » et décide.
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys()
      .then(function (noms) {
        return Promise.all(noms.filter(function (n) {
          return n !== CACHE && n.indexOf('liste-courses-') === 0;
        }).map(function (n) { return caches.delete(n); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (ev) {
  if (!ev.data) return;
  if (ev.data.type === 'ACTIVER') { self.skipWaiting(); return; }
  if (ev.data.type === 'CALENDRIER') {
    // On accuse réception : la page ne doit pas ouvrir l'adresse avant que le
    // fichier y soit, sans quoi elle tomberait sur un 404.
    const repondre = function (ok) {
      if (ev.ports && ev.ports[0]) ev.ports[0].postMessage({ ok: ok });
    };
    ev.waitUntil(
      caches.open(CACHE).then(function (c) {
        return c.put(CHEMIN_CALENDRIER, new Response(ev.data.ics, {
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }));
      }).then(function () { repondre(true); }, function () { repondre(false); })
    );
  }
});

// Chemins que l'on accepte de servir depuis le cache. Tout le reste passe au
// réseau sans être intercepté : la synchronisation ne doit jamais être servie
// depuis un cache, et « sw.js » surtout pas — un service worker qui se met
// lui-même en cache peut geler les mises à jour pour de bon.
const CHEMINS_COQUILLE = new Set(COQUILLE.map(function (u) {
  return new URL(u, self.location).pathname;
}));

/* Le plan de repas, servi avec son vrai type MIME.
   iOS n'ajoute au calendrier qu'un fichier qu'il OUVRE en « text/calendar » :
   le menu de partage ne propose pas Calendrier, et un blob fabriqué dans la
   page n'a pas toujours un type que le système reconnaît. La page dépose donc
   le fichier ici, et le service worker le sert comme le ferait un serveur. */
const CHEMIN_CALENDRIER = new URL('./repas.ics', self.location).pathname;

self.addEventListener('fetch', function (ev) {
  const req = ev.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Avant tout le reste : c'est une navigation, mais elle ne doit pas passer
  // par le réseau — le fichier n'existe que dans le cache.
  if (url.pathname === CHEMIN_CALENDRIER) {
    ev.respondWith(
      caches.open(CACHE)
        .then(function (c) { return c.match(CHEMIN_CALENDRIER); })
        .then(function (r) {
          return r || new Response('Aucun plan de repas à ajouter.', {
            status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        })
    );
    return;
  }

  if (req.mode === 'navigate') {
    ev.respondWith(
      fetch(req)
        .then(function (rep) {
          const copie = rep.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copie); });
          return rep;
        })
        .catch(function () {
          return caches.match(req).then(function (r) {
            return r || caches.match('./liste-courses.html');
          });
        })
    );
    return;
  }

  if (!CHEMINS_COQUILLE.has(url.pathname)) return;

  ev.respondWith(
    caches.match(req).then(function (enCache) {
      if (enCache) return enCache;
      return fetch(req).then(function (rep) {
        if (rep && rep.ok && rep.type === 'basic') {
          const copie = rep.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copie); });
        }
        return rep;
      });
    })
  );
});
