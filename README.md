# Liste de courses

Composer sa semaine de repas et en tirer la liste de courses : quantités
additionnées, unités harmonisées, tri par rayon, coût estimé.

## Ce que contient le dépôt

| Fichier | Rôle |
|---|---|
| `liste-courses.html` | L'application entière. Ouvrable par double-clic, sans serveur ni réseau. |
| `index.html` | Point d'entrée du site hébergé : redirige vers l'application. |
| `manifest.webmanifest` | Nom, icônes et mode plein écran pour l'installation sur téléphone. |
| `sw.js` | Service worker : rend l'application disponible hors ligne. |
| `icone-*.png` | Icônes d'installation. |
| `serveur/` | Serveur de synchronisation, facultatif. Voir `serveur/LISEZMOI.md`. |
| `package.json`, `Dockerfile` | Pour déployer le tout comme un seul service. |

## Deux façons de s'en servir

**En local.** Double-cliquer `liste-courses.html`. Tout fonctionne, les données
restent dans ce navigateur, sur cet appareil. Aucun réseau n'est contacté.

**Hébergée.** Publier le dépôt sur n'importe quel hébergeur statique
(GitHub Pages, Netlify, Cloudflare Pages). L'application devient installable sur
l'écran d'accueil d'un téléphone et fonctionne hors ligne.

### Installer sur iPhone

Ouvrir l'adresse **dans Safari** (les autres navigateurs iOS ne savent pas le
faire), puis Partager → « Sur l'écran d'accueil ».

⚠️ **L'application installée et l'onglet Safari ont deux stockages séparés.**
Les données saisies dans Safari ne suivent pas à l'installation. Exporter avant,
importer après — ou attendre la synchronisation, qui règle le problème.

### Sur Android

Chrome propose l'installation de lui-même, ou menu → « Installer l'application ».

## Mise à jour

Le service worker ne bascule jamais de version en pleine session : quand une
nouvelle version est disponible, l'application propose « Recharger » et attend.

Après chaque modification des fichiers, **incrémenter `VERSION` dans `sw.js`** —
c'est ce qui déclenche la mise à jour chez les utilisateurs.

## Partager un espace entre plusieurs personnes

Facultatif, et sans effet tant qu'aucun serveur n'est configuré : par défaut les
données ne quittent pas l'appareil.

1. Déployer le serveur avec `--statique .` : **un seul service sert
   l'application et la synchronisation**, ce qui évite toute question de CORS
   et ne laisse qu'une adresse à partager. Voir `serveur/LISEZMOI.md`.
2. Ouvrir l'application à cette adresse. Elle **détecte son serveur toute
   seule** — rien à saisir.
3. Réglages → « Créer un espace partagé » : les données affichées y sont
   déposées et un lien est produit.
4. Transmettre ce lien. En l'ouvrant, l'autre personne rejoint l'espace.

Si l'application est hébergée ailleurs que le serveur (GitHub Pages d'un côté,
serveur de l'autre), il faut renseigner l'adresse du serveur à la main dans
Réglages. Tout le reste est identique.

Chaque appareil peut connaître plusieurs espaces et basculer de l'un à l'autre
par le bouton en haut de l'écran. « Cet appareil » désigne les données locales,
qui restent intactes et privées.

Deux personnes peuvent cocher la même liste en même temps : les modifications se
fusionnent chemin par chemin. Hors ligne — un magasin sans réseau — tout continue
de fonctionner et repart tout seul à la reconnexion.

⚠️ **Le lien de partage fait office de clé.** Il n'y a pas de comptes : qui l'a
peut tout voir et tout modifier.

## Sauvegarde

Les données vivent dans le navigateur. L'export JSON (onglet Réglages) est la
seule sauvegarde : en faire un de temps en temps, et avant toute manipulation.
