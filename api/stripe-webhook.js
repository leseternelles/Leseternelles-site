// Fonction serveur Vercel : appelée par Stripe quand un paiement est terminé.
// La signature de Stripe est vérifiée (réglage STRIPE_WEBHOOK_SECRET). Si le paiement est bien « paid »,
// on envoie deux e-mails : un à Les Éternelles (events@), un de confirmation au client.

const { SHOW, REF_RE, stripeSignatureOk, transporter, euro, EMAIL_RE } = require('./_lib');

const done = new Set(); // évite les doublons si Stripe rappelle (meilleur effort)

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

const handler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) { console.error('STRIPE_WEBHOOK_SECRET manquant'); return res.status(503).end(); }

  let raw = '';
  try { raw = await rawBody(req); } catch (e) { return res.status(400).end(); }
  if (!stripeSignatureOk(raw, req.headers['stripe-signature'], secret)) {
    console.error('Signature Stripe non valide');
    return res.status(400).end();
  }

  let ev;
  try { ev = JSON.parse(raw); } catch (e) { return res.status(400).end(); }
  if (!ev || (ev.type !== 'checkout.session.completed' && ev.type !== 'checkout.session.async_payment_succeeded')) return res.status(200).end();

  const c = (ev.data && ev.data.object) || {};
  if (c.payment_status !== 'paid') return res.status(200).end(); // paiement différé : on attend l'événement « async_payment_succeeded »
  if (!REF_RE.test(String(c.client_reference_id || ''))) return res.status(200).end(); // pas une réservation de ce site
  if (done.has(c.id)) return res.status(200).end();

  const m = c.metadata || {};
  const email = String((c.customer_details && c.customer_details.email) || c.customer_email || m.email || '');
  const basket = m.basket || '';
  const name = m.name || '';
  const phone = m.phone || '';
  const total = euro(Math.round(Number(c.amount_total || 0)));
  const code = String(c.client_reference_id);
  const tp = transporter();
  if (!tp) { console.error('Réglages e-mail manquants'); return res.status(503).end(); }
  const to = process.env.MAIL_TO || 'events@leseternelles.com';

  const internal = [
    `Réservation payée : ${m.title || SHOW.title}`,
    '',
    `Référence : ${code}`,
    `Personnes : ${basket || 'à vérifier dans Stripe'}`,
    `Montant payé : ${total}`,
    `Nom : ${name}`,
    `Téléphone : ${phone || 'non renseigné'}`,
    `E-mail : ${email || 'non renseigné'}`,
    '',
    'Paiement confirmé par Stripe.',
  ].join('\n');

  const customer = [
    `Bonjour,`,
    '',
    `Merci, votre réservation pour le spectacle « ${SHOW.title} » est confirmée et payée.`,
    '',
    `Quand : ${SHOW.dateFr}`,
    `Où : Les Éternelles, Saint-Nizier-le-Bouchoux (Ain)`,
    `Places : ${basket}`,
    `Montant payé : ${total}`,
    `Référence : ${code}`,
    '',
    `Présentez ce message (ou donnez votre nom) à l'entrée.`,
    `Une question ? Répondez à ce message ou appelez le 06 42 78 70 81.`,
    '',
    `À bientôt,`,
    `Les Éternelles`,
    '',
    '—',
    `Hello, your booking for “${SHOW.title}” (${SHOW.dateEn}) is confirmed and paid. Reference: ${code}. Please show this message at the entrance.`,
  ].join('\n');

  const jobs = [tp.t.sendMail({ from: `"Site Les Éternelles" <${tp.user}>`, to, subject: `[Site] Réservation payée : ${basket || SHOW.title} (${total})`, text: internal, ...(email && EMAIL_RE.test(email) ? { replyTo: email } : {}) })];
  if (email && EMAIL_RE.test(email)) {
    jobs.push(tp.t.sendMail({ from: `"Les Éternelles" <${tp.user}>`, to: email, replyTo: to, subject: `Votre réservation : ${SHOW.title}, 20 décembre 2026`, text: customer }));
  }
  const results = await Promise.allSettled(jobs);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  results.forEach((r) => { if (r.status === 'rejected') console.error('Envoi impossible :', r.reason && r.reason.code, r.reason && r.reason.message); });
  if (!ok) return res.status(502).end(); // aucun e-mail parti : Stripe réessaiera
  done.add(c.id);
  if (done.size > 500) done.clear();
  return res.status(200).end();
};

handler.config = { api: { bodyParser: false } }; // Stripe signe le texte brut : on ne laisse pas Vercel le transformer
module.exports = handler;
