// Migration additive et idempotente : ajoute les colonnes du lot "envoi
// WhatsApp réel" (phase 3, Meta WhatsApp Cloud API) sur une base déjà
// déployée, sans rejouer schema.sql en entier.
import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }

const statements = [
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT',
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT',
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_verify_token TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS companies_whatsapp_phone_idx ON companies(whatsapp_phone_number_id) WHERE whatsapp_phone_number_id IS NOT NULL',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_error TEXT',
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
  console.log('Migration réglages WhatsApp appliquée.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
