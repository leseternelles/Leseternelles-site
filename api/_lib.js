// Outils communs aux fonctions de réservation (le préfixe « _ » évite que Vercel en fasse une adresse publique).

const nodemailer = require('nodemailer');

const clean = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
const oneLine = (v, max) => clean(v, max).replace(/[\n\t|]+/g, ' ').trim();
const EMAIL_RE = /^[^\s@<>"',;:|]+@[^\s@<>"',;:|]+\.[^\s@<>"',;:|]{2,}$/;

// Spectacle « Magie de Noël » : tarifs en centimes, jamais envoyés par la page (le serveur recalcule tout).
const SHOW = {
  code: 'NOEL2026',
  title: 'Magie de Noël',
  dateFr: 'dimanche 20 décembre 2026 à 16 h',
  dateEn: 'Sunday 20 December 2026 at 4 pm',
  // Ventes fermées à partir de ce moment (heure de Paris, 15 h le jour du spectacle)
  closesAt: Date.parse('2026-12-20T15:00:00+01:00'),
  priceAdult: 1500,
  priceChild: 1000,
  maxPerPerson: 20,
  maxSeats: 40, // par réservation
  // Jauge totale du spectacle : 300 places
  cap: { a: 150, k: 100, s: 50 },
  holdMinutes: 30, // places gardées le temps de payer
};

function salesOpen() {
  if (String(process.env.SALES_OPEN || '').toLowerCase() === 'false') return false;
  return Date.now() < SHOW.closesAt;
}

function newReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = require('crypto').randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${SHOW.code}-${s}`;
}
const REF_RE = /^NOEL2026-[A-HJ-NP-Z2-9]{10}$/;

const SITE = () => String(process.env.SITE_URL || 'https://leseternelles.com').replace(/\/+$/, '');

async function sumup(path, options) {
  const key = process.env.SUMUP_API_KEY;
  if (!key) { const e = new Error('SUMUP_API_KEY manquante'); e.code = 'not_configured'; throw e; }
  const r = await fetch(`https://api.sumup.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...((options && options.headers) || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch (e) { body = null; }
  return { status: r.status, ok: r.ok, body };
}

function transporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    user,
    t: nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.ionos.fr', port, secure: port === 465, auth: { user, pass } }),
  };
}

const euro = (cents) => (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }) + ' €';

// Texte d'un panier : « 2 adultes, 1 enfant (5 à 12 ans), 1 enfant de moins de 5 ans »
function basketText(a, k, s, lang) {
  const en = lang === 'en';
  const parts = [];
  if (a) parts.push(en ? `${a} adult${a > 1 ? 's' : ''}` : `${a} adulte${a > 1 ? 's' : ''}`);
  if (k) parts.push(en ? `${k} child${k > 1 ? 'ren' : ''} (5 to 12)` : `${k} enfant${k > 1 ? 's' : ''} (5 à 12 ans)`);
  if (s) parts.push(en ? `${s} under 5 (free)` : `${s} enfant${s > 1 ? 's' : ''} de moins de 5 ans (gratuit)`);
  return parts.join(', ');
}

module.exports = { clean, oneLine, EMAIL_RE, SHOW, salesOpen, newReference, REF_RE, SITE, sumup, transporter, euro, basketText };
