# Serveur de synchronisation

**Aucune dépendance.** Les règles vivent dans `routes.js`, qui ne connaît ni
Node ni Cloudflare : il reçoit une requête décortiquée et un magasin, et rend
une réponse. Deux moteurs l'utilisent, et c'est la même logique dans les deux —
il n'y a pas deux versions des règles d'accès à garder d'accord.

| Moteur | Fichier | Stockage | Pour quoi |
|---|---|---|---|
| **Cloudflare** | `worker/` | Durable Objects | Déploiement recommandé. Gratuit, rien à administrer, rien à perdre. |
| **Node** | `serveur/serveur.js` | Un fichier JSON par espace | Auto-hébergement, développement, et les tests. |

```bash
node serveur/serveur.js --port 8787 --donnees ./donnees --statique ./public
```

| Option | Défaut | Rôle |
|---|---|---|
| `--port` | `8787` (ou `$PORT`) | Port d'écoute |
| `--hote` | `0.0.0.0` (ou `$HOST`) | Interface |
| `--donnees` | `./donnees` | Dossier des espaces |
| `--statique` | *(aucun)* | Sert aussi l'application depuis ce dossier |

Avec `--statique .`, **tout tient dans un seul service** : pas de CORS à régler,
une seule adresse à partager.

## Déployer sur Cloudflare

```bash
npx wrangler login      # une fois
npx wrangler deploy
```

C'est tout. `wrangler.toml` déclare le reste : `public/` est publié comme
fichiers de l'application, et les appels `/api/` vont au Durable Object de
l'espace concerné.

**Pourquoi ce choix.** Un espace = un Durable Object. Cloudflare n'exécute
qu'une requête à la fois par objet, donc « lire puis écrire » est indivisible
sans qu'on ait à l'organiser — c'est exactement la garantie que le moteur Node
doit tenir à la main avec une file d'attente. Le stockage est adossé à SQLite et
**survit aux déploiements** : il n'y a pas de volume à monter, donc pas d'oubli
possible. Et rien ne s'endort : pas de réveil à froid au premier accès.

L'offre gratuite couvre largement l'usage : 100 000 requêtes par jour, 5 Go de
stockage. L'application ne sonde le serveur que lorsque son onglet est visible,
ce qui met deux téléphones à quelques centaines de requêtes par jour.

Le premier déploiement crée le Worker et son nom d'hôte
(`liste-courses.<compte>.workers.dev`). C'est l'adresse à mettre dans
l'application, sous Plus → Synchronisation — ou rien du tout si l'application
est servie par ce même Worker, puisqu'elle se relie alors toute seule.

### Ce qui est publié, et ce qui ne l'est pas

Seul `public/` est publié. Le reste du dépôt — `serveur/`, `worker/`,
`wrangler.toml`, `.git` — n'a aucune adresse. C'est délibéré : une liste de ce
qu'on publie se vérifie, une liste de ce qu'on exclut s'oublie. Un fichier de
secrets posé à la racine ne peut pas se retrouver en ligne par accident.

Les tests le vérifient à chaque exécution, sur le vrai moteur : `/.git/config`,
`/wrangler.toml` et `/serveur/routes.js` doivent répondre 404.

## Déployer sur Node (auto-hébergement)

N'importe quel hébergeur qui exécute Node convient : un VPS, Docker, Railway.
Deux exigences :

1. **HTTPS.** Sans lui, pas d'installation sur l'écran d'accueil, pas de service
   worker, et la clé de l'espace circulerait en clair.
2. **Un disque qui persiste.** C'est l'erreur de déploiement la plus fréquente,
   et elle ne se voit qu'au redéploiement suivant. Le dossier `--donnees` doit
   survivre aux redémarrages **et aux mises à jour du code**. Sur la plupart
   des hébergeurs, le système de fichiers du conteneur est reconstruit à chaque
   déploiement : sans volume monté sur ce dossier, tous les espaces
   disparaissent et les liens déjà partagés cessent de fonctionner.

   Au démarrage, le serveur affiche le nombre d'espaces qu'il voit et prévient
   quand le dossier semble être sur le disque du conteneur. Si le compte
   retombe à zéro après un déploiement, c'est exactement ce problème.

   | Hébergeur | Ce qu'il faut faire |
   |---|---|
   | Railway | Ajouter un *Volume* monté sur `/donnees` |
   | Render | Ajouter un *Disk*, chemin de montage `/donnees` (indisponible sur l'offre gratuite) |
   | VPS / Docker | `docker run -v listecourses:/donnees …` |

   L'image fixe déjà `DONNEES=/donnees` : il n'y a que le volume à monter.

   Le déploiement Cloudflare n'a aucun de ces pièges : il n'y a pas de disque.

**Si les espaces ont déjà disparu.** Rien n'est perdu tant qu'un appareil a
encore l'espace : l'application y détecte l'état « espace perdu sur le serveur »
et propose **Reconstruire l'espace**, sous Plus → Partage & synchronisation.
L'espace est recréé avec le même identifiant et la même clé, donc les liens
déjà envoyés fonctionnent à nouveau.

Sauvegarde : copier le dossier `--donnees`. Rien d'autre n'est à conserver.

## Invitation par code

Rejoindre un espace demandait de faire passer un lien de trois cents
caractères. Un code de huit suffit : `K3F7-M2QX`, dictable au téléphone.

```
POST /api/espaces/:id/invitations   (clé de l'espace en Bearer)  → { code, valableMs }
POST /api/invitations/:code                                      → { id, cle, nom }
```

**La brièveté tient à la durée, pas à la longueur.** Le code vaut un quart
d'heure et ne sert qu'une fois. Huit caractères dans un alphabet de 32 font
1 100 milliards de combinaisons ; les épuiser en quinze minutes demanderait
plus d'un milliard de requêtes par seconde. Un code permanent de cette taille,
lui, finirait par tomber.

L'alphabet écarte **I, L, O et U**, les quatre qui se confondent à l'oral avec
1, 0 et V. À la lecture on les rattrape quand même, et les tirets, espaces et
minuscules sont ignorés : `k3f7-m2qx` et `K3F7M2QX` désignent le même code.

**Ce que le serveur retient.** L'invitation est rangée sous l'**empreinte** du
code — lire le stockage ne livre aucun code utilisable — et contient la clé de
l'espace en clair. C'est le compromis assumé : le serveur ne connaît que
l'empreinte de la clé, il ne peut donc pas la redonner sans qu'on la lui
confie. L'enregistrement disparaît dès qu'il a servi, ou à son expiration.

Un code inconnu et un code périmé reçoivent la **même** réponse : distinguer
les deux dirait à qui essaie au hasard quand il est tombé juste.

## Abonnement du calendrier

Un calendrier abonné relit une adresse tout seul et **remplace** son contenu :
c'est le seul mécanisme qui propage aussi les suppressions, là où un fichier
importé ne sait qu'ajouter et remplacer.

| Route | Auth | Rôle |
|---|---|---|
| `POST /api/espaces/:id/calendrier` | clé de l'espace | crée ou renouvelle le jeton, rend l'adresse |
| `PUT /api/espaces/:id/calendrier.ics` | clé de l'espace | dépose un plan à jour |
| `GET /api/espaces/:id/calendrier.ics?jeton=…` | jeton | ce que lit le téléphone |
| `DELETE /api/espaces/:id/calendrier` | clé de l'espace | révoque |

Le jeton vit dans l'adresse : un abonnement ne sait pas envoyer d'en-tête. Il
est distinct de la clé de synchronisation, donc révocable sans casser le
partage. Qui détient l'adresse lit le plan de repas.

C'est l'application qui fabrique le fichier ; le serveur ne fait que le garder.
Il n'y a donc pas deux versions de la même logique de génération à maintenir
d'accord.

**Règle qui gouverne le reste : ne jamais servir un calendrier vide par
erreur.** Espace introuvable, jeton invalide, rien de déposé → une erreur en
texte brut, jamais un `BEGIN:VCALENDAR` sans événement. Un abonné qui reçoit
« 0 repas » vide son calendrier, alarmes comprises ; un abonné qui reçoit une
erreur garde ce qu'il a. Serveur éteint ou données perdues doivent donc figer,
pas effacer.

## Sécurité : ce que ce serveur fait et ne fait pas

**Il fait.** Chaque espace a une clé aléatoire de 32 caractères, exigée à chaque
requête. Le serveur n'en garde qu'une empreinte SHA-256 : un accès en lecture
aux fichiers ne révèle aucune clé. Les écritures d'un même espace sont
sérialisées, et les fichiers remplacés de façon atomique.

**Il ne fait pas.** Il n'y a **ni comptes ni rôles** : la clé vaut l'accès, en
lecture comme en écriture. Qui reçoit un lien de partage peut tout voir et tout
modifier, et rien ne permet de le lui retirer ensuite sinon recréer un espace.
Il n'y a pas non plus de limitation de débit : à exposer sur Internet ouvert,
placer un reverse proxy devant.

C'est le compromis assumé de cette étape. Des comptes et des rôles supposent une
authentification, c'est le chantier suivant.

## L'API

Authentification : `Authorization: Bearer <clé>`.

| | |
|---|---|
| `POST /api/espaces` | Crée un espace. Corps : `{nom, document}`. Renvoie `{id, cle, nom, version}`. |
| `GET /api/espaces/:id?depuis=N` | Renvoie les opérations postérieures à `N`, ou le document complet si `N` est trop ancien. |
| `POST /api/espaces/:id/operations` | Corps : `{operations, auteur}`. Renvoie `{version}`. |
| `GET /api/sante` | État du service. |

Une opération est un chemin et une valeur : `{c: ["semaine","coches","ing_riz"], v: true}`,
ou `{c: [...], d: true}` pour une suppression. Deux modifications sur des chemins
différents fusionnent sans se marcher dessus ; sur le même chemin, la dernière
arrivée l'emporte.

Le journal conserve les 500 dernières opérations. Un client plus en retard que ça
reçoit le document complet.

## Changer de plateforme

Le client ne connaît que ces quatre routes. Réimplémenter le même contrat sur
Supabase, Firebase ou autre ne demande de toucher à aucune ligne de
`liste-courses.html` — c'est la raison d'être du contrat.
