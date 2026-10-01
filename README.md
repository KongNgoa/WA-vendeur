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

Variables utiles : `PORT`, `DATABASE_URL`, `ANTHROPIC_API_KEY` (réponse IA automatique sur WhatsApp), `ANTHROPIC_MODEL` (optionnel, défaut `claude-haiku-4-5-20251001`), `META_APP_SECRET` (vérification de signature du webhook WhatsApp), `ENCRYPTION_KEY` (chiffre le jeton d'accès WhatsApp en base — recommandé en production, voir 1.10.6), `REQUIRE_WEBHOOK_SIGNATURE` (optionnel, `true` pour rejeter les webhooks WhatsApp sans signature valide — à activer seulement une fois `META_APP_SECRET` confirmé configuré).

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

## Audit sécurité, fiabilité et analytics (1.10.6)
Suite à un audit complet du code et une étude du marché WhatsApp commerce IA (arrivée de "Meta Business Agent", un concurrent gratuit et natif à la plateforme), cette version corrige les points de sécurité et de fiabilité identifiés et ajoute un premier tableau de bord analytique.

**Sécurité**
- **Jeton d'accès WhatsApp chiffré en base** (AES-256-GCM) au lieu d'être stocké en clair. Nécessite une variable `ENCRYPTION_KEY` sur Railway (une longue chaîne aléatoire, ex. générée par `openssl rand -hex 32`) ; sans elle, le jeton reste stocké en clair comme avant, avec un avertissement au démarrage du serveur.
- **Limitation du nombre de tentatives** (rate limiting) sur la connexion, la connexion super-admin, l'inscription et le mot de passe oublié, pour bloquer les tentatives automatisées répétées.
- **Vérification de la signature des webhooks WhatsApp** : option `REQUIRE_WEBHOOK_SIGNATURE=true` pour rejeter tout webhook dont la signature Meta est invalide ou absente (désactivée par défaut tant que `META_APP_SECRET` n'est pas confirmé configuré sur Railway, pour ne rien casser).
- **Le testeur "Assistant commercial IA" du tableau de bord respecte désormais le quota mensuel de messages IA** de l'offre, au lieu de pouvoir l'utiliser sans limite.

**Fiabilité**
- **Doublons évités** quand plusieurs messages du même client arrivent en rafale sur WhatsApp : un seul prospect et une seule conversation sont créés par client, même en cas de messages simultanés.
- **Messages WhatsApp dupliqués ignorés** (ex. si Meta renvoie deux fois la même notification) grâce à un identifiant unique par message.
- **Réponses IA et règles métier (score du prospect, transfert vers un humain, prise de rendez-vous, catalogue) fonctionnent désormais aussi bien en anglais qu'en français**, et plus seulement en français.
- **Le quota mensuel de prospects de l'offre est maintenant appliqué partout** (y compris sur les nouveaux contacts WhatsApp), pas seulement dans l'ajout manuel.
- **Limites de chargement** ajoutées sur les listes (conversations, prospects, commandes, relances, rendez-vous) pour garder l'application rapide même avec un historique volumineux.

**Nouveau : onglet Analytics**
- **Taux de réponse**, **temps de réponse moyen**, **taux de conversion prospect → commande** et **messages IA utilisés ce mois** en un coup d'œil.
- **Graphique des messages reçus sur les 14 derniers jours** pour repérer les pics d'activité.

## CRM en vue pipeline et catalogue avec photos (1.10.7)
- **Vue Kanban pour les prospects** (onglet CRM → bouton "🗂️ Pipeline") : les prospects sont répartis en colonnes par étape (Nouveau, À contacter, En discussion, Gagné, Perdu), déplaçables par glisser-déposer ou via le menu déroulant de chaque carte — pratique pour visualiser et faire avancer son pipeline commercial d'un coup d'œil, en plus de la vue liste existante.
- **Correction d'un bug de fond sur le statut des prospects** : l'étape commerciale (Nouveau/En discussion/Gagné/Perdu, modifiée manuellement) et la température IA (Chaud/Tiède/Froid, recalculée automatiquement à chaque message WhatsApp reçu) partageaient la même donnée en base. Un prospect marqué "Gagné" pouvait donc repasser silencieusement "Chaud" ou "Froid" dès son prochain message client, et les relances automatiques ne s'arrêtaient pas toujours correctement pour les dossiers conclus. Les deux notions sont désormais séparées : l'étape du pipeline reste stable, modifiable uniquement par vous.
- **Photos produits dans le catalogue** : chaque produit peut désormais avoir une photo (URL d'image). Elle s'affiche dans la gestion du catalogue et, surtout, est envoyée automatiquement au client sur WhatsApp dès qu'il sélectionne un article dans le catalogue interactif — avant la réponse de l'IA.

Dernière étape d'intégration : API raccordée au modèle PostgreSQL relationnel.
