import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, transaction, closeDatabase } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const sessions = new Map();
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@wavendeur.local';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';
const json = (res,status,data) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}); res.end(JSON.stringify(data)); };
const body = async req => { let s=''; for await (const c of req) s += c; if (s.length > 1000000) throw new Error('Payload trop volumineux'); return s ? JSON.parse(s) : {}; };
const hashPassword = (password,salt=crypto.randomBytes(16).toString('hex')) => ({salt,hash:crypto.scryptSync(password,salt,64).toString('hex')});
const verifyPassword = (password,salt,expected) => crypto.timingSafeEqual(Buffer.from(hashPassword(password,salt).hash,'hex'),Buffer.from(expected,'hex'));
const token = () => crypto.randomBytes(32).toString('hex');

async function ensureDemo() {
  return transaction(async client => {
    let c = await client.query('SELECT id FROM companies WHERE name=$1 LIMIT 1',['Boutique Démo Yaoundé']);
    let companyId = c.rows[0]?.id;
    if (!companyId) {
      const r = await client.query("INSERT INTO companies(name,sector,ai_name) VALUES($1,$2,$3) RETURNING id",['Boutique Démo Yaoundé','Mode & accessoires','Julie']);
      companyId = r.rows[0].id;
      const products=[['Nike Air Max','Chaussures',25000,8],['T-shirt Premium','Vêtements',12000,17],['Jean homme','Vêtements',18000,5]];
      for (const p of products) await client.query('INSERT INTO products(company_id,name,category,price,stock) VALUES($1,$2,$3,$4,$5)',[companyId,...p]);
      await client.query('INSERT INTO subscriptions(company_id,plan,status,monthly_price) VALUES($1,$2,$3,$4)',[companyId,'Business','active',25000]);
    }
    let u = await client.query('SELECT id,password_hash,password_salt FROM users WHERE email=$1',[DEMO_EMAIL]);
    if (!u.rows[0]) { const h=hashPassword(DEMO_PASSWORD); await client.query('INSERT INTO users(company_id,email,name,role,password_hash,password_salt) VALUES($1,$2,$3,$4,$5,$6)',[companyId,DEMO_EMAIL,'Administrateur','owner',h.hash,h.salt]); }
    return companyId;
  });
}

async function dashboard(companyId) {
  const [company,products,prospects,orders,conversations,followups,subscription] = await Promise.all([
    query('SELECT id,name,sector,ai_name AS "aiName",ai_tone AS "aiTone" FROM companies WHERE id=$1',[companyId]),
    query('SELECT id,name,category,price,stock FROM products WHERE company_id=$1 ORDER BY created_at DESC',[companyId]),
    query('SELECT id,name,phone,need,value,score,status,order_intent AS "orderIntent",last_contact AS "lastContact" FROM prospects WHERE company_id=$1 ORDER BY score DESC',[companyId]),
    query('SELECT o.id,o.order_number AS number,p.name AS client,o.amount,o.status,o.created_at AS "createdAt" FROM orders o LEFT JOIN prospects p ON p.id=o.prospect_id WHERE o.company_id=$1 ORDER BY o.created_at DESC',[companyId]),
    query(`SELECT c.id,c.external_contact AS phone,p.name,COALESCE(json_agg(json_build_object('id',m.id,'from',m.direction,'text',m.body) ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL),'[]') AS messages FROM conversations c LEFT JOIN prospects p ON p.id=c.prospect_id LEFT JOIN messages m ON m.conversation_id=c.id WHERE c.company_id=$1 GROUP BY c.id,p.name ORDER BY c.created_at DESC`,[companyId]),
    query('SELECT id,due_at AS "dueAt",status,text FROM followups WHERE company_id=$1 ORDER BY due_at NULLS LAST',[companyId]),
    query('SELECT plan,status,monthly_price AS "monthlyPrice",next_billing_at AS "nextBillingAt" FROM subscriptions WHERE company_id=$1',[companyId])
  ]);
  return {company:company.rows[0],products:products.rows,prospects:prospects.rows,orders:orders.rows,conversations:conversations.rows,followups:followups.rows,subscription:subscription.rows[0]};
}

function ai(text, products=[]) { const q=String(text||'').toLowerCase(); if(q.includes('prix')||q.includes('combien')) return products.length ? products.map(p=>`${p.name}: ${Number(p.price).toLocaleString('fr-FR')} FCFA`).join(' · ')+'. Lequel vous intéresse ?' : 'Je peux vous renseigner sur nos produits. Quel article recherchez-vous ?'; if(q.includes('dispon')||q.includes('stock')) return 'Oui, dites-moi le produit souhaité et je vérifie le stock.'; if(q.includes('livr')) return 'Oui. Quel est votre quartier pour organiser la livraison ?'; if(q.includes('acheter')||q.includes('commande')) return 'Avec plaisir. Donnez-moi votre nom, téléphone, produit et localisation pour préparer la commande.'; if(q.includes('humain')||q.includes('conseiller')) return 'Bien sûr. Je transmets votre demande à un conseiller humain.'; return 'Bonjour 👋 Je suis Julie, votre assistante commerciale. Que puis-je faire pour vous ?'; }

async function handler(req,res) {
  if(req.method==='OPTIONS') return json(res,204,{});
  const u=new URL(req.url,`http://${req.headers.host}`);
  if(req.method==='GET'&&u.pathname==='/api/health') return json(res,200,{ok:true,version:'1.5.0',service:'WA-Vendeur',database:'postgresql'});
  if(req.method==='GET'&&u.pathname==='/api/version') return json(res,200,{version:'1.5.0'});
  if(req.method==='GET'&&u.pathname==='/') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await readFile(path.join(__dirname,'public/index.html'))); }
  await ensureDemo();
  if(req.method==='POST'&&u.pathname==='/api/login') { const b=await body(req); const r=await query('SELECT u.id,u.name,u.email,u.company_id,u.password_hash,u.password_salt,c.name AS company_name FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=$1',[b.email]); const user=r.rows[0]; if(!user||!verifyPassword(String(b.password||''),user.password_salt,user.password_hash)) return json(res,401,{error:'Identifiants incorrects'}); const t=token(); sessions.set(t,{userId:user.id,companyId:user.company_id,expires:Date.now()+86400000}); return json(res,200,{token:t,user:{id:user.id,name:user.name,email:user.email,companyId:user.company_id,company:user.company_name}}); }
  const auth=(req.headers.authorization||'').replace(/^Bearer\s+/i,''); const session=sessions.get(auth); if(!session||session.expires<Date.now()) return json(res,401,{error:'Authentification requise'});
  if(req.method==='GET'&&u.pathname==='/api/bootstrap') return json(res,200,await dashboard(session.companyId));
  if(req.method==='GET'&&u.pathname==='/api/products') { const r=await query('SELECT id,name,category,price,stock FROM products WHERE company_id=$1 ORDER BY created_at DESC',[session.companyId]); return json(res,200,{products:r.rows}); }
  if(req.method==='POST'&&u.pathname==='/api/products') { const b=await body(req); if(!b.name||b.price===undefined) return json(res,400,{error:'Nom et prix requis'}); const r=await query('INSERT INTO products(company_id,name,category,price,stock) VALUES($1,$2,$3,$4,$5) RETURNING id,name,category,price,stock',[session.companyId,b.name,b.category||null,Number(b.price),Number(b.stock||0)]); return json(res,201,{product:r.rows[0]}); }
  if(req.method==='POST'&&u.pathname==='/api/prospects') { const b=await body(req); const r=await query('INSERT INTO prospects(company_id,name,phone,need,value,score,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[session.companyId,b.name||null,b.phone||null,b.need||null,Number(b.value||0),Math.max(0,Math.min(100,Number(b.score||0))),b.status||'Nouveau']); return json(res,201,{prospect:r.rows[0]}); }
  if(req.method==='POST'&&u.pathname==='/api/ai/reply') { const b=await body(req); const d=await query('SELECT name,price,stock FROM products WHERE company_id=$1 ORDER BY created_at',[session.companyId]); return json(res,200,{reply:ai(b.text,d.rows),provider:'fallback-demo'}); }
  if(req.method==='POST'&&u.pathname==='/api/followups') { const b=await body(req); const r=await query('INSERT INTO followups(company_id,prospect_id,text,due_at,status) VALUES($1,$2,$3,$4,$5) RETURNING *',[session.companyId,b.prospectId||null,b.text||null,b.dueAt||null,'Programmée']); return json(res,201,{followup:r.rows[0]}); }
  if(req.method==='GET'&&u.pathname==='/api/health/db') { await query('SELECT 1'); return json(res,200,{ok:true,database:'postgresql'}); }
  return json(res,404,{error:'Route introuvable'});
}

const server=http.createServer((req,res)=>handler(req,res).catch(e=>{console.error(e);json(res,500,{error:'Erreur serveur'});}));
server.listen(PORT,'0.0.0.0',()=>console.log(`WA-Vendeur 1.5.0 listening on ${PORT}`));
process.on('SIGTERM',async()=>{server.close();await closeDatabase();});
