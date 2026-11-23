# Les Éternelles — site web

## Réservation en ligne du spectacle « Magie de Noël »

Pages : `reservation-noel/` (FR) et `en/reservation-noel/` (EN). Le visiteur choisit adultes, enfants de 5 à 12 ans et moins de 5 ans, saisit ses coordonnées, puis est envoyé sur la page de paiement SumUp (Hosted Checkout). Les données de carte ne passent jamais par ce site.

Fonctions serveur (dossier `api/`) :
- `reservation.js` : recalcule le prix côté serveur (adulte 15 €, enfant 10 €, moins de 5 ans gratuit), crée le paiement SumUp, et renvoie l'état d'un paiement à la page de retour.
- `sumup-webhook.js` : appelée par SumUp ; relit le paiement chez SumUp et, s'il est payé, envoie un e-mail à events@ et une confirmation au client.
- `_lib.js` : tarifs, jauge (150 adultes, 100 enfants de 5 à 12 ans, 50 moins de 5 ans), date de fermeture des ventes et outils communs.
- `_seats.js` : compteur de places dans une base Redis (Upstash).

Réglages à saisir dans Vercel (Settings > Environment Variables), puis redéployer :
- `SUMUP_API_KEY` : clé secrète SumUp (Developers > API keys).
- `SUMUP_MERCHANT_CODE` : code marchand SumUp (commence par « M »).
- `SMTP_USER`, `SMTP_PASS` : déjà utilisés par le formulaire de contact.
- Jauge : dans Vercel, onglet Storage, créer une base « Upstash for Redis » (offre gratuite) et la connecter au projet : Vercel ajoute seul `KV_REST_API_URL` et `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`). Sans cette base, la jauge n'est pas contrôlée.
- Facultatifs : `SITE_URL` (défaut https://leseternelles.com), `SALES_OPEN=false` pour fermer les ventes à tout moment.

Les ventes se ferment seules le dimanche 20 décembre 2026 à 15 h. Pour changer les tarifs ou la date, modifier `api/_lib.js` et les deux pages.

Fonctionnement de la jauge : quand un client lance son paiement, ses places sont gardées 30 minutes (le paiement SumUp expire au même moment). Si le paiement aboutit, elles sont comptées définitivement ; sinon elles sont libérées toutes seules. Un enfant ne peut être réservé qu'avec au moins un adulte. Pour changer la jauge, modifier `cap` dans `api/_lib.js`.
