// Migration additive et idempotente : ajoute les colonnes du lot "relances
// automatiques contrôlées" (source, cancelled_reason) à la table followups
// sur une base déjà déployée, sans rejouer schema.sql en entier.
import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }

const statements = [
  "ALTER TABLE followups ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'",
  'ALTER TABLE followups ADD COLUMN IF NOT EXISTS cancelled_reason TEXT',
  'CREATE INDEX IF NOT EXISTS followups_source_idx ON followups(company_id, prospect_id, status, source)',
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
  console.log('Migration relances automatiques appliquée.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
