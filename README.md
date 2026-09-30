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

Compte super-admin (vision et contrôle sur toutes les entreprises, via `/superadmin.html`) : `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` (créés/synchronisés automatiquement au démarrage — changer `SUPERADMIN_PASSWORD` sur Railway suffit à faire tourner le mot de passe), `SUPERADMIN_NAME` (optionnel).

Réinitialisation de mot de passe par email (libre-service, "mot de passe oublié") : `RESEND_API_KEY` (compte gratuit sur resend.com), `EMAIL_FROM` (optionnel, défaut `VENDIA <onboarding@resend.dev>`). Sans cette clé, la réinitialisation assistée par l'administrateur de l'équipe (onglet Équipe) ou par le super-admin reste disponible sans aucune configuration.

Inscription en libre-service (`/signup.html`) : tunnel de paiement mobile money (Orange Money / MTN Mobile Money). `ORANGE_MONEY_NUMBER`, `MTN_MOMO_NUMBER` (optionnels — numéros déjà pré-configurés par défaut). Le compte reste bloqué jusqu'à validation manuelle du paiement par le super-admin (`/superadmin.html` → "Validations de paiement en attente"). `RESEND_API_KEY` est nécessaire pour que le super-admin reçoive un email à chaque nouvelle demande et que le client reçoive l'email de confirmation d'activation — sans cette clé, les demandes restent visibles dans le panneau super-admin mais aucun email n'est envoyé.

Rapport quotidien (20h, heure du Cameroun) envoyé par email à chaque administrateur d'entreprise et un récapitulatif complet au super-admin : nécessite aussi `RESEND_API_KEY`. Sans cette clé, les rapports sont bien calculés chaque soir mais aucun email n'est réellement envoyé (juste journalisé côté serveur).

## Fonctionnalités inspirées des concurrents africains (1.10.0)
- **Catalogue interactif dans WhatsApp** : quand un client tape "catalogue", "vos produits", "menu"… l'assistant envoie une liste WhatsApp native (jusqu'à 10 produits, prix + stock) que le client parcourt sans quitter la conversation ; la sélection déclenche une réponse IA sur le produit exact.
- **Relance automatique réellement envoyée** : les relances programmées automatiquement (prospects tièdes/froids) sont désormais envoyées pour de vrai sur WhatsApp par l'IA dès leur échéance, sans action manuelle (nécessite `ANTHROPIC_API_KEY` et WhatsApp configuré ; sinon la relance reste visible dans l'onglet Relances comme avant).
- **Paiement mobile money propre à chaque entreprise** : chaque entreprise renseigne ses propres numéros Orange Money / MTN Mobile Money dans Paramètres → l'IA les indique automatiquement au client au moment de la commande. Distinct des numéros du super-admin (`ORANGE_MONEY_NUMBER`/`MTN_MOMO_NUMBER`) qui servent uniquement au tunnel d'abonnement VENDIA.
- **Prise de rendez-vous automatisée** : un client qui exprime une intention de rendez-vous (livraison, démo, appel) avec un jour/une heure est confirmé automatiquement (visible dans l'onglet Relances → Rendez-vous) ; sans date précise, le rendez-vous reste "Proposé" et l'IA demande au client de préciser.

Dernière étape d'intégration : API raccordée au modèle PostgreSQL relationnel.
