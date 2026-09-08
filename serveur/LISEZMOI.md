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
2. **Un disque qui persiste.** Le dossier `--donnees` doit survivre aux
   redémarrages. Sur les hébergeurs à système de fichiers éphémère, monter un
   volume — sinon les espaces disparaissent au premier redéploiement.

Sauvegarde : copier le dossier `--donnees`. Rien d'autre n'est à conserver.

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
