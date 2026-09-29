// Migration additive et idempotente : administration d'équipe (transfert du
// rôle owner, limite d'administrateurs par forfait), réinitialisation de
// mot de passe (password_resets) et compte super-admin séparé des
// entreprises clientes (super_admins + sessions.super_admin_id). Sans effet
// sur les données existantes. Appliquée automatiquement au démarrage du
// serveur (voir ensureMigrations() dans server.js) — ce script n'est utile
// que pour l'appliquer manuellement hors déploiement.
import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }

const statements = [
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false',
  `CREATE TABLE IF NOT EXISTS super_admins (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     password_salt TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  'ALTER TABLE sessions ALTER COLUMN user_id DROP NOT NULL',
  'ALTER TABLE sessions ALTER COLUMN company_id DROP NOT NULL',
  'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS super_admin_id UUID REFERENCES super_admins(id) ON DELETE CASCADE',
  `CREATE TABLE IF NOT EXISTS password_resets (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL,
     expires_at TIMESTAMPTZ NOT NULL,
     used_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  'CREATE INDEX IF NOT EXISTS password_resets_token_idx ON password_resets(token_hash)',
];

const client = new Client({ connectionString: url });
try {
  await client.connect();
  await client.query('BEGIN');
  for (const stmt of statements) {
    await client.query(stmt);
    console.log('OK:', stmt.split('\n')[0]);
  }
  await client.query('COMMIT');
  console.log('Migration administration/super-admin appliquée.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
