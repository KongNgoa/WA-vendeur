// Migration additive et idempotente : table 'sessions' (persistance des
// connexions, pour ne plus déconnecter tout le monde à chaque redéploiement)
// + colonne 'ai_auto_reply_enabled' (réponse automatique par IA aux messages
// WhatsApp entrants). Sans effet sur les données existantes.
import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }

const statements = [
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_auto_reply_enabled BOOLEAN NOT NULL DEFAULT true',
  `CREATE TABLE IF NOT EXISTS sessions (
     token TEXT PRIMARY KEY,
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  'CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at)',
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
  console.log('Migration sessions + réponse IA automatique appliquée.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
