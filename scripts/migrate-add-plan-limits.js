// Migration additive et idempotente : compteurs de quota IA par entreprise
// (forfaits Starter/Business/Pro avec limites). Sans effet sur les données
// existantes.
import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }

const statements = [
  'ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ai_messages_used INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ai_usage_reset_at TIMESTAMPTZ NOT NULL DEFAULT now()',
];

const client = new Client({ connectionString: url });
try {
  await client.connect();
  await client.query('BEGIN');
  for (const stmt of statements) {
    await client.query(stmt);
    console.log('OK:', stmt);
  }
  await client.query('COMMIT');
  console.log('Migration forfaits avec limites appliquée.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
