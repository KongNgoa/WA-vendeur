import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }
const client = new Client({ connectionString: url });
try {
  await client.connect();
  const r = await client.query(`SELECT current_database() AS database, current_user AS user, COUNT(*)::int AS tables FROM information_schema.tables WHERE table_schema='public'`);
  console.log(JSON.stringify({ok:true,...r.rows[0]}));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally { await client.end().catch(()=>{}); }
