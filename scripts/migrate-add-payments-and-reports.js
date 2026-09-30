// Migration additive et idempotente : tunnel de paiement mobile money
// (inscription en libre-service, validation par le super-admin) et
// rapports quotidiens (utilise la table app_state déjà présente). Sans
// effet sur les données existantes. Appliquée automatiquement au démarrage
// du serveur (voir ensureMigrations() dans server.js) — ce script n'est
// utile que pour l'appliquer manuellement hors déploiement.
import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }

const statements = [
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ',
  `CREATE TABLE IF NOT EXISTS payment_requests (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     plan TEXT NOT NULL CHECK(plan IN ('Starter','Business','Pro')),
     method TEXT NOT NULL CHECK(method IN ('orange_money','mtn_momo')),
     amount NUMERIC(14,2) NOT NULL,
     payer_phone TEXT,
     reference TEXT,
     status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     decided_at TIMESTAMPTZ
   )`,
  'CREATE INDEX IF NOT EXISTS payment_requests_status_idx ON payment_requests(status)',
  // N'approuve que les entreprises SANS demande de paiement (créées avant ce
  // lot, ou directement par le super-admin) — jamais les nouvelles
  // inscriptions en attente, qui ont toujours une ligne dans payment_requests.
  `UPDATE companies SET approved_at = COALESCE(approved_at, created_at)
     WHERE approved_at IS NULL AND id NOT IN (SELECT company_id FROM payment_requests)`,
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
  console.log('Migration paiements/rapports appliquée.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
