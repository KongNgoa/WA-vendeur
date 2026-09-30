// Migration additive et idempotente : fonctionnalités inspirées des
// meilleures pratiques des concurrents africains/globaux (catalogue
// interactif WhatsApp, relance automatique réellement envoyée, paiement
// mobile money propre à chaque entreprise, prise de rendez-vous
// automatisée). Sans effet sur les données existantes. Appliquée
// automatiquement au démarrage du serveur (voir ensureMigrations() dans
// server.js) — ce script n'est utile que pour l'appliquer manuellement hors
// déploiement.
import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }

const statements = [
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_orange_money TEXT',
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_mtn_momo TEXT',
  `CREATE TABLE IF NOT EXISTS appointments (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
     conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
     type TEXT NOT NULL DEFAULT 'Rendez-vous',
     scheduled_at TIMESTAMPTZ,
     status TEXT NOT NULL DEFAULT 'Proposé',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  'CREATE INDEX IF NOT EXISTS appointments_company_idx ON appointments(company_id, scheduled_at)',
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
  console.log('Migration fonctionnalités concurrentielles appliquée.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
