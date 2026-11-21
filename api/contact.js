// Fonction serveur Vercel : reçoit le formulaire (FR / EN) et envoie un e-mail à events@leseternelles.com.
// Réglages à saisir dans Vercel (Settings > Environment Variables) : SMTP_USER, SMTP_PASS
// Facultatifs : SMTP_HOST (défaut smtp.ionos.fr), SMTP_PORT (défaut 465), MAIL_TO (défaut events@leseternelles.com)

const nodemailer = require('nodemailer');

const MAX = { first: 80, last: 80, phone: 40, email: 160, subject: 200, message: 5000 };
const hits = new Map(); // limite par adresse IP (meilleur effort, remis à zéro à chaque démarrage)

const clean = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
const oneLine = (v, max) => clean(v, max).replace(/[\n\t]+/g, ' ');
const EMAIL_RE = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]{2,}$/;

function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 5) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 2000) hits.clear();
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};

  const lang = b.lang === 'en' ? 'en' : 'fr';

  // Anti-spam : champ piège rempli, ou formulaire envoyé en moins de 2,5 secondes
  const elapsed = Number(b.elapsed || 0);
  if (clean(b.website, 200) || elapsed < 2500) {
    return res.status(200).json({ ok: true }); // on fait comme si, sans rien envoyer
  }

  const d = {
    first: oneLine(b.first, MAX.first),
    last: oneLine(b.last, MAX.last),
    phone: oneLine(b.phone, MAX.phone),
    email: oneLine(b.email, MAX.email),
    subject: oneLine(b.subject, MAX.subject),
    message: clean(b.message, MAX.message),
  };

  const errors = [];
  if (!d.first) errors.push('first');
  if (!d.last) errors.push('last');
  if (!EMAIL_RE.test(d.email)) errors.push('email');
  if (!d.subject) errors.push('subject');
  if (d.message.length < 3) errors.push('message');
  if (b.consent !== true) errors.push('consent');
  if (d.phone && !/^[0-9+().\-\s]{6,40}$/.test(d.phone)) errors.push('phone');
  if (errors.length) return res.status(400).json({ ok: false, error: 'invalid', fields: errors });

  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '').trim();
  if (tooMany(ip)) return res.status(429).json({ ok: false, error: 'rate' });

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return res.status(503).json({ ok: false, error: 'not_configured' });

  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.ionos.fr',
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const to = process.env.MAIL_TO || 'events@leseternelles.com';
  const text = [
    `Nouvelle demande reçue depuis le site leseternelles.com (${lang === 'en' ? 'version anglaise' : 'version française'})`,
    '',
    `Sujet : ${d.subject}`,
    `Prénom : ${d.first}`,
    `Nom : ${d.last}`,
    `Téléphone : ${d.phone || 'non renseigné'}`,
    `E-mail : ${d.email}`,
    '',
    'Message :',
    d.message,
    '',
    '—',
    'Pour répondre, utilisez simplement « Répondre » : la réponse part vers l\'adresse du visiteur.',
  ].join('\n');

  try {
    await transporter.sendMail({
      from: `"Site Les Éternelles" <${user}>`,
      to,
      replyTo: `"${d.first.replace(/["\\]/g, '')} ${d.last.replace(/["\\]/g, '')}" <${d.email}>`,
      subject: `[Site] ${d.subject}`,
      text,
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Envoi impossible :', e && e.code, e && e.message);
    return res.status(502).json({ ok: false, error: 'send' });
  }
};
