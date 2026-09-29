# WA-Vendeur

WA-Vendeur transforme WhatsApp en commercial disponible 24h/24 : assistant IA, catalogue, prospects, commandes et relances.

## MVP bêta
- Dashboard commercial
- Catalogue produits
- Prospects et scoring
- Commandes
- Assistant IA avec mode démo sans clé API
- Endpoint de santé pour déploiement
- PostgreSQL si `DATABASE_URL` est fourni

## Démarrage
```bash
npm install
npm start
```

Variables utiles : `PORT`, `DATABASE_URL`, `ANTHROPIC_API_KEY` (réponse IA automatique sur WhatsApp), `ANTHROPIC_MODEL` (optionnel, défaut `claude-haiku-4-5-20251001`), `META_APP_SECRET` (vérification de signature du webhook WhatsApp).

Dernière étape d'intégration : API raccordée au modèle PostgreSQL relationnel.
