import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import pg from 'pg';
import PDFDocument from 'pdfkit';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3001);
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL est obligatoire');
}

const shouldUseSsl =
  process.env.DATABASE_SSL === 'true' ||
  connectionString.includes('sslmode=require') ||
  process.env.NODE_ENV === 'production';

const pool = new pg.Pool({
  connectionString,
  ssl: shouldUseSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
});

app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true,
}));
app.use(express.json({ limit: '35mb' }));
app.use(cookieParser());
app.use('/uploads', express.static(uploadDir, { maxAge: '30d', immutable: false }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });
const geojsonUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const validExtension = /\.(geojson|json)$/i.test(file.originalname || '');
    const validMime = [
      'application/json',
      'application/geo+json',
      'application/octet-stream',
      'text/plain',
    ].includes(file.mimetype);

    if (!validExtension && !validMime) {
      return cb(new Error('Seuls les fichiers .geojson et .json sont acceptés'));
    }

    cb(null, true);
  },
});

function normalize(row) {
  return {
    id: row.id,
    ...row.data,
    created_date: row.created_date,
    updated_date: row.updated_date,
  };
}

function applyFilter(records, filter = {}) {
  if (!filter || Object.keys(filter).length === 0) return records;
  return records.filter((record) =>
    Object.entries(filter).every(([key, expected]) => {
      const current = record[key];
      if (Array.isArray(expected)) return expected.includes(current);
      if (expected && typeof expected === 'object' && '$in' in expected) {
        return expected.$in.includes(current);
      }
      return current === expected;
    })
  );
}

function applySort(records, sort) {
  if (!sort) return records;
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  return [...records].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (av == null && bv == null) return 0;
    if (av == null) return desc ? 1 : -1;
    if (bv == null) return desc ? -1 : 1;
    if (av < bv) return desc ? 1 : -1;
    if (av > bv) return desc ? -1 : 1;
    return 0;
  });
}

const AUTH_COOKIE = 'lm_session';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const INVITATION_TTL_DAYS = Number(process.env.INVITATION_TTL_DAYS || 7);

async function ensureCadastreGeojsonSchema() {
  await pool.query(`
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
  `);
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
    status: row.status,
    organisation_id: row.organisation_id,
    communes_supervisees: row.communes_supervisees || [],
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

async function ensureAuthSchema() {
  await pool.query(`
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
  `);
}

async function syncBase44User(user) {
  const data = publicUser(user);
  const existing = await pool.query(
    "SELECT id FROM base44_records WHERE entity='User' AND lower(data->>'email')=lower($1) LIMIT 1",
    [user.email]
  );
  if (existing.rows.length) {
    await pool.query(
      'UPDATE base44_records SET data=$1::jsonb, updated_date=now() WHERE id=$2',
      [JSON.stringify(data), existing.rows[0].id]
    );
  } else {
    await pool.query(
      "INSERT INTO base44_records(entity, data) VALUES('User', $1::jsonb)",
      [JSON.stringify(data)]
    );
  }
}

async function ensureInitialAdmin() {
  const email = (
    process.env.ADMIN_EMAIL ||
    process.env.DEV_USER_EMAIL ||
    'admin@local.test'
  ).toLowerCase();

  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.warn('ADMIN_PASSWORD non défini : aucun compte initial ne sera créé automatiquement.');
    return;
  }

  const found = await pool.query(
    'SELECT * FROM app_users WHERE lower(email)=lower($1) LIMIT 1',
    [email]
  );

  if (found.rows.length) {
    await syncBase44User(found.rows[0]);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const created = await pool.query(
    `INSERT INTO app_users(
      email,password_hash,full_name,first_name,last_name,role,status
    )
    VALUES($1,$2,$3,$4,$5,$6,'actif')
    RETURNING *`,
    [
      email,
      passwordHash,
      process.env.ADMIN_NAME || process.env.DEV_USER_NAME || 'Administrateur Collecte',
      process.env.ADMIN_FIRST_NAME || process.env.DEV_USER_FIRST_NAME || 'Administrateur',
      process.env.ADMIN_LAST_NAME || process.env.DEV_USER_LAST_NAME || 'Collecte',
      process.env.ADMIN_ROLE || process.env.DEV_USER_ROLE || 'admin',
    ]
  );

  await syncBase44User(created.rows[0]);
  console.log(`Compte administrateur initial créé : ${email}`);
}

function createSessionToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function setSessionCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[AUTH_COOKIE];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'SELECT * FROM app_users WHERE id=$1 AND status=$2 LIMIT 1',
      [payload.sub, 'actif']
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Session invalide' });
    }

    req.user = result.rows[0];
    next();
  } catch (_error) {
    res.status(401).json({ error: 'Session expirée ou invalide' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Droits administrateur requis' });
  }
  next();
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicAppUrl() {
  return (
    process.env.APP_URL ||
    process.env.PUBLIC_BASE_URL ||
    `http://localhost:${PORT}`
  ).replace(/\/+$/, '');
}

async function createCollectePdf(collecteId) {
  const result = await pool.query(
    "SELECT * FROM base44_records WHERE entity='Collecte' AND id=$1 LIMIT 1",
    [collecteId]
  );
  if (!result.rows.length) throw new Error('Collecte introuvable');
  const collecte = normalize(result.rows[0]);

  const doc = new PDFDocument({ margin: 45, size: 'A4' });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.fontSize(18).text('Rapport de collecte terrain', { align: 'center' });
  doc.moveDown();
  const fields = [
    ['Identifiant', collecte.id],
    ['Commune', collecte.commune],
    ['Section', collecte.section],
    ['Parcelle', collecte.parcelle],
    ['Lot', collecte.lot],
    ['Îlot', collecte.ilot],
    ['Quartier', collecte.quartier],
    ['Statut', collecte.statut],
    ['Agent', collecte.created_by],
    ['Date de création', collecte.created_date],
    ['Propriétaire', [collecte.prop_nom, collecte.prop_prenoms].filter(Boolean).join(' ')],
    ['Téléphone', collecte.prop_tel],
  ];

  doc.fontSize(11);
  for (const [label, value] of fields) {
    if (value !== undefined && value !== null && value !== '') {
      doc.font('Helvetica-Bold').text(`${label} :`, { continued: true });
      doc.font('Helvetica').text(` ${String(value)}`);
    }
  }

  doc.moveDown();
  doc.fontSize(8).fillColor('gray').text('Document généré par Collecte Terrain Pro.');
  doc.end();
  return completed;
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: 'error',
      error: error.message,
    });
  }
});

app.get('/api/apps/public/prod/public-settings/by-id/:appId', (req, res) => {
  res.json({
    id: req.params.appId || 'local',
    public_settings: { requiresAuth: true },
  });
});

/* ------------------------- AUTHENTIFICATION ------------------------- */

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email et mot de passe obligatoires',
      });
    }

    const result = await pool.query(
      'SELECT * FROM app_users WHERE lower(email)=lower($1) LIMIT 1',
      [email]
    );

    if (!result.rows.length || result.rows[0].status !== 'actif') {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    setSessionCookie(res, createSessionToken(user));
    await syncBase44User(user);
    res.json(publicUser(user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json(publicUser(req.user));
});

app.patch('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    const allowed = [
      'full_name',
      'first_name',
      'last_name',
      'organisation_id',
      'communes_supervisees',
    ];

    const values = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) => allowed.includes(key))
    );

    const result = await pool.query(
      `UPDATE app_users SET
       full_name=COALESCE($1,full_name),
       first_name=COALESCE($2,first_name),
       last_name=COALESCE($3,last_name),
       organisation_id=COALESCE($4,organisation_id),
       communes_supervisees=COALESCE($5::jsonb,communes_supervisees),
       updated_at=now()
       WHERE id=$6
       RETURNING *`,
      [
        values.full_name,
        values.first_name,
        values.last_name,
        values.organisation_id,
        values.communes_supervisees
          ? JSON.stringify(values.communes_supervisees)
          : null,
        req.user.id,
      ]
    );

    await syncBase44User(result.rows[0]);
    res.json(publicUser(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/app-logs', (_req, res) => res.json({ ok: true }));

/* ------------------------- INVITATIONS ------------------------- */

app.post(
  '/api/users/invite',
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const normalizedEmail = String(req.body?.email || '')
        .trim()
        .toLowerCase();

      const role = String(req.body?.role || 'agent');
      const organisationId =
        req.body?.organisation_id ||
        req.body?.organisationId ||
        null;

      if (!normalizedEmail) {
        return res.status(400).json({ error: 'Email obligatoire' });
      }

      const existingUser = await pool.query(
        'SELECT id FROM app_users WHERE lower(email)=lower($1) LIMIT 1',
        [normalizedEmail]
      );

      if (existingUser.rows.length) {
        return res.status(409).json({
          error: 'Un utilisateur existe déjà avec cette adresse email',
        });
      }

      const rawToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = tokenHash(rawToken);
      const expiresAt = new Date(
        Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();

      const invitationData = {
        email: normalizedEmail,
        role,
        organisation_id: organisationId,
        token_hash: hashedToken,
        status: 'pending',
        statut: 'en_attente',
        expires_at: expiresAt,
        invited_by: req.user.email,
      };

      const existingInvitation = await pool.query(
        `SELECT id
         FROM base44_records
         WHERE entity='Invitation'
           AND lower(data->>'email')=lower($1)
           AND data->>'status'='pending'
         LIMIT 1`,
        [normalizedEmail]
      );

      let invitationRow;
      if (existingInvitation.rows.length) {
        const updated = await pool.query(
          `UPDATE base44_records
           SET data=$1::jsonb, updated_date=now()
           WHERE id=$2
           RETURNING *`,
          [
            JSON.stringify(invitationData),
            existingInvitation.rows[0].id,
          ]
        );
        invitationRow = updated.rows[0];
      } else {
        const created = await pool.query(
          `INSERT INTO base44_records(entity, data)
           VALUES('Invitation', $1::jsonb)
           RETURNING *`,
          [JSON.stringify(invitationData)]
        );
        invitationRow = created.rows[0];
      }

      const invitationUrl =
        `${publicAppUrl()}/accept-invitation?token=${encodeURIComponent(rawToken)}`;

      res.status(201).json({
        ok: true,
        invitation: normalize(invitationRow),
        invitation_url: invitationUrl,
        message: 'Invitation créée. Copiez ce lien et transmettez-le à l’utilisateur.',
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get('/api/invitations/:token', async (req, res, next) => {
  try {
    const hashedToken = tokenHash(req.params.token);

    const result = await pool.query(
      `SELECT *
       FROM base44_records
       WHERE entity='Invitation'
         AND data->>'token_hash'=$1
         AND data->>'status'='pending'
       LIMIT 1`,
      [hashedToken]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: 'Invitation introuvable, expirée ou déjà utilisée',
      });
    }

    const invitation = normalize(result.rows[0]);

    if (
      invitation.expires_at &&
      new Date(invitation.expires_at).getTime() < Date.now()
    ) {
      return res.status(410).json({ error: 'Cette invitation a expiré' });
    }

    res.json({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      organisation_id: invitation.organisation_id,
      status: invitation.status,
      expires_at: invitation.expires_at,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/invitations/:token/accept', async (req, res, next) => {
  const client = await pool.connect();

  try {
    const password = String(req.body?.password || '');
    const firstName = String(req.body?.first_name || '').trim();
    const lastName = String(req.body?.last_name || '').trim();

    if (password.length < 8) {
      return res.status(400).json({
        error: 'Le mot de passe doit contenir au moins 8 caractères',
      });
    }

    const hashedToken = tokenHash(req.params.token);
    await client.query('BEGIN');

    const invitationResult = await client.query(
      `SELECT *
       FROM base44_records
       WHERE entity='Invitation'
         AND data->>'token_hash'=$1
         AND data->>'status'='pending'
       LIMIT 1
       FOR UPDATE`,
      [hashedToken]
    );

    if (!invitationResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Invitation introuvable, expirée ou déjà utilisée',
      });
    }

    const invitationRow = invitationResult.rows[0];
    const invitation = normalize(invitationRow);

    if (
      invitation.expires_at &&
      new Date(invitation.expires_at).getTime() < Date.now()
    ) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Cette invitation a expiré' });
    }

    const existingUser = await client.query(
      'SELECT id FROM app_users WHERE lower(email)=lower($1) LIMIT 1',
      [invitation.email]
    );

    if (existingUser.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Un utilisateur existe déjà avec cette adresse email',
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const fullName =
      [firstName, lastName].filter(Boolean).join(' ') || invitation.email;

    const userResult = await client.query(
      `INSERT INTO app_users(
        email,password_hash,first_name,last_name,full_name,
        role,status,organisation_id
      )
      VALUES($1,$2,$3,$4,$5,$6,'actif',$7)
      RETURNING *`,
      [
        invitation.email,
        passwordHash,
        firstName,
        lastName,
        fullName,
        invitation.role || 'agent',
        invitation.organisation_id || null,
      ]
    );

    const createdUser = userResult.rows[0];

    const base44UserData = publicUser(createdUser);
    await client.query(
      `INSERT INTO base44_records(entity, data)
       VALUES('User', $1::jsonb)`,
      [JSON.stringify(base44UserData)]
    );

    await client.query(
      `UPDATE base44_records
       SET data=data || $1::jsonb, updated_date=now()
       WHERE id=$2`,
      [
        JSON.stringify({
          status: 'accepted',
          statut: 'acceptee',
          accepted_at: new Date().toISOString(),
          accepted_user_id: createdUser.id,
        }),
        invitationRow.id,
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      ok: true,
      user: publicUser(createdUser),
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Un utilisateur existe déjà avec cette adresse email',
      });
    }

    next(error);
  } finally {
    client.release();
  }
});

/* ------------------------- GEOJSON CADASTRAL PERSISTANT ------------------------- */

app.post(
  '/api/cadastre/geojson',
  requireAuth,
  requireAdmin,
  geojsonUpload.single('file'),
  async (req, res, next) => {
    const client = await pool.connect();

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Fichier GeoJSON manquant' });
      }

      const organisationId = String(req.body.organisation_id || '').trim();
      const commune = String(req.body.commune || '').trim().toUpperCase();
      const nomSection = String(req.body.nom_section || '').trim().toUpperCase();

      if (!organisationId || !commune || !nomSection) {
        return res.status(400).json({
          error: 'organisation_id, commune et nom_section sont obligatoires',
        });
      }

      let geojson;
      try {
        geojson = JSON.parse(req.file.buffer.toString('utf8'));
      } catch (_error) {
        return res.status(400).json({ error: 'Le fichier ne contient pas un JSON valide' });
      }

      if (
        !geojson ||
        geojson.type !== 'FeatureCollection' ||
        !Array.isArray(geojson.features)
      ) {
        return res.status(400).json({
          error: 'Le fichier doit être un GeoJSON FeatureCollection valide',
        });
      }

      const canonicalBuffer = Buffer.from(JSON.stringify(geojson), 'utf8');
      const compressed = zlib.gzipSync(canonicalBuffer, { level: 9 });
      const sha256 = crypto.createHash('sha256').update(canonicalBuffer).digest('hex');
      const safeFilename = (req.file.originalname || `${nomSection}.geojson`)
        .replace(/[^a-zA-Z0-9._-]/g, '_');

      await client.query('BEGIN');

      const fileResult = await client.query(
        `INSERT INTO cadastre_geojson_files (
           organisation_id,
           commune,
           nom_section,
           filename,
           content_type,
           content_compressed,
           original_size_bytes,
           compressed_size_bytes,
           feature_count,
           sha256,
           created_by
         )
         VALUES ($1,$2,$3,$4,'application/geo+json',$5,$6,$7,$8,$9,$10)
         RETURNING id, filename, feature_count, sha256, created_at`,
        [
          organisationId,
          commune,
          nomSection,
          safeFilename,
          compressed,
          canonicalBuffer.length,
          compressed.length,
          geojson.features.length,
          sha256,
          req.user.email,
        ]
      );

      const fileRow = fileResult.rows[0];
      const geojsonUrl = `/api/cadastre/geojson/${fileRow.id}`;

      const cadastreData = {
        organisation_id: organisationId,
        commune,
        nom_section: nomSection,
        nombre_parcelles: geojson.features.length,
        geojson_url: geojsonUrl,
        geojson_file_id: fileRow.id,
        geojson_storage: 'postgresql',
        geojson_sha256: sha256,
        filename: safeFilename,
        created_by: req.user.email,
      };

      const cadastreResult = await client.query(
        `INSERT INTO base44_records(entity, data)
         VALUES('CadastreCommunal', $1::jsonb)
         RETURNING *`,
        [JSON.stringify(cadastreData)]
      );

      await client.query('COMMIT');

      res.status(201).json({
        ok: true,
        geojson_file_id: fileRow.id,
        geojson_url: geojsonUrl,
        nombre_parcelles: geojson.features.length,
        sha256,
        cadastre: normalize(cadastreResult.rows[0]),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  }
);

app.get(
  '/api/cadastre/geojson/:id',
  requireAuth,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT *
         FROM cadastre_geojson_files
         WHERE id=$1
         LIMIT 1`,
        [req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'Fichier GeoJSON introuvable' });
      }

      const row = result.rows[0];
      const etag = `\"${row.sha256}\"`;

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      const content = zlib.gunzipSync(row.content_compressed);

      res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
      res.setHeader('Content-Length', String(content.length));
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
      res.setHeader('X-GeoJSON-SHA256', row.sha256);
      res.send(content);
    } catch (error) {
      next(error);
    }
  }
);

/* ------------------------- ENTITÉS ------------------------- */

app.get('/api/entities/:entity', requireAuth, async (req, res, next) => {
  try {
    const { entity } = req.params;
    const filter = req.query.filter ? JSON.parse(req.query.filter) : {};
    const sort = req.query.sort || '';
    const limit = req.query.limit
      ? Number(req.query.limit)
      : undefined;

    const result = await pool.query(
      'SELECT * FROM base44_records WHERE entity=$1',
      [entity]
    );

    let rows = result.rows.map(normalize);
    rows = applyFilter(rows, filter);
    rows = applySort(rows, sort);

    if (limit) rows = rows.slice(0, limit);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/entities/:entity', requireAuth, async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { entity } = req.params;
    const body = { ...(req.body || {}) };

    if (!body.created_by) {
      body.created_by = req.user.email;
    }

    // Idempotence des collectes synchronisées hors ligne.
    // Le même offline_sync_id renvoie toujours la même ligne, même si le
    // téléphone répète la requête ou si deux synchronisations se chevauchent.
    if (entity === 'Collecte' && body.offline_sync_id) {
      const syncId = String(body.offline_sync_id).trim();
      body.offline_sync_id = syncId;

      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`Collecte:${syncId}`]
      );

      const existing = await client.query(
        `SELECT *
         FROM base44_records
         WHERE entity = 'Collecte'
           AND data->>'offline_sync_id' = $1
         LIMIT 1`,
        [syncId]
      );

      if (existing.rows.length) {
        await client.query('COMMIT');
        return res.status(200).json(normalize(existing.rows[0]));
      }

      const inserted = await client.query(
        `INSERT INTO base44_records(entity, data)
         VALUES('Collecte', $1::jsonb)
         RETURNING *`,
        [JSON.stringify(body)]
      );

      await client.query('COMMIT');
      return res.status(201).json(normalize(inserted.rows[0]));
    }

    const result = await client.query(
      `INSERT INTO base44_records(entity, data)
       VALUES($1, $2::jsonb)
       RETURNING *`,
      [entity, JSON.stringify(body)]
    );

    res.status(201).json(normalize(result.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error);
  } finally {
    client.release();
  }
});

app.patch(
  '/api/entities/:entity/:id',
  requireAuth,
  async (req, res, next) => {
    try {
      const { entity, id } = req.params;

      // Les utilisateurs existent dans app_users (authentification) et dans
      // base44_records (interface). Toute modification doit rester synchronisée.
      if (entity === 'User') {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ error: 'Accès administrateur requis' });
        }

        // L'identifiant envoyé par l'interface peut être :
        // - l'id de base44_records ;
        // - ou l'id de app_users conservé dans data.id.
        // On accepte les deux pour éviter l'erreur "Utilisateur introuvable".
        const record = await pool.query(
          `SELECT *
           FROM base44_records
           WHERE entity='User'
             AND (
               id::text = $1
               OR data->>'id' = $1
             )
           LIMIT 1`,
          [String(id)]
        );

        let currentData = record.rows[0]?.data || null;
        let email = currentData?.email || null;

        // Sécurité supplémentaire : si le User miroir n'existe pas encore,
        // on recherche directement le compte d'authentification.
        if (!email) {
          const account = await pool.query(
            `SELECT *
             FROM app_users
             WHERE id::text = $1
             LIMIT 1`,
            [String(id)]
          );

          if (!account.rows.length) {
            return res.status(404).json({ error: 'Utilisateur introuvable' });
          }

          email = account.rows[0].email;
          currentData = publicUser(account.rows[0]);
        }

        const body = req.body || {};
        const hasOrganisation = Object.prototype.hasOwnProperty.call(body, 'organisation_id');
        const hasRole = Object.prototype.hasOwnProperty.call(body, 'role');
        const hasCommunes = Object.prototype.hasOwnProperty.call(body, 'communes_supervisees');
        const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');

        const updatedUser = await pool.query(
          `UPDATE app_users SET
             organisation_id = CASE WHEN $1 THEN $2::uuid ELSE organisation_id END,
             role = CASE WHEN $3 THEN $4 ELSE role END,
             communes_supervisees = CASE WHEN $5 THEN $6::jsonb ELSE communes_supervisees END,
             status = CASE WHEN $7 THEN $8 ELSE status END,
             updated_at = now()
           WHERE lower(email)=lower($9)
           RETURNING *`,
          [
            hasOrganisation,
            body.organisation_id || null,
            hasRole,
            body.role || null,
            hasCommunes,
            JSON.stringify(body.communes_supervisees || []),
            hasStatus,
            body.status || null,
            email,
          ]
        );

        if (!updatedUser.rows.length) {
          return res.status(404).json({ error: 'Compte authentifié introuvable' });
        }

        await syncBase44User(updatedUser.rows[0]);
        return res.json(publicUser(updatedUser.rows[0]));
      }

      const result = await pool.query(
        `UPDATE base44_records
         SET data=data || $1::jsonb, updated_date=now()
         WHERE entity=$2 AND id=$3
         RETURNING *`,
        [JSON.stringify(req.body || {}), entity, id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'Not found' });
      }

      res.json(normalize(result.rows[0]));
    } catch (error) {
      next(error);
    }
  }
);

app.delete(
  '/api/entities/:entity/:id',
  requireAuth,
  async (req, res, next) => {
    try {
      const { entity, id } = req.params;

      if (entity === 'CadastreCommunal') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const record = await client.query(
            `SELECT data FROM base44_records
             WHERE entity='CadastreCommunal' AND id=$1
             LIMIT 1`,
            [id]
          );

          if (!record.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Section cadastrale introuvable' });
          }

          const fileId = record.rows[0].data?.geojson_file_id;
          await client.query(
            `DELETE FROM base44_records
             WHERE entity='CadastreCommunal' AND id=$1`,
            [id]
          );

          if (fileId) {
            await client.query(
              'DELETE FROM cadastre_geojson_files WHERE id=$1',
              [fileId]
            );
          }

          await client.query('COMMIT');
          return res.json({ ok: true, geojson_file_id: fileId || null });
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }

      await pool.query(
        'DELETE FROM base44_records WHERE entity=$1 AND id=$2',
        [entity, id]
      );

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/upload',
  requireAuth,
  upload.single('file'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier manquant' });
    }

    const baseUrl =
      process.env.PUBLIC_BASE_URL ||
      `http://localhost:${PORT}`;

    res.json({
      file_url: `${baseUrl}/uploads/${req.file.filename}`,
    });
  }
);

app.post(
  '/api/functions/:name',
  requireAuth,
  async (req, res, next) => {
    try {
      if (req.params.name === 'exportCollectePdf') {
        const pdf = await createCollectePdf(req.body?.collecteId);

        return res.json({
          data: {
            success: true,
            file: pdf.toString('base64'),
          },
        });
      }

      res.json({
        data: { success: true },
        ok: true,
      });
    } catch (error) {
      next(error);
    }
  }
);

/* ------------------------- FRONTEND ------------------------- */

const distDir = path.join(__dirname, '..', 'dist');

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (filePath.endsWith('.geojson')) res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: error.message || 'Erreur interne',
  });
});

await ensureAuthSchema();
await ensureCadastreGeojsonSchema();
await ensureInitialAdmin();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Collecte Terrain API listening on port ${PORT}`);
});
