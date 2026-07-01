CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS base44_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_base44_records_entity
  ON base44_records(entity);
CREATE INDEX IF NOT EXISTS idx_base44_records_data_gin
  ON base44_records USING gin(data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_base44_records_email
  ON base44_records ((data->>'email'))
  WHERE data ? 'email';

-- L'utilisateur administrateur est créé automatiquement au premier appel /api/auth/me.

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  full_name text,
  first_name text,
  last_name text,
  role text NOT NULL DEFAULT 'agent',
  status text NOT NULL DEFAULT 'actif',
  organisation_id uuid,
  communes_supervisees jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(lower(email));


CREATE TABLE IF NOT EXISTS cadastre_geojson_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id text NOT NULL,
  commune text NOT NULL,
  nom_section text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/geo+json',
  content_compressed bytea NOT NULL,
  original_size_bytes bigint NOT NULL DEFAULT 0,
  compressed_size_bytes bigint NOT NULL DEFAULT 0,
  feature_count integer NOT NULL DEFAULT 0,
  sha256 text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cadastre_geojson_org
  ON cadastre_geojson_files (organisation_id);
CREATE INDEX IF NOT EXISTS idx_cadastre_geojson_commune
  ON cadastre_geojson_files (organisation_id, commune);
CREATE INDEX IF NOT EXISTS idx_cadastre_geojson_section
  ON cadastre_geojson_files (organisation_id, commune, nom_section);
