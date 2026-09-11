/* Un espace = un Durable Object.
 *
 * C'est lui qui remplace le fichier JSON du serveur Node — et, accessoirement,
 * la file d'attente : Cloudflare n'exécute qu'une requête à la fois par objet,
 * donc « lire puis écrire » est indivisible sans qu'on ait à l'organiser.
 *
 * Le calendrier est rangé à part. Un .ics pèse jusqu'à 512 Ko : le garder dans
 * le même enregistrement que le document ferait réécrire un demi-mégaoctet à
 * chaque case cochée.
 */
import routes from '../serveur/routes.js';

const CLE_ESPACE = 'espace';
const CLE_ICS = 'ics';

export class Espace {
  constructor(state) {
    this.state = state;
    this.magasin = {
      lire: async () => {
        const e = await this.state.storage.get(CLE_ESPACE);
        if (!e) return null;
        if (e.calendrier) e.calendrier.ics = (await this.state.storage.get(CLE_ICS)) || '';
        return e;
      },
      ecrire: async (id, espace) => {
        const aRanger = Object.assign({}, espace);
        if (aRanger.calendrier) {
          const cal = Object.assign({}, aRanger.calendrier);
          const contenu = cal.ics || '';
          delete cal.ics;
          aRanger.calendrier = cal;
          await this.state.storage.put(CLE_ICS, contenu);
        } else {
          await this.state.storage.delete(CLE_ICS);
        }
        await this.state.storage.put(CLE_ESPACE, aRanger);
      },
    };
  }

  /** Reçoit une requête déjà décortiquée par le Worker, rend la réponse décrite. */
  async fetch(requeteHttp) {
    const requete = await requeteHttp.json();
    requete.parametres = new URLSearchParams(requete.parametresTexte || '');
    const reponse = await routes.traiter(requete, this.magasin);
    return new Response(JSON.stringify(reponse), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
