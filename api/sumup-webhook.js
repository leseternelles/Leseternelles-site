// Fonction serveur Vercel : appelée par SumUp quand l'état d'un paiement change.
// On ne fait jamais confiance au contenu reçu : on relit le paiement chez SumUp, et seulement s'il est « PAID »
// on envoie deux e-mails : un à Les Éternelles (events@), un de confirmation au client.

const { SHOW, REF_RE, sumup, transporter, clean, euro, EMAIL_RE } = require('./_lib');
const seats = require('./_seats');

const done = new Set(); // évite les doublons si SumUp rappelle (meilleur effort)

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  // Deux formats possibles : { id: <paiement> } ou { id: <événement>, payload: { checkout_id: <paiement> } }
  const id = clean((b.payload && b.payload.checkout_id) || b.id, 80);
  if (!/^[0-9a-fA-F-]{20,60}$/.test(id)) return res.status(200).end(); // rien d'exploitable : on répond 2xx pour éviter les relances

  let c;
  try {
    const r = await sumup(`/v0.1/checkouts/${encodeURIComponent(id)}`);
    if (!r.ok) return res.status(r.status >= 500 ? 502 : 200).end();
    c = r.body;
  } catch (e) {
    console.error('Lecture du paiement impossible :', e && e.message);
    return res.status(502).end(); // SumUp réessaiera plus tard
  }

  if (!c || c.status !== 'PAID' || !REF_RE.test(String(c.checkout_reference || ''))) return res.status(200).end();
  if (process.env.SUMUP_MERCHANT_CODE && c.merchant_code && c.merchant_code !== process.env.SUMUP_MERCHANT_CODE) return res.status(200).end();
  if (done.has(c.id)) return res.status(200).end();

  const [title, basket, name, email, phone, counts] = String(c.description || '').split(' | ');
  const m = /^A(\d+) K(\d+) S(\d+)$/.exec(counts || '');
  const [na, nk, ns] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];

  // Jauge : on compte définitivement les places (une seule fois par réservation)
  if (seats.enabled() && m) {
    try { await seats.markPaid(String(c.checkout_reference), na, nk, ns); }
    catch (e) { console.error('Compteur de places indisponible :', e && e.message); return res.status(502).end(); }
  }
  // E-mails : une seule fois par réservation, même si SumUp rappelle
  let mailFlag = false;
  if (seats.enabled()) {
    try { if (!(await seats.once(`mailed:${c.checkout_reference}`))) { done.add(c.id); return res.status(200).end(); } mailFlag = true; }
    catch (e) { console.error('Drapeau e-mail indisponible :', e && e.message); }
  }
  const total = euro(Math.round(Number(c.amount || 0) * 100));
  const code = String(c.checkout_reference);
  const tp = transporter();
  if (!tp) { console.error('Réglages e-mail manquants'); return res.status(503).end(); }
  const to = process.env.MAIL_TO || 'events@leseternelles.com';

  const internal = [
    `Réservation payée : ${title || SHOW.title}`,
    '',
    `Référence : ${code}`,
    `Personnes : ${basket || 'à vérifier dans SumUp'}`,
    `Montant payé : ${total}`,
    `Nom : ${name || ''}`,
    `Téléphone : ${phone || 'non renseigné'}`,
    `E-mail : ${email || 'non renseigné'}`,
    '',
    'Paiement vérifié auprès de SumUp.',
  ].join('\n');

  const customer = [
    `Bonjour,`,
    '',
    `Merci, votre réservation pour le spectacle « ${SHOW.title} » est confirmée et payée.`,
    '',
    `Quand : ${SHOW.dateFr}`,
    `Où : Les Éternelles, Saint-Nizier-le-Bouchoux (Ain)`,
    `Places : ${basket || ''}`,
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
  if (!ok) { if (mailFlag) await seats.forget(`mailed:${c.checkout_reference}`).catch(() => {}); return res.status(502).end(); } // aucun e-mail parti : SumUp réessaiera
  done.add(c.id);
  if (done.size > 500) done.clear();
  return res.status(200).end();
};
