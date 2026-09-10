# Serveur de synchronisation

Node seul, **aucune dépendance**. Il stocke un fichier JSON par espace et sert,
si on le lui demande, l'application elle-même.

```bash
node serveur/serveur.js --port 8787 --donnees ./donnees --statique .
```

| Option | Défaut | Rôle |
|---|---|---|
| `--port` | `8787` (ou `$PORT`) | Port d'écoute |
| `--hote` | `0.0.0.0` (ou `$HOST`) | Interface |
| `--donnees` | `./donnees` | Dossier des espaces |
| `--statique` | *(aucun)* | Sert aussi l'application depuis ce dossier |

Avec `--statique .`, **tout tient dans un seul service** : pas de CORS à régler,
une seule adresse à partager.

## Déployer

N'importe quel hébergeur qui exécute Node convient : Fly.io, Render, Railway, un
VPS. Deux exigences :

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
   | Fly.io | `fly volumes create donnees --size 1`, puis dans `fly.toml` : `[mounts] source="donnees" destination="/donnees"` |
   | Render | Ajouter un *Disk*, chemin de montage `/donnees` (indisponible sur l'offre gratuite) |
   | Railway | Ajouter un *Volume* monté sur `/donnees` |
   | VPS / Docker | `docker run -v listecourses:/donnees …` |

   L'image fixe déjà `DONNEES=/donnees` : il n'y a que le volume à monter.

**Si les espaces ont déjà disparu.** Rien n'est perdu tant qu'un appareil a
encore l'espace : l'application y détecte l'état « espace perdu sur le serveur »
et propose **Reconstruire l'espace**, sous Plus → Partage & synchronisation.
L'espace est recréé avec le même identifiant et la même clé, donc les liens
déjà envoyés fonctionnent à nouveau. Montez le volume d'abord, sinon la perte
se reproduira au déploiement suivant.

Sauvegarde : copier le dossier `--donnees`. Rien d'autre n'est à conserver.

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
