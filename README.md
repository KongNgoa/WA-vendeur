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

Variables utiles : `PORT`, `DATABASE_URL`, `ANTHROPIC_API_KEY` (réponse IA automatique sur WhatsApp), `ANTHROPIC_MODEL` (optionnel, défaut `claude-haiku-4-5-20251001`), `META_APP_SECRET` (vérification de signature du webhook WhatsApp), `ENCRYPTION_KEY` (chiffre le jeton d'accès WhatsApp en base — recommandé en production, voir 1.10.6), `REQUIRE_WEBHOOK_SIGNATURE` (optionnel, `true` pour rejeter les webhooks WhatsApp sans signature valide — à activer seulement une fois `META_APP_SECRET` confirmé configuré). `AFFILIATE_PERCENT` (commission de parrainage en %, défaut `20`, `0` pour la désactiver) et `AFFILIATE_MAX_PAYMENTS` (nombre maximal de paiements d'un filleul qui rapportent une commission, défaut `12`) — voir 1.10.10.

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

## Démarrage rapide par secteur, export comptable et performance (1.10.8)
- **Modèles de démarrage rapide par secteur** (onglet Catalogue → "Démarrage rapide") : 4 modèles prêts à l'emploi (Boutique mode & accessoires, Restaurant & traiteur, Salon de beauté & coiffure, Quincaillerie & matériaux) pré-remplissent en un clic la personnalité de l'assistant IA (nom, ton, consignes adaptées au métier) et quelques produits d'exemple — pratique pour une nouvelle entreprise qui veut tester WhatsApp avec son assistant dès l'inscription. Le catalogue existant n'est jamais écrasé : les produits d'exemple ne sont ajoutés que si le catalogue est encore vide.
- **Export comptable simple** (onglet Commandes → "📊 Exporter en Excel") : génère un fichier Excel (.xlsx) avec le détail de toutes les commandes et un résumé des totaux par statut, prêt à transmettre à un comptable ou à importer ailleurs.
- **Démarrage du serveur plus rapide** : l'initialisation de la démo (compte d'exemple) ne s'exécute plus qu'une seule fois au démarrage du serveur au lieu d'être revérifiée à chaque requête, ce qui réduit la charge sur la base de données.

## Vitrine web publique (1.10.9)
- **Une boutique en ligne par entreprise** (Paramètres → "Vitrine web") : une page publique `/boutique/<nom>` générée automatiquement depuis le catalogue (photos, prix, catégories, recherche), à partager sur Facebook, TikTok ou Instagram. Chaque produit a un bouton **"Commander sur WhatsApp"** qui ouvre la conversation avec le message déjà rédigé : la vente se conclut avec l'assistant IA, comme avant.
- **Désactivée par défaut** : l'entreprise choisit son lien (modifiable), renseigne le numéro WhatsApp affiché (un numéro camerounais local reçoit automatiquement l'indicatif +237) puis l'active. Impossible d'activer sans numéro WhatsApp valide.
- **Pensée pour le référencement et le partage** : aperçu riche (titre, description, photo) dans Facebook/WhatsApp, données structurées schema.org (produits, prix en XAF, disponibilité), lien canonique.
- **Sûre** : tout le contenu est échappé, la page disparaît (404) si l'entreprise la désactive, est suspendue ou n'est pas encore validée, et les requêtes répétées sont limitées par IP.

## Page par produit et pixels publicitaires (1.10.20)
- **Une page dédiée par produit** : `/boutique/<lien>/p/<id>` (bouton 🔗 dans le catalogue pour copier le lien). Grande photo, prix, "🔥 Plus que N en stock" sous 5 unités, bouton Commander (même formulaire que la vitrine, paiement à la livraison), aperçu riche pour Facebook / WhatsApp et données structurées schema.org `Product`. Le Studio promo ajoute automatiquement ce lien ("🛒 Commander en ligne") aux textes générés.
- **Pixels Facebook et TikTok** (Réglages → Vitrine web, facultatifs) : sur la vitrine et les pages produit, envoi de `PageView`, `ViewContent` (page produit), `InitiateCheckout` (ouverture du formulaire) et `Purchase` (Facebook) / `CompletePayment` (TikTok) à la commande, avec montant en XAF. Les identifiants sont validés strictement avant d'être insérés dans la page ; une mention "pixels de mesure publicitaire" apparaît en pied de page quand un pixel est actif. Il revient au commerçant de respecter les règles de consentement applicables à sa clientèle.

## Renouveler ou monter en gamme (1.10.19)
- Partout où VENDIA invite à changer de forfait (quota atteint, commandes bloquées, échéance proche), deux boutons : **« ⭐ Passer à Business / Pro »** (mis en avant, plus gros) et **« Renouveler mon forfait actuel »** (secondaire).
- Dans l'onglet Abonnement, le forfait supérieur est présélectionné et signalé « ⭐ recommandé » avec un encadré explicatif ; le renouvellement à l'identique reste un choix de la liste. Les clients Pro, sans forfait supérieur, ne voient que le renouvellement.

## Commandes bloquées et alertes de stock (1.10.18)
- **Quota de prospects atteint + commande de la vitrine** : la commande est enregistrée (le client voit une confirmation normale) mais passe en statut **Bloquée** : nom, téléphone et adresse sont masqués (aussi dans l'export Excel) et son statut ne peut pas être modifié. Le propriétaire et les responsables reçoivent un e-mail d'urgence (nombre et montant des commandes bloquées), la bannière rouge du tableau de bord ne peut pas être masquée, et chaque ligne propose "Passer à Business / Pro". Dès que le forfait supérieur est validé (ou que le quota se libère), les commandes sont **débloquées automatiquement** et un e-mail le confirme. Les commandes bloquées comptent dans la limite de 3 commandes en attente par téléphone.
- **Alertes de stock permanentes** (bannière sur tous les onglets, non masquable) : ⚠️ à 5 unités ou moins, 🟠 à 2, 🔴 à 1 ou épuisé, avec un ton de plus en plus urgent. La **vitesse de vente** (moyenne des 14 derniers jours, d'après les commandes de la vitrine) est affichée ("≈ 1,9 vendu/jour, environ 2,7 jours de stock") et relève le niveau d'urgence : un produit qui se vend vite est signalé même avec plus de 5 unités (≤ 7 jours de stock). Le stock est coloré dans le catalogue, et les alertes figurent dans le rapport quotidien de 20 h et dans l'e-mail de commande.
- Limite connue : seules les commandes de la vitrine portent produit et quantité ; la vitesse de vente ne tient donc pas compte des commandes saisies à la main ou conclues sur WhatsApp.

## Commande directe sur la vitrine (1.10.17)
- **Bouton "Commander" sur chaque produit de la vitrine** : le client remplit un court formulaire (quantité, téléphone, nom, adresse de livraison) et valide, paiement à la livraison. Le lien "poser une question sur WhatsApp" reste disponible sous le bouton.
- **Tout est enregistré automatiquement** : la commande (onglet Commandes, badge "🛒 Vitrine", produit, quantité, adresse, téléphone cliquable vers WhatsApp), le contact dans le CRM (même si le quota de prospects est atteint, une vente n'est jamais perdue) et un e-mail au propriétaire et aux responsables.
- **Stock réservé de façon atomique** : jamais de vente au-delà du stock ; une commande annulée rend le stock au catalogue (une seule fois).
- **Statut modifiable** depuis l'onglet Commandes (En attente → Confirmée → En préparation → Livrée / Annulée), jusqu'ici impossible depuis l'interface. L'export Excel inclut produit, quantité, adresse et origine.
- **Protections** : champ piège anti-robot, 8 commandes / 10 min par IP, 60 / h par boutique, 3 commandes en attente maximum par téléphone, validation stricte, tout le contenu échappé.

## Audit et correctifs (1.10.16)
- **Schéma SQL réparé** : `schema.sql` s'exécute désormais sans erreur sur une base vierge (tables sessions/password_resets créées après users) et peut être rejoué sans erreur.
- **Requêtes** : une requête JSON trop volumineuse (413) ou invalide (400) renvoie un message clair au lieu d'une erreur 500, et le serveur ne garde plus en mémoire un corps déjà jugé trop gros.
- **Photos** : les photos non utilisées (remplacées, produit supprimé, envoi abandonné) sont purgées automatiquement après 1 h, pour ne pas consommer le plafond de 500.
- **Abonnement** : e-mail au client quand un paiement est refusé ; messages d'erreur du renouvellement et de l'envoi de photo traduits en anglais ; les bannières d'échéance et de montée en gamme ne s'affichent qu'à l'administrateur.

## Invitation à monter en gamme (1.10.15)
- **Bannière dans le tableau de bord** pour les forfaits Starter et Business : à partir de 80 % du quota de prospects ou de réponses IA du mois, un message prévient le client (avec croix pour le masquer le temps de la session) ; à 100 %, la bannière devient rouge et explique la conséquence (nouveaux contacts non enregistrés, ou réponses IA de secours).
- Le bouton "Passer à Business / Pro" ouvre l'onglet Abonnement avec le forfait supérieur déjà sélectionné. Le montant du forfait supérieur reste le prix plein (pas de prorata).

## Paiement manuel amélioré (1.10.14)
- **Nouvel onglet "Abonnement"** (administrateur de l'équipe uniquement) : forfait, prix, date d'échéance et jours restants, numéro Orange Money / MTN à payer (copiable), formulaire de renouvellement ou de changement de forfait, historique des paiements avec leur statut. Une bannière prévient 5 jours avant l'échéance et après.
- **Chaque paiement validé prolonge l'abonnement de 30 jours** à partir de l'échéance en cours (plus de perte si on paie en avance). Les abonnements actifs existants reçoivent 30 jours à partir du déploiement. L'accès n'est jamais coupé automatiquement : la bannière sert de rappel et le super-admin garde la main.
- **Anti-doublon** : une même référence de transaction (insensible aux espaces, tirets et majuscules) ne peut pas servir deux fois, ni à l'inscription ni au renouvellement ; référence trop courte refusée ; un seul paiement en attente par entreprise.
- **Super-admin** : les demandes de renouvellement sont repérées par un badge "Renouvellement" et signalées par e-mail ; l'e-mail d'activation indique la nouvelle date d'échéance.

## Photos de produits (1.10.12 → 1.10.13)
- **Téléversement direct à l'ajout d'un produit** : un champ "Photo du produit" permet de choisir une image depuis le téléphone ou l'ordinateur ; elle est réduite dans le navigateur (JPEG, 1600 px max) puis stockée en base (table `product_images`, servie sur `/img/<id>`). Le lien collé à la main reste possible, et le bouton 📷 du catalogue change la photo d'un produit existant.
- La photo est utilisée partout : catalogue, vitrine web, envoi d'images par l'IA sur WhatsApp et affiches du Studio promo (même domaine, donc toujours intégrable). Contrôles côté serveur : 2 Mo max, JPEG/PNG/WebP vérifiés sur le contenu, 500 photos max par entreprise.

## Studio promo (1.10.11)
- **Nouvel onglet "Studio promo"** : choisissez un produit du catalogue et obtenez en un clic un texte prêt à publier (statut WhatsApp, publication Facebook/Instagram ou message à un client), modifiable avant copie ou partage WhatsApp.
- **Texte rédigé par l'IA, sans invention** : le serveur n'envoie à Claude que le nom, la catégorie, le prix et l'alerte de stock ; l'IA n'écrit jamais de lien, de numéro ni de remise. Les liens de commande WhatsApp et de vitrine sont ajoutés par le serveur. Même quota mensuel que les autres usages IA ; au-delà (ou sans clé API), un modèle de texte FR/EN est utilisé.
- **Affiche PNG générée dans le navigateur** (format statut 9:16 ou carré), 4 thèmes de couleurs, accroche personnalisable, nom, prix, numéro WhatsApp de la vitrine. La photo du produit n'est intégrée que si son hébergeur l'autorise ; sinon l'affiche reste téléchargeable sans photo.

## Programme de parrainage (1.10.10)
- **Un lien de parrainage par entreprise** (nouvel onglet "Parrainage") : `/signup.html?ref=<code>`, à copier ou à partager d'un clic sur WhatsApp. Le champ "Code de parrainage" de l'inscription est pré-rempli ; un code inconnu ou invalide n'empêche jamais l'inscription.
- **Commission calculée à la validation du paiement du filleul** : `AFFILIATE_PERCENT` % du montant (20 % par défaut), sur ses `AFFILIATE_MAX_PAYMENTS` premiers paiements (12 par défaut). Un paiement ne génère jamais deux commissions, et aucune commission n'est due si le parrain est suspendu ou non validé. Le parrain est prévenu par e-mail (si `RESEND_API_KEY` est configurée).
- **Versement manuel, suivi dans l'appli** : le parrain renseigne son numéro Orange Money / MTN MoMo ; le super-admin voit les commissions à verser (panneau "Commissions de parrainage à verser"), les règle par mobile money puis les marque comme versées — le parrain est prévenu et ses compteurs "à recevoir / versées" se mettent à jour.
- Le tableau du parrain montre ses filleuls (abonné actif ou en attente de paiement) et ce que chacun lui a rapporté.

Dernière étape d'intégration : API raccordée au modèle PostgreSQL relationnel.
## 1.10.44 — Blocage strict à l'échéance et à la limite de messages

- **Échéance** : plus de période de grâce (`GRACE_DAYS = 0`) — dès que `next_billing_at` est dépassé, API, webhooks, IA, relances et campagnes sont bloqués ; l'écran client ne montre que l'onglet Abonnement avec « Renouvelez votre forfait ou passez au forfait supérieur ». Vaut aussi pour la fin de l'essai gratuit.
- **Limite de messages IA** (Starter : 150/mois) : l'IA est suspendue. Aucun relais humain automatique (l'humain reste le dernier recours) ; un bandeau rouge propose le forfait supérieur.
- Rappel : campagnes (403 + upgrade), bannières (402), produits (403), membres et boutiques restent bloqués à leur plafond avec cadenas 🔒.

## 1.10.43 — Essai gratuit 7 jours, paiement annuel, limite de produits

- **Essai gratuit 7 jours** (signup.html, case « Commencer par l'essai gratuit ») : aucun paiement, compte activé immédiatement avec le forfait **Business** débloqué (`subscriptions.status='trial'`, `next_billing_at = +7 jours`). À l'échéance, le garde d'abonnement expiré existant bloque le compte (+2 jours de grâce) jusqu'à un renouvellement ; l'onglet Abonnement affiche « il reste N jour(s) » pendant l'essai. Constante `TRIAL_DAYS`.
- **Paiement annuel** : 10 mois payés pour 12 (`ANNUAL_MONTHS_PAID`) — Starter 100 000, Business 250 000, Pro 500 000 FCFA. Sélecteur Mensuel/Annuel à l'inscription et au renouvellement ; `payment_requests.period` ; la validation super-admin ajoute 365 jours au lieu de 30.
- **Limite de produits** : Starter 50, Business 300, Pro illimité (`maxProducts`) ; création refusée (403 `product_quota`) au-delà, compteur « n / max » et cadenas 🔒 dans le catalogue.
- Messages IA inchangés : Starter 150/mois, Business et Pro illimités.

## 1.10.42 — Cadenas partout où le forfait limite

- Équipe (membres) et boutiques : quand la limite du forfait est atteinte, bloc 🔒 + bouton « Passer à <forfait supérieur> » (helper `lockCta`), comme pour les campagnes et les relances automatiques.

## 1.10.41 — Business : 15 bannières/mois, fonctions verrouillées avec cadenas

- Forfait Business : bannières du Studio promo **10 → 15/mois** (Starter reste à 10, Pro illimité).
- Politique « cadenas » : une fonction hors forfait reste visible avec 🔒 et un bouton d'invitation à passer au forfait supérieur (campagnes sur Starter, et désormais relances automatiques sur Starter).

## 1.10.40 — Limites de forfaits ajustées

- **Starter** : messages IA 100 → **150**/mois ; bannières du Studio promo limitées à **10/mois**.
- **Business** : Studio promo limité à **10 bannières/mois** ; messages de campagne 500 → **300**/mois.
- **Pro** : bannières illimitées (inchangé).
- Une bannière est comptée à chaque téléchargement ou partage (table `promo_banners`, `GET /api/promo/banners/usage`, `POST /api/promo/banners/use` → 402 `banner_quota` au-delà). Compteur affiché dans le panneau Affiche, avec bouton « Voir les forfaits ».

## 1.10.39 — Support : l'IA va au bout, l'humain en dernier recours

- Le message d'accueil de la bulle d'aide ne parle plus de transmission à l'équipe.
- L'assistant de support doit comprendre, guider pas à pas, proposer d'autres pistes et collecter les informations utiles. La transmission n'est autorisée par le serveur qu'après au moins 2 réponses de l'IA, ou si l'utilisateur réclame une personne à 2 reprises ; avant, `escalate` est forcé à faux et l'IA reçoit la consigne de ne jamais mentionner l'équipe.
- Le bouton « Parler à l'équipe » n'apparaît qu'après 2 réponses de l'IA. En cas d'erreur passagère de l'IA, elle demande de renvoyer le message au lieu de transmettre (transmission directe seulement sans clé `ANTHROPIC_API_KEY`).

## 1.10.38 — Support intégré, navigation latérale, barre de stock compacte

- **Bulle d'aide** dans l'espace client (🔔 « Aide », en bas à droite, aussi quand l'abonnement est expiré) : l'assistant IA répond avec une base de connaissances VENDIA (`SUPPORT_KB` dans `server.js`) ; s'il ne peut pas résoudre (bug, paiement, accès, question hors base, client mécontent, demande d'humain, 2 tentatives sans succès) il **transmet à l'équipe** et prévient par email (`SUPERADMIN_EMAIL`). Le client peut aussi cliquer « Parler à l'équipe » ou « Problème résolu ».
- **Super-admin → Support** : liste des demandes avec **statut** (IA en cours / À traiter / Réponse envoyée / Résolu), **type** (WhatsApp, IA, produits, boutique, commandes, paiement, compte, bug, suggestion, autre), priorité, résumé IA, fil de conversation, réponse (notification push au client) et **qualification à la clôture** (résolu par l'IA, par l'équipe, contournement, non reproductible, évolution demandée, sans réponse, clôture automatique, doublon) + satisfaction 👍/👎. Clôture automatique : IA sans activité 48 h, équipe sans réponse du client 7 jours. Indicateur du taux de demandes résolues par l'IA.
- Tables `support_tickets` / `support_messages` ; routes `/api/support/*` (client) et `/api/superadmin/support*`. Sans `ANTHROPIC_API_KEY`, toute demande est transmise directement à l'équipe.
- **Navigation latérale** groupée (Pilotage / Ventes / Développer / Configuration), tiroir sur mobile.
- **Alerte de stock** réduite à une barre d'une ligne (chips des produits, « Détails » pour déplier).

## 1.10.37 — Bannières publicitaires, Marketing super-admin, vidéo de lancement

- **Moteur de bannières** (`public/assets/banner.js`, canvas, partagé) : 4 modèles (Studio, Luxe, Pop, Minimal), 4 formats (story 9:16, portrait 4:5, carré, Facebook 1,91:1), couleurs automatiques tirées de la photo, **détourage automatique** quand le fond de la photo est uni (sinon cadre photo avec fond flou), ombre portée, gros bouton **COMMANDER**, **QR code** (lib MIT `qrcode-generator`, `public/assets/qr.js`) vers la page produit de la boutique (ou un lien wa.me si la boutique est désactivée).
- **Studio promo** : nouveaux contrôles Format / Modèle / Couleurs / Traitement de la photo / Sous-titre. Le choix est mémorisé dans la promotion (`poster_theme` = `modele.couleurs.photo`). Une image PNG n'est pas cliquable : la fonction « commander » vient du QR code, du lien et du numéro WhatsApp affichés.
- **Boutique** : bouton « Commander » en dégradé bien visible + barre fixe en bas (prix + Commander) sur les pages produit.
- **Super-admin → Marketing** : onglet Gestion | Marketing. Table `vendia_campaigns`, routes `GET/POST /api/superadmin/marketing`, `DELETE /api/superadmin/marketing/:id`. 3 modèles de campagne FR/EN avec maquette de téléphone WhatsApp, texte de publication, hashtags, lien avec suivi UTM, téléchargement d'un format ou de tous. Logique dans `public/assets/marketing.js`.
- **Vidéo** : `marketing/video1/` (animation HTML pilotée par `window.__seek(t)`), rendu avec `python3 marketing/video1/render.py sortie.mp4` (Playwright + ffmpeg). Les MP4 ne sont pas versionnés.
- Les fichiers `.js` de `/assets/` sont servis (cache 5 min).

## 1.10.36 — L'IA va au bout avant de passer la main

- **L'IA est l'interlocuteur principal** : consigne renforcée dans son prompt. Avant toute transmission : (1) comprendre la demande (une question précise si elle est floue), (2) essayer de la traiter avec le catalogue, les paiements et les consignes, (3) ne transmettre que si elle dépasse vraiment ses capacités. Tant qu'elle n'a pas encore répondu dans la conversation, elle n'a pas le droit de transmettre.
- **Demande d'humain ou réclamation « normale »** : l'IA répond d'abord (bienveillance, clarification, solution). Si le client insiste (2e demande en 24 h), la demande est transmise (non urgente, ou urgente pour une réclamation).
- **Urgence immédiate** seulement pour les cas graves (litige, plainte, avocat, arnaque/fraude, police) ou quand l'IA détecte une vraie urgence (marqueur interne `[[URGENT]]`). Message d'accusé de réception et alerte immédiate.
- **Alertes graduées** : urgent = notification persistante + vibration longue + bip, rappel à 30 min puis 2 h ; non urgent = notification simple, un seul rappel à 2 h, pas de bip. Pastille « 🚨 Urgent » dans la liste.
- Si l'IA est désactivée, indisponible ou sans clé, toute demande d'humain est signalée tout de suite (jamais de demande perdue).
- Colonnes : `conversations.needs_human_urgent`, `soft_asks`, `soft_asks_at` (remises à zéro quand la conversation est traitée).

## 1.10.35 — Alertes téléphone, passage à l'humain et guide de démarrage

**Passage à l'humain (l'IA reste prioritaire)**
- L'IA répond seule à tout ce que le catalogue, les moyens de paiement et les consignes permettent de traiter. Elle ne dit plus « je vérifie et je reviens » : si elle ne peut pas répondre, elle dit honnêtement que la demande est transmise à l'équipe et termine par le marqueur interne `[[HUMAIN]]` (retiré avant l'envoi).
- Une conversation passe « À traiter » (`conversations.needs_human`) dans 3 cas : demande explicite d'un humain, réclamation/litige/paiement bloqué, ou question hors catalogue/consignes. Une seule alerte par demande ; rappels push à 30 min puis 2 h si personne ne répond (vérification toutes les 5 min).
- Dès qu'un humain répond depuis l'application, l'IA est **en pause** sur cette conversation (12 h, `ai_paused_until`). Boutons « Marquer comme traité » et « Reprendre l'IA » (`POST /api/conversations/:id/handled|resume-ai`). Si le client réécrit pendant la pause et que la dernière réponse humaine date de plus de 5 min, une nouvelle alerte part (l'IA reste muette).
- Onglet Conversations : filtre « À traiter », pastille rouge, badge sur l'onglet et dans le titre de la page, bip + bandeau quand l'app est ouverte (`GET /api/handoff/summary`, interrogé toutes les 30 s).

**Notifications push (Android, iPhone, ordinateur)**
- Web Push (paquet `web-push`). Les clés VAPID sont créées au premier démarrage et stockées en base (`app_settings`) : **aucune variable Railway à ajouter**. Abonnements dans `push_subscriptions` ; seuls propriétaire et admins reçoivent les alertes ; un abonnement expiré (404/410) est supprimé automatiquement.
- `/sw.js` (service worker) et `/manifest.webmanifest` (app installable). Notification persistante (`requireInteraction`) avec vibration, ouverture directe de la conversation (`/?conv=…`).
- Réglages → « Alertes sur votre téléphone » : activer/désactiver/tester, guides Android, iPhone (iOS 16.4+, app ajoutée à l'écran d'accueil) et ordinateur. Routes : `GET /api/push/status`, `POST /api/push/subscribe|unsubscribe|test`.
- **Limite** : une application web ne peut pas forcer une vraie sonnerie d'alarme qui passe outre le mode silencieux (seule une app native le peut). Les alertes Telegram n'ont pas été ajoutées.

**Guide de démarrage**
- Bouton « Guide » + carte sur le tableau de bord + ouverture automatique pour un nouveau compte (≤ 2 étapes faites). 8 étapes dépliables, expliquées pas à pas, en français et en anglais : assistant IA, produits, connexion WhatsApp (URL de rappel et jeton de vérification avec boutons Copier, test de connexion), premier message reçu, numéros de paiement, alertes téléphone, équipe, abonnement.
- Progression détectée automatiquement (`GET /api/onboarding/progress`) ; masquable par entreprise (`POST /api/onboarding/dismiss`, colonne `companies.onboarding_dismissed_at`).

## 1.10.34 — Campagnes récurrentes

- Lors de la programmation, option **Une seule fois / Chaque jour / Chaque semaine / Chaque mois** (`repeat` sur `POST /api/campaigns/:id/schedule`).
- La campagne programmée sert de modèle et reste « Programmée » ; à chaque échéance une **copie** part (visible dans l'historique, avec la date) et l'audience est recalculée à ce moment-là.
- Une occurrence en retard de plus de 6 h est sautée ; un échec ponctuel (quota, audience vide) envoie un e-mail mais la série continue ; entreprise suspendue/expirée : la série est annulée. Limite de 52 envois par série. « Annuler » arrête la série.

## 1.10.33 — Bibliothèque de promotions et campagnes programmées

- **Bibliothèque** : l'onglet Promotions enregistre chaque promo (texte, produit, affiche) sous un nom ; on peut la réutiliser, la mettre à jour, la supprimer (200 max par entreprise). `GET/POST/PATCH/DELETE /api/promotions`.
- **« Envoyer à ma base »** : ouvre le formulaire de campagne avec le texte prérempli ; on choisit une ou plusieurs bases clients et/ou le répertoire.
- **Programmation** : « Quand ? » → plus tard (≥ 1 min, ≤ 90 jours, plan Business). `POST /api/campaigns/:id/schedule`. Le serveur vérifie toutes les 30 s ; la campagne est annulée avec une note et un e-mail si l'entreprise est suspendue/expirée, si l'heure est dépassée de plus de 6 h, ou si le lancement échoue. Une campagne programmée peut être annulée.
- Les campagnes gardent le lien vers la promotion (`promotion_id`, compteur d'utilisations).

## 1.10.32 — Répertoire téléphonique
Dans l'onglet **Bases clients**, nouveau panneau **Mon répertoire téléphonique** (propriétaire/administrateur) : on importe ses propres contacts par copier-coller (« Nom, numéro »), par fichier `.vcf` / `.csv` / `.txt` (export du téléphone) ou, sur Android/Chrome, directement depuis le répertoire du téléphone (« Choisir dans mon téléphone »). Les contacts se rangent par **groupes** (Famille, Voisinage, Salon 2026…). Les numéros sont normalisés (+237 ajouté pour les numéros camerounais à 9 chiffres ; indicatif requis pour les autres pays), dédoublonnés et comparés au CRM (un numéro déjà dans le CRM n'est pas ajouté en double). Une confirmation d'accord des contacts est obligatoire à l'import. Limite : 5 000 contacts par entreprise.
**Campagnes** : une case « Mon répertoire téléphonique » (avec choix des groupes) s'ajoute aux bases du CRM ; l'audience est l'union des deux, sans doublon. Un contact qui répond STOP (ou que l'on exclut) n'est plus jamais contacté, il ne peut pas être supprimé ni réimporté, et seul son propre REPRENDRE le réactive. Un contact du répertoire qui répond devient un prospect du CRM comme les autres. Les contacts du répertoire hors fenêtre de 24 h nécessitent le modèle Meta Marketing, comme tous les envois de masse.

## 1.10.31 — Bases clients et campagnes réutilisables
**Nouvel onglet « Bases clients »** : dix listes automatiques, toujours à jour, calculées à partir de votre CRM : tous les contacts, clients (closés), clients fidèles (2 commandes et plus), pas encore closés, en relance, hésitants (score 40-69), prospects chauds (70+), nouveaux (7 jours), inactifs (30 jours et +), perdus. Pour chacune : effectif, liste consultable avec recherche (nom, téléphone, étape, score, commandes, total dépensé, dernier contact), export CSV (propriétaire/administrateur) et bouton « Campagne ». Les désabonnés (STOP) sont toujours exclus ; un même numéro n'est compté qu'une fois.
**Campagnes** : on coche une ou plusieurs bases (union, sans doublon) au lieu de régler des filtres ; les anciens filtres restent dans « Filtres avancés ». Nouveaux boutons : **Enregistrer sans envoyer** (brouillon conservé puis **Lancer** plus tard) et **Réutiliser** (recharge le message, le modèle Meta et l'audience d'une ancienne campagne pour la relancer).

## 1.10.30 — Blocage après expiration et rapports de 20h
**Blocage :** l'accès est maintenu 2 jours après l'échéance (`GRACE_DAYS`), puis le compte est entièrement bloqué : l'API répond 402 (seul l'onglet Abonnement reste accessible pour renouveler), l'IA ne répond plus, les relances, campagnes et le bot Telegram s'arrêtent, la vitrine `/boutique/...` renvoie 404 et les rapports de 20h ne sont plus envoyés à l'entreprise. Les données sont conservées. Le déblocage est automatique dès qu'un paiement est validé (la nouvelle échéance repart de la date de validation si l'ancienne est dépassée). Dans l'espace super-admin : badge « Bloquée », date d'échéance et bouton **Offrir des jours** (1 à 365 j, à partir d'aujourd'hui ou de l'échéance si elle est future) pour débloquer manuellement ou faire un geste commercial. **Avant de déployer**, vérifiez les dates d'échéance de vos entreprises existantes : toute entreprise dont l'échéance date de plus de 2 jours sera bloquée immédiatement.
**Rapport quotidien d'entreprise (20h, Cameroun) :** CA, commandes et nouveaux prospects avec comparaison à la veille et à la moyenne des 7 jours précédents, tendance sur 7 jours, liste des commandes du jour (client, produit, montant, statut), livraisons en attente, prospects chauds (score ≥ 70) et hésitants, rendez-vous du jour et de demain, relances prévues et envoyées, messages de campagne envoyés, stock à renouveler, quota IA et échéance de l'abonnement.
**Rapport général super-admin (20h) :** totaux de la plateforme (CA, commandes, prospects, messages, entreprises actives/bloquées, revenu mensuel récurrent, inscriptions du jour, paiements à valider), alertes (blocages, échéances proches, entreprises sans activité depuis 3 jours, WhatsApp non connecté, quota IA presque atteint) et un tableau par entreprise avec évolution et tendance du CA sur 7 jours. Le bouton « Envoyer les rapports du jour maintenant » (espace super-admin) déclenche les mêmes e-mails à la demande. Nécessite `RESEND_API_KEY` et `SUPERADMIN_EMAIL`.

## 1.10.29 — Rappels d'échéance (paiement manuel)
(Les paliers sont ceux de 1.10.30 : 5 j, veille, jour J, dernier jour de grâce, compte bloqué.)
Comme les paiements sont manuels, VENDIA envoie maintenant à l'administrateur de chaque entreprise un e-mail de rappel avec les numéros Orange Money / MTN MoMo et le montant du forfait : à 5 jours de l'échéance, la veille, le jour de l'expiration, puis 3 jours après. Chaque palier n'est envoyé qu'une fois ; un renouvellement validé remet le cycle à zéro. Aucun rappel si un paiement est déjà en attente de validation. Nécessite `RESEND_API_KEY` (sans clé, rien n'est envoyé et l'envoi sera retenté dès qu'elle est ajoutée). Le blocage est décrit en 1.10.30 ci-dessus.
Déjà en place avant cette version : e-mail au super-admin à chaque demande de paiement (`SUPERADMIN_EMAIL`), e-mail d'activation à la validation, e-mail en cas de rejet.

## 1.10.28 — Retrait de Campay
Le paiement automatique Campay (1.10.26 et 1.10.27) est retiré : la vérification d'entreprise (RCCM, ACF, NIU) n'est pas possible pour le moment. Le paiement manuel (référence de transaction validée par le super-admin) reste la seule méthode. Les variables `CAMPAY_*` ne sont plus utilisées et peuvent être supprimées de Railway. Les colonnes `payment_requests.provider` / `provider_ref` éventuellement créées sont ignorées sans risque.

## 1.10.25 — Canal Telegram

Chaque entreprise peut connecter **son bot Telegram** (Réglages WhatsApp → panneau Telegram : créer le bot avec @BotFather, coller le jeton). VENDIA vérifie le jeton (`getMe`), enregistre le webhook (`/webhooks/telegram/<secret>` + en-tête `secret_token`, déduplication par `update_id`) et chiffre le jeton comme les secrets WhatsApp. Les messages créent conversation + contact CRM (`prospects.telegram_chat_id`, sans téléphone), l'assistant IA répond (accueil `/start`, catalogue en texte, transfert humain, quota IA) et les réponses manuelles depuis VENDIA repartent sur Telegram. Les conversations sont repérées « ✈️ Telegram ». Les campagnes, relances automatiques et notifications de commande restent WhatsApp uniquement (contacts Telegram sans numéro). Nécessite une URL publique en HTTPS (Railway).

## 1.10.24 — Multi-boutiques

Un compte peut avoir plusieurs vitrines (table `shops`) : **Starter 1, Business 3, Pro 10**. Chacune a son nom, son lien `/boutique/<slug>`, son numéro WhatsApp, son slogan et ses pixels Facebook/TikTok. Un produit est rattaché à une boutique précise ou à « toutes les boutiques » (par défaut) ; la page produit, la commande et le stock respectent ce rattachement. Les commandes affichent la boutique d'origine. Réglages WhatsApp → sélecteur de boutique + « Nouvelle boutique ». La boutique existante devient automatiquement la boutique principale (migration au démarrage ; les colonnes `companies.shop_*` ne sont plus lues). API : `GET/POST /api/shops`, `PATCH/DELETE /api/shops/:id` (les anciennes routes `/api/settings/shop` pointent sur la principale).

## 1.10.23 — Campagnes de diffusion WhatsApp

Nouvel onglet **Campagnes** (propriétaire/admin) : message envoyé à un segment du CRM (étape, température, clients / jamais commandé, inactivité), personnalisable avec `{prénom}`. Garde-fous : forfait **Business** (500 messages/mois) ou **Pro** (3 000), Starter verrouillé avec bouton de montée en gamme ; confirmation obligatoire que les contacts ont accepté d'être sollicités ; **STOP** (et variantes) = désabonnement définitif de la campagne, **REPRENDRE** pour se réabonner, dédoublonnage par numéro ; mention « Répondez STOP » ajoutée à chaque message. Envoi étalé (lots de 10 toutes les 20 s) ; message libre dans la fenêtre WhatsApp de 24 h, sinon **modèle Meta Marketing** (`Bonjour {{1}}, {{2}}`) s'il est renseigné, sinon contact ignoré (raison visible dans Détails). Tables `campaigns`, `campaign_recipients`, colonnes `prospects.opted_out*`.

## 1.10.22 — Suivi de commande automatique par WhatsApp

Réglages WhatsApp → « Suivi de commande automatique » : quand une commande passe en *Confirmée*, *En préparation*, *Livrée* ou *Annulée*, le client reçoit un message WhatsApp (un seul envoi par statut). WhatsApp n'autorise un message libre que dans les 24 h suivant le dernier message du client : hors fenêtre, VENDIA bascule sur un **modèle Meta approuvé** (catégorie Utility, variables {{1}} prénom, {{2}} n° de commande, {{3}} statut) si son nom est renseigné ; sinon la commande affiche « Client non prévenu ». Désactivé par défaut. Colonnes : `companies.order_notify_*`, `orders.last_notified_status/notify_result`.

## 1.10.21 — Analytics de ventes

Onglet **Analytics** : CA livré / en cours, nombre de commandes et panier moyen (avec variation vs période précédente, 7/30/90 jours), entonnoir contacts → discussion/intention → commande → livré, commandes des 14 derniers jours, produits les plus vendus (commandes vitrine) et performance par membre de l'équipe (visible propriétaire/admin ; colonne `orders.handled_by`). API : `GET /api/analytics/sales?days=`.

