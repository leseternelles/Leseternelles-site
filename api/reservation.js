// Fonction serveur Vercel : réservation du spectacle « Magie de Noël ».
//   POST /api/reservation  : vérifie la demande, recalcule le prix, crée le paiement SumUp et renvoie l'adresse de la page de paiement.
//   GET  /api/reservation?ref=... : état d'une réservation (pour la page de retour après paiement).
// Les données de carte ne passent jamais par ce site : le client les saisit sur la page sécurisée de SumUp.
// Réglages Vercel (Settings > Environment Variables) : SUMUP_API_KEY, SUMUP_MERCHANT_CODE. Facultatifs : SITE_URL, SALES_OPEN=false pour fermer les ventes.

const { clean, oneLine, EMAIL_RE, SHOW, salesOpen, newReference, REF_RE, SITE, sumup, euro, basketText } = require('./_lib');

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
  if (!REF_RE.test(ref)) return res.status(400).json({ ok: false, error: 'ref' });
  try {
    const r = await sumup(`/v0.1/checkouts?checkout_reference=${encodeURIComponent(ref)}`);
    if (!r.ok) {
      console.error('SumUp a refusé la lecture du paiement :', r.status, JSON.stringify(r.body).slice(0, 300));
      return res.status(r.status === 404 ? 404 : 502).json({ ok: false, error: r.status === 404 ? 'unknown' : 'sumup' });
    }
    const list = Array.isArray(r.body) ? r.body : [];
    const c = list.find((x) => x && x.checkout_reference === ref) || list[0];
    if (!c) return res.status(404).json({ ok: false, error: 'unknown' });
    const parts = String(c.description || '').split(' | ');
    return res.status(200).json({ ok: true, status: c.status || 'PENDING', amount: c.amount, basket: parts[1] || '' });
  } catch (e) {
    console.error('Lecture du paiement impossible :', e && e.message);
    return res.status(502).json({ ok: false, error: 'sumup' });
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

  const merchant = process.env.SUMUP_MERCHANT_CODE;
  if (!merchant || !process.env.SUMUP_API_KEY) return res.status(503).json({ ok: false, error: 'not_configured' });

  // Le prix est recalculé ici : celui affiché dans la page n'est qu'indicatif.
  const cents = a * SHOW.priceAdult + k * SHOW.priceChild;
  const ref = newReference();
  const site = SITE();
  const back = `${site}${lang === 'en' ? '/en' : ''}/reservation-noel/?ref=${ref}`;
  // Format lu par le webhook : « titre | panier | Nom Prénom | e-mail | téléphone »
  const description = [
    `${SHOW.title} 20/12/2026`,
    basketText(a, k, s, lang),
    `${d.last.toUpperCase()} ${d.first}`,
    d.email,
    d.phone,
  ].join(' | ');

  try {
    const r = await sumup('/v0.1/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        checkout_reference: ref,
        amount: Math.round(cents) / 100,
        currency: 'EUR',
        merchant_code: merchant,
        description,
        redirect_url: back,
        return_url: `${site}/api/sumup-webhook`,
        hosted_checkout: { enabled: true },
      }),
    });
    const url = r.body && r.body.hosted_checkout_url;
    if (!r.ok || !url) {
      console.error('SumUp a refusé la création du paiement :', r.status, JSON.stringify(r.body).slice(0, 300));
      return res.status(502).json({ ok: false, error: 'sumup' });
    }
    return res.status(200).json({ ok: true, url, ref, total: euro(cents) });
  } catch (e) {
    console.error('Création du paiement impossible :', e && e.message);
    return res.status(502).json({ ok: false, error: 'sumup' });
  }
};
