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
const json = (res,status,data) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'}); res.end(JSON.stringify(data)); };
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
    let u = await client.query('SELECT id FROM users WHERE email=$1',[DEMO_EMAIL]);
    if (!u.rows[0]) { const h=hashPassword(DEMO_PASSWORD); await client.query('INSERT INTO users(company_id,email,name,role,password_hash,password_salt) VALUES($1,$2,$3,$4,$5,$6)',[companyId,DEMO_EMAIL,'Administrateur','owner',h.hash,h.salt]); }
    return companyId;
  });
}

async function dashboard(companyId) {
  const [company,products,prospects,orders,conversations,followups,subscription] = await Promise.all([
    query('SELECT id,name,sector,ai_name AS "aiName",ai_tone AS "aiTone" FROM companies WHERE id=$1',[companyId]),
    query('SELECT id,name,category,price,stock,created_at AS "createdAt" FROM products WHERE company_id=$1 ORDER BY created_at DESC',[companyId]),
    query('SELECT id,name,phone,need,value,score,status,order_intent AS "orderIntent",last_contact AS "lastContact",created_at AS "createdAt" FROM prospects WHERE company_id=$1 ORDER BY score DESC,created_at DESC',[companyId]),
    query('SELECT o.id,o.order_number AS number,p.name AS client,o.amount,o.status,o.created_at AS "createdAt" FROM orders o LEFT JOIN prospects p ON p.id=o.prospect_id WHERE o.company_id=$1 ORDER BY o.created_at DESC',[companyId]),
    query(`SELECT c.id,c.external_contact AS phone,p.name,COALESCE(json_agg(json_build_object('id',m.id,'from',m.direction,'text',m.body) ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL),'[]') AS messages FROM conversations c LEFT JOIN prospects p ON p.id=c.prospect_id LEFT JOIN messages m ON m.conversation_id=c.id WHERE c.company_id=$1 GROUP BY c.id,p.name ORDER BY c.created_at DESC`,[companyId]),
    query('SELECT id,due_at AS "dueAt",status,text,prospect_id AS "prospectId" FROM followups WHERE company_id=$1 ORDER BY due_at NULLS LAST',[companyId]),
    query('SELECT plan,status,monthly_price AS "monthlyPrice",next_billing_at AS "nextBillingAt" FROM subscriptions WHERE company_id=$1',[companyId])
  ]);
  const ps=prospects.rows, os=orders.rows;
  return {
    company:company.rows[0],
    products:products.rows,
    prospects:ps,
    orders:os,
    conversations:conversations.rows,
    followups:followups.rows,
    subscription:subscription.rows[0],
    metrics:{
      prospects:ps.length,
      hot:ps.filter(x=>x.score>=70).length,
      warm:ps.filter(x=>x.score>=40&&x.score<70).length,
      cold:ps.filter(x=>x.score<40).length,
      orders:os.length,
      revenue:os.reduce((s,x)=>s+Number(x.amount||0),0),
      products:products.rows.length,
      lowStock:products.rows.filter(x=>Number(x.stock)<=5).length
    }
  };
}

function classifyLead(text, products=[], prospect={}) {
  const q=String(text||'').toLowerCase();
  let score=0;
  const reasons=[];
  const add=(points,reason)=>{ score+=points; reasons.push((points>0?'+':'')+points+' '+reason); };

  if (/acheter|commande|commander|je prends|je veux|réserver|reserver|prendre/.test(q)) add(30,'intention d’achat');
  if (/prix|combien|tarif|coût|cout/.test(q)) add(10,'question prix');
  if (/dispon|stock|avez-vous|avez vous/.test(q)) add(10,'vérification de disponibilité');
  if (/livr|livraison|expéd|exped|où|ou\b/.test(q)) add(5,'logistique');
  if (/aujourd|maintenant|urgent|rapidement|ce soir|demain/.test(q)) add(15,'urgence');
  if (/budget|fcfa|€|euro|payer|paiement|momo|orange money/.test(q)) add(10,'budget/paiement évoqué');
  if (products.some(p=>q.includes(String(p.name||'').toLowerCase()))) add(15,'produit du catalogue identifié');
  if (prospect.phone) add(5,'contact connu');
  if (prospect.value>0) add(5,'valeur potentielle renseignée');
  if (/juste regarder|simplement regarder|pas intéress|pas interesse|je réfléchis|je reflechis|plus tard/.test(q)) add(-15,'intention faible');
  score=Math.max(score,Number(prospect.score||0));
  score=Math.max(0,Math.min(100,score));
  const status=score>=70?'Chaud':score>=40?'Tiède':'Froid';
  const orderIntent=/acheter|commande|commander|je prends|je veux|réserver|reserver/.test(q);
  return {score,status,orderIntent,reasons};
}

function ai(text, products=[]) {
  const q=String(text||'').toLowerCase();
  if(q.includes('prix')||q.includes('combien')) return products.length ? products.map(p=>`${p.name}: ${Number(p.price).toLocaleString('fr-FR')} FCFA`).join(' · ')+'. Lequel vous intéresse ?' : 'Je peux vous renseigner sur nos produits. Quel article recherchez-vous ?';
  if(q.includes('dispon')||q.includes('stock')) return 'Oui, dites-moi le produit souhaité et je vérifie le stock.';
  if(q.includes('livr')) return 'Oui. Quel est votre quartier pour organiser la livraison ?';
  if(q.includes('acheter')||q.includes('commande')) return 'Avec plaisir. Donnez-moi votre nom, téléphone, produit et localisation pour préparer la commande.';
  if(q.includes('humain')||q.includes('conseiller')) return 'Bien sûr. Je transmets votre demande à un conseiller humain.';
  return 'Bonjour 👋 Je suis Julie, votre assistante commerciale. Que puis-je faire pour vous ?';
}

async function handler(req,res) {
  if(req.method==='OPTIONS') return json(res,204,{});
  const u=new URL(req.url,`http://${req.headers.host}`);
  if(req.method==='GET'&&u.pathname==='/api/health') return json(res,200,{ok:true,version:'1.6.0',service:'VENDIA',database:'postgresql'});
  if(req.method==='GET'&&u.pathname==='/api/version') return json(res,200,{version:'1.6.0'});
  if(req.method==='GET'&&u.pathname==='/') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await readFile(path.join(__dirname,'public/index.html'))); }
  await ensureDemo();

  if(req.method==='POST'&&u.pathname==='/api/login') {
    const b=await body(req);
    const r=await query('SELECT u.id,u.name,u.email,u.company_id,u.password_hash,u.password_salt,c.name AS company_name FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=$1',[b.email]);
    const user=r.rows[0];
    if(!user||!verifyPassword(String(b.password||''),user.password_salt,user.password_hash)) return json(res,401,{error:'Identifiants incorrects'});
    const t=token(); sessions.set(t,{userId:user.id,companyId:user.company_id,expires:Date.now()+86400000});
    return json(res,200,{token:t,user:{id:user.id,name:user.name,email:user.email,companyId:user.company_id,company:user.company_name}});
  }

  const auth=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const session=sessions.get(auth);
  if(!session||session.expires<Date.now()) return json(res,401,{error:'Authentification requise'});
  const companyId=session.companyId;

  if(req.method==='GET'&&u.pathname==='/api/bootstrap') return json(res,200,await dashboard(companyId));
  if(req.method==='GET'&&u.pathname==='/api/dashboard') return json(res,200,await dashboard(companyId));

  if(req.method==='GET'&&u.pathname==='/api/products') {
    const r=await query('SELECT id,name,category,price,stock,created_at AS "createdAt" FROM products WHERE company_id=$1 ORDER BY created_at DESC',[companyId]);
    return json(res,200,{products:r.rows});
  }
  if(req.method==='POST'&&u.pathname==='/api/products') {
    const b=await body(req);
    if(!b.name||b.price===undefined||Number.isNaN(Number(b.price))) return json(res,400,{error:'Nom et prix valides requis'});
    const r=await query('INSERT INTO products(company_id,name,category,price,stock) VALUES($1,$2,$3,$4,$5) RETURNING id,name,category,price,stock,created_at AS "createdAt"',[companyId,String(b.name).trim(),b.category||null,Number(b.price),Math.max(0,Number(b.stock||0))]);
    return json(res,201,{product:r.rows[0]});
  }
  const productMatch=u.pathname.match(/^\/api\/products\/([0-9a-f-]+)$/i);
  if(productMatch && (req.method==='PUT'||req.method==='PATCH')) {
    const b=await body(req);
    if(!b.name||b.price===undefined||Number.isNaN(Number(b.price))) return json(res,400,{error:'Nom et prix valides requis'});
    const r=await query('UPDATE products SET name=$1,category=$2,price=$3,stock=$4 WHERE id=$5 AND company_id=$6 RETURNING id,name,category,price,stock,created_at AS "createdAt"',[String(b.name).trim(),b.category||null,Number(b.price),Math.max(0,Number(b.stock||0)),productMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Produit introuvable'});
    return json(res,200,{product:r.rows[0]});
  }
  if(productMatch && req.method==='DELETE') {
    const r=await query('DELETE FROM products WHERE id=$1 AND company_id=$2 RETURNING id',[productMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Produit introuvable'});
    return json(res,200,{ok:true});
  }

  if(req.method==='GET'&&u.pathname==='/api/prospects') {
    const r=await query('SELECT id,name,phone,need,value,score,status,order_intent AS "orderIntent",last_contact AS "lastContact",created_at AS "createdAt" FROM prospects WHERE company_id=$1 ORDER BY score DESC,created_at DESC',[companyId]);
    return json(res,200,{prospects:r.rows});
  }
  if(req.method==='POST'&&u.pathname==='/api/prospects') {
    const b=await body(req);
    if(!b.name&& !b.phone) return json(res,400,{error:'Nom ou téléphone requis'});
    const score=Math.max(0,Math.min(100,Number(b.score||0)));
    const r=await query('INSERT INTO prospects(company_id,name,phone,need,value,score,status,order_intent,last_contact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING id,name,phone,need,value,score,status,order_intent AS "orderIntent",last_contact AS "lastContact"',[companyId,b.name||null,b.phone||null,b.need||null,Number(b.value||0),score,b.status||'Nouveau',Boolean(b.orderIntent)]);
    return json(res,201,{prospect:r.rows[0]});
  }
  const prospectMatch=u.pathname.match(/^\/api\/prospects\/([0-9a-f-]+)$/i);
  if(prospectMatch && (req.method==='PUT'||req.method==='PATCH')) {
    const b=await body(req);
    if(!b.name&&!b.phone) return json(res,400,{error:'Nom ou téléphone requis'});
    const score=Math.max(0,Math.min(100,Number(b.score||0)));
    const r=await query('UPDATE prospects SET name=$1,phone=$2,need=$3,value=$4,score=$5,status=$6,order_intent=$7,last_contact=now() WHERE id=$8 AND company_id=$9 RETURNING id,name,phone,need,value,score,status,order_intent AS "orderIntent",last_contact AS "lastContact"',[b.name||null,b.phone||null,b.need||null,Number(b.value||0),score,b.status||'Nouveau',Boolean(b.orderIntent),prospectMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Prospect introuvable'});
    return json(res,200,{prospect:r.rows[0]});
  }
  if(prospectMatch && req.method==='DELETE') {
    const r=await query('DELETE FROM prospects WHERE id=$1 AND company_id=$2 RETURNING id',[prospectMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Prospect introuvable'});
    return json(res,200,{ok:true});
  }

  if(req.method==='POST'&&u.pathname==='/api/ai/reply') {
    const b=await body(req); const d=await query('SELECT name,price,stock FROM products WHERE company_id=$1 ORDER BY created_at',[companyId]);
    return json(res,200,{reply:ai(b.text,d.rows),provider:'fallback-demo'});
  }

  if(req.method==='POST'&&u.pathname==='/api/ai/qualify') {
    const b=await body(req);
    if(!b.text) return json(res,400,{error:'Message requis'});
    const d=await query('SELECT name,price,stock FROM products WHERE company_id=$1 ORDER BY created_at',[companyId]);
    let prospect={score:0,phone:b.phone||null,value:Number(b.value||0)};
    if(b.prospectId){
      const p=await query('SELECT id,name,phone,need,value,score,status,order_intent AS "orderIntent" FROM prospects WHERE id=$1 AND company_id=$2',[b.prospectId,companyId]);
      if(!p.rows[0]) return json(res,404,{error:'Prospect introuvable'});
      prospect=p.rows[0];
    }
    const result=classifyLead(b.text,d.rows,prospect);
    if(b.prospectId){
      await query(
        'UPDATE prospects SET score=$1,status=$2,order_intent=$3,last_contact=now(),need=COALESCE(NULLIF($4,\'\'),need) WHERE id=$5 AND company_id=$6',
        [result.score,result.status,result.orderIntent,b.text,b.prospectId,companyId]
      );
    }
    return json(res,200,{qualification:result,provider:'rules-engine-v1'});
  }
  if(req.method==='POST'&&u.pathname==='/api/followups') {
    const b=await body(req); const r=await query('INSERT INTO followups(company_id,prospect_id,text,due_at,status) VALUES($1,$2,$3,$4,$5) RETURNING *',[companyId,b.prospectId||null,b.text||null,b.dueAt||null,'Programmée']);
    return json(res,201,{followup:r.rows[0]});
  }
  if(req.method==='GET'&&u.pathname==='/api/conversations') {
    const r=await query(`SELECT c.id,c.channel,c.external_contact AS phone,c.prospect_id AS "prospectId",p.name AS prospect, c.created_at AS "createdAt",
      COALESCE(json_agg(json_build_object('id',m.id,'direction',m.direction,'body',m.body,'createdAt',m.created_at) ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL),'[]') AS messages
      FROM conversations c LEFT JOIN prospects p ON p.id=c.prospect_id LEFT JOIN messages m ON m.conversation_id=c.id
      WHERE c.company_id=$1 GROUP BY c.id,p.name ORDER BY MAX(m.created_at) DESC NULLS LAST,c.created_at DESC`,[companyId]);
    return json(res,200,{conversations:r.rows});
  }
  if(req.method==='POST'&&u.pathname==='/api/conversations') {
    const b=await body(req);
    const r=await query('INSERT INTO conversations(company_id,prospect_id,channel,external_contact) VALUES($1,$2,$3,$4) RETURNING id,prospect_id AS "prospectId",channel,external_contact AS phone,created_at AS "createdAt"',[companyId,b.prospectId||null,b.channel||'whatsapp',b.phone||null]);
    return json(res,201,{conversation:r.rows[0]});
  }
  const convMatch=u.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages$/i);
  if(convMatch && req.method==='POST') {
    const b=await body(req);
    if(!b.body) return json(res,400,{error:'Message requis'});
    const own=await query('SELECT id,prospect_id AS "prospectId",external_contact AS phone FROM conversations WHERE id=$1 AND company_id=$2',[convMatch[1],companyId]);
    if(!own.rows[0]) return json(res,404,{error:'Conversation introuvable'});
    const direction=b.direction||'out';
    const text=String(b.body).trim();
    const r=await query('INSERT INTO messages(conversation_id,direction,body,provider_message_id) VALUES($1,$2,$3,$4) RETURNING id,direction,body,created_at AS "createdAt"',[convMatch[1],direction,text,b.providerMessageId||null]);

    let prospectId=b.prospectId||own.rows[0].prospectId||null;
    let qualification=null;
    if(prospectId) await query('UPDATE conversations SET prospect_id=$1 WHERE id=$2 AND company_id=$3',[prospectId,convMatch[1],companyId]);

    if(direction==='in') {
      if(!prospectId) {
        const phone=b.phone||own.rows[0].phone||null;
        const existing=phone ? await query('SELECT id FROM prospects WHERE company_id=$1 AND phone=$2 ORDER BY created_at DESC LIMIT 1',[companyId,phone]) : {rows:[]};
        if(existing.rows[0]) {
          prospectId=existing.rows[0].id;
        } else {
          const name=(b.name||'').trim()||null;
          const created=await query('INSERT INTO prospects(company_id,name,phone,need,value,score,status,order_intent,last_contact) VALUES($1,$2,$3,$4,0,0,$5,false,now()) RETURNING id',[companyId,name,phone,text,'Nouveau']);
          prospectId=created.rows[0].id;
        }
        await query('UPDATE conversations SET prospect_id=$1 WHERE id=$2 AND company_id=$3',[prospectId,convMatch[1],companyId]);
      }

      const d=await query('SELECT name,price,stock FROM products WHERE company_id=$1 ORDER BY created_at',[companyId]);
      const p=await query('SELECT id,name,phone,need,value,score,status,order_intent AS "orderIntent" FROM prospects WHERE id=$1 AND company_id=$2',[prospectId,companyId]);
      if(p.rows[0]) {
        qualification=classifyLead(text,d.rows,p.rows[0]);
        await query('UPDATE prospects SET score=$1,status=$2,order_intent=$3,last_contact=now(),need=COALESCE(NULLIF($4,\'\'),need) WHERE id=$5 AND company_id=$6',[qualification.score,qualification.status,qualification.orderIntent,text,prospectId,companyId]);
      }
    }
    return json(res,201,{message:r.rows[0],prospectId,qualification});
  }
  if(req.method==='POST'&&u.pathname==='/api/orders') {
    const b=await body(req);
    if(!b.prospectId) return json(res,400,{error:'Prospect requis'});
    const amount=Number(b.amount||0);
    if(Number.isNaN(amount)||amount<0) return json(res,400,{error:'Montant invalide'});
    const number='VND-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
    const r=await query('INSERT INTO orders(company_id,prospect_id,order_number,amount,status) VALUES($1,$2,$3,$4,$5) RETURNING id,order_number AS number,prospect_id AS "prospectId",amount,status,created_at AS "createdAt"',[companyId,b.prospectId,number,amount,b.status||'En attente']);
    await query('UPDATE prospects SET order_intent=true,status=CASE WHEN status IS NULL OR status IN (\'Nouveau\',\'À contacter\') THEN \'En discussion\' ELSE status END WHERE id=$1 AND company_id=$2',[b.prospectId,companyId]);
    return json(res,201,{order:r.rows[0]});
  }
  if(req.method==='GET'&&u.pathname==='/api/orders') {
    const r=await query('SELECT o.id,o.order_number AS number,o.prospect_id AS "prospectId",p.name AS client,o.amount,o.status,o.created_at AS "createdAt" FROM orders o LEFT JOIN prospects p ON p.id=o.prospect_id WHERE o.company_id=$1 ORDER BY o.created_at DESC',[companyId]);
    return json(res,200,{orders:r.rows});
  }
  const orderMatch=u.pathname.match(/^\/api\/orders\/([0-9a-f-]+)$/i);
  if(orderMatch && (req.method==='PUT'||req.method==='PATCH')) {
    const b=await body(req);
    const r=await query('UPDATE orders SET amount=$1,status=$2 WHERE id=$3 AND company_id=$4 RETURNING id,order_number AS number,prospect_id AS "prospectId",amount,status,created_at AS "createdAt"',[Math.max(0,Number(b.amount||0)),b.status||'En attente',orderMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Commande introuvable'});
    return json(res,200,{order:r.rows[0]});
  }
  if(req.method==='GET'&&u.pathname==='/api/followups') {
    const r=await query('SELECT f.id,f.prospect_id AS "prospectId",p.name AS prospect,f.text,f.due_at AS "dueAt",f.status,f.sent_at AS "sentAt",f.created_at AS "createdAt" FROM followups f LEFT JOIN prospects p ON p.id=f.prospect_id WHERE f.company_id=$1 ORDER BY f.due_at NULLS LAST',[companyId]);
    return json(res,200,{followups:r.rows});
  }
  if(req.method==='PUT'&&u.pathname.startsWith('/api/followups/')) {
    const id=u.pathname.split('/').pop(); const b=await body(req);
    const r=await query('UPDATE followups SET text=$1,due_at=$2,status=$3 WHERE id=$4 AND company_id=$5 RETURNING id,prospect_id AS "prospectId",text,due_at AS "dueAt",status,sent_at AS "sentAt"',[b.text||null,b.dueAt||null,b.status||'Programmée',id,companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Relance introuvable'});
    return json(res,200,{followup:r.rows[0]});
  }
  if(req.method==='GET'&&u.pathname==='/api/health/db') { await query('SELECT 1'); return json(res,200,{ok:true,database:'postgresql'}); }
  return json(res,404,{error:'Route introuvable'});
}

const server=http.createServer((req,res)=>handler(req,res).catch(e=>{console.error(e);json(res,500,{error:'Erreur serveur'});}));
server.listen(PORT,'0.0.0.0',()=>console.log(`VENDIA 1.6.0 listening on ${PORT}`));
process.on('SIGTERM',async()=>{server.close();await closeDatabase();});
