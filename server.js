import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, transaction, closeDatabase } from './db.js';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@wavendeur.local';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
// Numéros mobile money du super-admin pour le tunnel de paiement en
// libre-service (voir /api/signup) — configurables par variable
// d'environnement pour pouvoir les changer sans redéploiement de code.
const ORANGE_MONEY_NUMBER = process.env.ORANGE_MONEY_NUMBER || '+237691965012';
const MTN_MOMO_NUMBER = process.env.MTN_MOMO_NUMBER || '+237672353499';
const json = (res,status,data) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'}); res.end(JSON.stringify(data)); };
const body = async req => { let s=''; for await (const c of req) s += c; if (s.length > 1000000) throw new Error('Payload trop volumineux'); return s ? JSON.parse(s) : {}; };
const rawBody = async req => { let s=''; for await (const c of req) s += c; if (s.length > 1000000) throw new Error('Payload trop volumineux'); return s; };
const hashPassword = (password,salt=crypto.randomBytes(16).toString('hex')) => ({salt,hash:crypto.scryptSync(password,salt,64).toString('hex')});
const verifyPassword = (password,salt,expected) => crypto.timingSafeEqual(Buffer.from(hashPassword(password,salt).hash,'hex'),Buffer.from(expected,'hex'));
const token = () => crypto.randomBytes(32).toString('hex');
const escHtml = v => String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const genTempPassword = () => crypto.randomBytes(9).toString('base64url');

// Chiffrement au repos des secrets sensibles (jetons d'accès WhatsApp) avant
// stockage en base — AES-256-GCM avec une clé dérivée de ENCRYPTION_KEY
// (n'importe quelle longueur/format en entrée, toujours réduite à 32 octets
// via SHA-256). Sans ENCRYPTION_KEY configuré, on continue de stocker en
// clair (comportement historique, pour ne pas casser un déploiement existant)
// mais un avertissement est journalisé au démarrage — voir plus bas. Les
// valeurs déjà en clair en base (avant l'ajout de ce chiffrement, ou si la
// clé n'est toujours pas configurée) restent lisibles : encryptSecret() est
// un no-op sans clé, et decryptSecret() renvoie tel quel tout ce qui ne porte
// pas le préfixe 'enc1:' plutôt que d'échouer.
const ENC_PREFIX = 'enc1:';
function encryptionKey() {
  const k = process.env.ENCRYPTION_KEY;
  return k ? crypto.createHash('sha256').update(k).digest() : null;
}
function encryptSecret(plain) {
  if (!plain) return null;
  const key = encryptionKey();
  if (!key) return String(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function decryptSecret(stored) {
  if (!stored) return null;
  if (!stored.startsWith(ENC_PREFIX)) return stored; // valeur historique en clair, ou chiffrement non configuré
  const key = encryptionKey();
  if (!key) { console.error('[crypto] ENCRYPTION_KEY absent — impossible de déchiffrer un secret chiffré'); return null; }
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) { console.error('[crypto] echec dechiffrement:', e.message); return null; }
}

// Limiteur de débit simple en mémoire (par IP + route) — suffisant pour une
// instance unique Railway. Protège les routes publiques sensibles
// (connexion, inscription, mot de passe oublié) contre le brute-force et le
// spam, sans dépendance externe (pas de Redis). Fenêtre glissante.
const rateLimitBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let arr = rateLimitBuckets.get(key);
  if (!arr) { arr = []; rateLimitBuckets.set(key, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= max) return true;
  arr.push(now);
  if (arr.length === 0) rateLimitBuckets.delete(key);
  return false;
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
const tooManyRequests = res => json(res, 429, { error: 'Trop de tentatives. Réessayez dans quelques minutes.' });

// Sessions persistées en base (table 'sessions') plutôt qu'en mémoire du
// process : sans ça, chaque redéploiement (fréquent sur Railway) déconnectait
// tout le monde instantanément et sans prévenir. Une session est soit celle
// d'un utilisateur d'entreprise (userId+companyId), soit celle d'un
// super-admin (superAdminId) — jamais les deux à la fois.
async function createSession(userId, companyId) {
  const t = token();
  await query('INSERT INTO sessions(token,user_id,company_id,expires_at) VALUES($1,$2,$3,now() + interval \'24 hours\')', [t, userId, companyId]);
  query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}); // purge opportuniste, pas besoin de cron pour ce volume
  return t;
}
async function createSuperAdminSession(superAdminId) {
  const t = token();
  await query('INSERT INTO sessions(token,super_admin_id,expires_at) VALUES($1,$2,now() + interval \'24 hours\')', [t, superAdminId]);
  query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
  return t;
}
async function getSession(t) {
  if (!t) return null;
  const r = await query('SELECT user_id AS "userId",company_id AS "companyId",super_admin_id AS "superAdminId" FROM sessions WHERE token=$1 AND expires_at > now()', [t]);
  return r.rows[0] || null;
}
async function deleteSession(t) {
  if (!t) return;
  await query('DELETE FROM sessions WHERE token=$1', [t]).catch(() => {});
}
async function getUserRole(userId) {
  const r = await query('SELECT role FROM users WHERE id=$1', [userId]);
  return r.rows[0]?.role || null;
}

// Réinitialisation de mot de passe en libre-service : jeton à usage unique,
// valable 1h, dont seul le hash est stocké (comme un mot de passe) pour
// qu'une fuite de la base ne permette pas de rejouer un lien déjà envoyé.
async function createPasswordResetToken(userId) {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  await query('DELETE FROM password_resets WHERE user_id=$1', [userId]); // un seul lien actif à la fois
  await query('INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,now() + interval \'1 hour\')', [userId, tokenHash]);
  return raw;
}
async function consumePasswordResetToken(raw) {
  const tokenHash = crypto.createHash('sha256').update(String(raw || '')).digest('hex');
  const r = await query('SELECT id,user_id AS "userId" FROM password_resets WHERE token_hash=$1 AND expires_at>now() AND used_at IS NULL', [tokenHash]);
  const row = r.rows[0];
  if (!row) return null;
  await query('UPDATE password_resets SET used_at=now() WHERE id=$1', [row.id]);
  return row.userId;
}

// Envoi d'email via l'API HTTP de Resend (même approche que l'appel à
// l'API Anthropic : fetch natif, pas de nouvelle dépendance npm). Sans
// RESEND_API_KEY configuré, on journalise et on renvoie false plutôt que
// d'échouer bruyamment — la réinitialisation assistée par un administrateur
// ou le super-admin reste disponible sans aucune configuration.
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('[email] RESEND_API_KEY non configuré — email non envoyé (destinataire=%s, sujet=%s)', to, subject); return false; }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'VENDIA <onboarding@resend.dev>', to: [to], subject, html })
    });
    if (!resp.ok) { console.error('[email] echec envoi, HTTP', resp.status, await resp.text().catch(() => '')); return false; }
    return true;
  } catch (e) { console.error('[email] erreur envoi:', e.message); return false; }
}

// Vérifie que le POST du webhook vient bien de Meta (HMAC-SHA256 du corps
// brut avec le secret de l'App, comparé en temps constant) plutôt que
// d'accepter n'importe quelle requête pointant vers cette URL publique.
// Si META_APP_SECRET n'est pas configuré, le comportement par défaut reste
// permissif (pour ne pas casser un webhook déjà en production avant que la
// variable d'environnement soit ajoutée) : on journalise un avertissement à
// chaque appel non vérifié. Une fois META_APP_SECRET confirmé configuré sur
// Railway, définir REQUIRE_WEBHOOK_SIGNATURE=true pour basculer en mode
// strict (rejet si la signature est absente/invalide) — voir README.
function verifyMetaSignature(req, raw) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    if (process.env.REQUIRE_WEBHOOK_SIGNATURE === 'true') { console.error('[webhook] META_APP_SECRET absent alors que REQUIRE_WEBHOOK_SIGNATURE=true — requête rejetée'); return false; }
    console.warn('[webhook] META_APP_SECRET non configuré — vérification de signature désactivée (voir README : REQUIRE_WEBHOOK_SIGNATURE)');
    return true;
  }
  const header = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function ensureDemo() {
  return transaction(async client => {
    let c = await client.query('SELECT id FROM companies WHERE name=$1 LIMIT 1',['Boutique Démo Yaoundé']);
    let companyId = c.rows[0]?.id;
    if (!companyId) {
      const r = await client.query("INSERT INTO companies(name,sector,ai_name,approved_at) VALUES($1,$2,$3,now()) RETURNING id",['Boutique Démo Yaoundé','Mode & accessoires','Assistant commercial']);
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

// Compte super-admin (vision et contrôle sur toutes les entreprises VENDIA),
// séparé des comptes clients — créé automatiquement au démarrage à partir de
// variables d'environnement Railway (même logique que le compte démo), pour
// éviter d'avoir à exécuter une commande manuellement. Sans SUPERADMIN_EMAIL
// / SUPERADMIN_PASSWORD définis, aucun compte super-admin n'existe.
async function ensureSuperAdmin() {
  const email = process.env.SUPERADMIN_EMAIL, password = process.env.SUPERADMIN_PASSWORD;
  if (!email || !password) return;
  const normalized = email.trim().toLowerCase();
  const existing = await query('SELECT id,password_hash,password_salt FROM super_admins WHERE email=$1',[normalized]);
  const h = hashPassword(password);
  if (!existing.rows[0]) {
    await query('INSERT INTO super_admins(email,name,password_hash,password_salt) VALUES($1,$2,$3,$4)',[normalized, process.env.SUPERADMIN_NAME || 'Super Admin', h.hash, h.salt]);
    console.log('[superadmin] compte super-admin initial cree pour', normalized);
  } else {
    // Le mot de passe reste synchronisé avec la variable d'environnement à
    // chaque démarrage : changer SUPERADMIN_PASSWORD sur Railway suffit donc
    // à faire tourner le mot de passe, sans accès direct à la base.
    await query('UPDATE super_admins SET password_hash=$1,password_salt=$2,name=$3 WHERE id=$4',[h.hash, h.salt, process.env.SUPERADMIN_NAME || 'Super Admin', existing.rows[0].id]);
  }
}

async function dashboard(companyId) {
  // Note : les conversations ne sont volontairement PAS chargées ici — le
  // dashboard client les récupère séparément via GET /api/conversations
  // (qui plafonne déjà les messages par fil) juste après ce chargement
  // initial ; les requêter deux fois doublait inutilement la charge, et sans
  // plafond ici c'était justement la requête qui grossissait sans limite
  // avec l'historique (voir audit).
  const [company,products,prospects,orders,followups,subscription,appointments] = await Promise.all([
    query('SELECT id,name,sector,ai_name AS "aiName",ai_tone AS "aiTone",ai_language AS "aiLanguage",ai_rules AS "aiRules",ai_auto_reply_enabled AS "aiAutoReplyEnabled" FROM companies WHERE id=$1',[companyId]),
    query('SELECT id,name,category,price,stock,image_url AS "imageUrl",created_at AS "createdAt" FROM products WHERE company_id=$1 ORDER BY created_at DESC',[companyId]),
    query('SELECT id,name,phone,need,value,score,status,stage,order_intent AS "orderIntent",last_contact AS "lastContact",next_action AS "nextAction",next_action_priority AS "nextActionPriority",next_action_reason AS "nextActionReason",next_action_at AS "nextActionAt",created_at AS "createdAt" FROM prospects WHERE company_id=$1 ORDER BY score DESC,created_at DESC LIMIT 500',[companyId]),
    query('SELECT o.id,o.order_number AS number,p.name AS client,o.amount,o.status,o.created_at AS "createdAt" FROM orders o LEFT JOIN prospects p ON p.id=o.prospect_id WHERE o.company_id=$1 ORDER BY o.created_at DESC LIMIT 500',[companyId]),
    query('SELECT id,due_at AS "dueAt",status,text,prospect_id AS "prospectId",source,cancelled_reason AS "cancelledReason" FROM followups WHERE company_id=$1 ORDER BY due_at NULLS LAST LIMIT 500',[companyId]),
    query('SELECT plan,status,monthly_price AS "monthlyPrice",next_billing_at AS "nextBillingAt" FROM subscriptions WHERE company_id=$1',[companyId]),
    query(`SELECT a.id,a.prospect_id AS "prospectId",p.name AS prospect,a.type,a.scheduled_at AS "scheduledAt",a.status FROM appointments a LEFT JOIN prospects p ON p.id=a.prospect_id WHERE a.company_id=$1 ORDER BY a.scheduled_at NULLS LAST,a.created_at DESC LIMIT 500`,[companyId])
  ]);
  const ps=prospects.rows, os=orders.rows;
  const plan=subscription.rows[0]?.plan;
  const limits=planLimits(plan);
  const [aiUsage,prospectsThisMonth]=await Promise.all([
    getAiUsage(companyId,plan),
    query("SELECT COUNT(*)::int AS n FROM prospects WHERE company_id=$1 AND created_at >= date_trunc('month', now())",[companyId])
  ]);
  return {
    company:company.rows[0],
    products:products.rows,
    prospects:ps,
    orders:os,
    conversations:[],
    followups:followups.rows,
    appointments:appointments.rows,
    subscription:subscription.rows[0],
    usage:{
      aiMessages:aiUsage,
      prospectsThisMonth:prospectsThisMonth.rows[0].n,
      prospectsLimit:limits.maxProspectsPerMonth,
      autoFollowups:limits.autoFollowups,
      maxUsers:limits.maxUsers,
      maxAdmins:limits.maxAdmins
    },
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

function extractCustomerData(text, current={}) {
  const q=String(text||'').trim();
  const phone=(q.match(/(?:\+?237[\s.-]?)?(?:6\d{8}|2\d{8})\b/)||[])[0]||current.phone||null;
  const nameMatch=q.match(/(?:je suis|moi c'est|moi c’est|nom[: ]+|je m'appelle|je m’appelle|my name is|i'm|i am|this is)\s+([A-Za-zÀ-ÿ' -]{2,40})/i);
  const name=nameMatch ? nameMatch[1].trim().replace(/\\s+/g,' ') : current.name||null;
  const locMatch=q.match(/(?:à|a|sur|dans|vers|quartier)\s+([A-Za-zÀ-ÿ' -]{2,35})(?=\\s+(?:svp|s'il|pour|et|,|\.|$))/i);
  const location=locMatch ? locMatch[1].trim() : null;
  return {name,phone,location};
}

// Température IA calculée depuis le score (Chaud/Tiède/Froid) — stockée dans
// prospects.status, à ne jamais confondre avec prospects.stage (étape du
// pipeline commercial : Nouveau/À contacter/En discussion/Gagné/Perdu, modifiable
// manuellement dans l'interface, voir CRM/kanban). Avant la séparation de ces
// deux colonnes les deux notions partageaient status, et l'IA écrasait sans le
// vouloir l'étape manuelle à chaque message entrant.
function heatFromScore(score) {
  return score>=70?'Chaud':score>=40?'Tiède':'Froid';
}

// Valide une URL d'image produit (catalogue). N'accepte que http(s), rejette
// les schémas dangereux (javascript:, data:...) et les chaînes trop longues.
// Retourne l'URL nettoyée, ou null si absente/invalide.
function validImageUrl(raw) {
  const s=String(raw||'').trim();
  if(!s) return null;
  if(s.length>2000) return null;
  if(!/^https?:\/\//i.test(s)) return null;
  return s;
}

// Modèles de démarrage rapide par secteur d'activité : personnalité IA et
// produits d'exemple pré-remplis, pour qu'une entreprise qui vient de
// s'inscrire ait quelque chose de pertinent à montrer à ses premiers clients
// WhatsApp sans tout configurer à la main. Appliqué uniquement sur demande
// explicite (POST /api/onboarding/apply-template), jamais automatiquement.
const SECTOR_TEMPLATES={
  mode:{
    label:'Boutique mode & accessoires',
    sector:'Mode & accessoires',
    aiName:'Aïcha',
    aiTone:'Chaleureux, élégant et enthousiaste, comme une vendeuse passionnée de mode',
    aiLanguage:'Français',
    aiRules:"Mets en avant le style et la qualité des tissus. Demande la taille et la couleur souhaitées avant de confirmer une commande. Si un article n'est plus en stock, propose une alternative similaire du catalogue.",
    products:[
      {name:'Robe wax imprimée',category:'Robes',price:15000,stock:8},
      {name:'Ensemble bazin brodé',category:'Ensembles',price:35000,stock:4},
      {name:'Sac à main cuir',category:'Accessoires',price:12000,stock:10},
      {name:'Sandales plates',category:'Chaussures',price:8000,stock:15},
    ],
  },
  restaurant:{
    label:'Restaurant & traiteur',
    sector:'Restauration',
    aiName:'Chef Marcel',
    aiTone:'Convivial, appétissant et rapide, comme un serveur qui connaît le menu par cœur',
    aiLanguage:'Français',
    aiRules:"Annonce toujours les plats du jour disponibles avant de prendre une commande. Demande l'adresse de livraison si le client veut être livré, et précise le délai estimé. Mentionne si un plat est épicé.",
    products:[
      {name:'Ndolé complet',category:'Plats',price:3500,stock:20},
      {name:'Poulet DG',category:'Plats',price:4500,stock:15},
      {name:'Brochettes (portion de 5)',category:'Grillades',price:2000,stock:30},
      {name:'Jus de bissap (1L)',category:'Boissons',price:1500,stock:25},
    ],
  },
  beaute:{
    label:'Salon de beauté & coiffure',
    sector:'Beauté & coiffure',
    aiName:'Grace',
    aiTone:'Douce, rassurante et professionnelle, comme une styliste de confiance',
    aiLanguage:'Français',
    aiRules:"Propose toujours de fixer un rendez-vous avec un jour et une heure précis quand le client montre de l'intérêt. Demande le type de coiffure ou de soin souhaité. Reste discret et bienveillant sur les questions de beauté.",
    products:[
      {name:'Tresses box braids',category:'Coiffure',price:10000,stock:999},
      {name:'Pose perruque + coupe',category:'Coiffure',price:15000,stock:999},
      {name:'Manucure complète',category:'Beauté des mains',price:5000,stock:999},
      {name:'Soin visage hydratant',category:'Soins',price:7000,stock:999},
    ],
  },
  quincaillerie:{
    label:'Quincaillerie & matériaux',
    sector:'Quincaillerie',
    aiName:'Paul',
    aiTone:'Direct, pratique et fiable, comme un vendeur en quincaillerie qui connaît son stock',
    aiLanguage:'Français',
    aiRules:"Donne toujours le prix et la quantité disponible en stock. Demande la quantité souhaitée par le client avant de confirmer. Si un client décrit un projet (construction, réparation), suggère les produits complémentaires utiles.",
    products:[
      {name:'Sac de ciment 50kg',category:'Matériaux',price:6000,stock:50},
      {name:'Fer à béton 12mm (barre)',category:'Matériaux',price:7500,stock:40},
      {name:'Peinture émail (1L)',category:'Peinture',price:4000,stock:20},
      {name:'Perceuse électrique',category:'Outillage',price:28000,stock:6},
    ],
  },
};

function classifyLead(text, products=[], prospect={}) {
  const q=String(text||'').toLowerCase();
  let score=0;
  const reasons=[];
  const add=(points,reason)=>{ score+=points; reasons.push((points>0?'+':'')+points+' '+reason); };

  if (/acheter|commande|commander|je prends|je veux|réserver|reserver|prendre|\bbuy\b|\bpurchase\b|\border\b|i want|i'll take|i will take/.test(q)) add(30,'intention d’achat');
  if (/prix|combien|tarif|coût|cout|\bprice\b|how much|\bcost\b/.test(q)) add(10,'question prix');
  if (/dispon|stock|avez-vous|avez vous|available|in stock|do you have/.test(q)) add(10,'vérification de disponibilité');
  if (/livr|livraison|expéd|exped|où|ou\b|\bdeliver|delivery|shipping|\bwhere\b/.test(q)) add(5,'logistique');
  if (/aujourd|maintenant|urgent|rapidement|ce soir|demain|\btoday\b|\bnow\b|urgent|asap|tomorrow|tonight/.test(q)) add(15,'urgence');
  if (/budget|fcfa|€|euro|payer|paiement|momo|orange money|\bpay\b|payment|\$|usd/.test(q)) add(10,'budget/paiement évoqué');
  if (products.some(p=>q.includes(String(p.name||'').toLowerCase()))) add(15,'produit du catalogue identifié');
  if (prospect.phone) add(5,'contact connu');
  if (prospect.value>0) add(5,'valeur potentielle renseignée');
  if (/juste regarder|simplement regarder|pas intéress|pas interesse|je réfléchis|je reflechis|plus tard|just looking|not interested|i'll think about it|maybe later|not now/.test(q)) add(-15,'intention faible');
  score=Math.max(score,Number(prospect.score||0));
  score=Math.max(0,Math.min(100,score));
  const status=heatFromScore(score);
  const orderIntent=/acheter|commande|commander|je prends|je veux|réserver|reserver|\bbuy\b|\bpurchase\b|\border\b|i want|i'll take/.test(q);
  return {score,status,orderIntent,reasons};
}

// Moteur d'action commerciale (section 10 du dossier de transmission).
// Règle impérative : ce moteur ne fait qu'analyser et recommander — il ne
// déclenche jamais lui-même un envoi de message réel (WhatsApp ou autre).
// Ponctuation tolérante : sur WhatsApp, les apostrophes sont très souvent
// omises ou remplacées par une espace (« quelqu un » au lieu de « quelqu'un »).
const HANDOFF_PHRASES = /parler\s+(?:à|a)\s+(?:un|quelqu['’]?\s?un|une\s+personne)|passez[\s-]?moi|je\s+veux\s+(?:un\s+)?(?:humain|conseiller|responsable)|(?:humain|conseiller|responsable)\s+svp|besoin\s+d['’]?\s?un\s+humain|appelez[\s-]?moi\s+quelqu['’]?\s?un|(?:talk|speak)\s+to\s+(?:a\s+)?(?:human|person|someone|agent|representative)|(?:connect|transfer)\s+me\s+to\s+(?:a\s+)?(?:human|agent|someone)|i\s+(?:want|need)\s+(?:a\s+)?(?:human|agent|representative)|(?:human|agent|representative)[,\s]+please/i;
const HANDOFF_SENSITIVE = /r[ée]clamation|remboursement|rembours(?:er|é)|litige|plainte|arnaque|escroqu|avocat|juridique|paiement\s+(?:bloqu[ée]|refus[ée]|non\s+pass[ée])|erreur\s+de\s+paiement|m[ée]content|insatisfait|d[ée]ç[ue]|\brefund\b|\bcomplaint\b|\bdispute\b|chargeback|\bscam\b|fraud(?:ulent)?|\blawyer\b|legal action|payment\s+(?:failed|blocked|declined|not\s+going\s+through)|this\s+is\s+a\s+scam|\bunhappy\b|dissatisfied|disappointed|not\s+happy/i;

function determineNextAction(text, qualification) {
  const q = String(text || '');
  if (HANDOFF_PHRASES.test(q)) {
    return { action: 'handoff', priority: 'high', reason: "Demande explicite d'un interlocuteur humain" };
  }
  if (HANDOFF_SENSITIVE.test(q)) {
    return { action: 'handoff', priority: 'high', reason: 'Réclamation, litige ou paiement bloqué — situation sensible' };
  }
  if (qualification.orderIntent) {
    return { action: 'propose_order', priority: 'high', reason: "Intention d'achat forte" };
  }
  if (/prix|combien|tarif|co[uû]t/i.test(q) && qualification.status !== 'Chaud') {
    return { action: 'answer_and_qualify', priority: 'medium', reason: 'Question de prix — répondre puis qualifier' };
  }
  if (qualification.status === 'Chaud') {
    return { action: 'propose_order', priority: 'high', reason: 'Prospect chaud — action commerciale prioritaire' };
  }
  if (qualification.status === 'Tiède') {
    return { action: 'follow_up_soon', priority: 'medium', reason: 'Prospect tiède — prévoir une relance rapprochée' };
  }
  if (qualification.status === 'Froid') {
    return { action: 'nurture', priority: 'low', reason: 'Prospect froid — nurturing / relance différée' };
  }
  return { action: 'answer_and_qualify', priority: 'low', reason: 'Poursuivre la conversation et qualifier davantage' };
}

// Prise de rendez-vous automatisée (fonctionnalité repérée chez les
// concurrents — livraison/démo/appel programmés directement depuis la
// conversation). Détection volontairement simple (mots-clés + expressions de
// date/heure courantes en français) plutôt qu'un moteur NLU complet : elle
// couvre les tournures les plus fréquentes sur WhatsApp sans dépendance
// externe, et laisse toujours le dernier mot à l'IA/l'équipe en cas de doute
// (aucune date reconnue → le rendez-vous reste "Proposé", pas confirmé).
const APPOINTMENT_TYPE_HINTS = [
  [/d[ée]mo|d[ée]monstration/i, 'Démonstration'],
  [/livr/i, 'Livraison'],
  [/appel|m['’]appeler|me joindre/i, 'Appel'],
];
const APPOINTMENT_INTENT = /\b(rendez[- ]vous|rdv|passer (?:chez|vous voir)|venir (?:chez|vous voir)|on se voit|programmer|planifier|caler|fixer un moment|appointment|meet(?:ing)?|schedule|book (?:a|an) (?:time|slot|call|visit)|set up (?:a|an) (?:time|call|meeting)|let'?s meet)\b/i;
const WEEKDAYS_FR = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
const WEEKDAYS_EN = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function parseAppointmentSlot(text, now) {
  const q = String(text||'').toLowerCase();
  const base = now || cameroonNow();
  let date = null;

  if (/après[- ]demain|day after tomorrow/.test(q)) { date = new Date(base); date.setUTCDate(date.getUTCDate()+2); }
  else if (/\bdemain\b|\btomorrow\b/.test(q)) { date = new Date(base); date.setUTCDate(date.getUTCDate()+1); }
  else if (/\baujourd['’]?hui\b|\bce soir\b|\btoday\b|\btonight\b/.test(q)) { date = new Date(base); }
  else {
    const wdFr = WEEKDAYS_FR.findIndex(d => new RegExp('\\b'+d+'\\b').test(q));
    const wd = wdFr !== -1 ? wdFr : WEEKDAYS_EN.findIndex(d => new RegExp('\\b'+d+'\\b').test(q));
    if (wd !== -1) {
      date = new Date(base);
      const todayWd = date.getUTCDay();
      let delta = (wd - todayWd + 7) % 7;
      if (delta === 0) delta = 7; // "lundi" un lundi = le lundi suivant, pas aujourd'hui
      date.setUTCDate(date.getUTCDate()+delta);
    } else {
      const dm = q.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
      if (dm) {
        date = new Date(base);
        const year = dm[3] ? (dm[3].length===2?2000+Number(dm[3]):Number(dm[3])) : date.getUTCFullYear();
        date.setUTCFullYear(year, Number(dm[2])-1, Number(dm[1]));
      }
    }
  }
  if (!date) return null;

  const tm = q.match(/\b(\d{1,2})\s*[h:]\s*(\d{2})?\b/);
  let hour = 9, minute = 0; // heure par défaut si le client ne précise que le jour
  if (tm) { hour = Math.min(23, Number(tm[1])); minute = tm[2] ? Number(tm[2]) : 0; }
  else if (/matin|morning/.test(q)) hour = 9;
  else if (/apr[eè]s[- ]midi|afternoon/.test(q)) hour = 15;
  else if (/soir|evening|night/.test(q)) hour = 18;
  date.setUTCHours(hour, minute, 0, 0);
  // `base`/`date` portent l'heure du Cameroun encodée dans les champs UTC
  // (voir cameroonNow()) — on revient ici au véritable instant UTC (Cameroun
  // = UTC+1 fixe, sans heure d'été) avant de renvoyer une date exploitable.
  date = new Date(date.getTime() - 60*60*1000);

  const typeMatch = APPOINTMENT_TYPE_HINTS.find(([re]) => re.test(q));
  return { scheduledAt: date, hasExplicitTime: Boolean(tm), type: typeMatch ? typeMatch[1] : 'Rendez-vous' };
}

// Relances automatiques contrôlées (section 26 du dossier de transmission).
// Portée volontairement réduite par rapport à la cadence multi-étapes décrite
// dans le dossier (quelques heures → 24h → 72h avec suivi de réponse) : il
// n'existe pas encore de planificateur/tâche de fond dans ce serveur HTTP
// simple, et « pas de réponse » n'a de sens que lorsque l'envoi WhatsApp réel
// existera (phase suivante). Ici : UNE relance automatique programmée par
// prospect à la fois, ré-échelonnée (jamais dupliquée) à chaque nouvelle
// qualification, et annulée dès que la situation ne la justifie plus plus —
// commande passée, prospect gagné/perdu, ou action immédiate requise (humain,
// commande à proposer, réponse urgente). Ce moteur ne fait que planifier ou
// annuler des lignes en base ; il n'envoie jamais de message lui-même.
const AUTO_FOLLOWUP_DELAYS_MS = {
  follow_up_soon: 4 * 60 * 60 * 1000,  // ~4h — prospect tiède
  nurture: 72 * 60 * 60 * 1000         // ~72h — prospect froid
};

async function cancelAutoFollowups(companyId, prospectId, reason) {
  if (!companyId || !prospectId) return;
  await query(
    "UPDATE followups SET status='Annulée',cancelled_reason=$1 WHERE company_id=$2 AND prospect_id=$3 AND source='auto' AND status='Programmée'",
    [reason, companyId, prospectId]
  );
}

async function syncAutoFollowup(companyId, prospectId, nextAction) {
  if (!companyId || !prospectId || !nextAction) return;
  const s = await query('SELECT plan FROM subscriptions WHERE company_id=$1',[companyId]);
  if (!planLimits(s.rows[0]?.plan).autoFollowups) {
    return cancelAutoFollowups(companyId, prospectId, "Relances automatiques non incluses dans le forfait actuel");
  }
  const delayMs = AUTO_FOLLOWUP_DELAYS_MS[nextAction.action];
  if (!delayMs) {
    return cancelAutoFollowups(companyId, prospectId, "Action immédiate requise (" + nextAction.action + ") — relance automatique inutile");
  }
  const dueAt = new Date(Date.now() + delayMs).toISOString();
  const text = 'Relance automatique — ' + nextAction.reason;
  const existing = await query(
    "SELECT id FROM followups WHERE company_id=$1 AND prospect_id=$2 AND source='auto' AND status='Programmée' ORDER BY created_at DESC LIMIT 1",
    [companyId, prospectId]
  );
  if (existing.rows[0]) {
    await query('UPDATE followups SET due_at=$1,text=$2 WHERE id=$3', [dueAt, text, existing.rows[0].id]);
  } else {
    await query(
      "INSERT INTO followups(company_id,prospect_id,text,due_at,status,source) VALUES($1,$2,$3,$4,'Programmée','auto')",
      [companyId, prospectId, text, dueAt]
    );
  }
}

function ai(text, products=[]) {
  const q=String(text||'').toLowerCase();
  const isEn = /\b(price|how much|cost|stock|available|deliver|delivery|buy|order|human|agent)\b/.test(q) && !/[àâéèêëîïôûüç]/.test(q);
  if(q.includes('prix')||q.includes('combien')||q.includes('price')||q.includes('how much')) return products.length ? products.map(p=>`${p.name}: ${Number(p.price).toLocaleString('fr-FR')} FCFA`).join(' · ')+(isEn?'. Which one interests you?':'. Lequel vous intéresse ?') : (isEn?'I can tell you about our products. Which item are you looking for?':'Je peux vous renseigner sur nos produits. Quel article recherchez-vous ?');
  if(q.includes('dispon')||q.includes('stock')||q.includes('available')) return isEn?'Yes, tell me which product and I\'ll check stock.':'Oui, dites-moi le produit souhaité et je vérifie le stock.';
  if(q.includes('livr')||q.includes('deliver')) return isEn?'Yes. What\'s your area for delivery?':'Oui. Quel est votre quartier pour organiser la livraison ?';
  if(q.includes('acheter')||q.includes('commande')||q.includes('buy')||q.includes('order')) return isEn?'With pleasure. Give me your name, phone, product and location to prepare the order.':'Avec plaisir. Donnez-moi votre nom, téléphone, produit et localisation pour préparer la commande.';
  if(q.includes('humain')||q.includes('conseiller')||q.includes('human')||q.includes('agent')) return isEn?'Of course. I\'m passing your request to a team member.':'Bien sûr. Je transmets votre demande à un conseiller humain.';
  return isEn?'Hello 👋 I\'m your sales assistant. How can I help you?':'Bonjour 👋 Je suis votre assistant commercial. Que puis-je faire pour vous ?';
}

// Envoi WhatsApp réel (phase 3, Meta WhatsApp Cloud API). Règle impérative,
// comme pour les moteurs de qualification et de relance : on n'envoie JAMAIS
// un message de notre propre initiative ici — cette fonction n'est appelée
// que lorsqu'un utilisateur a explicitement créé un message sortant (via
// l'interface CRM/Conversations). Si l'entreprise n'a pas configuré
// WhatsApp, ou si la conversation n'est pas un vrai fil WhatsApp, le message
// reste simplement enregistré en base comme avant (comportement démo
// inchangé) sans aucun appel réseau.
const WHATSAPP_API_VERSION = 'v21.0';

function formatWhatsAppPhone(phone) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (/^[62]\d{8}$/.test(p)) p = '237' + p; // numéro mobile camerounais local sans indicatif
  return p || null;
}

async function sendWhatsAppMessage(company, toPhone, text) {
  const to = formatWhatsAppPhone(toPhone);
  if (!to) return { error: 'Numéro de destinataire invalide' };
  try {
    const resp = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${company.whatsappPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + company.whatsappAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { error: data?.error?.message || ('Erreur WhatsApp (HTTP ' + resp.status + ')') };
    }
    return { providerMessageId: data?.messages?.[0]?.id || null };
  } catch (e) {
    return { error: 'Connexion à WhatsApp impossible : ' + e.message };
  }
}

// Catalogue produits interactif (fonctionnalité "meilleure pratique" repérée
// chez plusieurs concurrents africains/globaux — Zoko, Interakt — qui
// affichent le catalogue directement dans la conversation au lieu d'un texte
// brut). Utilise un message "interactive list" de l'API Cloud WhatsApp
// (natif, sans passer par un catalogue Meta Commerce séparé) : le client
// parcourt jusqu'à 10 produits par message sans quitter WhatsApp. L'id de
// chaque ligne (product_<id>) permet, à la sélection, de retrouver le
// produit exact — voir extractInboundText.
async function sendWhatsAppProductList(company, toPhone, products) {
  const to = formatWhatsAppPhone(toPhone);
  if (!to) return { error: 'Numéro de destinataire invalide' };
  const rows = (products || []).slice(0, 10).map(p => ({
    id: 'product_' + p.id,
    title: String(p.name || 'Produit').slice(0, 24),
    description: (Number(p.price || 0).toLocaleString('fr-FR') + ' FCFA' + (Number(p.stock) > 0 ? ' · Stock: ' + p.stock : ' — Rupture de stock')).slice(0, 72)
  }));
  if (!rows.length) return { error: 'Aucun produit à afficher' };
  try {
    const resp = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${company.whatsappPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + company.whatsappAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: 'Voici notre catalogue 🛍️ Touchez un article pour en savoir plus.' },
          action: { button: 'Voir le catalogue', sections: [{ title: 'Nos produits', rows }] }
        }
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { error: data?.error?.message || ('Erreur WhatsApp (HTTP ' + resp.status + ')') };
    return { providerMessageId: data?.messages?.[0]?.id || null };
  } catch (e) {
    return { error: 'Connexion à WhatsApp impossible : ' + e.message };
  }
}

// Photo produit envoyée quand le client sélectionne un article dans le
// catalogue interactif (WhatsApp ne permet pas d'image par ligne dans une
// liste native — on l'envoie donc comme message séparé juste après la
// sélection, voir webhook POST /webhooks/whatsapp).
async function sendWhatsAppImage(company, toPhone, imageUrl, caption) {
  const to = formatWhatsAppPhone(toPhone);
  if (!to) return { error: 'Numéro de destinataire invalide' };
  try {
    const resp = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${company.whatsappPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + company.whatsappAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption: caption || '' } })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { error: data?.error?.message || ('Erreur WhatsApp (HTTP ' + resp.status + ')') };
    return { providerMessageId: data?.messages?.[0]?.id || null };
  } catch (e) {
    return { error: 'Connexion à WhatsApp impossible : ' + e.message };
  }
}

// Le client demande à voir le catalogue en texte libre ("vous avez quoi
// comme produits ?", "catalogue", "menu"…) — déclenche l'envoi de la liste
// interactive ci-dessus plutôt qu'une réponse IA classique.
const CATALOG_INTENT = /\b(catalogue?|liste des produits|vos produits|vos articles|qu[’']?avez[- ]vous|qu avez vous|montrez?[- ]moi|montre moi vos|voir (?:le |vos )?produits|c['’]est quoi vos produits|menu produits|catalog|product list|your products|what do you (?:have|sell)|show me (?:your|the) products?|see (?:your|the) products?|products? menu)\b/i;

// Convertit un message WhatsApp entrant (texte libre OU réponse à un message
// interactif) en texte exploitable par le pipeline existant (qualification,
// IA, etc.). Une sélection dans la liste du catalogue devient une phrase
// naturelle ("Je m'intéresse à ...") pour que l'IA réponde avec le prix/stock
// exact du produit choisi, en s'appuyant sur le catalogue déjà dans son
// system prompt — sans code de réponse dédié à dupliquer/maintenir.
function extractInboundText(msg) {
  if (msg.type === 'text') return msg.text?.body || '';
  if (msg.type === 'interactive') {
    const it = msg.interactive || {};
    if (it.type === 'list_reply' && it.list_reply) {
      const title = it.list_reply.title || '';
      return title ? ("Je m'intéresse à : " + title) : "Je m'intéresse à ce produit.";
    }
    if (it.type === 'button_reply' && it.button_reply) {
      return it.button_reply.title || it.button_reply.id || '';
    }
  }
  return '[Message ' + (msg.type || 'non textuel') + ' reçu — non traité automatiquement]';
}

// Si le message entrant est une sélection dans le catalogue interactif
// (sendWhatsAppProductList), renvoie l'id du produit choisi (voir rows:
// id: 'product_'+p.id), sinon null.
function extractSelectedProductId(msg) {
  if (msg.type === 'interactive' && msg.interactive?.type === 'list_reply') {
    const id = msg.interactive.list_reply?.id || '';
    if (id.startsWith('product_')) return id.slice('product_'.length);
  }
  return null;
}

// Définition des forfaits VENDIA. C'est ici (et uniquement ici) que se
// décide ce que chaque palier autorise — la table 'subscriptions' ne stocke
// que le nom du plan choisi par l'entreprise, jamais ses limites : changer
// une limite ne demande donc qu'une modification de cet objet.
// aiMessagesLimit / maxProspectsPerMonth / maxUsers = null signifie illimité.
// maxAdmins = combien de membres peuvent simultanément porter le rôle
// 'owner' (l'administrateur d'équipe, capable d'ajouter/retirer des membres
// et de transférer ce rôle) : Starter n'a qu'un seul utilisateur de toute
// façon, Business impose un administrateur unique (transférable), Pro en
// autorise jusqu'à 3 pour les équipes plus grandes.
const PLAN_LIMITS = {
  Starter:  { monthlyPrice: 10000, maxProspectsPerMonth: 100, maxUsers: 1,    maxAdmins: 1, aiAutoReply: true, aiMessagesLimit: 100, autoFollowups: false, prioritySupport: false },
  Business: { monthlyPrice: 25000, maxProspectsPerMonth: 300, maxUsers: 3,    maxAdmins: 1, aiAutoReply: true, aiMessagesLimit: null, autoFollowups: true,  prioritySupport: false },
  Pro:      { monthlyPrice: 50000, maxProspectsPerMonth: null, maxUsers: null, maxAdmins: 3, aiAutoReply: true, aiMessagesLimit: null, autoFollowups: true,  prioritySupport: true  },
};
const planLimits = plan => PLAN_LIMITS[plan] || PLAN_LIMITS.Starter;

// Lit (et réinitialise si la période mensuelle glissante est écoulée) le
// quota de réponses IA d'une entreprise. Pas de tâche de fond nécessaire :
// la réinitialisation se fait paresseusement, à la prochaine lecture/écriture
// après l'échéance — comme la purge des sessions expirées plus haut.
async function getAiUsage(companyId, plan) {
  const limit = planLimits(plan).aiMessagesLimit;
  const r = await query('SELECT ai_messages_used AS "used",ai_usage_reset_at AS "resetAt" FROM subscriptions WHERE company_id=$1',[companyId]);
  let row = r.rows[0] || { used: 0, resetAt: null };
  if (!row.resetAt || new Date(row.resetAt) <= new Date()) {
    const newReset = new Date(Date.now() + 30*24*60*60*1000);
    await query('UPDATE subscriptions SET ai_messages_used=0,ai_usage_reset_at=$1 WHERE company_id=$2',[newReset.toISOString(),companyId]).catch(()=>{});
    row = { used: 0, resetAt: newReset.toISOString() };
  }
  const remaining = limit==null ? null : Math.max(0, limit - row.used);
  return { used: row.used, limit, remaining, resetAt: row.resetAt };
}
async function incrementAiUsage(companyId) {
  await query('UPDATE subscriptions SET ai_messages_used=ai_messages_used+1 WHERE company_id=$1',[companyId]).catch(()=>{});
}

// Génère une réponse WhatsApp via l'API Anthropic (Claude), ancrée dans le
// catalogue et le ton propres à l'entreprise. Ne lève jamais d'exception vers
// l'appelant : renvoie null si la clé API est absente ou si l'appel échoue
// (l'appelant journalise et laisse simplement la conversation sans réponse
// automatique pour ce message — comportement dégradé, jamais bloquant).
async function generateAiReply(company, prospect, products, history) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.warn('[ai-reply] ANTHROPIC_API_KEY non configuré — réponse automatique désactivée'); return null; }

  const catalogue = (products||[]).length
    ? products.map(p=>'- '+p.name+(p.category?' ('+p.category+')':'')+' : '+Number(p.price).toLocaleString('fr-FR')+' FCFA, stock '+p.stock).join('\n')
    : 'Aucun produit renseigné pour le moment — ne propose aucun article précis, demande ce que le client recherche.';

  const paymentMethods=[company.paymentOrangeMoney?('Orange Money : '+company.paymentOrangeMoney):null,company.paymentMtnMomo?('MTN Mobile Money : '+company.paymentMtnMomo):null].filter(Boolean);

  const systemPrompt = [
    'Tu es '+(company.aiName||'l\'assistant commercial')+' de l\'entreprise "'+company.name+'"'+(company.sector?' (secteur : '+company.sector+')':'')+', et tu réponds aux clients sur WhatsApp.',
    'Ton de voix : '+(company.aiTone||'professionnel et chaleureux')+'.',
    'Langue : réponds TOUJOURS dans la même langue que le dernier message du client (détecte-la automatiquement à chaque message — français, anglais, ou autre). Si son message ne permet pas de déterminer la langue avec certitude (ex. juste un emoji ou un numéro), utilise '+(company.aiLanguage||'le français')+' par défaut. Ne mélange jamais deux langues dans une même réponse.',
    company.aiRules ? 'Consignes spécifiques de l\'entreprise à respecter : '+company.aiRules : null,
    'Catalogue actuel :\n'+catalogue,
    prospect ? 'Fiche du client en cours — statut commercial : '+(prospect.status||'inconnu')+', besoin exprimé jusqu\'ici : '+(prospect.need||'non précisé')+'.' : null,
    paymentMethods.length ? 'Moyens de paiement disponibles pour ce client :\n'+paymentMethods.join('\n')+'\nQuand le client confirme vouloir commander/payer, indique-lui clairement comment payer (numéro et moyen ci-dessus). Ne mentionne aucun autre moyen de paiement.' : null,
    'Si le client propose ou confirme une date/heure pour un rendez-vous, une livraison, une démonstration ou un appel, confirme-le clairement et brièvement dans ta réponse (le système enregistre ce rendez-vous automatiquement). Si son intention de rendez-vous est claire mais qu\'il ne précise ni jour ni heure, demande-lui de proposer un jour et une heure.',
    'Règles impératives :',
    '- Réponds de façon brève et naturelle, comme un vrai message WhatsApp (1 à 3 phrases courtes, pas de markdown, pas de listes à puces, pas de formule d\'email).',
    '- N\'invente jamais un prix, un produit ou une disponibilité qui n\'est pas dans le catalogue ci-dessus.',
    '- Si tu ne peux pas répondre avec certitude, dis que tu vérifies et reviens vers le client, sans inventer de réponse.',
    '- Ne révèle jamais que tu es une intelligence artificielle, sauf si le client le demande explicitement.',
  ].filter(Boolean).join('\n\n');

  const raw = (history||[]).filter(m=>m.body && m.body.trim()).map(m=>({role: m.direction==='in'?'user':'assistant', content:m.body}));
  const messages=[];
  for (const m of raw) {
    if (messages.length && messages[messages.length-1].role===m.role) messages[messages.length-1].content += '\n' + m.content;
    else messages.push({...m});
  }
  while (messages.length && messages[0].role!=='user') messages.shift();
  if (!messages.length || messages[messages.length-1].role!=='user') return null; // rien de neuf à répondre

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 300, system: systemPrompt, messages })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(()=>'');
      console.error('[ai-reply] erreur API Anthropic %s: %s', resp.status, errText.slice(0,300));
      return null;
    }
    const data = await resp.json();
    const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
    return text || null;
  } catch(e) {
    console.error('[ai-reply] echec appel API Anthropic:', e.message);
    return null;
  }
}

// N'envoie réellement que si (a) l'entreprise a configuré ses identifiants
// WhatsApp, (b) la conversation est un fil WhatsApp avec un numéro connu.
// Sinon, renvoie null (aucun envoi, comportement inchangé).
async function maybeSendWhatsApp(companyId, conv, text) {
  if (!conv || conv.channel !== 'whatsapp' || !conv.phone) return null;
  const c = await query('SELECT whatsapp_phone_number_id AS "whatsappPhoneNumberId",whatsapp_access_token AS "whatsappAccessToken" FROM companies WHERE id=$1', [companyId]);
  const company = c.rows[0];
  if (!company?.whatsappPhoneNumberId || !company?.whatsappAccessToken) return null;
  company.whatsappAccessToken = decryptSecret(company.whatsappAccessToken);
  if (!company.whatsappAccessToken) return { error: 'Jeton WhatsApp illisible (chiffrement) — reconfigurez-le dans Réglages.' };
  return sendWhatsAppMessage(company, conv.phone, text);
}

// Statut du quota mensuel de nouveaux prospects (plan Starter/Business/Pro —
// voir PLAN_LIMITS). limit=null signifie illimité. Utilisé à la fois pour la
// création manuelle (POST /api/prospects) et pour la création automatique
// depuis un message WhatsApp entrant (ingestMessage ci-dessous) — jusqu'ici
// cette limite n'était affichée nulle part côté serveur, jamais appliquée.
async function prospectQuotaStatus(companyId) {
  const s = await query('SELECT plan FROM subscriptions WHERE company_id=$1',[companyId]);
  const limit = planLimits(s.rows[0]?.plan).maxProspectsPerMonth;
  if (limit == null) return { allowed: true, limit: null };
  const c = await query("SELECT COUNT(*)::int AS n FROM prospects WHERE company_id=$1 AND created_at >= date_trunc('month', now())",[companyId]);
  return { allowed: c.rows[0].n < limit, limit, count: c.rows[0].n };
}

// Retrouve ou crée le prospect associé à un numéro de téléphone, en évitant
// la création en double quand deux messages du même contact arrivent presque
// simultanément (rafale de webhooks) : on retente une lecture si l'insertion
// se heurte à la contrainte unique prospects_company_phone_idx (ajoutée par
// ensureMigrations — voir audit, point "race condition"). Fonctionne aussi
// sans cette contrainte (ancienne base non encore migrée), simplement sans la
// protection anti-doublon dans ce cas précis. Renvoie null si le quota mensuel
// de prospects du forfait est atteint ET qu'aucun prospect existant n'a été
// trouvé pour ce numéro (dégradé : le message est quand même traité et reçoit
// une réponse IA, mais sans fiche CRM créée — voir ingestMessage).
async function findOrCreateProspectByPhone(companyId, phone, name, needText) {
  if (phone) {
    const existing = await query('SELECT id FROM prospects WHERE company_id=$1 AND phone=$2 ORDER BY created_at DESC LIMIT 1',[companyId,phone]);
    if (existing.rows[0]) return existing.rows[0].id;
  }
  const quota = await prospectQuotaStatus(companyId);
  if (!quota.allowed) {
    console.warn('[prospects] quota mensuel atteint companyId=%s limite=%s — nouveau contact non enregistre en CRM',companyId,quota.limit);
    return null;
  }
  try {
    const created = await query('INSERT INTO prospects(company_id,name,phone,need,value,score,status,stage,order_intent,last_contact) VALUES($1,$2,$3,$4,0,0,$5,$6,false,now()) RETURNING id',[companyId,name,phone,needText,heatFromScore(0),'Nouveau']);
    return created.rows[0].id;
  } catch (e) {
    if (e.code === '23505' && phone) { // doublon créé entre-temps par une requête concurrente — on relit la ligne gagnante
      const r2 = await query('SELECT id FROM prospects WHERE company_id=$1 AND phone=$2 ORDER BY created_at DESC LIMIT 1',[companyId,phone]);
      if (r2.rows[0]) return r2.rows[0].id;
    }
    throw e;
  }
}

// Même principe que ci-dessus pour les conversations WhatsApp : évite deux
// conversations distinctes pour le même contact quand plusieurs messages
// arrivent en rafale (voir audit, point "race condition"). S'appuie sur
// conversations_company_channel_contact_idx quand elle existe.
async function findOrCreateWhatsAppConversation(companyId, from) {
  const select = () => query('SELECT id,prospect_id AS "prospectId",external_contact AS phone,channel FROM conversations WHERE company_id=$1 AND channel=\'whatsapp\' AND external_contact=$2 ORDER BY created_at DESC LIMIT 1',[companyId,from]);
  const existing = await select();
  if (existing.rows[0]) return existing.rows[0];
  try {
    const created = await query('INSERT INTO conversations(company_id,prospect_id,channel,external_contact) VALUES($1,NULL,\'whatsapp\',$2) RETURNING id,prospect_id AS "prospectId",external_contact AS phone,channel',[companyId,from]);
    return created.rows[0];
  } catch (e) {
    if (e.code === '23505') {
      const r2 = await select();
      if (r2.rows[0]) return r2.rows[0];
    }
    throw e;
  }
}

// Logique partagée d'ingestion d'un message dans une conversation, utilisée à
// la fois par la route manuelle POST /api/conversations/:id/messages (saisie
// dans l'interface, ou test depuis l'Assistant IA) et par le webhook WhatsApp
// entrant (phase 3) — pour que les deux chemins qualifient, déterminent
// l'action recommandée et synchronisent la relance automatique de façon
// identique, sans dérive entre les deux.
// conv = {id (conversationId), prospectId, phone, channel} tel que connu
// avant l'ingestion (déjà en base ou résolu par l'appelant).
async function ingestMessage(companyId, conversationId, conv, b) {
  const direction=b.direction||'out';
  const text=String(b.body).trim();
  const r=await query('INSERT INTO messages(conversation_id,direction,body,provider_message_id) VALUES($1,$2,$3,$4) RETURNING id,direction,body,provider_message_id AS "providerMessageId",provider_error AS "providerError",created_at AS "createdAt"',[conversationId,direction,text,b.providerMessageId||null]);
  const messageRow=r.rows[0];

  let prospectId=b.prospectId||conv.prospectId||null;
  let qualification=null;
  let nextAction=null;
  if(prospectId) await query('UPDATE conversations SET prospect_id=$1 WHERE id=$2 AND company_id=$3',[prospectId,conversationId,companyId]);

  if(direction==='in') {
    if(!prospectId) {
      const phone=b.phone||conv.phone||null;
      const name=(b.name||'').trim()||null;
      prospectId=await findOrCreateProspectByPhone(companyId,phone,name,text);
      if(prospectId) await query('UPDATE conversations SET prospect_id=$1 WHERE id=$2 AND company_id=$3',[prospectId,conversationId,companyId]);
    }

    const d=await query('SELECT name,price,stock FROM products WHERE company_id=$1 ORDER BY created_at',[companyId]);
    const p=await query('SELECT id,name,phone,need,value,score,status,order_intent AS "orderIntent" FROM prospects WHERE id=$1 AND company_id=$2',[prospectId,companyId]);
    if(p.rows[0]) {
      const extracted=extractCustomerData(text,p.rows[0]);
      qualification=classifyLead(text,d.rows,p.rows[0]);
      nextAction=determineNextAction(text,qualification);
      const needText=extracted.location ? text+' | Localisation: '+extracted.location : text;
      await query(
        'UPDATE prospects SET name=COALESCE(NULLIF($1,\'\'),name),phone=COALESCE(NULLIF($2,\'\'),phone),score=$3,status=$4,order_intent=$5,last_contact=now(),need=COALESCE(NULLIF($6,\'\'),need),next_action=$7,next_action_priority=$8,next_action_reason=$9,next_action_at=now() WHERE id=$10 AND company_id=$11',
        [extracted.name,extracted.phone,qualification.score,qualification.status,qualification.orderIntent,needText,nextAction.action,nextAction.priority,nextAction.reason,prospectId,companyId]
      );
      await syncAutoFollowup(companyId,prospectId,nextAction);
    }
  } else if (direction==='out') {
    const sendResult=await maybeSendWhatsApp(companyId,conv,text);
    if(sendResult) {
      if(sendResult.error) console.error('[whatsapp-send] echec envoi companyId=%s conversationId=%s erreur=%s',companyId,conversationId,sendResult.error);
      const updated=await query('UPDATE messages SET provider_message_id=COALESCE($1,provider_message_id),provider_error=$2 WHERE id=$3 RETURNING provider_message_id AS "providerMessageId",provider_error AS "providerError"',[sendResult.providerMessageId||null,sendResult.error||null,messageRow.id]);
      Object.assign(messageRow,updated.rows[0]);
    }
  }
  return {message:messageRow,prospectId,qualification,nextAction};
}

async function handler(req,res) {
  if(req.method==='OPTIONS') return json(res,204,{});
  const u=new URL(req.url,`http://${req.headers.host}`);
  if(req.method==='GET'&&u.pathname==='/api/health') return json(res,200,{ok:true,version:'1.10.8',service:'VENDIA',database:'postgresql'});
  if(req.method==='GET'&&u.pathname==='/api/version') return json(res,200,{version:'1.10.8'});
  if(req.method==='GET'&&u.pathname==='/') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await readFile(path.join(__dirname,'public/index.html'))); }
  if(req.method==='GET'&&(u.pathname==='/confidentialite'||u.pathname==='/privacy')) { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await readFile(path.join(__dirname,'public/confidentialite.html'))); }
  if(req.method==='GET'&&u.pathname==='/superadmin.html') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await readFile(path.join(__dirname,'public/superadmin.html'))); }
  if(req.method==='GET'&&u.pathname==='/signup.html') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await readFile(path.join(__dirname,'public/signup.html'))); }
  if(req.method==='GET'&&u.pathname.startsWith('/assets/')) {
    const assetTypes={'.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
    const ext=path.extname(u.pathname).toLowerCase();
    const rel=path.normalize(u.pathname).replace(/^(\.\.[/\\])+/,'');
    if(!assetTypes[ext]) return json(res,404,{error:'Introuvable'});
    try {
      const filePath=path.join(__dirname,'public',rel);
      if(!filePath.startsWith(path.join(__dirname,'public'))) return json(res,404,{error:'Introuvable'});
      const data=await readFile(filePath);
      res.writeHead(200,{'Content-Type':assetTypes[ext],'Cache-Control':'public, max-age=604800, immutable'});
      return res.end(data);
    } catch { return json(res,404,{error:'Introuvable'}); }
  }

  // Webhook WhatsApp (Meta Cloud API, phase 3) — appelé directement par Meta,
  // donc volontairement AVANT ensureDemo()/l'authentification par session :
  // Meta n'a ni compte ni jeton de session VENDIA, seulement le jeton de
  // vérification propre à chaque entreprise, comparé ci-dessous.
  if(req.method==='GET'&&u.pathname==='/webhooks/whatsapp') {
    const mode=u.searchParams.get('hub.mode');
    const verifyToken=u.searchParams.get('hub.verify_token');
    const challenge=u.searchParams.get('hub.challenge');
    console.log('[webhook] GET verification hit — mode=%s token=%s',mode,verifyToken?verifyToken.slice(0,6)+'…':'(none)');
    if(mode==='subscribe'&&verifyToken) {
      const match=await query('SELECT id FROM companies WHERE whatsapp_verify_token=$1',[verifyToken]);
      if(match.rows[0]) { console.log('[webhook] GET verification OK'); res.writeHead(200,{'Content-Type':'text/plain'}); return res.end(challenge||''); }
      console.log('[webhook] GET verification FAILED — no company with this verify_token');
    }
    res.writeHead(403,{'Content-Type':'text/plain'}); return res.end('Forbidden');
  }
  if(req.method==='POST'&&u.pathname==='/webhooks/whatsapp') {
    // Meta exige un accusé 200 rapide, retries sinon — on encaisse toute
    // erreur de traitement sans jamais la répercuter dans la réponse HTTP.
    console.log('[webhook] POST received, content-length=%s',req.headers['content-length']);
    try {
      const raw=await rawBody(req);
      if(!verifyMetaSignature(req,raw)) {
        console.error('[webhook] signature invalide — requête rejetée');
        res.writeHead(403,{'Content-Type':'text/plain'}); return res.end('Forbidden');
      }
      const b=raw?JSON.parse(raw):{};
      const entries=Array.isArray(b.entry)?b.entry:[];
      console.log('[webhook] POST parsed — %d entry(ies)',entries.length);
      for(const entry of entries) {
        const changes=Array.isArray(entry.changes)?entry.changes:[];
        for(const change of changes) {
          const value=change.value||{};
          const phoneNumberId=value.metadata?.phone_number_id;
          const messages=Array.isArray(value.messages)?value.messages:[];
          console.log('[webhook] change field=%s phoneNumberId=%s messages=%d',change.field,phoneNumberId,messages.length);
          if(!phoneNumberId||!messages.length) continue; // accusés de statut (lu/livré) ou métadonnées seules : rien à faire
          const c=await query('SELECT c.id,c.name,c.sector,c.ai_name AS "aiName",c.ai_tone AS "aiTone",c.ai_language AS "aiLanguage",c.ai_rules AS "aiRules",c.ai_auto_reply_enabled AS "aiAutoReplyEnabled",c.suspended,c.approved_at AS "approvedAt",c.whatsapp_phone_number_id AS "whatsappPhoneNumberId",c.whatsapp_access_token AS "whatsappAccessToken",c.payment_orange_money AS "paymentOrangeMoney",c.payment_mtn_momo AS "paymentMtnMomo",s.plan AS "plan" FROM companies c LEFT JOIN subscriptions s ON s.company_id=c.id WHERE c.whatsapp_phone_number_id=$1',[phoneNumberId]);
          const companyRow=c.rows[0];
          const targetCompanyId=companyRow?.id;
          if(!targetCompanyId) { console.error('Webhook WhatsApp: aucune entreprise pour phone_number_id',phoneNumberId); continue; }
          if(companyRow.suspended||!companyRow.approvedAt) { console.warn('[webhook] entreprise suspendue ou non validée companyId=%s — message ignoré',targetCompanyId); continue; }
          companyRow.whatsappAccessToken=decryptSecret(companyRow.whatsappAccessToken);
          console.log('[webhook] routing %d message(s) to companyId=%s',messages.length,targetCompanyId);
          const contact=(value.contacts||[])[0];
          const contactName=contact?.profile?.name||null;
          for(const msg of messages) {
            const from=String(msg.from||'').replace(/^237/,''); // aligné sur le format local déjà utilisé dans l'app (ex. prospects saisis manuellement)
            if(!from) continue;
            // Déduplication : Meta peut renvoyer deux fois le même événement
            // (retry réseau, accusé non reçu à temps) — on n'ingère chaque
            // message WhatsApp qu'une seule fois (voir audit, table déjà
            // prévue dans le schéma mais jusqu'ici jamais utilisée).
            if(msg.id) {
              const dedup=await query('INSERT INTO webhook_events(provider,external_event_id,payload) VALUES($1,$2,$3) ON CONFLICT (provider,external_event_id) DO NOTHING RETURNING id',['whatsapp_cloud',msg.id,JSON.stringify({phoneNumberId,from,type:msg.type})]).catch(e=>{console.error('[webhook] dedup indisponible (table manquante?) — poursuite sans dedup:',e.message); return {rows:[{id:'nodedupe'}]};});
              if(!dedup.rows[0]) { console.log('[webhook] message déjà traité (dedup) id=%s — ignoré',msg.id); continue; }
            }
            const text=extractInboundText(msg);
            const conversationRow=await findOrCreateWhatsAppConversation(targetCompanyId,from);
            const ingestResult=await ingestMessage(targetCompanyId,conversationRow.id,conversationRow,{body:text,direction:'in',phone:from,name:contactName,providerMessageId:msg.id||null});

            // Catalogue avec images : si le client vient de sélectionner un
            // article dans la liste interactive et que ce produit a une
            // photo, on l'envoie en message séparé (WhatsApp ne permet pas
            // d'image par ligne dans une liste native) avant la réponse IA.
            const selectedProductId=extractSelectedProductId(msg);
            if(selectedProductId && companyRow.whatsappPhoneNumberId && companyRow.whatsappAccessToken) {
              try {
                const sp=(await query('SELECT name,price,image_url AS "imageUrl" FROM products WHERE id=$1 AND company_id=$2',[selectedProductId,targetCompanyId])).rows[0];
                if(sp?.imageUrl) {
                  const caption=sp.name+' — '+Number(sp.price||0).toLocaleString('fr-FR')+' FCFA';
                  const imgResult=await sendWhatsAppImage(companyRow,from,sp.imageUrl,caption);
                  if(imgResult.error) console.error('[catalog] echec envoi photo produit companyId=%s produit=%s erreur=%s',targetCompanyId,selectedProductId,imgResult.error);
                  else await query('INSERT INTO messages(conversation_id,direction,body,provider_message_id) VALUES($1,$2,$3,$4)',[conversationRow.id,'out','🖼️ Photo envoyée — '+caption,imgResult.providerMessageId||null]);
                }
              } catch(e) { console.error('[catalog] echec photo produit companyId=%s erreur=%s',targetCompanyId,e.message); }
            }

            // Prise de rendez-vous automatisée : un client qui exprime une
            // intention de rendez-vous (mot-clé) dans son message est
            // enregistré, confirmé (date/heure reconnue) ou "proposé" (date
            // non reconnue — un humain/l'IA devra préciser) sans action
            // manuelle. Ne bloque jamais le reste du traitement du message.
            if (ingestResult.prospectId && APPOINTMENT_INTENT.test(text)) {
              try {
                const slot=parseAppointmentSlot(text);
                await query(
                  'INSERT INTO appointments(company_id,prospect_id,conversation_id,type,scheduled_at,status) VALUES($1,$2,$3,$4,$5,$6)',
                  [targetCompanyId,ingestResult.prospectId,conversationRow.id,slot?.type||'Rendez-vous',slot?slot.scheduledAt.toISOString():null,slot?'Confirmé':'Proposé']
                );
              } catch(e) { console.error('[appointments] echec creation companyId=%s erreur=%s',targetCompanyId,e.message); }
            }

            // Réponse automatique par IA (24h/24) : déclenchée uniquement sur un
            // message WhatsApp entrant réel — jamais sur un envoi sortant — donc
            // aucun risque de boucle. Si un transfert humain est requis
            // (réclamation, litige, demande explicite d'un conseiller), l'IA ne
            // traite pas le sujet : un accusé de réception est envoyé et la main
            // reste chez l'humain (l'action recommandée reste visible dans
            // l'onglet Relances, comme avant).
            const limits=planLimits(companyRow.plan);
            if(companyRow.aiAutoReplyEnabled!==false && limits.aiAutoReply) {
              try {
                let replyText;
                let handledByCatalog=false;
                if(ingestResult.nextAction?.action==='handoff') {
                  replyText="Merci pour votre message 🙏 Je transmets tout de suite à un membre de notre équipe qui revient vers vous rapidement.";
                } else if (CATALOG_INTENT.test(text) && companyRow.whatsappPhoneNumberId && companyRow.whatsappAccessToken) {
                  const catalogProducts=(await query('SELECT id,name,price,stock FROM products WHERE company_id=$1 ORDER BY created_at',[targetCompanyId])).rows;
                  if (catalogProducts.length) {
                    const sendResult=await sendWhatsAppProductList(companyRow,from,catalogProducts);
                    if (sendResult.error) {
                      console.error('[catalog] echec envoi liste interactive companyId=%s erreur=%s',targetCompanyId,sendResult.error);
                    } else {
                      await query('INSERT INTO messages(conversation_id,direction,body,provider_message_id) VALUES($1,$2,$3,$4)',[conversationRow.id,'out','📋 Catalogue interactif envoyé ('+catalogProducts.length+' produit(s))',sendResult.providerMessageId||null]);
                      handledByCatalog=true;
                    }
                  }
                }
                if (!handledByCatalog && replyText===undefined) {
                  const usage=await getAiUsage(targetCompanyId,companyRow.plan);
                  if(usage.remaining!==null && usage.remaining<=0) {
                    console.warn('[ai-reply] quota IA epuise companyId=%s plan=%s',targetCompanyId,companyRow.plan);
                  } else {
                    const prospectRow=ingestResult.prospectId ? (await query('SELECT status,need FROM prospects WHERE id=$1',[ingestResult.prospectId])).rows[0] : null;
                    const productsRows=(await query('SELECT name,category,price,stock FROM products WHERE company_id=$1 ORDER BY created_at',[targetCompanyId])).rows;
                    const historyRows=(await query('SELECT direction,body FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 12',[conversationRow.id])).rows.reverse();
                    replyText=await generateAiReply(companyRow,prospectRow,productsRows,historyRows);
                    if(replyText) await incrementAiUsage(targetCompanyId);
                  }
                }
                if(replyText) await ingestMessage(targetCompanyId,conversationRow.id,conversationRow,{body:replyText,direction:'out'});
              } catch(e) {
                console.error('[ai-reply] echec reponse automatique companyId=%s conversationId=%s erreur=%s',targetCompanyId,conversationRow.id,e.message);
              }
            }
          }
        }
      }
    } catch(e) {
      console.error('Webhook WhatsApp erreur de traitement:',e);
    }
    return json(res,200,{received:true});
  }

  if(req.method==='POST'&&u.pathname==='/api/login') {
    if(rateLimited('login:'+clientIp(req),10,5*60*1000)) return tooManyRequests(res);
    const b=await body(req);
    const r=await query('SELECT u.id,u.name,u.email,u.company_id,u.password_hash,u.password_salt,c.name AS company_name,c.suspended,c.approved_at AS "approvedAt" FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=$1',[b.email]);
    const user=r.rows[0];
    if(!user||!verifyPassword(String(b.password||''),user.password_salt,user.password_hash)) return json(res,401,{error:'Identifiants incorrects'});
    if(!user.approvedAt) return json(res,403,{error:"Votre compte est en attente de validation du paiement. Vous serez averti par email dès l'activation."});
    if(user.suspended) return json(res,403,{error:'Ce compte VENDIA est suspendu. Contactez le support.'});
    const t=await createSession(user.id,user.company_id);
    return json(res,200,{token:t,user:{id:user.id,name:user.name,email:user.email,companyId:user.company_id,company:user.company_name}});
  }

  if(req.method==='POST'&&u.pathname==='/api/logout') {
    await deleteSession((req.headers.authorization||'').replace(/^Bearer\s+/i,''));
    return json(res,200,{ok:true});
  }

  // Mot de passe oublié — libre-service par email (voir sendEmail). La
  // réponse est volontairement identique que l'email existe ou non, pour ne
  // pas permettre de deviner quels emails sont enregistrés dans VENDIA.
  if(req.method==='POST'&&u.pathname==='/api/forgot-password') {
    if(rateLimited('forgot:'+clientIp(req),5,10*60*1000)) return tooManyRequests(res);
    const b=await body(req);
    const email=String(b.email||'').trim().toLowerCase();
    if(email) {
      const r=await query('SELECT id,name FROM users WHERE email=$1',[email]);
      const user=r.rows[0];
      if(user) {
        const rawToken=await createPasswordResetToken(user.id);
        const proto=req.headers['x-forwarded-proto']||'https';
        const link=proto+'://'+req.headers.host+'/?resetToken='+rawToken;
        await sendEmail(email,'Réinitialisation de votre mot de passe VENDIA',
          '<p>Bonjour '+escHtml(user.name)+',</p><p>Cliquez sur ce lien pour choisir un nouveau mot de passe (valable 1 heure) :</p><p><a href="'+link+'">'+link+'</a></p><p>Si vous n\'êtes pas à l\'origine de cette demande, ignorez cet email.</p>');
      }
    }
    return json(res,200,{ok:true,message:"Si un compte existe avec cet email, un lien de réinitialisation a été envoyé."});
  }
  if(req.method==='POST'&&u.pathname==='/api/reset-password') {
    const b=await body(req);
    if(!b.token||!b.password) return json(res,400,{error:'Lien invalide'});
    if(String(b.password).length<6) return json(res,400,{error:'Le mot de passe doit contenir au moins 6 caractères'});
    const userId=await consumePasswordResetToken(b.token);
    if(!userId) return json(res,400,{error:'Lien invalide ou expiré. Refaites une demande.'});
    const h=hashPassword(String(b.password));
    await query('UPDATE users SET password_hash=$1,password_salt=$2 WHERE id=$3',[h.hash,h.salt,userId]);
    await query('DELETE FROM sessions WHERE user_id=$1',[userId]).catch(()=>{}); // déconnecte partout par sécurité
    return json(res,200,{ok:true});
  }

  // Forfaits + instructions de paiement (public, utilisé par la page
  // d'inscription en libre-service) — une seule source de vérité côté
  // serveur (PLAN_LIMITS) pour éviter que les prix affichés divergent.
  if(req.method==='GET'&&u.pathname==='/api/plans') {
    const plans=Object.fromEntries(Object.entries(PLAN_LIMITS).map(([name,l])=>[name,{
      monthlyPrice:l.monthlyPrice, maxProspectsPerMonth:l.maxProspectsPerMonth, maxUsers:l.maxUsers,
      aiMessagesLimit:l.aiMessagesLimit, autoFollowups:l.autoFollowups, prioritySupport:l.prioritySupport
    }]));
    return json(res,200,{plans,payment:{orangeMoney:ORANGE_MONEY_NUMBER,mtnMomo:MTN_MOMO_NUMBER}});
  }

  // Inscription en libre-service : crée l'entreprise (nom saisi par
  // l'administrateur, affiché ensuite dans toute l'interface de son
  // équipe), son premier utilisateur (owner) et une demande de paiement en
  // attente. Le compte reste bloqué (companies.approved_at NULL — voir la
  // passerelle d'authentification plus bas) tant que le super-admin n'a pas
  // validé la réception du paiement mobile money.
  if(req.method==='POST'&&u.pathname==='/api/signup') {
    if(rateLimited('signup:'+clientIp(req),5,10*60*1000)) return tooManyRequests(res);
    const b=await body(req);
    const lang=b.lang==='en'?'en':'fr';
    const SIGNUP_MSG={
      fr:{missing:"Nom de l'entreprise, nom, email et mot de passe requis",shortPwd:'Le mot de passe doit contenir au moins 6 caractères',method:'Choisissez un moyen de paiement (Orange Money ou MTN Mobile Money)',payer:'Numéro payeur et référence de la transaction requis pour la validation',emailUsed:'Cet email est déjà utilisé',success:'Compte créé. Il sera activé dès que votre paiement aura été validé — vous serez averti par email.'},
      en:{missing:'Company name, name, email and password are required',shortPwd:'Password must be at least 6 characters',method:'Choose a payment method (Orange Money or MTN Mobile Money)',payer:'Payer number and transaction reference are required for validation',emailUsed:'This email is already in use',success:'Account created. It will be activated once your payment is confirmed — you will be notified by email.'}
    }[lang];
    if(!b.companyName||!b.ownerName||!b.ownerEmail||!b.ownerPassword) return json(res,400,{error:SIGNUP_MSG.missing});
    if(String(b.ownerPassword).length<6) return json(res,400,{error:SIGNUP_MSG.shortPwd});
    const plan=['Starter','Business','Pro'].includes(b.plan) ? b.plan : 'Starter';
    if(!['orange_money','mtn_momo'].includes(b.paymentMethod)) return json(res,400,{error:SIGNUP_MSG.method});
    if(!b.payerPhone||!b.reference) return json(res,400,{error:SIGNUP_MSG.payer});
    const email=String(b.ownerEmail).trim().toLowerCase();
    const existingUser=await query('SELECT id FROM users WHERE email=$1',[email]);
    if(existingUser.rows[0]) return json(res,409,{error:SIGNUP_MSG.emailUsed});
    const amount=planLimits(plan).monthlyPrice;
    const result=await transaction(async client=>{
      const c=await client.query('INSERT INTO companies(name,sector) VALUES($1,$2) RETURNING id',[String(b.companyName).trim(),b.sector||null]);
      const newCompanyId=c.rows[0].id;
      await client.query('INSERT INTO subscriptions(company_id,plan,status,monthly_price) VALUES($1,$2,$3,$4)',[newCompanyId,plan,'trial',amount]);
      const h=hashPassword(String(b.ownerPassword));
      await client.query('INSERT INTO users(company_id,email,name,role,password_hash,password_salt) VALUES($1,$2,$3,\'owner\',$4,$5)',[newCompanyId,email,String(b.ownerName).trim(),h.hash,h.salt]);
      const pr=await client.query('INSERT INTO payment_requests(company_id,plan,method,amount,payer_phone,reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[newCompanyId,plan,b.paymentMethod,amount,String(b.payerPhone).trim(),String(b.reference).trim()]);
      return {companyId:newCompanyId,paymentRequestId:pr.rows[0].id};
    });
    await sendEmail(process.env.SUPERADMIN_EMAIL||'', 'VENDIA — Nouvelle demande d\'activation en attente',
      '<p>Nouvelle inscription à valider :</p><ul>'+
      '<li>Entreprise : '+escHtml(b.companyName)+'</li>'+
      '<li>Forfait : '+escHtml(plan)+' ('+amount+' FCFA)</li>'+
      '<li>Propriétaire : '+escHtml(b.ownerName)+' — '+escHtml(email)+'</li>'+
      '<li>Moyen de paiement : '+(b.paymentMethod==='orange_money'?'Orange Money':'MTN Mobile Money')+'</li>'+
      '<li>Numéro payeur : '+escHtml(b.payerPhone)+'</li>'+
      '<li>Référence : '+escHtml(b.reference)+'</li></ul>'+
      '<p>Validez depuis le panneau super-admin : /superadmin.html</p>');
    return json(res,201,{ok:true,companyId:result.companyId,message:SIGNUP_MSG.success});
  }

  // --- Super-admin : compte séparé des entreprises clientes, vision et
  // contrôle sur l'ensemble de VENDIA (voir ensureSuperAdmin). Routes
  // entièrement indépendantes de l'authentification par entreprise
  // ci-dessous : un jeton de session super-admin n'a pas de companyId, et
  // réciproquement un jeton d'entreprise n'ouvre aucune route super-admin.
  if(req.method==='POST'&&u.pathname==='/api/superadmin/login') {
    if(rateLimited('sa-login:'+clientIp(req),10,5*60*1000)) return tooManyRequests(res);
    const b=await body(req);
    const r=await query('SELECT id,name,email,password_hash,password_salt FROM super_admins WHERE email=$1',[String(b.email||'').trim().toLowerCase()]);
    const sa=r.rows[0];
    if(!sa||!verifyPassword(String(b.password||''),sa.password_salt,sa.password_hash)) return json(res,401,{error:'Identifiants incorrects'});
    const t=await createSuperAdminSession(sa.id);
    return json(res,200,{token:t,admin:{id:sa.id,name:sa.name,email:sa.email}});
  }
  if(req.method==='POST'&&u.pathname==='/api/superadmin/logout') {
    await deleteSession((req.headers.authorization||'').replace(/^Bearer\s+/i,''));
    return json(res,200,{ok:true});
  }
  if(u.pathname.startsWith('/api/superadmin/')) {
    const saAuth=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    const saSession=await getSession(saAuth);
    if(!saSession||!saSession.superAdminId) return json(res,401,{error:'Authentification super-admin requise'});

    if(req.method==='GET'&&u.pathname==='/api/superadmin/companies') {
      const rows=(await query(`SELECT c.id,c.name,c.sector,c.suspended,c.approved_at AS "approvedAt",c.created_at AS "createdAt",s.plan,s.status,s.monthly_price AS "monthlyPrice" FROM companies c LEFT JOIN subscriptions s ON s.company_id=c.id ORDER BY c.created_at DESC`)).rows;
      const withUsage=await Promise.all(rows.map(async c=>{
        const [usage,userCount,prospectsCount]=await Promise.all([
          getAiUsage(c.id,c.plan),
          query('SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1',[c.id]),
          query("SELECT COUNT(*)::int AS n FROM prospects WHERE company_id=$1 AND created_at >= date_trunc('month', now())",[c.id])
        ]);
        return {...c,userCount:userCount.rows[0].n,prospectsThisMonth:prospectsCount.rows[0].n,aiUsage:usage,limits:planLimits(c.plan)};
      }));
      return json(res,200,{companies:withUsage});
    }

    if(req.method==='POST'&&u.pathname==='/api/superadmin/companies') {
      const b=await body(req);
      if(!b.name||!b.ownerName||!b.ownerEmail||!b.ownerPassword) return json(res,400,{error:'Nom de l\'entreprise, nom/email/mot de passe du propriétaire requis'});
      if(String(b.ownerPassword).length<6) return json(res,400,{error:'Le mot de passe doit contenir au moins 6 caractères'});
      const email=String(b.ownerEmail).trim().toLowerCase();
      const existingUser=await query('SELECT id FROM users WHERE email=$1',[email]);
      if(existingUser.rows[0]) return json(res,409,{error:'Cet email est déjà utilisé'});
      const plan=['Starter','Business','Pro'].includes(b.plan) ? b.plan : 'Starter';
      const result=await transaction(async client=>{
        // Créée directement par le super-admin : approuvée d'emblée, pas de
        // passage par le tunnel de paiement (Jean se porte garant lui-même).
        const c=await client.query('INSERT INTO companies(name,sector,approved_at) VALUES($1,$2,now()) RETURNING id',[String(b.name).trim(),b.sector||null]);
        const newCompanyId=c.rows[0].id;
        await client.query('INSERT INTO subscriptions(company_id,plan,status,monthly_price) VALUES($1,$2,$3,$4)',[newCompanyId,plan,'active',planLimits(plan).monthlyPrice]);
        const h=hashPassword(String(b.ownerPassword));
        const nu=await client.query('INSERT INTO users(company_id,email,name,role,password_hash,password_salt) VALUES($1,$2,$3,\'owner\',$4,$5) RETURNING id,name,email,role',[newCompanyId,email,String(b.ownerName).trim(),h.hash,h.salt]);
        return {companyId:newCompanyId,owner:nu.rows[0]};
      });
      return json(res,201,{companyId:result.companyId,owner:result.owner});
    }

    const scMatch=u.pathname.match(/^\/api\/superadmin\/companies\/([0-9a-f-]+)$/i);
    if(scMatch&&(req.method==='PUT'||req.method==='PATCH')) {
      const b=await body(req);
      if(b.plan!==undefined&&['Starter','Business','Pro'].includes(b.plan)) {
        await query('UPDATE subscriptions SET plan=$1,monthly_price=$2 WHERE company_id=$3',[b.plan,planLimits(b.plan).monthlyPrice,scMatch[1]]);
      }
      if(b.suspended!==undefined) {
        await query('UPDATE companies SET suspended=$1 WHERE id=$2',[Boolean(b.suspended),scMatch[1]]);
        if(b.suspended) await query('DELETE FROM sessions WHERE company_id=$1',[scMatch[1]]).catch(()=>{}); // déconnecte immédiatement l'entreprise suspendue
      }
      if(b.status!==undefined&&['trial','active','cancelled','past_due'].includes(b.status)) {
        await query('UPDATE subscriptions SET status=$1 WHERE company_id=$2',[b.status,scMatch[1]]);
      }
      return json(res,200,{ok:true});
    }

    const scConvMatch=u.pathname.match(/^\/api\/superadmin\/companies\/([0-9a-f-]+)\/conversations$/i);
    if(scConvMatch&&req.method==='GET') {
      const r=await query(`SELECT c.id,c.channel,c.external_contact AS phone,p.name AS prospect,c.created_at AS "createdAt",
        COALESCE(json_agg(json_build_object('id',m.id,'direction',m.direction,'body',m.body,'createdAt',m.created_at) ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL),'[]') AS messages
        FROM conversations c LEFT JOIN prospects p ON p.id=c.prospect_id LEFT JOIN messages m ON m.conversation_id=c.id
        WHERE c.company_id=$1 GROUP BY c.id,p.name ORDER BY MAX(m.created_at) DESC NULLS LAST,c.created_at DESC`,[scConvMatch[1]]);
      return json(res,200,{conversations:r.rows});
    }

    const scUsersMatch=u.pathname.match(/^\/api\/superadmin\/companies\/([0-9a-f-]+)\/users$/i);
    if(scUsersMatch&&req.method==='GET') {
      const r=await query('SELECT id,name,email,role,created_at AS "createdAt" FROM users WHERE company_id=$1 ORDER BY created_at',[scUsersMatch[1]]);
      return json(res,200,{users:r.rows});
    }
    if(scUsersMatch&&req.method==='POST') {
      const b=await body(req);
      if(!b.name||!b.email||!b.password) return json(res,400,{error:'Nom, email et mot de passe requis'});
      if(String(b.password).length<6) return json(res,400,{error:'Le mot de passe doit contenir au moins 6 caractères'});
      const email=String(b.email).trim().toLowerCase();
      const existingUser=await query('SELECT id FROM users WHERE email=$1',[email]);
      if(existingUser.rows[0]) return json(res,409,{error:'Cet email est déjà utilisé'});
      const role=['owner','admin','sales','viewer'].includes(b.role) ? b.role : 'sales';
      const h=hashPassword(String(b.password));
      const r=await query('INSERT INTO users(company_id,email,name,role,password_hash,password_salt) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,created_at AS "createdAt"',[scUsersMatch[1],email,String(b.name).trim(),role,h.hash,h.salt]);
      return json(res,201,{user:r.rows[0]});
    }
    const scUserMatch=u.pathname.match(/^\/api\/superadmin\/companies\/([0-9a-f-]+)\/users\/([0-9a-f-]+)$/i);
    if(scUserMatch&&req.method==='DELETE') {
      const r=await query('DELETE FROM users WHERE id=$1 AND company_id=$2 RETURNING id',[scUserMatch[2],scUserMatch[1]]);
      if(!r.rows[0]) return json(res,404,{error:'Utilisateur introuvable'});
      await query('DELETE FROM sessions WHERE user_id=$1',[scUserMatch[2]]).catch(()=>{});
      return json(res,200,{ok:true});
    }
    const scResetMatch=u.pathname.match(/^\/api\/superadmin\/companies\/([0-9a-f-]+)\/users\/([0-9a-f-]+)\/reset-password$/i);
    if(scResetMatch&&req.method==='POST') {
      const r=await query('SELECT id FROM users WHERE id=$1 AND company_id=$2',[scResetMatch[2],scResetMatch[1]]);
      if(!r.rows[0]) return json(res,404,{error:'Utilisateur introuvable'});
      const pwd=genTempPassword();
      const h=hashPassword(pwd);
      await query('UPDATE users SET password_hash=$1,password_salt=$2 WHERE id=$3',[h.hash,h.salt,scResetMatch[2]]);
      await query('DELETE FROM sessions WHERE user_id=$1',[scResetMatch[2]]).catch(()=>{});
      return json(res,200,{ok:true,tempPassword:pwd});
    }

    // Validations de paiement (tunnel Orange Money / MTN Mobile Money) :
    // liste des demandes en attente (ou toutes), approbation (active
    // l'entreprise et sa souscription) et rejet.
    if(req.method==='GET'&&u.pathname==='/api/superadmin/payment-requests') {
      const status=['pending','approved','rejected'].includes(u.searchParams.get('status')) ? u.searchParams.get('status') : 'pending';
      const r=await query(`SELECT pr.id,pr.company_id AS "companyId",c.name AS "companyName",pr.plan,pr.method,pr.amount,pr.payer_phone AS "payerPhone",pr.reference,pr.status,pr.created_at AS "createdAt",pr.decided_at AS "decidedAt"
        FROM payment_requests pr JOIN companies c ON c.id=pr.company_id WHERE pr.status=$1 ORDER BY pr.created_at DESC`,[status]);
      return json(res,200,{paymentRequests:r.rows});
    }
    const prApproveMatch=u.pathname.match(/^\/api\/superadmin\/payment-requests\/([0-9a-f-]+)\/approve$/i);
    if(prApproveMatch&&req.method==='POST') {
      const pr=await query('SELECT id,company_id AS "companyId",plan,amount FROM payment_requests WHERE id=$1 AND status=\'pending\'',[prApproveMatch[1]]);
      if(!pr.rows[0]) return json(res,404,{error:'Demande introuvable ou déjà traitée'});
      const {companyId:pendingCompanyId,plan}=pr.rows[0];
      await transaction(async client=>{
        await client.query('UPDATE payment_requests SET status=\'approved\',decided_at=now() WHERE id=$1',[prApproveMatch[1]]);
        await client.query('UPDATE companies SET approved_at=COALESCE(approved_at,now()) WHERE id=$1',[pendingCompanyId]);
        await client.query('UPDATE subscriptions SET plan=$1,status=\'active\',monthly_price=$2 WHERE company_id=$3',[plan,planLimits(plan).monthlyPrice,pendingCompanyId]);
      });
      const owners=await query("SELECT email,name FROM users WHERE company_id=$1 AND role='owner'",[pendingCompanyId]);
      for(const o of owners.rows) {
        await sendEmail(o.email,'Votre compte VENDIA est activé 🎉',
          '<p>Bonjour '+escHtml(o.name)+',</p><p>Votre paiement a été validé et votre compte VENDIA (forfait '+escHtml(plan)+') est maintenant actif. Vous pouvez vous connecter dès maintenant.</p>');
      }
      return json(res,200,{ok:true});
    }
    const prRejectMatch=u.pathname.match(/^\/api\/superadmin\/payment-requests\/([0-9a-f-]+)\/reject$/i);
    if(prRejectMatch&&req.method==='POST') {
      const r=await query('UPDATE payment_requests SET status=\'rejected\',decided_at=now() WHERE id=$1 AND status=\'pending\' RETURNING id',[prRejectMatch[1]]);
      if(!r.rows[0]) return json(res,404,{error:'Demande introuvable ou déjà traitée'});
      return json(res,200,{ok:true});
    }

    return json(res,404,{error:'Route super-admin introuvable'});
  }

  const auth=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const session=await getSession(auth);
  if(!session||!session.companyId) return json(res,401,{error:'Authentification requise'});
  const companyId=session.companyId;
  const susp=await query('SELECT suspended,approved_at AS "approvedAt" FROM companies WHERE id=$1',[companyId]);
  if(!susp.rows[0]?.approvedAt) return json(res,403,{error:"Votre compte est en attente de validation du paiement. Vous serez averti par email dès l'activation."});
  if(susp.rows[0]?.suspended) return json(res,403,{error:'Ce compte VENDIA est suspendu. Contactez le support.'});

  if(req.method==='GET'&&u.pathname==='/api/bootstrap') return json(res,200,await dashboard(companyId));
  if(req.method==='GET'&&u.pathname==='/api/dashboard') return json(res,200,await dashboard(companyId));

  // Tableau de bord analytics (taux de réponse, temps de réponse moyen,
  // conversion prospect→commande, volume de messages sur 14 jours) — absent
  // jusqu'ici au-delà des compteurs bruts déjà sur le dashboard principal,
  // repéré comme argument de vente manquant face aux standards du marché.
  if(req.method==='GET'&&u.pathname==='/api/analytics') {
    const [respRow,convRow,byDay,plan]=await Promise.all([
      query(`WITH inbound AS (
        SELECT m.id,m.created_at,
          (SELECT MIN(m2.created_at) FROM messages m2 WHERE m2.conversation_id=m.conversation_id AND m2.direction='out' AND m2.created_at>m.created_at) AS next_out
        FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE c.company_id=$1 AND m.direction='in' AND m.created_at >= now() - interval '30 days'
      )
      SELECT COUNT(*)::int AS total,COUNT(next_out)::int AS answered,
             AVG(EXTRACT(EPOCH FROM (next_out-created_at)))::int AS "avgSeconds"
      FROM inbound`,[companyId]),
      query(`SELECT
        (SELECT COUNT(*)::int FROM prospects WHERE company_id=$1) AS total,
        (SELECT COUNT(DISTINCT prospect_id)::int FROM orders WHERE company_id=$1 AND prospect_id IS NOT NULL) AS converted`,[companyId]),
      query(`SELECT date_trunc('day',m.created_at) AS day,COUNT(*)::int AS n
        FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE c.company_id=$1 AND m.direction='in' AND m.created_at >= now() - interval '14 days'
        GROUP BY 1 ORDER BY 1`,[companyId]),
      query('SELECT plan FROM subscriptions WHERE company_id=$1',[companyId])
    ]);
    const resp=respRow.rows[0]||{total:0,answered:0,avgSeconds:null};
    const conv=convRow.rows[0]||{total:0,converted:0};
    const byDayMap=new Map(byDay.rows.map(r=>[new Date(r.day).toISOString().slice(0,10),r.n]));
    const messagesByDay=[];
    for(let i=13;i>=0;i--) {
      const d=new Date(); d.setUTCDate(d.getUTCDate()-i);
      const key=d.toISOString().slice(0,10);
      messagesByDay.push({day:key,count:byDayMap.get(key)||0});
    }
    const aiUsage=await getAiUsage(companyId,plan.rows[0]?.plan);
    return json(res,200,{
      responseRate:{total:resp.total,answered:resp.answered,pct:resp.total?Math.round(resp.answered/resp.total*100):null},
      avgResponseSeconds:resp.avgSeconds,
      conversion:{totalProspects:conv.total,converted:conv.converted,pct:conv.total?Math.round(conv.converted/conv.total*100):null},
      messagesByDay,
      aiUsage
    });
  }

  if(req.method==='GET'&&u.pathname==='/api/me') {
    const r=await query('SELECT id,name,email,role FROM users WHERE id=$1',[session.userId]);
    return json(res,200,{me:r.rows[0]||null});
  }
  if(req.method==='POST'&&u.pathname==='/api/me/password') {
    const b=await body(req);
    const r=await query('SELECT password_hash,password_salt FROM users WHERE id=$1',[session.userId]);
    const u2=r.rows[0];
    if(!u2||!verifyPassword(String(b.currentPassword||''),u2.password_salt,u2.password_hash)) return json(res,401,{error:'Mot de passe actuel incorrect'});
    if(String(b.newPassword||'').length<6) return json(res,400,{error:'Le nouveau mot de passe doit contenir au moins 6 caractères'});
    const h=hashPassword(String(b.newPassword));
    await query('UPDATE users SET password_hash=$1,password_salt=$2 WHERE id=$3',[h.hash,h.salt,session.userId]);
    return json(res,200,{ok:true});
  }

  if(req.method==='PATCH'&&u.pathname==='/api/settings/ai') {
    const b=await body(req);
    // autoReplyEnabled seul (case à cocher) vs. formulaire complet de
    // personnalisation (nom/ton/langue/consignes) : on ne touche que les
    // champs réellement envoyés pour ne pas écraser les autres par erreur.
    if(Object.keys(b).length===1 && 'autoReplyEnabled' in b) {
      await query('UPDATE companies SET ai_auto_reply_enabled=$1 WHERE id=$2',[Boolean(b.autoReplyEnabled),companyId]);
      return json(res,200,{ok:true});
    }
    await query('UPDATE companies SET ai_name=$1,ai_tone=$2,ai_language=$3,ai_rules=$4,ai_auto_reply_enabled=$5 WHERE id=$6',[
      b.aiName?String(b.aiName).trim().slice(0,60):'Assistant commercial',
      b.aiTone?String(b.aiTone).trim().slice(0,120):'Professionnel et chaleureux',
      b.aiLanguage?String(b.aiLanguage).trim().slice(0,40):'Français',
      b.aiRules?String(b.aiRules).trim().slice(0,2000):null,
      b.autoReplyEnabled!==false,
      companyId
    ]);
    return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&u.pathname==='/api/settings/ai') {
    const r=await query('SELECT ai_name AS "aiName",ai_tone AS "aiTone",ai_language AS "aiLanguage",ai_rules AS "aiRules",ai_auto_reply_enabled AS "aiAutoReplyEnabled" FROM companies WHERE id=$1',[companyId]);
    return json(res,200,r.rows[0]||{});
  }

  // Numéros mobile money PROPRES à cette entreprise, pour que SES clients
  // puissent payer directement dans la conversation WhatsApp (l'IA les
  // mentionne — voir generateAiReply). Bien distinct des numéros du
  // super-admin (ORANGE_MONEY_NUMBER/MTN_MOMO_NUMBER) qui servent uniquement
  // au tunnel d'abonnement VENDIA lui-même.
  if(req.method==='GET'&&u.pathname==='/api/settings/payment') {
    const r=await query('SELECT payment_orange_money AS "orangeMoney",payment_mtn_momo AS "mtnMomo" FROM companies WHERE id=$1',[companyId]);
    return json(res,200,r.rows[0]||{orangeMoney:null,mtnMomo:null});
  }
  if(req.method==='PATCH'&&u.pathname==='/api/settings/payment') {
    const b=await body(req);
    await query('UPDATE companies SET payment_orange_money=$1,payment_mtn_momo=$2 WHERE id=$3',[b.orangeMoney?String(b.orangeMoney).trim():null,b.mtnMomo?String(b.mtnMomo).trim():null,companyId]);
    return json(res,200,{ok:true});
  }

  // Rendez-vous (livraison, démo, appel…) détectés automatiquement dans les
  // conversations WhatsApp entrantes — voir APPOINTMENT_INTENT/parseAppointmentSlot.
  if(req.method==='GET'&&u.pathname==='/api/appointments') {
    const r=await query(`SELECT a.id,a.prospect_id AS "prospectId",p.name AS prospect,p.phone,a.type,a.scheduled_at AS "scheduledAt",a.status,a.created_at AS "createdAt" FROM appointments a LEFT JOIN prospects p ON p.id=a.prospect_id WHERE a.company_id=$1 ORDER BY a.scheduled_at NULLS LAST,a.created_at DESC LIMIT 500`,[companyId]);
    return json(res,200,{appointments:r.rows});
  }
  const apMatch=u.pathname.match(/^\/api\/appointments\/([0-9a-f-]+)$/i);
  if(apMatch&&(req.method==='PUT'||req.method==='PATCH')) {
    const b=await body(req);
    const r=await query('UPDATE appointments SET scheduled_at=COALESCE($1,scheduled_at),status=COALESCE($2,status) WHERE id=$3 AND company_id=$4 RETURNING id,prospect_id AS "prospectId",type,scheduled_at AS "scheduledAt",status',[b.scheduledAt||null,b.status||null,apMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Rendez-vous introuvable'});
    return json(res,200,r.rows[0]);
  }
  if(apMatch&&req.method==='DELETE') {
    const r=await query('DELETE FROM appointments WHERE id=$1 AND company_id=$2 RETURNING id',[apMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Rendez-vous introuvable'});
    return json(res,200,{ok:true});
  }

  if(req.method==='GET'&&u.pathname==='/api/settings/whatsapp') {
    let c=await query('SELECT whatsapp_phone_number_id AS "phoneNumberId",whatsapp_access_token AS "accessToken",whatsapp_verify_token AS "verifyToken" FROM companies WHERE id=$1',[companyId]);
    let row=c.rows[0]||{};
    if(!row.verifyToken) {
      const vt=crypto.randomBytes(12).toString('hex');
      await query('UPDATE companies SET whatsapp_verify_token=$1 WHERE id=$2',[vt,companyId]);
      row.verifyToken=vt;
    }
    const clearToken=decryptSecret(row.accessToken);
    const proto=req.headers['x-forwarded-proto']||'https';
    return json(res,200,{
      phoneNumberId:row.phoneNumberId||null,
      accessTokenSet:Boolean(clearToken),
      accessTokenPreview:clearToken?('••••'+clearToken.slice(-4)):null,
      verifyToken:row.verifyToken,
      webhookUrl:proto+'://'+req.headers.host+'/webhooks/whatsapp',
      configured:Boolean(row.phoneNumberId&&clearToken)
    });
  }
  if(req.method==='PUT'&&u.pathname==='/api/settings/whatsapp') {
    const b=await body(req);
    if(!b.phoneNumberId||!b.accessToken) return json(res,400,{error:'ID du numéro et jeton d\'accès requis'});
    const existing=await query('SELECT whatsapp_verify_token AS "verifyToken" FROM companies WHERE id=$1',[companyId]);
    const verifyToken=existing.rows[0]?.verifyToken||crypto.randomBytes(12).toString('hex');
    await query('UPDATE companies SET whatsapp_phone_number_id=$1,whatsapp_access_token=$2,whatsapp_verify_token=$3 WHERE id=$4',[String(b.phoneNumberId).trim(),encryptSecret(String(b.accessToken).trim()),verifyToken,companyId]);
    return json(res,200,{ok:true});
  }
  if(req.method==='POST'&&u.pathname==='/api/settings/whatsapp/test') {
    const c=await query('SELECT whatsapp_phone_number_id AS "phoneNumberId",whatsapp_access_token AS "accessToken" FROM companies WHERE id=$1',[companyId]);
    const row=c.rows[0];
    const clearToken=row?decryptSecret(row.accessToken):null;
    if(!row?.phoneNumberId||!clearToken) return json(res,400,{ok:false,error:'Renseigne d\'abord l\'ID du numéro et le jeton d\'accès'});
    try {
      const resp=await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${row.phoneNumberId}?fields=display_phone_number,verified_name`,{headers:{'Authorization':'Bearer '+clearToken}});
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok) return json(res,200,{ok:false,error:data?.error?.message||('Erreur WhatsApp (HTTP '+resp.status+')')});
      return json(res,200,{ok:true,displayPhoneNumber:data.display_phone_number||null,verifiedName:data.verified_name||null});
    } catch(e) {
      return json(res,200,{ok:false,error:'Connexion à WhatsApp impossible : '+e.message});
    }
  }

  if(req.method==='GET'&&u.pathname==='/api/products') {
    const r=await query('SELECT id,name,category,price,stock,image_url AS "imageUrl",created_at AS "createdAt" FROM products WHERE company_id=$1 ORDER BY created_at DESC',[companyId]);
    return json(res,200,{products:r.rows});
  }
  if(req.method==='POST'&&u.pathname==='/api/products') {
    const b=await body(req);
    if(!b.name||b.price===undefined||Number.isNaN(Number(b.price))) return json(res,400,{error:'Nom et prix valides requis'});
    const imageUrl=validImageUrl(b.imageUrl);
    if(b.imageUrl&&!imageUrl) return json(res,400,{error:'URL d\'image invalide (doit commencer par http:// ou https://)'});
    const r=await query('INSERT INTO products(company_id,name,category,price,stock,image_url) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,category,price,stock,image_url AS "imageUrl",created_at AS "createdAt"',[companyId,String(b.name).trim(),b.category||null,Number(b.price),Math.max(0,Number(b.stock||0)),imageUrl]);
    return json(res,201,{product:r.rows[0]});
  }
  const productMatch=u.pathname.match(/^\/api\/products\/([0-9a-f-]+)$/i);
  if(productMatch && (req.method==='PUT'||req.method==='PATCH')) {
    const b=await body(req);
    if(!b.name||b.price===undefined||Number.isNaN(Number(b.price))) return json(res,400,{error:'Nom et prix valides requis'});
    const imageUrl=validImageUrl(b.imageUrl);
    if(b.imageUrl&&!imageUrl) return json(res,400,{error:'URL d\'image invalide (doit commencer par http:// ou https://)'});
    const r=await query('UPDATE products SET name=$1,category=$2,price=$3,stock=$4,image_url=$5 WHERE id=$6 AND company_id=$7 RETURNING id,name,category,price,stock,image_url AS "imageUrl",created_at AS "createdAt"',[String(b.name).trim(),b.category||null,Number(b.price),Math.max(0,Number(b.stock||0)),imageUrl,productMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Produit introuvable'});
    return json(res,200,{product:r.rows[0]});
  }
  if(productMatch && req.method==='DELETE') {
    const r=await query('DELETE FROM products WHERE id=$1 AND company_id=$2 RETURNING id',[productMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Produit introuvable'});
    return json(res,200,{ok:true});
  }

  if(req.method==='GET'&&u.pathname==='/api/onboarding/templates') {
    const list=Object.entries(SECTOR_TEMPLATES).map(([key,t])=>({key,label:t.label,sector:t.sector,productCount:t.products.length}));
    return json(res,200,{templates:list});
  }
  // Applique un modèle de démarrage rapide (personnalité IA + produits
  // d'exemple) pour un secteur donné. N'écrase jamais un catalogue déjà
  // rempli : les produits d'exemple ne sont ajoutés que si le catalogue de
  // l'entreprise est actuellement vide, pour ne jamais effacer de vraies
  // données. La personnalité IA, elle, est toujours appliquée (l'utilisateur
  // peut ensuite l'ajuster depuis l'onglet Assistant IA).
  if(req.method==='POST'&&u.pathname==='/api/onboarding/apply-template') {
    const b=await body(req);
    const tpl=SECTOR_TEMPLATES[b.sector];
    if(!tpl) return json(res,400,{error:'Secteur inconnu. Choisissez : '+Object.keys(SECTOR_TEMPLATES).join(', ')});
    await query('UPDATE companies SET sector=$1,ai_name=$2,ai_tone=$3,ai_language=$4,ai_rules=$5 WHERE id=$6',[tpl.sector,tpl.aiName,tpl.aiTone,tpl.aiLanguage,tpl.aiRules,companyId]);
    const existing=await query('SELECT COUNT(*)::int AS n FROM products WHERE company_id=$1',[companyId]);
    let productsAdded=0;
    if(existing.rows[0].n===0) {
      for(const p of tpl.products) {
        await query('INSERT INTO products(company_id,name,category,price,stock) VALUES($1,$2,$3,$4,$5)',[companyId,p.name,p.category,p.price,p.stock]);
        productsAdded++;
      }
    }
    return json(res,200,{ok:true,productsAdded,skippedProducts:existing.rows[0].n>0});
  }

  if(req.method==='GET'&&u.pathname==='/api/users') {
    const r=await query('SELECT id,name,email,role,created_at AS "createdAt" FROM users WHERE company_id=$1 ORDER BY created_at',[companyId]);
    return json(res,200,{users:r.rows});
  }
  // Gestion d'équipe : seul le rôle 'owner' (l'administrateur — le premier
  // utilisateur de l'entreprise, ou celui à qui ce rôle a été transféré)
  // peut ajouter, modifier ou retirer des membres. Le rôle 'owner' lui-même
  // ne se distribue jamais via ces routes : seul /transfer-admin le fait,
  // pour garantir le nombre maximal d'administrateurs simultanés par forfait
  // (PLAN_LIMITS.maxAdmins).
  if(req.method==='POST'&&u.pathname==='/api/users') {
    const callerRole=await getUserRole(session.userId);
    if(callerRole!=='owner') return json(res,403,{error:"Seul l'administrateur de l'équipe peut ajouter des membres"});
    const b=await body(req);
    if(!b.name||!b.email||!b.password) return json(res,400,{error:'Nom, email et mot de passe requis'});
    if(String(b.password).length<6) return json(res,400,{error:'Le mot de passe doit contenir au moins 6 caractères'});
    const s=await query('SELECT plan FROM subscriptions WHERE company_id=$1',[companyId]);
    const limits=planLimits(s.rows[0]?.plan);
    if(limits.maxUsers!=null) {
      const count=await query('SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1',[companyId]);
      if(count.rows[0].n>=limits.maxUsers) return json(res,403,{error:"Limite de "+limits.maxUsers+" utilisateur(s) atteinte pour le forfait "+(s.rows[0]?.plan||'actuel')+". Passez à un forfait supérieur pour ajouter des membres."});
    }
    const email=String(b.email).trim().toLowerCase();
    const existing=await query('SELECT id FROM users WHERE email=$1',[email]);
    if(existing.rows[0]) return json(res,409,{error:'Cet email est déjà utilisé'});
    const role=['admin','sales','viewer'].includes(b.role) ? b.role : 'sales'; // 'owner' s'attribue uniquement via /transfer-admin
    const h=hashPassword(String(b.password));
    const r=await query('INSERT INTO users(company_id,email,name,role,password_hash,password_salt) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,created_at AS "createdAt"',[companyId,email,String(b.name).trim(),role,h.hash,h.salt]);
    return json(res,201,{user:r.rows[0]});
  }
  const userMatch=u.pathname.match(/^\/api\/users\/([0-9a-f-]+)$/i);
  if(userMatch && (req.method==='PUT'||req.method==='PATCH')) {
    const isSelf=userMatch[1]===session.userId;
    if(!isSelf) {
      const callerRole=await getUserRole(session.userId);
      if(callerRole!=='owner') return json(res,403,{error:"Seul l'administrateur de l'équipe peut modifier un autre membre"});
    }
    const b=await body(req);
    const role=['admin','sales','viewer'].includes(b.role) ? b.role : null; // le rôle 'owner' se change uniquement via /transfer-admin
    if(!role && !b.name) return json(res,400,{error:'Rien à mettre à jour'});
    const r=await query('UPDATE users SET name=COALESCE(NULLIF($1,\'\'),name),role=COALESCE($2,role) WHERE id=$3 AND company_id=$4 AND role<>\'owner\' RETURNING id,name,email,role,created_at AS "createdAt"',[b.name||null,role,userMatch[1],companyId]);
    if(!r.rows[0]) {
      // Si la ligne existe mais est administrateur, on l'autorise quand même à renommer son propre profil.
      if(isSelf) {
        const r2=await query('UPDATE users SET name=COALESCE(NULLIF($1,\'\'),name) WHERE id=$2 AND company_id=$3 RETURNING id,name,email,role,created_at AS "createdAt"',[b.name||null,userMatch[1],companyId]);
        if(r2.rows[0]) return json(res,200,{user:r2.rows[0]});
      }
      return json(res,404,{error:'Utilisateur introuvable'});
    }
    return json(res,200,{user:r.rows[0]});
  }
  if(userMatch && req.method==='DELETE') {
    const callerRole=await getUserRole(session.userId);
    if(callerRole!=='owner') return json(res,403,{error:"Seul l'administrateur de l'équipe peut retirer un membre"});
    if(userMatch[1]===session.userId) return json(res,400,{error:'Vous ne pouvez pas vous supprimer vous-même — transférez d\'abord vos droits d\'administration si besoin'});
    const count=await query('SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1',[companyId]);
    if(count.rows[0].n<=1) return json(res,400,{error:"Impossible de supprimer le dernier utilisateur de l'entreprise"});
    const r=await query('DELETE FROM users WHERE id=$1 AND company_id=$2 RETURNING id',[userMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Utilisateur introuvable'});
    await query('DELETE FROM sessions WHERE user_id=$1',[userMatch[1]]).catch(()=>{}); // révoque ses sessions actives
    return json(res,200,{ok:true});
  }

  // Transfert du rôle d'administrateur (owner) vers un autre membre. Si le
  // forfait limite le nombre d'administrateurs simultanés (Business: 1) et
  // que la limite serait dépassée, l'administrateur actuel est rétrogradé
  // en 'admin' dans la foulée — un vrai transfert plutôt qu'un ajout. Sur
  // Pro (jusqu'à 3), tant qu'il reste de la place, les deux gardent le rôle.
  const transferMatch=u.pathname.match(/^\/api\/users\/([0-9a-f-]+)\/transfer-admin$/i);
  if(transferMatch && req.method==='POST') {
    const callerRole=await getUserRole(session.userId);
    if(callerRole!=='owner') return json(res,403,{error:"Seul l'administrateur de l'équipe peut transférer ses droits"});
    if(transferMatch[1]===session.userId) return json(res,400,{error:'Vous êtes déjà administrateur'});
    const target=await query('SELECT id,role FROM users WHERE id=$1 AND company_id=$2',[transferMatch[1],companyId]);
    if(!target.rows[0]) return json(res,404,{error:'Utilisateur introuvable'});
    if(target.rows[0].role==='owner') return json(res,400,{error:'Ce membre est déjà administrateur'});
    const s=await query('SELECT plan FROM subscriptions WHERE company_id=$1',[companyId]);
    const maxAdmins=planLimits(s.rows[0]?.plan).maxAdmins;
    const ownerCount=await query("SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1 AND role='owner'",[companyId]);
    await query('UPDATE users SET role=\'owner\' WHERE id=$1',[transferMatch[1]]);
    let selfDemoted=false;
    if(maxAdmins!=null && (ownerCount.rows[0].n+1)>maxAdmins) {
      await query('UPDATE users SET role=\'admin\' WHERE id=$1',[session.userId]);
      selfDemoted=true;
    }
    return json(res,200,{ok:true,selfDemoted});
  }

  // Réinitialisation de mot de passe assistée par l'administrateur : ne
  // nécessite aucune configuration email — un mot de passe temporaire est
  // renvoyé une seule fois dans la réponse, à relayer manuellement au
  // membre concerné (WhatsApp, téléphone, en personne...).
  const resetPwMatch=u.pathname.match(/^\/api\/users\/([0-9a-f-]+)\/reset-password$/i);
  if(resetPwMatch && req.method==='POST') {
    const callerRole=await getUserRole(session.userId);
    if(callerRole!=='owner') return json(res,403,{error:"Seul l'administrateur de l'équipe peut réinitialiser le mot de passe d'un membre"});
    const target=await query('SELECT id FROM users WHERE id=$1 AND company_id=$2',[resetPwMatch[1],companyId]);
    if(!target.rows[0]) return json(res,404,{error:'Utilisateur introuvable'});
    const pwd=genTempPassword();
    const h=hashPassword(pwd);
    await query('UPDATE users SET password_hash=$1,password_salt=$2 WHERE id=$3',[h.hash,h.salt,resetPwMatch[1]]);
    await query('DELETE FROM sessions WHERE user_id=$1',[resetPwMatch[1]]).catch(()=>{});
    return json(res,200,{ok:true,tempPassword:pwd});
  }

  if(req.method==='GET'&&u.pathname==='/api/prospects') {
    const r=await query('SELECT id,name,phone,need,value,score,status,stage,order_intent AS "orderIntent",last_contact AS "lastContact",next_action AS "nextAction",next_action_priority AS "nextActionPriority",next_action_reason AS "nextActionReason",next_action_at AS "nextActionAt",created_at AS "createdAt" FROM prospects WHERE company_id=$1 ORDER BY score DESC,created_at DESC LIMIT 500',[companyId]);
    return json(res,200,{prospects:r.rows});
  }
  if(req.method==='POST'&&u.pathname==='/api/prospects') {
    const b=await body(req);
    if(!b.name&& !b.phone) return json(res,400,{error:'Nom ou téléphone requis'});
    const quota=await prospectQuotaStatus(companyId);
    if(!quota.allowed) return json(res,403,{error:'Limite de '+quota.limit+' prospects par mois atteinte pour votre forfait. Passez à un forfait supérieur pour continuer.'});
    const score=Math.max(0,Math.min(100,Number(b.score||0)));
    const stage=['Nouveau','À contacter','En discussion','Gagné','Perdu'].includes(b.stage) ? b.stage : 'Nouveau';
    const r=await query('INSERT INTO prospects(company_id,name,phone,need,value,score,status,stage,order_intent,last_contact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) RETURNING id,name,phone,need,value,score,status,stage,order_intent AS "orderIntent",last_contact AS "lastContact"',[companyId,b.name||null,b.phone||null,b.need||null,Number(b.value||0),score,heatFromScore(score),stage,Boolean(b.orderIntent)]);
    return json(res,201,{prospect:r.rows[0]});
  }
  const prospectMatch=u.pathname.match(/^\/api\/prospects\/([0-9a-f-]+)$/i);
  if(prospectMatch && (req.method==='PUT'||req.method==='PATCH')) {
    const b=await body(req);
    if(!b.name&&!b.phone) return json(res,400,{error:'Nom ou téléphone requis'});
    const score=Math.max(0,Math.min(100,Number(b.score||0)));
    const stage=['Nouveau','À contacter','En discussion','Gagné','Perdu'].includes(b.stage) ? b.stage : 'Nouveau';
    const r=await query('UPDATE prospects SET name=$1,phone=$2,need=$3,value=$4,score=$5,status=$6,stage=$7,order_intent=$8,last_contact=now() WHERE id=$9 AND company_id=$10 RETURNING id,name,phone,need,value,score,status,stage,order_intent AS "orderIntent",last_contact AS "lastContact"',[b.name||null,b.phone||null,b.need||null,Number(b.value||0),score,heatFromScore(score),stage,Boolean(b.orderIntent),prospectMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Prospect introuvable'});
    if(r.rows[0].stage==='Gagné'||r.rows[0].stage==='Perdu') await cancelAutoFollowups(companyId,prospectMatch[1],'Prospect '+r.rows[0].stage.toLowerCase()+' — relance automatique inutile');
    return json(res,200,{prospect:r.rows[0]});
  }
  if(prospectMatch && req.method==='DELETE') {
    const r=await query('DELETE FROM prospects WHERE id=$1 AND company_id=$2 RETURNING id',[prospectMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Prospect introuvable'});
    return json(res,200,{ok:true});
  }

  if(req.method==='POST'&&u.pathname==='/api/ai/reply') {
    const b=await body(req);
    const [d,c,pr,sub]=await Promise.all([
      query('SELECT name,category,price,stock FROM products WHERE company_id=$1 ORDER BY created_at',[companyId]),
      query('SELECT name,sector,ai_name AS "aiName",ai_tone AS "aiTone",ai_language AS "aiLanguage",ai_rules AS "aiRules",payment_orange_money AS "paymentOrangeMoney",payment_mtn_momo AS "paymentMtnMomo" FROM companies WHERE id=$1',[companyId]),
      b.prospectId ? query('SELECT status,need FROM prospects WHERE id=$1 AND company_id=$2',[b.prospectId,companyId]) : Promise.resolve({rows:[]}),
      query('SELECT plan FROM subscriptions WHERE company_id=$1',[companyId])
    ]);
    // Teste le VRAI moteur IA (Claude) utilisé sur WhatsApp quand la clé est
    // configurée, avec le catalogue et la personnalité réels de l'entreprise
    // — plutôt que la réponse de secours à mots-clés (fallback-demo), pour
    // que ce panneau serve de vérification fiable après un changement de clé.
    // Soumis au même quota mensuel que les réponses WhatsApp réelles (sinon
    // ce testeur permettait un nombre illimité d'appels Anthropic gratuits).
    const usage=await getAiUsage(companyId,sub.rows[0]?.plan);
    if(usage.remaining!==null && usage.remaining<=0) {
      return json(res,200,{reply:ai(b.text,d.rows),provider:'fallback-demo',quotaExceeded:true});
    }
    const real = await generateAiReply(c.rows[0]||{}, pr.rows[0]||null, d.rows, [{direction:'in',body:b.text}]);
    if(real) { await incrementAiUsage(companyId); return json(res,200,{reply:real,provider:'anthropic'}); }
    return json(res,200,{reply:ai(b.text,d.rows),provider:'fallback-demo',aiUnavailable:!process.env.ANTHROPIC_API_KEY});
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

  if(req.method==='POST'&&u.pathname==='/api/ai/next-action') {
    const b=await body(req);
    if(!b.text) return json(res,400,{error:'Message requis'});
    const d=await query('SELECT name,price,stock FROM products WHERE company_id=$1 ORDER BY created_at',[companyId]);
    let prospect={score:0,phone:b.phone||null,value:Number(b.value||0)};
    if(b.prospectId){
      const p=await query('SELECT id,name,phone,need,value,score,status,order_intent AS "orderIntent" FROM prospects WHERE id=$1 AND company_id=$2',[b.prospectId,companyId]);
      if(!p.rows[0]) return json(res,404,{error:'Prospect introuvable'});
      prospect=p.rows[0];
    }
    const qualification=classifyLead(b.text,d.rows,prospect);
    const nextAction=determineNextAction(b.text,qualification);
    if(b.prospectId){
      await query(
        'UPDATE prospects SET score=$1,status=$2,order_intent=$3,last_contact=now(),need=COALESCE(NULLIF($4,\'\'),need),next_action=$5,next_action_priority=$6,next_action_reason=$7,next_action_at=now() WHERE id=$8 AND company_id=$9',
        [qualification.score,qualification.status,qualification.orderIntent,b.text,nextAction.action,nextAction.priority,nextAction.reason,b.prospectId,companyId]
      );
      await syncAutoFollowup(companyId,b.prospectId,nextAction);
    }
    return json(res,200,{
      qualification:{score:qualification.score,status:qualification.status,orderIntent:qualification.orderIntent},
      nextAction,
      provider:'rules-engine-v1'
    });
  }

  if(req.method==='POST'&&u.pathname==='/api/followups') {
    const b=await body(req); const r=await query('INSERT INTO followups(company_id,prospect_id,text,due_at,status) VALUES($1,$2,$3,$4,$5) RETURNING *',[companyId,b.prospectId||null,b.text||null,b.dueAt||null,'Programmée']);
    return json(res,201,{followup:r.rows[0]});
  }
  if(req.method==='GET'&&u.pathname==='/api/conversations') {
    // Les 50 derniers messages par conversation seulement (sous-requête
    // latérale), pas tout l'historique — sans ce plafond, cette requête
    // grossit sans limite avec le temps et ralentit chaque chargement du
    // dashboard pour toutes les entreprises (voir audit). Les 500
    // conversations les plus récentes par entreprise, dans le même esprit.
    const r=await query(`SELECT c.id,c.channel,c.external_contact AS phone,c.prospect_id AS "prospectId",p.name AS prospect, c.created_at AS "createdAt",
      COALESCE((SELECT json_agg(x ORDER BY x."createdAt") FROM (
        SELECT m.id,m.direction,m.body,m.created_at AS "createdAt",m.provider_error AS "providerError"
        FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 50
      ) x),'[]') AS messages
      FROM conversations c LEFT JOIN prospects p ON p.id=c.prospect_id
      WHERE c.company_id=$1 ORDER BY c.created_at DESC LIMIT 500`,[companyId]);
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
    const own=await query('SELECT id,prospect_id AS "prospectId",external_contact AS phone,channel FROM conversations WHERE id=$1 AND company_id=$2',[convMatch[1],companyId]);
    if(!own.rows[0]) return json(res,404,{error:'Conversation introuvable'});
    const result=await ingestMessage(companyId,convMatch[1],own.rows[0],b);
    return json(res,201,result);
  }
  if(req.method==='POST'&&u.pathname==='/api/orders') {
    const b=await body(req);
    if(!b.prospectId) return json(res,400,{error:'Prospect requis'});
    const amount=Number(b.amount||0);
    if(Number.isNaN(amount)||amount<0) return json(res,400,{error:'Montant invalide'});
    const number='VND-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
    const r=await query('INSERT INTO orders(company_id,prospect_id,order_number,amount,status) VALUES($1,$2,$3,$4,$5) RETURNING id,order_number AS number,prospect_id AS "prospectId",amount,status,created_at AS "createdAt"',[companyId,b.prospectId,number,amount,b.status||'En attente']);
    await query('UPDATE prospects SET order_intent=true,stage=CASE WHEN stage IS NULL OR stage IN (\'Nouveau\',\'À contacter\') THEN \'En discussion\' ELSE stage END WHERE id=$1 AND company_id=$2',[b.prospectId,companyId]);
    await cancelAutoFollowups(companyId,b.prospectId,'Commande créée — relance automatique inutile');
    return json(res,201,{order:r.rows[0]});
  }
  if(req.method==='GET'&&u.pathname==='/api/orders') {
    const r=await query('SELECT o.id,o.order_number AS number,o.prospect_id AS "prospectId",p.name AS client,o.amount,o.status,o.created_at AS "createdAt" FROM orders o LEFT JOIN prospects p ON p.id=o.prospect_id WHERE o.company_id=$1 ORDER BY o.created_at DESC LIMIT 500',[companyId]);
    return json(res,200,{orders:r.rows});
  }

  // Export comptable simple (Palier 3 de la feuille de route) : un gérant qui
  // tient sa propre comptabilité peut télécharger ses commandes en Excel sans
  // ressaisie manuelle. Deux feuilles : détail des commandes, et un résumé par
  // statut (dont le total "encaissé" = commandes Livrée) pour un rapprochement
  // rapide. Pas de dépendance externe — généré à la volée avec exceljs.
  if(req.method==='GET'&&u.pathname==='/api/export/orders.xlsx') {
    const rows=(await query('SELECT o.order_number AS number,p.name AS client,p.phone,o.amount,o.status,o.created_at AS "createdAt" FROM orders o LEFT JOIN prospects p ON p.id=o.prospect_id WHERE o.company_id=$1 ORDER BY o.created_at DESC LIMIT 5000',[companyId])).rows;
    const wb=new ExcelJS.Workbook();
    wb.creator='VENDIA'; wb.created=new Date();

    const sheet=wb.addWorksheet('Commandes');
    sheet.columns=[
      {header:'Numéro',key:'number',width:24},
      {header:'Client',key:'client',width:26},
      {header:'Téléphone',key:'phone',width:16},
      {header:'Montant (FCFA)',key:'amount',width:16},
      {header:'Statut',key:'status',width:16},
      {header:'Date',key:'createdAt',width:20},
    ];
    sheet.getRow(1).font={bold:true};
    for(const r of rows) sheet.addRow({number:r.number,client:r.client||'—',phone:r.phone||'—',amount:Number(r.amount),status:r.status,createdAt:new Date(r.createdAt)});
    sheet.getColumn('amount').numFmt='#,##0';
    sheet.getColumn('createdAt').numFmt='dd/mm/yyyy hh:mm';

    const byStatus={}; let total=0, encaisse=0;
    for(const r of rows) { const amt=Number(r.amount)||0; byStatus[r.status]=(byStatus[r.status]||0)+amt; total+=amt; if(r.status==='Livrée') encaisse+=amt; }
    const summary=wb.addWorksheet('Résumé');
    summary.columns=[{header:'Statut',key:'status',width:22},{header:'Montant total (FCFA)',key:'amount',width:22}];
    summary.getRow(1).font={bold:true};
    Object.entries(byStatus).forEach(([status,amount])=>summary.addRow({status,amount}));
    summary.addRow({});
    const rowTotal=summary.addRow({status:'Total commandes',amount:total}); rowTotal.font={bold:true};
    const rowEncaisse=summary.addRow({status:'Dont encaissé (livré)',amount:encaisse}); rowEncaisse.font={bold:true};
    summary.getColumn('amount').numFmt='#,##0';

    const buffer=await wb.xlsx.writeBuffer();
    res.writeHead(200,{
      'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':'attachment; filename="vendia-commandes-'+new Date().toISOString().slice(0,10)+'.xlsx"',
      'Cache-Control':'no-store',
    });
    return res.end(Buffer.from(buffer));
  }
  const orderMatch=u.pathname.match(/^\/api\/orders\/([0-9a-f-]+)$/i);
  if(orderMatch && (req.method==='PUT'||req.method==='PATCH')) {
    const b=await body(req);
    const r=await query('UPDATE orders SET amount=$1,status=$2 WHERE id=$3 AND company_id=$4 RETURNING id,order_number AS number,prospect_id AS "prospectId",amount,status,created_at AS "createdAt"',[Math.max(0,Number(b.amount||0)),b.status||'En attente',orderMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Commande introuvable'});
    return json(res,200,{order:r.rows[0]});
  }
  if(req.method==='GET'&&u.pathname==='/api/followups') {
    const r=await query('SELECT f.id,f.prospect_id AS "prospectId",p.name AS prospect,f.text,f.due_at AS "dueAt",f.status,f.source,f.cancelled_reason AS "cancelledReason",f.sent_at AS "sentAt",f.created_at AS "createdAt" FROM followups f LEFT JOIN prospects p ON p.id=f.prospect_id WHERE f.company_id=$1 ORDER BY f.due_at NULLS LAST LIMIT 500',[companyId]);
    return json(res,200,{followups:r.rows});
  }
  if(req.method==='PUT'&&u.pathname.startsWith('/api/followups/')) {
    const id=u.pathname.split('/').pop(); const b=await body(req);
    const r=await query('UPDATE followups SET text=$1,due_at=$2,status=$3 WHERE id=$4 AND company_id=$5 RETURNING id,prospect_id AS "prospectId",text,due_at AS "dueAt",status,sent_at AS "sentAt"',[b.text||null,b.dueAt||null,b.status||'Programmée',id,companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Relance introuvable'});
    return json(res,200,{followup:r.rows[0]});
  }
  if(req.method==='DELETE'&&u.pathname.startsWith('/api/followups/')) {
    const id=u.pathname.split('/').pop();
    const r=await query('DELETE FROM followups WHERE id=$1 AND company_id=$2 RETURNING id',[id,companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Relance introuvable'});
    return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&u.pathname==='/api/health/db') { await query('SELECT 1'); return json(res,200,{ok:true,database:'postgresql'}); }
  return json(res,404,{error:'Route introuvable'});
}

// --- Rapport quotidien (20h, heure du Cameroun) ---------------------------
// Envoyé par email (voir sendEmail/RESEND_API_KEY) à chaque administrateur
// (rôle 'owner') de chaque entreprise active, et un récapitulatif de
// l'ensemble des entreprises au super-admin. Le Cameroun n'a pas d'heure
// d'été (UTC+1 toute l'année), donc un simple décalage fixe suffit — pas
// besoin de la base de fuseaux horaires du système pour ça.
const money = n => Number(n||0).toLocaleString('fr-FR')+' FCFA';
function cameroonNow() { return new Date(Date.now() + 60*60*1000); }

async function buildCompanyReport(companyId) {
  const [company,closedOrders,pendingDeliveries,dueFollowups,hesitant,newProspects,sub] = await Promise.all([
    query('SELECT name FROM companies WHERE id=$1',[companyId]),
    query(`SELECT id,order_number AS number,amount FROM orders WHERE company_id=$1 AND (created_at AT TIME ZONE 'Africa/Douala')::date = (now() AT TIME ZONE 'Africa/Douala')::date`,[companyId]),
    query(`SELECT o.id,o.order_number AS number,p.name AS client,o.status FROM orders o LEFT JOIN prospects p ON p.id=o.prospect_id WHERE o.company_id=$1 AND o.status IN ('En attente','Confirmée','En préparation') ORDER BY o.created_at`,[companyId]),
    query(`SELECT f.id,f.text,p.name AS prospect FROM followups f LEFT JOIN prospects p ON p.id=f.prospect_id WHERE f.company_id=$1 AND f.status='Programmée' AND f.due_at IS NOT NULL AND (f.due_at AT TIME ZONE 'Africa/Douala')::date = (now() AT TIME ZONE 'Africa/Douala')::date ORDER BY f.due_at`,[companyId]),
    query(`SELECT id,name,phone,score FROM prospects WHERE company_id=$1 AND stage NOT IN ('Gagné','Perdu') AND score BETWEEN 40 AND 69 ORDER BY score DESC`,[companyId]),
    query(`SELECT COUNT(*)::int AS n FROM prospects WHERE company_id=$1 AND (created_at AT TIME ZONE 'Africa/Douala')::date = (now() AT TIME ZONE 'Africa/Douala')::date`,[companyId]),
    query('SELECT plan FROM subscriptions WHERE company_id=$1',[companyId])
  ]);
  const revenueToday = closedOrders.rows.reduce((s,o)=>s+Number(o.amount||0),0);
  const aiUsage = await getAiUsage(companyId, sub.rows[0]?.plan);
  return { companyName: company.rows[0]?.name || 'Entreprise', closedOrders: closedOrders.rows, revenueToday, pendingDeliveries: pendingDeliveries.rows, dueFollowups: dueFollowups.rows, hesitant: hesitant.rows, newProspectsCount: newProspects.rows[0].n, aiUsage };
}

function reportToHtml(r) {
  return ''+
    '<p><strong>🏆 Prospects closés aujourd\'hui :</strong> '+r.closedOrders.length+' commande(s) — '+money(r.revenueToday)+'</p>'+
    (r.closedOrders.length ? '<ul>'+r.closedOrders.map(o=>'<li>'+escHtml(o.number)+' — '+money(o.amount)+'</li>').join('')+'</ul>' : '')+
    '<p><strong>🚚 Livraisons prévues / en attente :</strong> '+r.pendingDeliveries.length+'</p>'+
    (r.pendingDeliveries.length ? '<ul>'+r.pendingDeliveries.map(o=>'<li>'+escHtml(o.number)+' — '+escHtml(o.client||'Client')+' — '+escHtml(o.status)+'</li>').join('')+'</ul>' : '')+
    '<p><strong>🔁 Relances prévues aujourd\'hui :</strong> '+r.dueFollowups.length+'</p>'+
    (r.dueFollowups.length ? '<ul>'+r.dueFollowups.map(f=>'<li>'+escHtml(f.prospect||'Prospect')+' — '+escHtml(f.text||'')+'</li>').join('')+'</ul>' : '')+
    '<p><strong>🤔 Prospects hésitants :</strong> '+r.hesitant.length+'</p>'+
    (r.hesitant.length ? '<ul>'+r.hesitant.map(p=>'<li>'+escHtml(p.name||p.phone||'Prospect')+' (score '+p.score+'/100)</li>').join('')+'</ul>' : '')+
    '<p><strong>🆕 Nouveaux prospects aujourd\'hui :</strong> '+r.newProspectsCount+'</p>'+
    '<p><strong>🤖 Réponses IA utilisées ce mois :</strong> '+(r.aiUsage.limit==null ? 'illimité' : (r.aiUsage.used+' / '+r.aiUsage.limit))+'</p>';
}

async function sendDailyReports() {
  const companies=(await query('SELECT id,name FROM companies WHERE approved_at IS NOT NULL AND suspended=false')).rows;
  let combined='', totals={orders:0,revenue:0,newProspects:0};
  for (const c of companies) {
    const report=await buildCompanyReport(c.id);
    const html=reportToHtml(report);
    totals.orders+=report.closedOrders.length; totals.revenue+=report.revenueToday; totals.newProspects+=report.newProspectsCount;
    const owners=(await query("SELECT email,name FROM users WHERE company_id=$1 AND role='owner'",[c.id])).rows;
    for (const o of owners) {
      await sendEmail(o.email, 'VENDIA — Votre rapport du jour', '<p>Bonjour '+escHtml(o.name)+',</p><p>Voici le rapport de <strong>'+escHtml(report.companyName)+'</strong> pour aujourd\'hui :</p>'+html);
    }
    combined += '<h3>'+escHtml(report.companyName)+'</h3>'+html+'<hr>';
  }
  const summary='<p><strong>Entreprises actives :</strong> '+companies.length+' · <strong>Commandes closes :</strong> '+totals.orders+' · <strong>CA du jour :</strong> '+money(totals.revenue)+' · <strong>Nouveaux prospects :</strong> '+totals.newProspects+'</p><hr>';
  await sendEmail(process.env.SUPERADMIN_EMAIL||'', 'VENDIA — Rapport quotidien de toutes les entreprises', summary+combined);
}

async function checkDailyReportSchedule() {
  const now=cameroonNow();
  if (now.getUTCHours()!==20) return; // fenêtre : toute la 20e heure (20h00–20h59 Cameroun)
  const today=now.toISOString().slice(0,10);
  try {
    const r=await query('SELECT state FROM app_state WHERE id=1');
    const state=r.rows[0]?.state || {};
    if (state.lastDailyReportDate===today) return; // déjà envoyé aujourd'hui — protège contre les redémarrages
    await sendDailyReports();
    const newState=JSON.stringify({...state,lastDailyReportDate:today});
    await query('INSERT INTO app_state(id,state) VALUES(1,$1) ON CONFLICT (id) DO UPDATE SET state=$1,updated_at=now()',[newState]);
    console.log('[daily-report] rapports envoyes pour',today);
  } catch(e) { console.error('[daily-report] echec:',e.message); }
}

// --- Relance automatique des prospects hésitants (envoi réel) --------------
// Le moteur de relance (syncAutoFollowup, plus haut) planifie déjà une ligne
// dans 'followups' (source='auto') — jusqu'ici, elle restait affichée dans
// l'onglet Relances pour un envoi manuel. Ici : dès que l'échéance est
// passée, un message de relance généré par l'IA est réellement envoyé sur
// WhatsApp, sans action humaine — fonctionnalité "relance de prospects
// hésitants" repérée chez les concurrents (paniers abandonnés Zoko/Interakt),
// adaptée au contexte commercial (pas de panier, mais un prospect qui n'a
// pas répondu). Ne redéclenche jamais une relance déjà envoyée (sent_at) et
// respecte le même interrupteur/quota IA que les réponses automatiques.
async function generateFollowupReply(company, prospect) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const systemPrompt = [
    'Tu es '+(company.aiName||"l'assistant commercial")+' de l\'entreprise "'+company.name+'"'+(company.sector?' (secteur : '+company.sector+')':'')+'.',
    'Tu écris un court message de relance WhatsApp à un client qui n\'a pas répondu depuis un moment. Ton de voix : '+(company.aiTone||'professionnel et chaleureux')+'. Écris en '+(company.aiLanguage||'français')+'.',
    prospect?.need ? 'Besoin exprimé par le client jusqu\'ici : '+prospect.need+'.' : null,
    'Règles : 1 à 2 phrases courtes, naturelles, comme un vrai message WhatsApp (pas de markdown). Relance la conversation sans pression excessive, sans répéter un message déjà envoyé mot pour mot, sans inventer de prix ou de produit. Ne révèle jamais que tu es une intelligence artificielle.',
  ].filter(Boolean).join('\n\n');
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 150, system: systemPrompt, messages:[{role:'user',content:'Rédige le message de relance maintenant.'}] })
    });
    if (!resp.ok) { console.error('[followup-send] erreur API Anthropic %s',resp.status); return null; }
    const data = await resp.json();
    const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
    return text || null;
  } catch(e) { console.error('[followup-send] echec appel API Anthropic:',e.message); return null; }
}

async function checkDueFollowups() {
  let due;
  try {
    due = (await query(
      `SELECT f.id,f.company_id AS "companyId",f.prospect_id AS "prospectId",f.text
       FROM followups f WHERE f.status='Programmée' AND f.source='auto' AND f.sent_at IS NULL
         AND f.due_at IS NOT NULL AND f.due_at<=now() LIMIT 25`
    )).rows;
  } catch(e) { console.error('[followup-send] echec lecture des relances dues:',e.message); return; }

  for (const f of due) {
    try {
      const c=await query('SELECT c.id,c.name,c.sector,c.ai_name AS "aiName",c.ai_tone AS "aiTone",c.ai_language AS "aiLanguage",c.ai_auto_reply_enabled AS "aiAutoReplyEnabled",c.suspended,c.approved_at AS "approvedAt",c.whatsapp_phone_number_id AS "whatsappPhoneNumberId",c.whatsapp_access_token AS "whatsappAccessToken",s.plan AS "plan" FROM companies c LEFT JOIN subscriptions s ON s.company_id=c.id WHERE c.id=$1',[f.companyId]);
      const company=c.rows[0];
      const cancel = async reason => query("UPDATE followups SET status='Annulée',cancelled_reason=$1 WHERE id=$2",[reason,f.id]);
      if (!company || company.suspended || !company.approvedAt) { await cancel('Entreprise suspendue ou non validée'); continue; }
      const limits=planLimits(company.plan);
      if (!limits.autoFollowups || company.aiAutoReplyEnabled===false || !limits.aiAutoReply) { await cancel('Relances automatiques désactivées ou non incluses dans le forfait'); continue; }
      if (!company.whatsappPhoneNumberId || !company.whatsappAccessToken) { await cancel('WhatsApp non configuré'); continue; }

      const p=(await query('SELECT id,name,phone,need,status,stage FROM prospects WHERE id=$1',[f.prospectId])).rows[0];
      if (!p || ['Gagné','Perdu'].includes(p.stage)) { await cancel('Prospect déjà conclu'); continue; }

      const conv=(await query("SELECT id,external_contact AS phone,channel FROM conversations WHERE company_id=$1 AND prospect_id=$2 AND channel='whatsapp' ORDER BY created_at DESC LIMIT 1",[f.companyId,f.prospectId])).rows[0];
      if (!conv || !conv.phone) { await cancel('Aucune conversation WhatsApp associée'); continue; }

      const usage=await getAiUsage(f.companyId,company.plan);
      if (usage.remaining!==null && usage.remaining<=0) { await cancel('Quota IA mensuel épuisé'); continue; }

      const relance=await generateFollowupReply(company,p);
      if (!relance) { await cancel('Génération IA indisponible'); continue; }

      await ingestMessage(f.companyId,conv.id,conv,{body:relance,direction:'out'});
      await incrementAiUsage(f.companyId);
      await query("UPDATE followups SET status='Envoyée',sent_at=now() WHERE id=$1",[f.id]);
      console.log('[followup-send] relance envoyee companyId=%s prospectId=%s',f.companyId,f.prospectId);
    } catch(e) {
      console.error('[followup-send] echec pour followupId=%s: %s',f.id,e.message);
    }
  }
}

// Migrations additives et idempotentes exécutées au démarrage : évite de
// dépendre d'une étape manuelle (CLI/console Railway) après chaque déploiement
// qui ajoute des colonnes/tables. Sans effet sur les données existantes.
async function ensureMigrations() {
  const statements = [
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_auto_reply_enabled BOOLEAN NOT NULL DEFAULT true',
    `CREATE TABLE IF NOT EXISTS sessions (
       token TEXT PRIMARY KEY,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
       expires_at TIMESTAMPTZ NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    'CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at)',
    'ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ai_messages_used INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ai_usage_reset_at TIMESTAMPTZ NOT NULL DEFAULT now()',
    // Lot "administration d'équipe, réinitialisation de mot de passe et
    // super-admin" — idempotent. Le super_admin_id est ajouté à 'sessions'
    // (avec user_id/company_id rendus nullables) plutôt que d'utiliser une
    // table de sessions séparée, pour réutiliser exactement la même logique
    // de purge/expiration/révocation.
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false',
    `CREATE TABLE IF NOT EXISTS super_admins (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       email TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL,
       password_hash TEXT NOT NULL,
       password_salt TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    'ALTER TABLE sessions ALTER COLUMN user_id DROP NOT NULL',
    'ALTER TABLE sessions ALTER COLUMN company_id DROP NOT NULL',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS super_admin_id UUID REFERENCES super_admins(id) ON DELETE CASCADE',
    `CREATE TABLE IF NOT EXISTS password_resets (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       token_hash TEXT NOT NULL,
       expires_at TIMESTAMPTZ NOT NULL,
       used_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    'CREATE INDEX IF NOT EXISTS password_resets_token_idx ON password_resets(token_hash)',
    // Lot "tunnel de paiement mobile money + rapports quotidiens" —
    // idempotent. approved_at NULL = compte en attente de validation du
    // paiement par le super-admin (bloque connexion/API/webhook, voir plus
    // haut). Le backfill n'approuve que les entreprises SANS demande de
    // paiement (créées avant ce lot, ou directement par le super-admin) —
    // jamais les nouvelles inscriptions en attente, qui ont toujours une
    // ligne dans payment_requests.
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
    `UPDATE companies SET approved_at = COALESCE(approved_at, created_at)
       WHERE approved_at IS NULL AND id NOT IN (SELECT company_id FROM payment_requests)`,
    // Lot "meilleures pratiques des concurrents africains" — idempotent :
    // paiement mobile money propre à chaque entreprise (pour ses propres
    // clients, distinct des numéros du super-admin utilisés pour le tunnel
    // d'abonnement VENDIA) + rendez-vous automatisés.
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
    // Lot "audit sécurité/fiabilité" — idempotent. Déduplication des webhooks
    // Meta (table prévue de longue date dans schema.sql mais jamais créée
    // automatiquement au démarrage) + contraintes uniques anti-doublon pour
    // conversations/prospects (voir findOrCreateWhatsAppConversation /
    // findOrCreateProspectByPhone). Si des doublons existent déjà en base
    // (tests précédents), la création de l'index concerné échoue proprement
    // (erreur journalisée, statement suivant exécuté quand même) sans casser
    // le démarrage — la protection anti-doublon ne sera simplement pas
    // active tant que ces doublons n'auront pas été nettoyés manuellement.
    `CREATE TABLE IF NOT EXISTS webhook_events (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       provider TEXT NOT NULL,
       external_event_id TEXT,
       payload JSONB NOT NULL,
       received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE(provider, external_event_id)
     )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS conversations_company_channel_contact_idx ON conversations(company_id,channel,external_contact) WHERE external_contact IS NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS prospects_company_phone_idx ON prospects(company_id,phone) WHERE phone IS NOT NULL',
    // Sépare l'étape du pipeline (stage, modifiable manuellement — vue kanban) de
    // la température IA (status, recalculée à chaque message WhatsApp entrant) :
    // avant ce correctif les deux étaient confondues, un prospect "Gagné" repassait
    // "Chaud" dès sa prochaine réponse client. Le backfill reprend les valeurs de
    // pipeline encore présentes dans status vers la nouvelle colonne stage.
    "ALTER TABLE prospects ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'Nouveau'",
    "UPDATE prospects SET stage=status WHERE status IN ('Nouveau','À contacter','En discussion','Gagné','Perdu')",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT",
  ];
  for (const stmt of statements) {
    try { await query(stmt); } catch(e) { console.error('[migrations] echec:',stmt.split('\n')[0],e.message); }
  }
  console.log('[migrations] verifiees au demarrage');
  if (!process.env.ENCRYPTION_KEY) console.warn('[securite] ENCRYPTION_KEY non configuré — les jetons d\'accès WhatsApp sont stockés en clair en base (voir README)');
  if (!process.env.META_APP_SECRET) console.warn('[securite] META_APP_SECRET non configuré — la signature des webhooks WhatsApp entrants n\'est pas vérifiée (voir README)');
}

const server=http.createServer((req,res)=>handler(req,res).catch(e=>{console.error(e);json(res,500,{error:'Erreur serveur'});}));
ensureMigrations().then(()=>ensureSuperAdmin()).then(()=>ensureDemo()).catch(e=>console.error('[demarrage] echec initialisation:',e.message)).finally(()=>{
  setInterval(()=>checkDailyReportSchedule().catch(e=>console.error('[daily-report] echec planification:',e.message)), 60*1000);
  setInterval(()=>checkDueFollowups().catch(e=>console.error('[followup-send] echec planification:',e.message)), 60*1000);
  server.listen(PORT,'0.0.0.0',()=>console.log(`VENDIA 1.10.8 listening on ${PORT}`));
});
process.on('SIGTERM',async()=>{server.close();await closeDatabase();});
