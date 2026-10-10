-- WA-Vendeur 0.6 - schéma PostgreSQL de production
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  sector TEXT,
  phone TEXT,
  ai_name TEXT DEFAULT 'Assistant commercial',
  ai_tone TEXT DEFAULT 'Professionnel et chaleureux',
  ai_language TEXT DEFAULT 'Français',
  ai_rules TEXT,
  whatsapp_phone_number_id TEXT,
  whatsapp_access_token TEXT,
  whatsapp_verify_token TEXT,
  ai_auto_reply_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Lot "envoi WhatsApp réel" (phase 3, Meta WhatsApp Cloud API) — idempotent pour
-- les bases déjà déployées. Pour appliquer uniquement cet ajout sur la base de
-- production existante, utiliser scripts/migrate-add-whatsapp-settings.js.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_verify_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS companies_whatsapp_phone_idx ON companies(whatsapp_phone_number_id) WHERE whatsapp_phone_number_id IS NOT NULL;
-- Lot "sessions persistées + réponse IA automatique" — idempotent. Pour
-- appliquer uniquement cet ajout sur la base de production existante, utiliser
-- scripts/migrate-add-sessions-and-ai-reply.js.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_auto_reply_enabled BOOLEAN NOT NULL DEFAULT true;
-- Lot "administration d'équipe, mot de passe oublié et super-admin" —
-- idempotent. Pour appliquer uniquement cet ajout sur la base de production
-- existante, utiliser scripts/migrate-add-superadmin-and-roles.js.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false;
-- Lot "tunnel de paiement mobile money + rapports quotidiens" — idempotent.
-- approved_at NULL = compte en attente de validation du paiement par le
-- super-admin. Pour appliquer uniquement cet ajout sur la base de
-- production existante, utiliser scripts/migrate-add-payments-and-reports.js.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS payment_requests (
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
);
CREATE INDEX IF NOT EXISTS payment_requests_status_idx ON payment_requests(status);

CREATE TABLE IF NOT EXISTS super_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','sales','viewer')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_company_idx ON users(company_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_salt TEXT NOT NULL DEFAULT '';

-- user_id/company_id sont nullables : une session est soit celle d'un
-- utilisateur d'entreprise (les deux renseignés), soit celle d'un
-- super-admin (super_admin_id renseigné) — jamais les deux à la fois.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  super_admin_id UUID REFERENCES super_admins(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sessions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE sessions ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS super_admin_id UUID REFERENCES super_admins(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_token_idx ON password_resets(token_hash);


CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  price NUMERIC(14,2) NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_company_idx ON products(company_id);

CREATE TABLE IF NOT EXISTS prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  need TEXT,
  value NUMERIC(14,2) DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),
  status TEXT,
  stage TEXT NOT NULL DEFAULT 'Nouveau',
  order_intent BOOLEAN NOT NULL DEFAULT false,
  last_contact TIMESTAMPTZ,
  next_action TEXT,
  next_action_priority TEXT,
  next_action_reason TEXT,
  next_action_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prospects_company_idx ON prospects(company_id);
-- Un seul prospect par numéro de téléphone et par entreprise — empêche les
-- doublons quand plusieurs messages du même contact arrivent en rafale
-- (voir findOrCreateProspectByPhone dans server.js).
CREATE UNIQUE INDEX IF NOT EXISTS prospects_company_phone_idx ON prospects(company_id,phone) WHERE phone IS NOT NULL;
-- Lot "moteur d'action commerciale" (/api/ai/next-action) — idempotent pour les bases déjà déployées.
-- Pour appliquer uniquement cet ajout sur la base de production existante, sans rejouer tout schema.sql,
-- utiliser scripts/migrate-add-next-action.js.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_priority TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_reason TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ;
-- Sépare l'étape du pipeline commercial (stage : Nouveau/À contacter/En discussion/
-- Gagné/Perdu, modifiable manuellement) de la température IA (status : Chaud/
-- Tiède/Froid, recalculée à chaque message WhatsApp entrant). Avant ce correctif
-- les deux étaient confondues dans la colonne status, qui était donc écrasée par
-- l'IA à chaque message — un prospect marqué "Gagné" repassait "Chaud" dès sa
-- prochaine réponse. Voir vue kanban (CRM) dans server.js/index.html.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'Nouveau';
UPDATE prospects SET stage=status WHERE status IN ('Nouveau','À contacter','En discussion','Gagné','Perdu');

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  external_contact TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_company_idx ON conversations(company_id);
-- Une seule conversation par contact/canal et par entreprise — empêche les
-- doublons quand plusieurs messages du même contact arrivent en rafale
-- (voir findOrCreateWhatsAppConversation dans server.js).
CREATE UNIQUE INDEX IF NOT EXISTS conversations_company_channel_contact_idx ON conversations(company_id,channel,external_contact) WHERE external_contact IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('in','out','system')),
  body TEXT NOT NULL,
  provider_message_id TEXT,
  provider_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_error TEXT;
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'En attente',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_company_idx ON orders(company_id);

CREATE TABLE IF NOT EXISTS followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  text TEXT,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'Programmée',
  source TEXT NOT NULL DEFAULT 'manual',
  cancelled_reason TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS followups_source_idx ON followups(company_id, prospect_id, status, source);
-- Lot "relances automatiques contrôlées" — idempotent pour les bases déjà déployées.
-- Pour appliquer uniquement cet ajout sur la base de production existante,
-- utiliser scripts/migrate-add-followup-automation.js.
ALTER TABLE followups ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE followups ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
CREATE INDEX IF NOT EXISTS followups_due_idx ON followups(status, due_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK(plan IN ('Starter','Business','Pro')),
  status TEXT NOT NULL CHECK(status IN ('trial','active','cancelled','past_due')),
  monthly_price NUMERIC(14,2) NOT NULL,
  provider TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_billing_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  ai_messages_used INTEGER NOT NULL DEFAULT 0,
  ai_usage_reset_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Lot "forfaits avec limites" — idempotent. Pour appliquer uniquement cet
-- ajout sur la base de production existante, utiliser scripts/migrate-add-plan-limits.js.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ai_messages_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ai_usage_reset_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_event_id TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_event_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount_cfa INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT NOT NULL DEFAULT 'manual',
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);

CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lot "meilleures pratiques des concurrents africains" (catalogue interactif
-- WhatsApp, relance automatique réellement envoyée, paiement mobile money
-- propre à chaque entreprise, prise de rendez-vous automatisée) — idempotent.
-- Pour appliquer uniquement cet ajout sur la base de production existante,
-- utiliser scripts/migrate-add-competitive-features.js.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_orange_money TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_mtn_momo TEXT;

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'Rendez-vous',
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'Proposé',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointments_company_idx ON appointments(company_id, scheduled_at);

-- Vitrine web publique /boutique/<slug> (désactivée par défaut)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS shop_slug TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS shop_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS shop_whatsapp TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS shop_tagline TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS companies_shop_slug_idx ON companies(shop_slug) WHERE shop_slug IS NOT NULL;

-- Programme de parrainage : code par entreprise, filleuls et commissions
ALTER TABLE companies ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS referral_payout_phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS companies_referral_code_idx ON companies(referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS companies_referred_by_idx ON companies(referred_by) WHERE referred_by IS NOT NULL;
CREATE TABLE IF NOT EXISTS referral_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  referred_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_request_id UUID NOT NULL UNIQUE REFERENCES payment_requests(id) ON DELETE CASCADE,
  base_amount NUMERIC(12,2) NOT NULL,
  percent NUMERIC(5,2) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS referral_commissions_referrer_idx ON referral_commissions(referrer_company_id,status);

-- Photos de produits téléversées (1.10.12)
CREATE TABLE IF NOT EXISTS product_images (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE, data BYTEA NOT NULL, mime TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS product_images_company_idx ON product_images(company_id);

-- Paiement manuel : anti-doublon de référence et échéance d'abonnement (1.10.14)
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS reference_norm TEXT;
CREATE INDEX IF NOT EXISTS payment_requests_refnorm_idx ON payment_requests(reference_norm);

-- Commandes depuis la vitrine web (1.10.17)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manuel';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_reserved BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS handled_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS shop_fb_pixel TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS shop_tiktok_pixel TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS order_notify_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS order_notify_template TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS order_notify_lang TEXT NOT NULL DEFAULT 'fr';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_notified_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notify_result TEXT;

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  template_name TEXT,
  template_lang TEXT NOT NULL DEFAULT 'fr',
  audience JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'Brouillon',
  note TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS campaigns_company_idx ON campaigns(company_id, created_at DESC);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  first_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_idx ON campaign_recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_recipients_company_sent_idx ON campaign_recipients(company_id, sent_at) WHERE status='sent';

CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  whatsapp TEXT,
  tagline TEXT,
  fb_pixel TEXT,
  tiktok_pixel TEXT,
  is_main BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shops_slug_idx ON shops(slug);
CREATE INDEX IF NOT EXISTS shops_company_idx ON shops(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS shops_one_main_idx ON shops(company_id) WHERE is_main;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE SET NULL;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS telegram_bot_username TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS telegram_webhook_secret TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS companies_telegram_secret_idx ON companies(telegram_webhook_secret) WHERE telegram_webhook_secret IS NOT NULL;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS prospects_company_telegram_idx ON prospects(company_id,telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
