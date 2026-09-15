/* Un espace = un Durable Object. Une invitation aussi.
 *
 * C'est lui qui remplace le fichier JSON du serveur Node — et, accessoirement,
 * la file d'attente : Cloudflare n'exécute qu'une requête à la fois par objet,
 * donc « lire puis écrire » est indivisible sans qu'on ait à l'organiser.
 *
 * Le même objet sert aux deux usages, distingués par le nom qu'on lui donne :
 * l'identifiant de l'espace, ou « invitation:<empreinte du code> ». Une
 * invitation n'est qu'un petit enregistrement à durée de vie courte ; lui
 * donner sa propre classe n'apporterait qu'une migration de plus.
 *
 * Le calendrier est rangé à part. Un .ics pèse jusqu'à 512 Ko : le garder dans
 * le même enregistrement que le document ferait réécrire un demi-mégaoctet à
 * chaque case cochée.
 *
 * Le journal aussi, et pour une raison plus grave : une valeur ne peut pas
 * dépasser quelques mégaoctets. Tant qu'il vivait dans le même enregistrement que le
 * document, il suffisait qu'il grossisse pour que l'espace entier devienne
 * impossible à écrire — et là, plus rien ne passait. Séparés, le document
 * garde son budget à lui, et un journal trop lourd ne peut plus rien bloquer.
 */
import routes from '../serveur/routes.js';

const CLE_ESPACE = 'espace';
const CLE_JOURNAL = 'journal';
const CLE_ICS = 'ics';
const CLE_INVITATION = 'invitation';

/**
 * Les abonnements de l'espace, sous leur forme actuelle : appareil → abonnement.
 *
 * Un espace créé avant la séparation par appareil porte un abonnement UNIQUE,
 * à plat : { jetonEmpreinte, maj }. Le prendre pour un dictionnaire fait lire
 * « jetonEmpreinte » et « maj » comme des noms d'appareils, et écrire « .ics »
 * sur la chaîne de l'empreinte — ce qui lève, et fait échouer non pas le
 * calendrier, mais TOUTE requête sur l'espace : lire ne marche plus, écrire
 * non plus. C'est ce qui a figé les espaces déjà abonnés à la mise à jour.
 */
function abonnementsDe(calendrier) {
  if (!calendrier || typeof calendrier !== 'object') return null;
  if (typeof calendrier.jetonEmpreinte === 'string') return { _unique: calendrier };
  return calendrier;
}

export class Espace {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.magasin = {
      lire: async () => {
        const e = await this.state.storage.get(CLE_ESPACE);
        if (!e) return null;
        // Le journal a longtemps voyagé dans l'enregistrement lui-même : on
        // l'y reprend s'il s'y trouve encore, et la première écriture le
        // rangera dehors. Un espace déjà en place n'a rien à faire pour ça.
        if (!Array.isArray(e.journal)) e.journal = (await this.state.storage.get(CLE_JOURNAL)) || [];
        // Un abonnement par appareil : chaque .ics est rangé à part, sous son
        // propre nom, et recollé à la lecture.
        const abos = abonnementsDe(e.calendrier);
        if (abos) {
          const noms = Object.keys(abos);
          for (let i = 0; i < noms.length; i++) {
            const a = abos[noms[i]];
            // Une entrée qui n'est pas un abonnement n'a rien à faire là ;
            // lui écrire dessus est précisément ce qui cassait tout.
            if (!a || typeof a !== 'object') { delete abos[noms[i]]; continue; }
            a.ics = (await this.state.storage.get(CLE_ICS + ':' + noms[i])) ||
              // Le calendrier de l'abonnement unique était rangé sous « ics »,
              // sans nom d'appareil. On le récupère au lieu de le perdre : sans
              // ça, le téléphone déjà abonné verrait son agenda se vider.
              (noms[i] === '_unique' ? (await this.state.storage.get(CLE_ICS)) : '') || '';
          }
          e.calendrier = abos;
        }
        return e;
      },
      ecrire: async (id, espace) => {
        const aRanger = Object.assign({}, espace);
        await this.state.storage.put(CLE_JOURNAL, Array.isArray(espace.journal) ? espace.journal : []);
        delete aRanger.journal;
        const gardes = [];
        const abos = abonnementsDe(aRanger.calendrier);
        if (abos) {
          const cal = {};
          const noms = Object.keys(abos);
          for (let i = 0; i < noms.length; i++) {
            if (!abos[noms[i]] || typeof abos[noms[i]] !== 'object') continue;
            const a = Object.assign({}, abos[noms[i]]);
            const contenu = a.ics || '';
            delete a.ics;
            cal[noms[i]] = a;
            gardes.push(CLE_ICS + ':' + noms[i]);
            await this.state.storage.put(CLE_ICS + ':' + noms[i], contenu);
          }
          aRanger.calendrier = cal;
        }
        // Les .ics des abonnements révoqués n'ont plus de raison d'occuper la
        // place : un demi-mégaoctet par appareil disparu, sinon.
        const restants = await this.state.storage.list({ prefix: CLE_ICS });
        for (const nom of restants.keys()) {
          if (gardes.indexOf(nom) < 0) await this.state.storage.delete(nom);
        }
        await this.state.storage.put(CLE_ESPACE, aRanger);
      },

      // Une invitation se retrouve par l'empreinte de son code, jamais par
      // l'espace : c'est donc un autre objet qui la détient. Quand l'objet
      // courant EST celui de l'invitation, on lit son propre stockage.
      lireInvitation: (clef) => this.surInvitation(clef, 'GET'),
      ecrireInvitation: (clef, inv) => this.surInvitation(clef, 'PUT', inv),
      supprimerInvitation: (clef) => this.surInvitation(clef, 'DELETE'),
    };
  }

  /** Accès à l'objet qui détient une invitation — lui-même, ou un voisin. */
  async surInvitation(clef, methode, corps) {
    if (this.state.id.equals(this.env.ESPACE.idFromName('invitation:' + clef))) {
      return await this.invitationLocale(methode, corps);
    }
    const voisin = this.env.ESPACE.get(this.env.ESPACE.idFromName('invitation:' + clef));
    const rep = await voisin.fetch('https://espace.interne/invitation', {
      method: methode,
      headers: { 'Content-Type': 'application/json' },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
    if (methode !== 'GET') return null;
    const t = await rep.text();
    return t ? JSON.parse(t) : null;
  }

  async invitationLocale(methode, corps) {
    if (methode === 'GET') return (await this.state.storage.get(CLE_INVITATION)) || null;
    if (methode === 'PUT') { await this.state.storage.put(CLE_INVITATION, corps); return null; }
    // L'invitation consommée ne laisse rien derrière : la clé de l'espace y
    // figure en clair, elle ne doit pas survivre à son usage.
    await this.state.storage.deleteAll();
    return null;
  }

  async fetch(requeteHttp) {
    const url = new URL(requeteHttp.url);
    if (url.pathname === '/invitation') {
      const t = await requeteHttp.text();
      const r = await this.invitationLocale(requeteHttp.method, t ? JSON.parse(t) : undefined);
      return new Response(r === null ? '' : JSON.stringify(r), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    const requete = await requeteHttp.json();
    requete.parametres = new URLSearchParams(requete.parametresTexte || '');
    const reponse = await routes.traiter(requete, this.magasin);
    return new Response(JSON.stringify(reponse), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
