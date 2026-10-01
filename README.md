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

## Personnalité de l'IA et logo (1.10.2)
- **Nom, ton, langue et consignes de l'IA personnalisables** (onglet Assistant IA → "Personnalité de l'assistant IA") : chaque entreprise choisit comment son assistant se présente à ses clients (ces champs existaient déjà en base mais n'avaient jamais eu d'interface).
- **Le testeur "Assistant commercial IA" utilise désormais le vrai moteur Claude** (comme sur WhatsApp) quand `ANTHROPIC_API_KEY` est configurée, au lieu d'une réponse de secours à mots-clés — un badge indique clairement quel moteur a répondu, pratique pour vérifier qu'une clé fonctionne sans passer par WhatsApp.
- **Logo VENDIA intégré** : favicon, icône d'app et en-tête des 4 pages publiques, avec la palette de couleurs de la marque (bleu → vert en dégradé, fond marine) reprise pour les boutons principaux et onglets actifs.

## Interface bilingue et IA multilingue (1.10.3)
- **Tableau de bord entreprise (`/`) disponible en français et en anglais**, avec un sélecteur FR/EN dans l'en-tête (préférence mémorisée sur l'appareil). Toute l'interface visible — navigation, formulaires, tableaux, statuts, messages — est traduite ; les valeurs enregistrées en base (statuts, etc.) restent en français en interne pour ne rien casser côté serveur, seul l'affichage change.
- **Les réponses de l'IA s'adaptent automatiquement à la langue du client** : l'assistant détecte la langue du dernier message reçu sur WhatsApp (français, anglais, ou autre) et répond dans cette même langue, au lieu d'imposer une langue fixe. La langue configurée dans "Personnalité de l'IA" ne sert plus que de repli si la langue du message est ambiguë.
- Le super-admin (`/superadmin.html`), la page d'inscription (`/signup.html`) et la politique de confidentialité restent en français pour l'instant (usage interne / à traduire dans une prochaine étape si besoin).

## Traduction complète du site (1.10.4)
- **Les 4 pages sont désormais bilingues** : le super-admin, la page d'inscription et la politique de confidentialité disposent maintenant du même sélecteur FR/EN que le tableau de bord, avec la même préférence mémorisée sur l'appareil (partagée entre toutes les pages).
- **Les messages d'erreur et de confirmation de l'inscription en ligne** (`/api/signup`) s'affichent eux aussi dans la langue choisie par le client au moment de l'inscription.

## Onglet Conversations repensé (1.10.5)
- **Liste de conversations façon messagerie** au lieu d'empiler tous les messages de toutes les conversations sur la même page : chaque contact apparaît comme une seule ligne compacte (avatar, nom/numéro, aperçu du dernier message), triée par message le plus récent. Un clic ouvre la conversation complète dans une fenêtre dédiée.
- **Heure de chaque message affichée** (heure seule si envoyé aujourd'hui, date + heure sinon), avec des bulles alignées à gauche/droite comme sur WhatsApp pour distinguer client et VENDIA en un coup d'œil.

Dernière étape d'intégration : API raccordée au modèle PostgreSQL relationnel.
