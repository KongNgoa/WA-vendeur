import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, transaction, closeDatabase } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@wavendeur.local';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const json = (res,status,data) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'}); res.end(JSON.stringify(data)); };
const body = async req => { let s=''; for await (const c of req) s += c; if (s.length > 1000000) throw new Error('Payload trop volumineux'); return s ? JSON.parse(s) : {}; };
const rawBody = async req => { let s=''; for await (const c of req) s += c; if (s.length > 1000000) throw new Error('Payload trop volumineux'); return s; };
const hashPassword = (password,salt=crypto.randomBytes(16).toString('hex')) => ({salt,hash:crypto.scryptSync(password,salt,64).toString('hex')});
const verifyPassword = (password,salt,expected) => crypto.timingSafeEqual(Buffer.from(hashPassword(password,salt).hash,'hex'),Buffer.from(expected,'hex'));
const token = () => crypto.randomBytes(32).toString('hex');

// Sessions persistées en base (table 'sessions') plutôt qu'en mémoire du
// process : sans ça, chaque redéploiement (fréquent sur Railway) déconnectait
// tout le monde instantanément et sans prévenir.
async function createSession(userId, companyId) {
  const t = token();
  await query('INSERT INTO sessions(token,user_id,company_id,expires_at) VALUES($1,$2,$3,now() + interval \'24 hours\')', [t, userId, companyId]);
  query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}); // purge opportuniste, pas besoin de cron pour ce volume
  return t;
}
async function getSession(t) {
  if (!t) return null;
  const r = await query('SELECT user_id AS "userId",company_id AS "companyId" FROM sessions WHERE token=$1 AND expires_at > now()', [t]);
  return r.rows[0] || null;
}
async function deleteSession(t) {
  if (!t) return;
  await query('DELETE FROM sessions WHERE token=$1', [t]).catch(() => {});
}

// Vérifie que le POST du webhook vient bien de Meta (HMAC-SHA256 du corps
// brut avec le secret de l'App, comparé en temps constant) plutôt que
// d'accepter n'importe quelle requête pointant vers cette URL publique.
// Si META_APP_SECRET n'est pas encore configuré, on laisse passer en journalisant
// un avertissement (pour ne pas casser le webhook existant avant la mise à jour
// de la variable d'environnement), mais ça doit être corrigé rapidement.
function verifyMetaSignature(req, raw) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) { console.warn('[webhook] META_APP_SECRET non configuré — vérification de signature désactivée (à corriger)'); return true; }
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
    query('SELECT id,name,sector,ai_name AS "aiName",ai_tone AS "aiTone",ai_auto_reply_enabled AS "aiAutoReplyEnabled" FROM companies WHERE id=$1',[companyId]),
    query('SELECT id,name,category,price,stock,created_at AS "createdAt" FROM products WHERE company_id=$1 ORDER BY created_at DESC',[companyId]),
    query('SELECT id,name,phone,need,value,score,status,order_intent AS "orderIntent",last_contact AS "lastContact",next_action AS "nextAction",next_action_priority AS "nextActionPriority",next_action_reason AS "nextActionReason",next_action_at AS "nextActionAt",created_at AS "createdAt" FROM prospects WHERE company_id=$1 ORDER BY score DESC,created_at DESC',[companyId]),
    query('SELECT o.id,o.order_number AS number,p.name AS client,o.amount,o.status,o.created_at AS "createdAt" FROM orders o LEFT JOIN prospects p ON p.id=o.prospect_id WHERE o.company_id=$1 ORDER BY o.created_at DESC',[companyId]),
    query(`SELECT c.id,c.external_contact AS phone,p.name,COALESCE(json_agg(json_build_object('id',m.id,'from',m.direction,'text',m.body) ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL),'[]') AS messages FROM conversations c LEFT JOIN prospects p ON p.id=c.prospect_id LEFT JOIN messages m ON m.conversation_id=c.id WHERE c.company_id=$1 GROUP BY c.id,p.name ORDER BY c.created_at DESC`,[companyId]),
    query('SELECT id,due_at AS "dueAt",status,text,prospect_id AS "prospectId",source,cancelled_reason AS "cancelledReason" FROM followups WHERE company_id=$1 ORDER BY due_at NULLS LAST',[companyId]),
    query('SELECT plan,status,monthly_price AS "monthlyPrice",next_billing_at AS "nextBillingAt" FROM subscriptions WHERE company_id=$1',[companyId])
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
    conversations:conversations.rows,
    followups:followups.rows,
    subscription:subscription.rows[0],
    usage:{
      aiMessages:aiUsage,
      prospectsThisMonth:prospectsThisMonth.rows[0].n,
      prospectsLimit:limits.maxProspectsPerMonth,
      autoFollowups:limits.autoFollowups,
      maxUsers:limits.maxUsers
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
  const nameMatch=q.match(/(?:je suis|moi c'est|moi c’est|nom[: ]+|je m'appelle|je m’appelle)\s+([A-Za-zÀ-ÿ' -]{2,40})/i);
  const name=nameMatch ? nameMatch[1].trim().replace(/\\s+/g,' ') : current.name||null;
  const locMatch=q.match(/(?:à|a|sur|dans|vers|quartier)\s+([A-Za-zÀ-ÿ' -]{2,35})(?=\\s+(?:svp|s'il|pour|et|,|\.|$))/i);
  const location=locMatch ? locMatch[1].trim() : null;
  return {name,phone,location};
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

// Moteur d'action commerciale (section 10 du dossier de transmission).
// Règle impérative : ce moteur ne fait qu'analyser et recommander — il ne
// déclenche jamais lui-même un envoi de message réel (WhatsApp ou autre).
// Ponctuation tolérante : sur WhatsApp, les apostrophes sont très souvent
// omises ou remplacées par une espace (« quelqu un » au lieu de « quelqu'un »).
const HANDOFF_PHRASES = /parler\s+(?:à|a)\s+(?:un|quelqu['’]?\s?un|une\s+personne)|passez[\s-]?moi|je\s+veux\s+(?:un\s+)?(?:humain|conseiller|responsable)|(?:humain|conseiller|responsable)\s+svp|besoin\s+d['’]?\s?un\s+humain|appelez[\s-]?moi\s+quelqu['’]?\s?un/i;
const HANDOFF_SENSITIVE = /r[ée]clamation|remboursement|rembours(?:er|é)|litige|plainte|arnaque|escroqu|avocat|juridique|paiement\s+(?:bloqu[ée]|refus[ée]|non\s+pass[ée])|erreur\s+de\s+paiement|m[ée]content|insatisfait|d[ée]ç[ue]/i;

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
  if(q.includes('prix')||q.includes('combien')) return products.length ? products.map(p=>`${p.name}: ${Number(p.price).toLocaleString('fr-FR')} FCFA`).join(' · ')+'. Lequel vous intéresse ?' : 'Je peux vous renseigner sur nos produits. Quel article recherchez-vous ?';
  if(q.includes('dispon')||q.includes('stock')) return 'Oui, dites-moi le produit souhaité et je vérifie le stock.';
  if(q.includes('livr')) return 'Oui. Quel est votre quartier pour organiser la livraison ?';
  if(q.includes('acheter')||q.includes('commande')) return 'Avec plaisir. Donnez-moi votre nom, téléphone, produit et localisation pour préparer la commande.';
  if(q.includes('humain')||q.includes('conseiller')) return 'Bien sûr. Je transmets votre demande à un conseiller humain.';
  return 'Bonjour 👋 Je suis Julie, votre assistante commerciale. Que puis-je faire pour vous ?';
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

// Définition des forfaits VENDIA. C'est ici (et uniquement ici) que se
// décide ce que chaque palier autorise — la table 'subscriptions' ne stocke
// que le nom du plan choisi par l'entreprise, jamais ses limites : changer
// une limite ne demande donc qu'une modification de cet objet.
// aiMessagesLimit / maxProspectsPerMonth / maxUsers = null signifie illimité.
const PLAN_LIMITS = {
  Starter:  { monthlyPrice: 10000, maxProspectsPerMonth: 100, maxUsers: 1,    aiAutoReply: true, aiMessagesLimit: 100, autoFollowups: false, prioritySupport: false },
  Business: { monthlyPrice: 25000, maxProspectsPerMonth: 300, maxUsers: 3,    aiAutoReply: true, aiMessagesLimit: null, autoFollowups: true,  prioritySupport: false },
  Pro:      { monthlyPrice: 50000, maxProspectsPerMonth: null, maxUsers: null, aiAutoReply: true, aiMessagesLimit: null, autoFollowups: true,  prioritySupport: true  },
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

  const systemPrompt = [
    'Tu es '+(company.aiName||'l\'assistant commercial')+' de l\'entreprise "'+company.name+'"'+(company.sector?' (secteur : '+company.sector+')':'')+', et tu réponds aux clients sur WhatsApp.',
    'Ton de voix : '+(company.aiTone||'professionnel et chaleureux')+'. Réponds toujours en '+(company.aiLanguage||'français')+'.',
    company.aiRules ? 'Consignes spécifiques de l\'entreprise à respecter : '+company.aiRules : null,
    'Catalogue actuel :\n'+catalogue,
    prospect ? 'Fiche du client en cours — statut commercial : '+(prospect.status||'inconnu')+', besoin exprimé jusqu\'ici : '+(prospect.need||'non précisé')+'.' : null,
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
  return sendWhatsAppMessage(company, conv.phone, text);
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
      const existing=phone ? await query('SELECT id FROM prospects WHERE company_id=$1 AND phone=$2 ORDER BY created_at DESC LIMIT 1',[companyId,phone]) : {rows:[]};
      if(existing.rows[0]) {
        prospectId=existing.rows[0].id;
      } else {
        const name=(b.name||'').trim()||null;
        const created=await query('INSERT INTO prospects(company_id,name,phone,need,value,score,status,order_intent,last_contact) VALUES($1,$2,$3,$4,0,0,$5,false,now()) RETURNING id',[companyId,name,phone,text,'Nouveau']);
        prospectId=created.rows[0].id;
      }
      await query('UPDATE conversations SET prospect_id=$1 WHERE id=$2 AND company_id=$3',[prospectId,conversationId,companyId]);
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
  if(req.method==='GET'&&u.pathname==='/api/health') return json(res,200,{ok:true,version:'1.7.0',service:'VENDIA',database:'postgresql'});
  if(req.method==='GET'&&u.pathname==='/api/version') return json(res,200,{version:'1.7.0'});
  if(req.method==='GET'&&u.pathname==='/') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await readFile(path.join(__dirname,'public/index.html'))); }
  if(req.method==='GET'&&(u.pathname==='/confidentialite'||u.pathname==='/privacy')) { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await readFile(path.join(__dirname,'public/confidentialite.html'))); }

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
          const c=await query('SELECT c.id,c.name,c.sector,c.ai_name AS "aiName",c.ai_tone AS "aiTone",c.ai_language AS "aiLanguage",c.ai_rules AS "aiRules",c.ai_auto_reply_enabled AS "aiAutoReplyEnabled",s.plan AS "plan" FROM companies c LEFT JOIN subscriptions s ON s.company_id=c.id WHERE c.whatsapp_phone_number_id=$1',[phoneNumberId]);
          const companyRow=c.rows[0];
          const targetCompanyId=companyRow?.id;
          if(!targetCompanyId) { console.error('Webhook WhatsApp: aucune entreprise pour phone_number_id',phoneNumberId); continue; }
          console.log('[webhook] routing %d message(s) to companyId=%s',messages.length,targetCompanyId);
          const contact=(value.contacts||[])[0];
          const contactName=contact?.profile?.name||null;
          for(const msg of messages) {
            const from=String(msg.from||'').replace(/^237/,''); // aligné sur le format local déjà utilisé dans l'app (ex. prospects saisis manuellement)
            if(!from) continue;
            const text=msg.type==='text'?(msg.text?.body||'') : ('[Message '+(msg.type||'non textuel')+' reçu — non traité automatiquement]');
            let conv=await query('SELECT id,prospect_id AS "prospectId",external_contact AS phone,channel FROM conversations WHERE company_id=$1 AND channel=\'whatsapp\' AND external_contact=$2 ORDER BY created_at DESC LIMIT 1',[targetCompanyId,from]);
            let conversationRow=conv.rows[0];
            if(!conversationRow) {
              const created=await query('INSERT INTO conversations(company_id,prospect_id,channel,external_contact) VALUES($1,NULL,\'whatsapp\',$2) RETURNING id,prospect_id AS "prospectId",external_contact AS phone,channel',[targetCompanyId,from]);
              conversationRow=created.rows[0];
            }
            const ingestResult=await ingestMessage(targetCompanyId,conversationRow.id,conversationRow,{body:text,direction:'in',phone:from,name:contactName,providerMessageId:msg.id||null});

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
                if(ingestResult.nextAction?.action==='handoff') {
                  replyText="Merci pour votre message 🙏 Je transmets tout de suite à un membre de notre équipe qui revient vers vous rapidement.";
                } else {
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

  await ensureDemo();

  if(req.method==='POST'&&u.pathname==='/api/login') {
    const b=await body(req);
    const r=await query('SELECT u.id,u.name,u.email,u.company_id,u.password_hash,u.password_salt,c.name AS company_name FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=$1',[b.email]);
    const user=r.rows[0];
    if(!user||!verifyPassword(String(b.password||''),user.password_salt,user.password_hash)) return json(res,401,{error:'Identifiants incorrects'});
    const t=await createSession(user.id,user.company_id);
    return json(res,200,{token:t,user:{id:user.id,name:user.name,email:user.email,companyId:user.company_id,company:user.company_name}});
  }

  if(req.method==='POST'&&u.pathname==='/api/logout') {
    await deleteSession((req.headers.authorization||'').replace(/^Bearer\s+/i,''));
    return json(res,200,{ok:true});
  }

  const auth=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const session=await getSession(auth);
  if(!session) return json(res,401,{error:'Authentification requise'});
  const companyId=session.companyId;

  if(req.method==='GET'&&u.pathname==='/api/bootstrap') return json(res,200,await dashboard(companyId));
  if(req.method==='GET'&&u.pathname==='/api/dashboard') return json(res,200,await dashboard(companyId));

  if(req.method==='PATCH'&&u.pathname==='/api/settings/ai') {
    const b=await body(req);
    await query('UPDATE companies SET ai_auto_reply_enabled=$1 WHERE id=$2',[Boolean(b.autoReplyEnabled),companyId]);
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
    const proto=req.headers['x-forwarded-proto']||'https';
    return json(res,200,{
      phoneNumberId:row.phoneNumberId||null,
      accessTokenSet:Boolean(row.accessToken),
      accessTokenPreview:row.accessToken?('••••'+row.accessToken.slice(-4)):null,
      verifyToken:row.verifyToken,
      webhookUrl:proto+'://'+req.headers.host+'/webhooks/whatsapp',
      configured:Boolean(row.phoneNumberId&&row.accessToken)
    });
  }
  if(req.method==='PUT'&&u.pathname==='/api/settings/whatsapp') {
    const b=await body(req);
    if(!b.phoneNumberId||!b.accessToken) return json(res,400,{error:'ID du numéro et jeton d\'accès requis'});
    const existing=await query('SELECT whatsapp_verify_token AS "verifyToken" FROM companies WHERE id=$1',[companyId]);
    const verifyToken=existing.rows[0]?.verifyToken||crypto.randomBytes(12).toString('hex');
    await query('UPDATE companies SET whatsapp_phone_number_id=$1,whatsapp_access_token=$2,whatsapp_verify_token=$3 WHERE id=$4',[String(b.phoneNumberId).trim(),String(b.accessToken).trim(),verifyToken,companyId]);
    return json(res,200,{ok:true});
  }
  if(req.method==='POST'&&u.pathname==='/api/settings/whatsapp/test') {
    const c=await query('SELECT whatsapp_phone_number_id AS "phoneNumberId",whatsapp_access_token AS "accessToken" FROM companies WHERE id=$1',[companyId]);
    const row=c.rows[0];
    if(!row?.phoneNumberId||!row?.accessToken) return json(res,400,{ok:false,error:'Renseigne d\'abord l\'ID du numéro et le jeton d\'accès'});
    try {
      const resp=await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${row.phoneNumberId}?fields=display_phone_number,verified_name`,{headers:{'Authorization':'Bearer '+row.accessToken}});
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok) return json(res,200,{ok:false,error:data?.error?.message||('Erreur WhatsApp (HTTP '+resp.status+')')});
      return json(res,200,{ok:true,displayPhoneNumber:data.display_phone_number||null,verifiedName:data.verified_name||null});
    } catch(e) {
      return json(res,200,{ok:false,error:'Connexion à WhatsApp impossible : '+e.message});
    }
  }

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

  if(req.method==='GET'&&u.pathname==='/api/users') {
    const r=await query('SELECT id,name,email,role,created_at AS "createdAt" FROM users WHERE company_id=$1 ORDER BY created_at',[companyId]);
    return json(res,200,{users:r.rows});
  }
  if(req.method==='POST'&&u.pathname==='/api/users') {
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
    const role=['owner','admin','sales','viewer'].includes(b.role) ? b.role : 'sales';
    const h=hashPassword(String(b.password));
    const r=await query('INSERT INTO users(company_id,email,name,role,password_hash,password_salt) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,created_at AS "createdAt"',[companyId,email,String(b.name).trim(),role,h.hash,h.salt]);
    return json(res,201,{user:r.rows[0]});
  }
  const userMatch=u.pathname.match(/^\/api\/users\/([0-9a-f-]+)$/i);
  if(userMatch && (req.method==='PUT'||req.method==='PATCH')) {
    const b=await body(req);
    const role=['owner','admin','sales','viewer'].includes(b.role) ? b.role : null;
    if(!role && !b.name) return json(res,400,{error:'Rien à mettre à jour'});
    const r=await query('UPDATE users SET name=COALESCE(NULLIF($1,\'\'),name),role=COALESCE($2,role) WHERE id=$3 AND company_id=$4 RETURNING id,name,email,role,created_at AS "createdAt"',[b.name||null,role,userMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Utilisateur introuvable'});
    return json(res,200,{user:r.rows[0]});
  }
  if(userMatch && req.method==='DELETE') {
    if(userMatch[1]===session.userId) return json(res,400,{error:'Vous ne pouvez pas vous supprimer vous-même'});
    const count=await query('SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1',[companyId]);
    if(count.rows[0].n<=1) return json(res,400,{error:"Impossible de supprimer le dernier utilisateur de l'entreprise"});
    const r=await query('DELETE FROM users WHERE id=$1 AND company_id=$2 RETURNING id',[userMatch[1],companyId]);
    if(!r.rows[0]) return json(res,404,{error:'Utilisateur introuvable'});
    await query('DELETE FROM sessions WHERE user_id=$1',[userMatch[1]]).catch(()=>{}); // révoque ses sessions actives
    return json(res,200,{ok:true});
  }

  if(req.method==='GET'&&u.pathname==='/api/prospects') {
    const r=await query('SELECT id,name,phone,need,value,score,status,order_intent AS "orderIntent",last_contact AS "lastContact",next_action AS "nextAction",next_action_priority AS "nextActionPriority",next_action_reason AS "nextActionReason",next_action_at AS "nextActionAt",created_at AS "createdAt" FROM prospects WHERE company_id=$1 ORDER BY score DESC,created_at DESC',[companyId]);
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
    if(r.rows[0].status==='Gagné'||r.rows[0].status==='Perdu') await cancelAutoFollowups(companyId,prospectMatch[1],'Prospect '+r.rows[0].status.toLowerCase()+' — relance automatique inutile');
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
    const r=await query(`SELECT c.id,c.channel,c.external_contact AS phone,c.prospect_id AS "prospectId",p.name AS prospect, c.created_at AS "createdAt",
      COALESCE(json_agg(json_build_object('id',m.id,'direction',m.direction,'body',m.body,'createdAt',m.created_at,'providerError',m.provider_error) ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL),'[]') AS messages
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
    await query('UPDATE prospects SET order_intent=true,status=CASE WHEN status IS NULL OR status IN (\'Nouveau\',\'À contacter\') THEN \'En discussion\' ELSE status END WHERE id=$1 AND company_id=$2',[b.prospectId,companyId]);
    await cancelAutoFollowups(companyId,b.prospectId,'Commande créée — relance automatique inutile');
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
    const r=await query('SELECT f.id,f.prospect_id AS "prospectId",p.name AS prospect,f.text,f.due_at AS "dueAt",f.status,f.source,f.cancelled_reason AS "cancelledReason",f.sent_at AS "sentAt",f.created_at AS "createdAt" FROM followups f LEFT JOIN prospects p ON p.id=f.prospect_id WHERE f.company_id=$1 ORDER BY f.due_at NULLS LAST',[companyId]);
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
  ];
  for (const stmt of statements) {
    try { await query(stmt); } catch(e) { console.error('[migrations] echec:',stmt.split('\n')[0],e.message); }
  }
  console.log('[migrations] verifiees au demarrage');
}

const server=http.createServer((req,res)=>handler(req,res).catch(e=>{console.error(e);json(res,500,{error:'Erreur serveur'});}));
ensureMigrations().finally(()=>{
  server.listen(PORT,'0.0.0.0',()=>console.log(`VENDIA 1.7.0 listening on ${PORT}`));
});
process.on('SIGTERM',async()=>{server.close();await closeDatabase();});
