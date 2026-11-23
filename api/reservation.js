// Fonction serveur Vercel : réservation du spectacle « Magie de Noël ».
//   POST /api/reservation  : vérifie la demande, recalcule le prix, crée la page de paiement Stripe Checkout et renvoie son adresse.
//   GET  /api/reservation?ref=...&sid=... : état d'une réservation (pour la page de retour après paiement).
// Les données de carte ne passent jamais par ce site : le client les saisit sur la page sécurisée de Stripe.
// Réglages Vercel (Settings > Environment Variables) : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. Facultatifs : SITE_URL, SALES_OPEN=false pour fermer les ventes.

const { clean, oneLine, EMAIL_RE, SHOW, salesOpen, newReference, REF_RE, SITE, stripe, euro, basketText } = require('./_lib');

const SID_RE = /^cs_(test|live)_[A-Za-z0-9]{10,250}$/;

const hits = new Map(); // limite par adresse IP (meilleur effort, remis à zéro à chaque démarrage)
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 6) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 2000) hits.clear();
  return false;
}

const count = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= SHOW.maxPerPerson ? n : null;
};

async function status(req, res) {
  const ref = clean(req.query && req.query.ref, 40);
  const sid = clean(req.query && req.query.sid, 300);
  if (!REF_RE.test(ref)) return res.status(400).json({ ok: false, error: 'ref' });
  if (!SID_RE.test(sid)) return res.status(404).json({ ok: false, error: 'unknown' });
  try {
    const r = await stripe(`/v1/checkout/sessions/${encodeURIComponent(sid)}`);
    if (r.status === 404) return res.status(404).json({ ok: false, error: 'unknown' });
    if (!r.ok) {
      console.error('Stripe a refusé la lecture du paiement :', r.status, JSON.stringify(r.body && r.body.error ? { type: r.body.error.type, code: r.body.error.code, message: r.body.error.message } : r.body).slice(0, 300));
      return res.status(502).json({ ok: false, error: 'stripe' });
    }
    const c = r.body || {};
    if (c.client_reference_id !== ref) return res.status(404).json({ ok: false, error: 'unknown' });
    const st = c.payment_status === 'paid' ? 'PAID' : c.status === 'expired' ? 'EXPIRED' : 'PENDING';
    return res.status(200).json({ ok: true, status: st, amount: (Number(c.amount_total) || 0) / 100, basket: (c.metadata && c.metadata.basket) || '' });
  } catch (e) {
    console.error('Lecture du paiement impossible :', e && e.message);
    return res.status(502).json({ ok: false, error: 'stripe' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return status(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const lang = b.lang === 'en' ? 'en' : 'fr';

  // Anti-spam : champ piège rempli, ou formulaire envoyé en moins de 2,5 secondes
  if (clean(b.website, 200) || Number(b.elapsed || 0) < 2500) {
    return res.status(200).json({ ok: false, error: 'spam' });
  }

  if (!salesOpen()) return res.status(409).json({ ok: false, error: 'closed' });

  const d = {
    first: oneLine(b.first, 60),
    last: oneLine(b.last, 60),
    phone: oneLine(b.phone, 30),
    email: oneLine(b.email, 120),
  };
  const a = count(b.adults), k = count(b.kids), s = count(b.small);

  const errors = [];
  if (!d.first) errors.push('first');
  if (!d.last) errors.push('last');
  if (!EMAIL_RE.test(d.email)) errors.push('email');
  if (!d.phone || !/^[0-9+().\-\s]{6,30}$/.test(d.phone)) errors.push('phone');
  if (a === null || k === null || s === null) errors.push('people');
  else if (a < 1 || a + k + s > SHOW.maxSeats) errors.push('people');
  if (b.consent !== true) errors.push('consent');
  if (errors.length) return res.status(400).json({ ok: false, error: 'invalid', fields: errors });

  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '').trim();
  if (tooMany(ip)) return res.status(429).json({ ok: false, error: 'rate' });

  if (!String(process.env.STRIPE_SECRET_KEY || '').trim()) return res.status(503).json({ ok: false, error: 'not_configured' });

  // Le prix est recalculé ici : celui affiché dans la page n'est qu'indicatif.
  const cents = a * SHOW.priceAdult + k * SHOW.priceChild;
  const ref = newReference();
  const site = SITE();
  const base = `${site}${lang === 'en' ? '/en' : ''}/reservation-noel/`;
  const basket = basketText(a, k, s, lang);
  const name = `${d.last.toUpperCase()} ${d.first}`;

  const lines = [{
    quantity: a,
    price_data: { currency: 'eur', unit_amount: SHOW.priceAdult, product_data: { name: lang === 'en' ? `${SHOW.title} · Adult` : `${SHOW.title} · Adulte`, description: lang === 'en' ? SHOW.dateEn : SHOW.dateFr } },
  }];
  if (k) lines.push({
    quantity: k,
    price_data: { currency: 'eur', unit_amount: SHOW.priceChild, product_data: { name: lang === 'en' ? `${SHOW.title} · Child (5 to 12)` : `${SHOW.title} · Enfant (5 à 12 ans)`, description: lang === 'en' ? SHOW.dateEn : SHOW.dateFr } },
  });

  try {
    const r = await stripe('/v1/checkout/sessions', {
      method: 'POST',
      data: {
        mode: 'payment',
        client_reference_id: ref,
        customer_email: d.email,
        locale: lang,
        success_url: `${base}?ref=${ref}&sid={CHECKOUT_SESSION_ID}`,
        cancel_url: base,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        line_items: lines,
        payment_intent_data: { description: `${SHOW.title} 20/12/2026 | ${basket} | ${name}` },
        metadata: { ref, title: SHOW.title, basket, name, email: d.email, phone: d.phone, a, k, s, lang },
      },
    });
    const url = r.body && r.body.url;
    if (!r.ok || !url) {
      console.error('Stripe a refusé la création du paiement :', r.status, JSON.stringify(r.body && r.body.error ? { type: r.body.error.type, code: r.body.error.code, param: r.body.error.param, message: r.body.error.message } : r.body).slice(0, 400));
      return res.status(502).json({ ok: false, error: 'stripe' });
    }
    return res.status(200).json({ ok: true, url, ref, total: euro(cents) });
  } catch (e) {
    console.error('Création du paiement impossible :', e && e.message);
    return res.status(502).json({ ok: false, error: 'stripe' });
  }
};
