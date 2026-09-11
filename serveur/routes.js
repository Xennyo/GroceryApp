/* Logique du serveur de synchronisation, indépendante du moteur.
 *
 * Ce fichier ne connaît ni Node ni Cloudflare : il reçoit une requête déjà
 * décortiquée et un magasin, et rend une réponse décrite. Les deux adaptateurs
 * — serveur/serveur.js (Node + fichiers) et worker/ (Workers + Durable Object)
 * — n'ont plus qu'à traduire l'aller et le retour.
 *
 * C'est ce qui permet de déployer sur Cloudflare sans qu'il existe deux
 * versions des règles d'accès, du journal ou des opérations. Une seule logique,
 * testée une fois.
 *
 *   requete = { methode, chemin, parametres, cle, corpsTexte, origine,
 *               idPropose, clePropose }
 *   magasin = { async lire(id) → espace|null, async ecrire(id, espace) }
 *   retour  = { code, type: 'json'|'texte'|'ics', corps }
 *
 * Tout est asynchrone : sur Workers le stockage passe par le réseau, et
 * l'empreinte d'une clé par WebCrypto.
 */
'use strict';

const ID_VALIDE = /^[a-z0-9]{16,40}$/;
const TAILLE_MAX = 2 * 1024 * 1024;   // 2 Mo par requête
const JOURNAL_MAX = 500;              // opérations conservées pour le rattrapage
const ICS_MAX = 512 * 1024;

/* ——— Outils communs aux deux moteurs ————————————————————————————————————
   WebCrypto et TextEncoder existent à l'identique dans Node 18+ et dans
   Workers : une seule implémentation suffit, il n'y a pas de variante à
   maintenir d'accord avec l'autre.
   ------------------------------------------------------------------------- */

const encodeur = new TextEncoder();

/** Empreinte SHA-256, en hexadécimal. Asynchrone : WebCrypto l'impose. */
async function empreinte(valeur) {
  const brut = await crypto.subtle.digest('SHA-256', encodeur.encode(String(valeur)));
  const octets = new Uint8Array(brut);
  let sortie = '';
  for (let i = 0; i < octets.length; i++) sortie += octets[i].toString(16).padStart(2, '0');
  return sortie;
}

/** Comparaison à temps constant : ne pas révéler la clé par la durée. */
function memeEmpreinte(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

function octetsAleatoires(n) {
  const t = new Uint8Array(n);
  crypto.getRandomValues(t);
  return t;
}

/** base64url, sans dépendre de Buffer (absent de Workers). */
function base64url(octets) {
  let binaire = '';
  for (let i = 0; i < octets.length; i++) binaire += String.fromCharCode(octets[i]);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Identifiant d'espace : exactement 16 caractères [a-z0-9]. On tire jusqu'à en
 * avoir assez — filtrer sans compter produirait parfois un identifiant trop
 * court, donc un espace créé mais inatteignable.
 */
function identifiantEspace() {
  let sortie = '';
  while (sortie.length < 16) {
    sortie += base64url(octetsAleatoires(24)).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  return sortie.slice(0, 16);
}

function cleAleatoire() { return base64url(octetsAleatoires(24)); }

function nbOctets(texte) { return encodeur.encode(texte).length; }

/** Un calendrier plausible, et pas trop gros. On ne stocke rien d'autre. */
function valideIcs(texte) {
  return typeof texte === 'string' &&
    texte.indexOf('BEGIN:VCALENDAR') === 0 &&
    texte.indexOf('END:VCALENDAR') > 0 &&
    nbOctets(texte) <= ICS_MAX;
}

/* ——— Réponses ——————————————————————————————————————————————————————————— */

const json = function (code, corps) { return { code: code, type: 'json', corps: corps }; };
const texte = function (code, message) { return { code: code, type: 'texte', corps: message }; };
const ics = function (contenu) { return { code: 200, type: 'ics', corps: contenu }; };

/** Erreur métier : porte le code HTTP à rendre, au lieu d'un 400 par défaut. */
class ErreurRoute extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function corpsJson(requete) {
  const t = requete.corpsTexte;
  if (t === undefined || t === null || t === '') return {};
  if (nbOctets(t) > TAILLE_MAX) throw new ErreurRoute(413, 'corps trop volumineux');
  try { return JSON.parse(t); }
  catch (e) { throw new ErreurRoute(400, 'JSON invalide'); }
}

/* ——— Routes ————————————————————————————————————————————————————————————— */

/**
 * Traite une requête. Ne lève pas : toute erreur devient une réponse.
 * Le magasin est supposé déjà sérialisé par l'appelant — fichier d'attente
 * côté Node, Durable Object côté Cloudflare — de sorte que lire puis écrire
 * ne peut pas s'entrelacer avec une autre requête sur le même espace.
 */
async function traiter(requete, magasin) {
  try { return await router(requete, magasin); }
  catch (e) {
    if (e instanceof ErreurRoute) return json(e.code, { erreur: e.message });
    return json(400, { erreur: e.message || 'erreur' });
  }
}

async function router(requete, magasin) {
  const methode = requete.methode;
  const chemin = requete.chemin;

  if (methode === 'OPTIONS') return json(204, {});
  if (chemin === '/api/sante') return json(200, { etat: 'ok', version: 1 });

  if (chemin === '/api/espaces' && methode === 'POST') return await creer(requete, magasin);

  const mcal = chemin.match(/^\/api\/espaces\/([^/]+)\/calendrier(\.ics)?$/);
  if (mcal) return await calendrier(requete, magasin, mcal[1], !!mcal[2]);

  const m = chemin.match(/^\/api\/espaces\/([^/]+)(\/operations)?$/);
  if (m) return await espace(requete, magasin, m[1], !!m[2]);

  return null;   // pas une route d'API : à l'adaptateur de servir le statique
}

/** Création d'un espace — ou reconstruction d'un espace perdu. */
async function creer(requete, magasin) {
  const corps = corpsJson(requete);
  // Reconstruction : un appareil qui détient encore l'identifiant et la clé
  // d'un espace peut le recréer à l'identique. Connaître les deux, c'est déjà
  // y avoir accès — le lien de partage ne donne rien de plus. Les liens déjà
  // distribués continuent donc de fonctionner après une perte de données.
  const idVoulu = String((corps && corps.id) || '');
  const cleVoulue = String((corps && corps.cle) || '');
  let id, cle;
  if (idVoulu || cleVoulue) {
    if (!ID_VALIDE.test(idVoulu) || cleVoulue.length < 16) {
      return json(400, { erreur: 'identifiant ou clé invalide' });
    }
    if (await magasin.lire(idVoulu)) {
      // Il existe déjà : rien à reconstruire, l'appareil n'a qu'à se
      // synchroniser normalement.
      return json(409, { erreur: 'cet espace existe déjà' });
    }
    id = idVoulu; cle = cleVoulue;
  } else {
    id = requete.idPropose || identifiantEspace();
    cle = requete.clePropose || cleAleatoire();
  }
  const nouvel = {
    id: id, cleEmpreinte: await empreinte(cle),
    nom: String((corps && corps.nom) || 'Mon espace').slice(0, 80),
    version: 0, document: (corps && corps.document) || null,
    journal: [], creeLe: new Date().toISOString(),
  };
  if (nouvel.document) nouvel.version = 1;
  await magasin.ecrire(id, nouvel);
  return json(200, { id: id, cle: cle, nom: nouvel.nom, version: nouvel.version });
}

/* ——— Calendrier : l'abonnement ————————————————————————————————————————
   Un calendrier abonné ne sait pas envoyer d'en-tête d'authentification : il
   ne fait que demander une adresse. Le secret est donc dans l'adresse, et
   c'est un jeton à part — pas la clé de synchronisation — pour qu'il soit
   révocable sans casser le partage.

   Règle qui gouverne tout le reste : ne JAMAIS servir un calendrier vide
   quand quelque chose manque. Un abonnement remplace son contenu par ce qu'il
   reçoit ; répondre « 0 repas » à cause d'un espace perdu viderait le
   calendrier de l'abonné, alarmes comprises. Une erreur, elle, le fige.
   ---------------------------------------------------------------------- */
async function calendrier(requete, magasin, id, surFichier) {
  if (!ID_VALIDE.test(id)) return json(400, { erreur: 'identifiant invalide' });
  const espaceLu = await magasin.lire(id);
  if (!espaceLu) {
    return surFichier ? texte(404, 'espace introuvable') : json(404, { erreur: 'espace introuvable' });
  }

  // Lecture par l'abonnement : jeton dans l'adresse, rien d'autre.
  if (surFichier && requete.methode === 'GET') {
    const jeton = requete.parametres.get('jeton') || '';
    if (!espaceLu.calendrier || !espaceLu.calendrier.jetonEmpreinte) {
      return texte(404, 'aucun abonnement pour cet espace');
    }
    if (!jeton || !memeEmpreinte(await empreinte(jeton), espaceLu.calendrier.jetonEmpreinte)) {
      return texte(403, 'jeton invalide');
    }
    if (!espaceLu.calendrier.ics) {
      // Rien n'a encore été déposé : mieux vaut une erreur qu'un calendrier
      // vide, qui effacerait ce que l'abonné a déjà.
      return texte(404, 'aucun plan déposé');
    }
    return ics(espaceLu.calendrier.ics);
  }

  // Le reste passe par la clé de l'espace.
  const cle = requete.cle;
  if (!cle || !memeEmpreinte(await empreinte(cle), espaceLu.cleEmpreinte)) {
    return json(401, { erreur: 'clé invalide' });
  }

  // Créer ou renouveler le jeton d'abonnement.
  if (!surFichier && requete.methode === 'POST') {
    const corps = corpsJson(requete);
    const jeton = cleAleatoire();
    const contenu = typeof (corps && corps.ics) === 'string' ? corps.ics : '';
    espaceLu.calendrier = {
      jetonEmpreinte: await empreinte(jeton),
      ics: valideIcs(contenu) ? contenu : (espaceLu.calendrier && espaceLu.calendrier.ics) || '',
      maj: new Date().toISOString(),
    };
    await magasin.ecrire(id, espaceLu);
    return json(200, { jeton: jeton, url: adresseCalendrier(requete.origine, id, jeton) });
  }

  // Déposer un plan à jour. C'est l'application qui l'a fabriqué : le serveur
  // ne recalcule rien, il n'y a donc pas deux versions de la même logique à
  // maintenir d'accord.
  if (surFichier && requete.methode === 'PUT') {
    const contenu = requete.corpsTexte || '';
    if (!valideIcs(contenu)) return json(400, { erreur: 'calendrier invalide' });
    if (!espaceLu.calendrier || !espaceLu.calendrier.jetonEmpreinte) {
      return json(400, { erreur: 'aucun abonnement' });
    }
    espaceLu.calendrier.ics = contenu;
    espaceLu.calendrier.maj = new Date().toISOString();
    await magasin.ecrire(id, espaceLu);
    return json(200, { maj: espaceLu.calendrier.maj, octets: nbOctets(contenu) });
  }

  // Révoquer : l'adresse cesse de répondre, les abonnés se figent.
  if (!surFichier && requete.methode === 'DELETE') {
    delete espaceLu.calendrier;
    await magasin.ecrire(id, espaceLu);
    return json(200, { revoque: true });
  }

  return json(405, { erreur: 'méthode non autorisée' });
}

/** Adresse d'abonnement, telle que le téléphone devra la demander. */
function adresseCalendrier(origine, id, jeton) {
  return String(origine || '').replace(/\/+$/, '') +
    '/api/espaces/' + id + '/calendrier.ics?jeton=' + jeton;
}

/** Lecture et écriture du document d'un espace. */
async function espace(requete, magasin, id, surOperations) {
  if (!ID_VALIDE.test(id)) return json(400, { erreur: 'identifiant invalide' });
  const espaceLu = await magasin.lire(id);
  if (!espaceLu) return json(404, { erreur: 'espace introuvable' });
  const cle = requete.cle;
  if (!cle || !memeEmpreinte(await empreinte(cle), espaceLu.cleEmpreinte)) {
    return json(401, { erreur: 'clé invalide' });
  }

  // Lecture : le document complet, ou seulement ce qui a changé.
  if (!surOperations && requete.methode === 'GET') {
    const depuis = Number(requete.parametres.get('depuis') || 0);
    const plusAncien = espaceLu.journal.length ? espaceLu.journal[0].v : espaceLu.version + 1;
    if (depuis > 0 && depuis >= plusAncien - 1 && depuis <= espaceLu.version) {
      const suite = espaceLu.journal.filter(function (e) { return e.v > depuis; });
      return json(200, { id: id, nom: espaceLu.nom, version: espaceLu.version, operations: suite });
    }
    return json(200, { id: id, nom: espaceLu.nom, version: espaceLu.version, document: espaceLu.document });
  }

  // Écriture : on ajoute des opérations à la suite du journal.
  if (surOperations && requete.methode === 'POST') {
    const corps = corpsJson(requete);
    const operations = Array.isArray(corps.operations) ? corps.operations : [];
    if (corps.document && espaceLu.version === 0) {
      // Premier dépôt : l'espace prend le document tel quel.
      espaceLu.document = corps.document;
    }
    if (operations.length) {
      if (!espaceLu.document) espaceLu.document = {};
      appliquerOperations(espaceLu.document, operations);
      espaceLu.version += 1;
      espaceLu.journal.push({
        v: espaceLu.version, operations: operations, ts: Date.now(),
        auteur: String(corps.auteur || '').slice(0, 40),
      });
      if (espaceLu.journal.length > JOURNAL_MAX) espaceLu.journal = espaceLu.journal.slice(-JOURNAL_MAX);
    } else if (corps.document && espaceLu.version === 0) {
      espaceLu.version = 1;
    }
    if (typeof corps.nom === 'string' && corps.nom.trim()) espaceLu.nom = corps.nom.trim().slice(0, 80);
    await magasin.ecrire(id, espaceLu);
    return json(200, { version: espaceLu.version, nom: espaceLu.nom });
  }

  return json(405, { erreur: 'méthode non autorisée' });
}

/* ——— Application des opérations, côté serveur ————————————————————————————
   Miroir exact de la logique du client. Les deux doivent rester identiques :
   c'est ce qui garantit que tout le monde voit le même document.
   ------------------------------------------------------------------------- */
const COLLECTIONS_CLEF = {
  'ingredients': 'id', 'recettes': 'id', 'semainesTypes': 'id',
  'semaine.selection': 'id', 'semaine.ajoutsManuels': 'id',
  'membres': 'id',
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

const API = {
  ID_VALIDE: ID_VALIDE, TAILLE_MAX: TAILLE_MAX, JOURNAL_MAX: JOURNAL_MAX,
  empreinte: empreinte, identifiantEspace: identifiantEspace, cleAleatoire: cleAleatoire,
  valideIcs: valideIcs, adresseCalendrier: adresseCalendrier,
  appliquerOperations: appliquerOperations, traiter: traiter,
};

// Node lit `module.exports` ; Workers importe le module ES. Le même fichier
// sert aux deux : la ligne ci-dessous est ignorée là où `module` n'existe pas.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
