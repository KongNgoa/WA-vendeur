import { readFile } from 'node:fs/promises';
import pg from 'pg';
const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL est requis.'); process.exit(1); }
const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const client = new Client({ connectionString: url });
try {
  await client.connect();
  await client.query(sql);
  console.log('Schéma PostgreSQL appliqué.');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(()=>{});
}
