# Les Éternelles — site web

## Réservation en ligne du spectacle « Magie de Noël »

Pages : `reservation-noel/` (FR) et `en/reservation-noel/` (EN). Le visiteur choisit adultes, enfants de 5 à 12 ans et moins de 5 ans, saisit ses coordonnées, puis est envoyé sur la page de paiement hébergée par Stripe (Checkout). Les données de carte ne passent jamais par ce site.

Fonctions serveur (dossier `api/`) :
- `reservation.js` : recalcule le prix côté serveur (adulte 15 €, enfant 10 €, moins de 5 ans gratuit, 40 places au maximum par réservation), crée la session Stripe Checkout (valable 31 minutes), et renvoie l'état d'un paiement à la page de retour.
- `stripe-webhook.js` : appelée par Stripe ; vérifie la signature et, si le paiement est « paid », envoie un e-mail à events@ et une confirmation au client.
- `_lib.js` : tarifs, date de fermeture des ventes, appels à l'API Stripe, vérification de signature et outils communs.

Réglages à saisir dans Vercel (Settings > Environment Variables, environnement Production), puis redéployer :
- `STRIPE_SECRET_KEY` : clé secrète Stripe (Développeurs > Clés API ; `sk_test_...` pour essayer, `sk_live_...` pour de vrais paiements).
- `STRIPE_WEBHOOK_SECRET` : secret de signature du webhook (`whsec_...`). Dans Stripe : Développeurs > Webhooks > Ajouter un endpoint `https://leseternelles.com/api/stripe-webhook`, événements `checkout.session.completed` et `checkout.session.async_payment_succeeded`.
- `SMTP_USER`, `SMTP_PASS` : déjà utilisés par le formulaire de contact.
- Facultatifs : `SITE_URL` (défaut https://leseternelles.com), `SALES_OPEN=false` pour fermer les ventes à tout moment.

Le mode test et le mode réel de Stripe ont chacun leurs clés et leur webhook : en passant au réel, remplacer les deux réglages.

Les ventes se ferment seules le dimanche 20 décembre 2026 à 15 h. Pour changer les tarifs ou la date, modifier `api/_lib.js` et les deux pages.
