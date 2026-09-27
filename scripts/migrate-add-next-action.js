// Migration additive et idempotente : ajoute les colonnes du moteur d'action
// commerciale (/api/ai/next-action) à la table prospects sur une base déjà
// déployée, sans rejouer schema.sql en entier (ce qui échouerait sur les
// CREATE TABLE déjà existants). Peut être exécutée plusieurs fois sans risque.
import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }

const statements = [
  'ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action TEXT',
  'ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_priority TEXT',
  'ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_reason TEXT',
  'ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ',
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
  console.log('Migration next-action appliquée.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
