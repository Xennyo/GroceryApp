/* Serveur de synchronisation de « Liste de courses ».
 *
 * Node seul, aucune dépendance. Un espace = un fichier JSON contenant le
 * document et un journal des dernières opérations. Les clients envoient des
 * opérations ciblées et récupèrent celles des autres depuis leur position.
 *
 *   node serveur/serveur.js --port 8787 --donnees ./donnees [--statique .]
 *
 * Sans comptes : chaque espace a une clé secrète, transmise en Bearer.
 * Qui a la clé accède à l'espace. C'est le compromis assumé de cette étape.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = function (nom, defaut) {
  const i = args.indexOf('--' + nom);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
};
const PORT = Number(opt('port', process.env.PORT || 8787));
const HOTE = opt('hote', process.env.HOST || '0.0.0.0');
const DONNEES = path.resolve(opt('donnees', './donnees'));
const STATIQUE = opt('statique', null) ? path.resolve(opt('statique')) : null;

const TAILLE_MAX = 2 * 1024 * 1024;   // 2 Mo par requête
const JOURNAL_MAX = 500;              // opérations conservées pour le rattrapage

fs.mkdirSync(DONNEES, { recursive: true });

/* ——— Stockage ——————————————————————————————————————————————————————————— */

const ID_VALIDE = /^[a-z0-9]{16,40}$/;
const fichierEspace = function (id) { return path.join(DONNEES, id + '.json'); };

// Une file d'attente par espace : deux requêtes simultanées ne doivent pas
// écraser mutuellement leur écriture.
const files = new Map();
function enFile(id, tache) {
  const precedent = files.get(id) || Promise.resolve();
  const suivant = precedent.then(tache, tache);
  files.set(id, suivant.catch(function () {}));
  return suivant;
}

function lireEspace(id) {
  try { return JSON.parse(fs.readFileSync(fichierEspace(id), 'utf8')); }
  catch (e) { return null; }
}
function ecrireEspace(id, espace) {
  const tmp = fichierEspace(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(espace));
  fs.renameSync(tmp, fichierEspace(id));   // remplacement atomique
}

const empreinte = function (cle) { return crypto.createHash('sha256').update(String(cle)).digest('hex'); };
// Identifiant d'espace : exactement 16 caractères [a-z0-9]. On tire jusqu'à
// en avoir assez — filtrer sans compter produirait parfois un identifiant trop
// court, donc un espace créé mais inatteignable.
function identifiantEspace() {
  let sortie = '';
  while (sortie.length < 16) {
    sortie += crypto.randomBytes(24).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  return sortie.slice(0, 16);
}

/* ——— Utilitaires HTTP ——————————————————————————————————————————————————— */

/** Réponse en texte brut. Sert aux erreurs de l'abonnement, qui n'attend pas du JSON. */
function repondreTexte(res, code, message) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(message + '\n');
}

/** Un calendrier plausible, et pas trop gros. On ne stocke rien d'autre. */
function valideIcs(texte) {
  return typeof texte === 'string' &&
    texte.indexOf('BEGIN:VCALENDAR') === 0 &&
    texte.indexOf('END:VCALENDAR') > 0 &&
    Buffer.byteLength(texte) <= 512 * 1024;
}

/** Adresse d'abonnement, telle que le téléphone devra la demander. */
function adresseCalendrier(req, id, jeton) {
  const hote = req.headers.host || ('localhost:' + PORT);
  const protocole = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.encrypted ? 'https' : 'http');
  return protocole + '://' + hote + '/api/espaces/' + id + '/calendrier.ics?jeton=' + jeton;
}

function repondre(res, code, corps) {
  const texte = JSON.stringify(corps);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(texte);
}

/** Corps de la requête. En JSON par défaut, en texte brut si « brut ». */
function lireCorps(req, brut) {
  return new Promise(function (resoudre, rejeter) {
    let total = 0;
    const morceaux = [];
    req.on('data', function (m) {
      total += m.length;
      if (total > TAILLE_MAX) { rejeter(new Error('corps trop volumineux')); req.destroy(); return; }
      morceaux.push(m);
    });
    req.on('end', function () {
      if (brut) return resoudre(Buffer.concat(morceaux).toString('utf8'));
      if (!morceaux.length) return resoudre({});
      try { resoudre(JSON.parse(Buffer.concat(morceaux).toString('utf8'))); }
      catch (e) { rejeter(new Error('JSON invalide')); }
    });
    req.on('error', rejeter);
  });
}

function cleFournie(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/* ——— Fichiers statiques (facultatif) ————————————————————————————————————— */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function servirStatique(req, res) {
  if (!STATIQUE) { repondre(res, 404, { erreur: 'introuvable' }); return; }
  let chemin = decodeURIComponent((req.url || '/').split('?')[0]);
  if (chemin === '/') chemin = '/index.html';
  const cible = path.join(STATIQUE, chemin);
  if (!cible.startsWith(STATIQUE + path.sep) && cible !== STATIQUE) { repondre(res, 403, { erreur: 'refusé' }); return; }
  fs.stat(cible, function (err, st) {
    if (err || !st.isFile()) { repondre(res, 404, { erreur: 'introuvable' }); return; }
    // Le service worker ne doit jamais être servi depuis un cache HTTP long,
    // sinon les mises à jour n'arrivent plus.
    const cache = /sw\.js$/.test(cible) ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(cible)] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(cible).pipe(res);
  });
}

/* ——— Routes ————————————————————————————————————————————————————————————— */

const serveur = http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') { repondre(res, 204, {}); return; }

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const chemin = url.pathname;

  if (chemin === '/api/sante') { repondre(res, 200, { etat: 'ok', version: 1 }); return; }

  // Création d'un espace — ou reconstruction d'un espace perdu.
  if (chemin === '/api/espaces' && req.method === 'POST') {
    lireCorps(req).then(function (corps) {
      // Reconstruction : un appareil qui détient encore l'identifiant et la clé
      // d'un espace peut le recréer à l'identique. Connaître les deux, c'est
      // déjà y avoir accès — le lien de partage ne donne rien de plus. Les
      // liens déjà distribués continuent donc de fonctionner après une perte
      // de données côté serveur.
      const idVoulu = String((corps && corps.id) || '');
      const cleVoulue = String((corps && corps.cle) || '');
      let id, cle;
      if (idVoulu || cleVoulue) {
        if (!ID_VALIDE.test(idVoulu) || cleVoulue.length < 16) {
          repondre(res, 400, { erreur: 'identifiant ou clé invalide' });
          return null;
        }
        if (lireEspace(idVoulu)) {
          // Il existe déjà : rien à reconstruire, l'appareil n'a qu'à se
          // synchroniser normalement.
          repondre(res, 409, { erreur: 'cet espace existe déjà' });
          return null;
        }
        id = idVoulu; cle = cleVoulue;
      } else {
        id = identifiantEspace();
        cle = crypto.randomBytes(24).toString('base64url');
      }
      const espace = {
        id: id, cleEmpreinte: empreinte(cle),
        nom: String((corps && corps.nom) || 'Mon espace').slice(0, 80),
        version: 0, document: (corps && corps.document) || null,
        journal: [], creeLe: new Date().toISOString(),
      };
      if (espace.document) espace.version = 1;
      return enFile(id, function () { ecrireEspace(id, espace); }).then(function () {
        repondre(res, 200, { id: id, cle: cle, nom: espace.nom, version: espace.version });
      });
    }).catch(function (e) { repondre(res, 400, { erreur: e.message }); });
    return;
  }

  /* ——— Calendrier : l'abonnement ————————————————————————————————————————
     Un calendrier abonné ne sait pas envoyer d'en-tête d'authentification : il
     ne fait que demander une adresse. Le secret est donc dans l'adresse, et
     c'est un jeton à part — pas la clé de synchronisation — pour qu'il soit
     révocable sans casser le partage.

     Règle qui gouverne tout le reste : ne JAMAIS servir un calendrier vide
     quand quelque chose manque. Un abonnement remplace son contenu par ce
     qu'il reçoit ; répondre « 0 repas » à cause d'un espace perdu viderait le
     calendrier de l'abonné, alarmes comprises. Une erreur, elle, le fige.
     ---------------------------------------------------------------------- */
  const mcal = chemin.match(/^\/api\/espaces\/([^/]+)\/calendrier(\.ics)?$/);
  if (mcal) {
    const id = mcal[1];
    const surFichier = !!mcal[2];
    if (!ID_VALIDE.test(id)) { repondre(res, 400, { erreur: 'identifiant invalide' }); return; }
    const espace = lireEspace(id);
    if (!espace) {
      if (surFichier) { repondreTexte(res, 404, 'espace introuvable'); return; }
      repondre(res, 404, { erreur: 'espace introuvable' });
      return;
    }

    // Lecture par l'abonnement : jeton dans l'adresse, rien d'autre.
    if (surFichier && req.method === 'GET') {
      const jeton = url.searchParams.get('jeton') || '';
      if (!espace.calendrier || !espace.calendrier.jetonEmpreinte) {
        repondreTexte(res, 404, 'aucun abonnement pour cet espace');
        return;
      }
      if (!jeton || empreinte(jeton) !== espace.calendrier.jetonEmpreinte) {
        repondreTexte(res, 403, 'jeton invalide');
        return;
      }
      if (!espace.calendrier.ics) {
        // Rien n'a encore été déposé : mieux vaut une erreur qu'un calendrier
        // vide, qui effacerait ce que l'abonné a déjà.
        repondreTexte(res, 404, 'aucun plan déposé');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(espace.calendrier.ics);
      return;
    }

    // Le reste passe par la clé de l'espace.
    const cle = cleFournie(req);
    if (!cle || empreinte(cle) !== espace.cleEmpreinte) { repondre(res, 401, { erreur: 'clé invalide' }); return; }

    // Créer ou renouveler le jeton d'abonnement.
    if (!surFichier && req.method === 'POST') {
      lireCorps(req).then(function (corps) {
        return enFile(id, function () {
          const frais = lireEspace(id);
          if (!frais) throw new Error('espace introuvable');
          const jeton = crypto.randomBytes(18).toString('base64url');
          const ics = typeof (corps && corps.ics) === 'string' ? corps.ics : '';
          frais.calendrier = {
            jetonEmpreinte: empreinte(jeton),
            ics: valideIcs(ics) ? ics : (frais.calendrier && frais.calendrier.ics) || '',
            maj: new Date().toISOString(),
          };
          ecrireEspace(id, frais);
          return { jeton: jeton, url: adresseCalendrier(req, id, jeton) };
        });
      }).then(function (r) { repondre(res, 200, r); })
        .catch(function (e) { repondre(res, 400, { erreur: e.message }); });
      return;
    }

    // Déposer un plan à jour. C'est l'application qui l'a fabriqué : le serveur
    // ne recalcule rien, il n'y a donc pas deux versions de la même logique à
    // maintenir d'accord.
    if (surFichier && req.method === 'PUT') {
      lireCorps(req, true).then(function (texte) {
        if (!valideIcs(texte)) throw new Error('calendrier invalide');
        return enFile(id, function () {
          const frais = lireEspace(id);
          if (!frais) throw new Error('espace introuvable');
          if (!frais.calendrier || !frais.calendrier.jetonEmpreinte) throw new Error('aucun abonnement');
          frais.calendrier.ics = texte;
          frais.calendrier.maj = new Date().toISOString();
          ecrireEspace(id, frais);
          return { maj: frais.calendrier.maj, octets: Buffer.byteLength(texte) };
        });
      }).then(function (r) { repondre(res, 200, r); })
        .catch(function (e) { repondre(res, 400, { erreur: e.message }); });
      return;
    }

    // Révoquer : l'adresse cesse de répondre, les abonnés se figent.
    if (!surFichier && req.method === 'DELETE') {
      enFile(id, function () {
        const frais = lireEspace(id);
        if (!frais) throw new Error('espace introuvable');
        delete frais.calendrier;
        ecrireEspace(id, frais);
        return {};
      }).then(function () { repondre(res, 200, { revoque: true }); })
        .catch(function (e) { repondre(res, 400, { erreur: e.message }); });
      return;
    }

    repondre(res, 405, { erreur: 'méthode non autorisée' });
    return;
  }

  const m = chemin.match(/^\/api\/espaces\/([^/]+)(\/operations)?$/);
  if (m) {
    const id = m[1];
    const surOperations = !!m[2];
    if (!ID_VALIDE.test(id)) { repondre(res, 400, { erreur: 'identifiant invalide' }); return; }

    const espace = lireEspace(id);
    if (!espace) { repondre(res, 404, { erreur: 'espace introuvable' }); return; }
    const cle = cleFournie(req);
    if (!cle || empreinte(cle) !== espace.cleEmpreinte) { repondre(res, 401, { erreur: 'clé invalide' }); return; }

    // Lecture : le document complet, ou seulement ce qui a changé.
    if (!surOperations && req.method === 'GET') {
      const depuis = Number(url.searchParams.get('depuis') || 0);
      const plusAncien = espace.journal.length ? espace.journal[0].v : espace.version + 1;
      if (depuis > 0 && depuis >= plusAncien - 1 && depuis <= espace.version) {
        const suite = espace.journal.filter(function (e) { return e.v > depuis; });
        repondre(res, 200, { id: id, nom: espace.nom, version: espace.version, operations: suite });
        return;
      }
      repondre(res, 200, { id: id, nom: espace.nom, version: espace.version, document: espace.document });
      return;
    }

    // Écriture : on ajoute des opérations à la suite du journal.
    if (surOperations && req.method === 'POST') {
      lireCorps(req).then(function (corps) {
        const operations = Array.isArray(corps.operations) ? corps.operations : [];
        return enFile(id, function () {
          const frais = lireEspace(id);
          if (!frais) throw new Error('espace introuvable');
          if (corps.document && frais.version === 0) {
            // Premier dépôt : l'espace prend le document tel quel.
            frais.document = corps.document;
          }
          if (operations.length) {
            if (!frais.document) frais.document = {};
            appliquerOperations(frais.document, operations);
            frais.version += 1;
            frais.journal.push({ v: frais.version, operations: operations, ts: Date.now(), auteur: String(corps.auteur || '').slice(0, 40) });
            if (frais.journal.length > JOURNAL_MAX) frais.journal = frais.journal.slice(-JOURNAL_MAX);
          } else if (corps.document && frais.version === 0) {
            frais.version = 1;
          }
          if (typeof corps.nom === 'string' && corps.nom.trim()) frais.nom = corps.nom.trim().slice(0, 80);
          ecrireEspace(id, frais);
          return { version: frais.version, nom: frais.nom };
        });
      }).then(function (r) { repondre(res, 200, r); })
        .catch(function (e) { repondre(res, 400, { erreur: e.message }); });
      return;
    }

    repondre(res, 405, { erreur: 'méthode non autorisée' });
    return;
  }

  servirStatique(req, res);
});

/* ——— Application des opérations, côté serveur ————————————————————————————
   Miroir exact de la logique du client. Les deux doivent rester identiques :
   c'est ce qui garantit que tout le monde voit le même document.
   ------------------------------------------------------------------------- */
const COLLECTIONS_CLEF = {
  'ingredients': 'id', 'recettes': 'id', 'semainesTypes': 'id',
  'semaine.selection': 'id', 'semaine.ajoutsManuels': 'id',
};
function clefCollection(chemin) { return COLLECTIONS_CLEF[chemin.join('.')] || null; }

function appliquerOperation(doc, op) {
  const chemin = op.c;
  if (!Array.isArray(chemin) || !chemin.length) return doc;
  let noeud = doc;
  for (let i = 0; i < chemin.length - 1; i++) {
    const seg = chemin[i];
    const clef = clefCollection(chemin.slice(0, i + 1));
    if (clef && Array.isArray(noeud[seg])) {
      const suivant = chemin[i + 1];
      let entree = noeud[seg].find(function (e) { return String(e[clef]) === String(suivant); });
      if (!entree) {
        if (i + 2 === chemin.length && op.d) return doc;
        if (i + 2 === chemin.length) { noeud[seg].push(op.v); return doc; }
        entree = {}; entree[clef] = suivant; noeud[seg].push(entree);
      }
      if (i + 2 === chemin.length) {
        if (op.d) noeud[seg] = noeud[seg].filter(function (e) { return String(e[clef]) !== String(suivant); });
        else noeud[seg][noeud[seg].indexOf(entree)] = op.v;
        return doc;
      }
      noeud = entree; i += 1; continue;
    }
    if (noeud[seg] === undefined || noeud[seg] === null) noeud[seg] = {};
    noeud = noeud[seg];
  }
  const dernier = chemin[chemin.length - 1];
  if (dernier === '__ordre') return doc;
  if (op.d) delete noeud[dernier];
  else noeud[dernier] = op.v;
  return doc;
}

function appliquerOperations(doc, operations) {
  const ordres = [];
  (operations || []).forEach(function (op) {
    if (op && Array.isArray(op.c) && op.c[op.c.length - 1] === '__ordre') { ordres.push(op); return; }
    if (op && Array.isArray(op.c)) appliquerOperation(doc, op);
  });
  ordres.forEach(function (op) {
    const cheminTableau = op.c.slice(0, -1);
    const clef = clefCollection(cheminTableau);
    if (!clef) return;
    let noeud = doc;
    for (let i = 0; i < cheminTableau.length - 1; i++) noeud = noeud[cheminTableau[i]];
    const nom = cheminTableau[cheminTableau.length - 1];
    if (!Array.isArray(noeud[nom])) return;
    const parClef = new Map(noeud[nom].map(function (e) { return [String(e[clef]), e]; }));
    const ordonne = [];
    (op.v || []).forEach(function (k) { if (parClef.has(k)) { ordonne.push(parClef.get(k)); parClef.delete(k); } });
    parClef.forEach(function (e) { ordonne.push(e); });
    noeud[nom] = ordonne;
  });
  return doc;
}

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
    console.warn('     disparaissent au prochain déploiement. Montez-y un volume.');
    console.warn('');
  }
});
