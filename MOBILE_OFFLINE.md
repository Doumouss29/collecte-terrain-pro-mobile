# Version mobile hors ligne

## Fonctionnement
- PWA installable sur Android/iOS.
- Interface, données GET déjà consultées et GeoJSON déjà ouverts mis en cache.
- Authentification locale après une première connexion réussie.
- Collectes et photos compressées conservées dans IndexedDB.
- Synchronisation automatique au retour du réseau et écran `SyncOffline`.

## Installation mobile
1. Ouvrir l’application en ligne une première fois.
2. Se connecter et ouvrir les sections cadastrales nécessaires.
3. Android/Chrome : menu > Ajouter à l’écran d’accueil.
4. iPhone/Safari : Partager > Sur l’écran d’accueil.

## Important
Les fonds de carte distants ne sont disponibles hors ligne que s’ils ont déjà été chargés. Les polygones GeoJSON consultés sont mis en cache.
