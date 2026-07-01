# GeoJSON persistants dans PostgreSQL

Cette version n'enregistre plus les nouveaux imports cadastraux dans `/uploads`.

## Fonctionnement

- Import depuis l'interface d'administration.
- Validation du `FeatureCollection` par le backend.
- Compression GZIP et stockage dans `cadastre_geojson_files` sur PostgreSQL OVH.
- Création automatique de l'entité `CadastreCommunal`.
- URL stable : `/api/cadastre/geojson/<uuid>`.
- Mise en cache hors ligne par le service worker mobile.

## Anciennes sections

Les anciennes sections dont `geojson_url` contient `/uploads/` doivent être réimportées depuis l'interface, car les fichiers Render peuvent avoir disparu.

Requête de contrôle :

```sql
SELECT id, data->>'commune', data->>'nom_section', data->>'geojson_url'
FROM base44_records
WHERE entity='CadastreCommunal'
  AND data->>'geojson_url' LIKE '%/uploads/%';
```

Après réimport et vérification, supprimer les anciennes lignes concernées depuis l'interface ou avec une requête SQL ciblée.
