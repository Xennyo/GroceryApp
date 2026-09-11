/* Adaptateur Cloudflare Workers.
 *
 * Deux rôles, et rien d'autre : servir les fichiers de l'application, et
 * aiguiller les appels d'API vers le Durable Object de l'espace concerné. Les
 * règles, elles, sont dans serveur/routes.js, partagé avec le moteur Node.
 */
import routes from '../serveur/routes.js';
import { Espace } from './espace.js';

export { Espace };

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

function enResponse(reponse) {
  const corps = reponse.type === 'json' ? JSON.stringify(reponse.corps)
    : String(reponse.corps) + (reponse.type === 'texte' ? '\n' : '');
  const entetes = Object.assign({ 'Content-Type': TYPE_REPONSE[reponse.type] }, ENTETES_COMMUNES);
  // Un calendrier abonné se relit souvent : il ne doit pas être figé par un
  // cache, mais « no-store » ferait re-télécharger sans condition.
  if (reponse.type === 'ics') entetes['Cache-Control'] = 'no-cache';
  return new Response(reponse.code === 204 ? null : corps, { status: reponse.code, headers: entetes });
}

function cleFournie(request) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** L'espace visé, qui désigne le Durable Object à saisir. */
function espaceVise(chemin, corpsTexte) {
  const m = chemin.match(/^\/api\/espaces\/([^/]+)(?:\/|$)/);
  if (m) return m[1];
  if (chemin === '/api/espaces' && corpsTexte) {
    // Reconstruction : l'identifiant est dans le corps, pas dans l'adresse.
    try { return JSON.parse(corpsTexte).id || null; } catch (e) { return null; }
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const chemin = url.pathname;

    if (!chemin.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return enResponse({ code: 204, type: 'json', corps: {} });
      return env.ASSETS.fetch(request);
    }

    let corpsTexte = '';
    if (request.method !== 'GET' && request.method !== 'OPTIONS' && request.method !== 'HEAD') {
      corpsTexte = await request.text();
      if (corpsTexte.length > routes.TAILLE_MAX) {
        return enResponse({ code: 413, type: 'json', corps: { erreur: 'corps trop volumineux' } });
      }
    }

    const requete = {
      methode: request.method, chemin: chemin, parametresTexte: url.search,
      cle: cleFournie(request), corpsTexte: corpsTexte, origine: url.origin,
    };

    // Une création sans identifiant doit en tirer un ici : il désigne l'objet
    // à saisir, il faut donc le connaître avant de s'adresser à lui.
    let vise = espaceVise(chemin, corpsTexte);
    if (chemin === '/api/espaces' && request.method === 'POST' && !vise) {
      requete.idPropose = routes.identifiantEspace();
      requete.clePropose = routes.cleAleatoire();
      vise = requete.idPropose;
    }

    // Les routes sans espace (santé, adresses inconnues) n'ont rien à stocker.
    if (!vise) {
      requete.parametres = url.searchParams;
      const reponse = await routes.traiter(requete, { lire: async () => null, ecrire: async () => {} });
      if (!reponse) return env.ASSETS.fetch(request);
      return enResponse(reponse);
    }

    const objet = env.ESPACE.get(env.ESPACE.idFromName(vise));
    const rep = await objet.fetch('https://espace.interne/traiter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requete),
    });
    return enResponse(await rep.json());
  },
};
