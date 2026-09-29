-- WA-Vendeur 0.6 - schéma PostgreSQL de production
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
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

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','sales','viewer')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX users_company_idx ON users(company_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_salt TEXT NOT NULL DEFAULT '';

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  price NUMERIC(14,2) NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_company_idx ON products(company_id);

CREATE TABLE prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  need TEXT,
  value NUMERIC(14,2) DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),
  status TEXT,
  order_intent BOOLEAN NOT NULL DEFAULT false,
  last_contact TIMESTAMPTZ,
  next_action TEXT,
  next_action_priority TEXT,
  next_action_reason TEXT,
  next_action_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX prospects_company_idx ON prospects(company_id);
-- Lot "moteur d'action commerciale" (/api/ai/next-action) — idempotent pour les bases déjà déployées.
-- Pour appliquer uniquement cet ajout sur la base de production existante, sans rejouer tout schema.sql,
-- utiliser scripts/migrate-add-next-action.js.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_priority TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_reason TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ;

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  external_contact TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_company_idx ON conversations(company_id);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('in','out','system')),
  body TEXT NOT NULL,
  provider_message_id TEXT,
  provider_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_error TEXT;
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'En attente',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_company_idx ON orders(company_id);

CREATE TABLE followups (
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
CREATE INDEX followups_source_idx ON followups(company_id, prospect_id, status, source);
-- Lot "relances automatiques contrôlées" — idempotent pour les bases déjà déployées.
-- Pour appliquer uniquement cet ajout sur la base de production existante,
-- utiliser scripts/migrate-add-followup-automation.js.
ALTER TABLE followups ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE followups ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
CREATE INDEX followups_due_idx ON followups(status, due_at);

CREATE TABLE subscriptions (
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

CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_event_id TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_event_id)
);

CREATE TABLE payments (
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
