/* Serveur de synchronisation de « Liste de courses » — moteur Node.
 *
 * Node seul, aucune dépendance. Un espace = un fichier JSON contenant le
 * document et un journal des dernières opérations. Les clients envoient des
 * opérations ciblées et récupèrent celles des autres depuis leur position.
 *
 *   node serveur/serveur.js --port 8787 --donnees ./donnees [--statique .]
 *
 * Les règles elles-mêmes vivent dans routes.js, partagé avec le déploiement
 * Cloudflare (worker/). Ce fichier ne fait que traduire : une requête HTTP de
 * Node vers la forme attendue, un fichier vers le magasin, et retour.
 *
 * Sans comptes : chaque espace a une clé secrète, transmise en Bearer.
 * Qui a la clé accède à l'espace. C'est le compromis assumé de cette étape.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('node:crypto');

// routes.js n'utilise que WebCrypto, commun à Node et à Workers. Le global
// n'existe qu'à partir de Node 19 : on le pose nous-mêmes en dessous, plutôt
// que d'avoir deux implémentations de l'empreinte à garder d'accord.
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = nodeCrypto.webcrypto;

const routes = require('./routes.js');

const args = process.argv.slice(2);
const opt = function (nom, defaut) {
  const i = args.indexOf('--' + nom);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
};
const PORT = Number(opt('port', process.env.PORT || 8787));
const HOTE = opt('hote', process.env.HOST || '0.0.0.0');
const DONNEES = path.resolve(opt('donnees', './donnees'));
const STATIQUE = opt('statique', null) ? path.resolve(opt('statique')) : null;

const TAILLE_MAX = routes.TAILLE_MAX;

fs.mkdirSync(DONNEES, { recursive: true });

/* ——— Magasin : un fichier JSON par espace ————————————————————————————————— */

const fichierEspace = function (id) { return path.join(DONNEES, id + '.json'); };

const magasin = {
  async lire(id) {
    try { return JSON.parse(fs.readFileSync(fichierEspace(id), 'utf8')); }
    catch (e) { return null; }
  },
  async ecrire(id, espace) {
    const tmp = fichierEspace(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(espace));
    fs.renameSync(tmp, fichierEspace(id));   // remplacement atomique
  },
};

// Une file d'attente par espace : deux requêtes simultanées ne doivent pas
// écraser mutuellement leur écriture. C'est ce que le Durable Object donne
// gratuitement côté Cloudflare ; ici il faut le tenir à la main.
const files = new Map();
function enFile(id, tache) {
  if (!id) return Promise.resolve().then(tache);
  const precedent = files.get(id) || Promise.resolve();
  const suivant = precedent.then(tache, tache);
  files.set(id, suivant.catch(function () {}));
  return suivant;
}

/* ——— Utilitaires HTTP ——————————————————————————————————————————————————— */

const ENTETES_COMMUNES = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

const TYPE_REPONSE = {
  json: 'application/json; charset=utf-8',
  texte: 'text/plain; charset=utf-8',
  ics: 'text/calendar; charset=utf-8',
};

function envoyer(res, reponse) {
  const corps = reponse.type === 'json' ? JSON.stringify(reponse.corps)
    : String(reponse.corps) + (reponse.type === 'texte' ? '\n' : '');
  const entetes = Object.assign({ 'Content-Type': TYPE_REPONSE[reponse.type] }, ENTETES_COMMUNES);
  // Un calendrier abonné se relit souvent : il ne doit pas être figé par un
  // cache, mais « no-store » ferait re-télécharger sans condition.
  if (reponse.type === 'ics') entetes['Cache-Control'] = 'no-cache';
  res.writeHead(reponse.code, entetes);
  res.end(corps);
}

function lireCorps(req) {
  return new Promise(function (resoudre, rejeter) {
    let total = 0;
    const morceaux = [];
    req.on('data', function (m) {
      total += m.length;
      if (total > TAILLE_MAX) { rejeter(new Error('corps trop volumineux')); req.destroy(); return; }
      morceaux.push(m);
    });
    req.on('end', function () { resoudre(Buffer.concat(morceaux).toString('utf8')); });
    req.on('error', rejeter);
  });
}

function cleFournie(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function origineDe(req) {
  const hote = req.headers.host || ('localhost:' + PORT);
  const protocole = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.encrypted ? 'https' : 'http');
  return protocole + '://' + hote;
}

/** L'espace visé, pour savoir dans quelle file d'attente ranger la requête. */
function espaceVise(chemin, corpsTexte) {
  const m = chemin.match(/^\/api\/espaces\/([^/]+)(?:\/|$)/);
  if (m) return m[1];
  if (chemin === '/api/espaces' && corpsTexte) {
    // Reconstruction : l'identifiant est dans le corps, pas dans l'adresse.
    try { return JSON.parse(corpsTexte).id || null; } catch (e) { return null; }
  }
  return null;
}

/* ——— Fichiers statiques (facultatif) ————————————————————————————————————— */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function servirStatique(req, res) {
  if (!STATIQUE) { envoyer(res, { code: 404, type: 'json', corps: { erreur: 'introuvable' } }); return; }
  let chemin = decodeURIComponent((req.url || '/').split('?')[0]);
  if (chemin === '/') chemin = '/index.html';
  const cible = path.join(STATIQUE, chemin);
  if (!cible.startsWith(STATIQUE + path.sep) && cible !== STATIQUE) {
    envoyer(res, { code: 403, type: 'json', corps: { erreur: 'refusé' } }); return;
  }
  fs.stat(cible, function (err, st) {
    if (err || !st.isFile()) { envoyer(res, { code: 404, type: 'json', corps: { erreur: 'introuvable' } }); return; }
    // Le service worker ne doit jamais être servi depuis un cache HTTP long,
    // sinon les mises à jour n'arrivent plus.
    const cache = /sw\.js$/.test(cible) ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(cible)] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(cible).pipe(res);
  });
}

/* ——— Aiguillage ————————————————————————————————————————————————————————— */

const serveur = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const chemin = url.pathname;

  if (!chemin.startsWith('/api/')) {
    if (req.method === 'OPTIONS') { envoyer(res, { code: 204, type: 'json', corps: {} }); return; }
    servirStatique(req, res);
    return;
  }

  lireCorps(req).then(function (corpsTexte) {
    const requete = {
      methode: req.method, chemin: chemin, parametres: url.searchParams,
      cle: cleFournie(req), corpsTexte: corpsTexte, origine: origineDe(req),
    };
    // Lire puis écrire doit être indivisible pour un espace donné : on range
    // tout le traitement dans la file de cet espace.
    return enFile(espaceVise(chemin, corpsTexte), function () {
      return routes.traiter(requete, magasin);
    });
  }).then(function (reponse) {
    if (!reponse) { servirStatique(req, res); return; }
    envoyer(res, reponse);
  }).catch(function (e) {
    envoyer(res, { code: 400, type: 'json', corps: { erreur: e.message } });
  });
});

/**
 * Le dossier des données est-il sur le même système de fichiers que la racine ?
 * Si oui, c'est presque toujours le disque du conteneur : il repart à zéro au
 * redéploiement, et les espaces avec lui. On ne peut pas l'affirmer — un VPS
 * ordinaire est dans ce cas sans rien risquer — donc on prévient, sans bloquer.
 */
function disqueProbablementEphemere() {
  try { return fs.statSync(DONNEES).dev === fs.statSync('/').dev; }
  catch (e) { return false; }
}

serveur.listen(PORT, HOTE, function () {
  console.log('Synchronisation à l\'écoute sur http://' + HOTE + ':' + PORT);
  console.log('  données  : ' + DONNEES);
  console.log('  statique : ' + (STATIQUE || '(aucun)'));
  const existants = (function () {
    try { return fs.readdirSync(DONNEES).filter(function (f) { return /\.json$/.test(f); }).length; }
    catch (e) { return 0; }
  })();
  console.log('  espaces  : ' + existants);
  if (disqueProbablementEphemere()) {
    console.warn('');
    console.warn('  ⚠  ' + DONNEES + ' est sur le disque du conteneur.');
    console.warn('     Sur un hébergeur au système de fichiers éphémère, les espaces');
    console.warn('     disparaissent au prochain déploiement. Montez-y un volume,');
    console.warn('     ou déployez sur Cloudflare (voir serveur/LISEZMOI.md).');
    console.warn('');
  }
});
