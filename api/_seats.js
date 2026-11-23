// Compteur de places du spectacle, stocké dans une base Redis (Upstash, via Vercel Storage).
// Si la base n'est pas branchée (variables absentes), la jauge n'est pas contrôlée : seule la limite par réservation s'applique.
// Principe : une réservation « garde » ses places pendant 30 minutes le temps de payer ; une fois payée, elles sont comptées définitivement ;
// si le paiement n'aboutit pas, les places sont libérées toutes seules. Tout se passe dans un script Redis, donc sans risque de double vente.

const { SHOW } = require('./_lib');

const URL_ = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const enabled = () => !!(URL_() && TOKEN());

const K_HOLDS = `${SHOW.code.toLowerCase()}:holds`; // ensemble trié : « REF|a|k|s » avec l'heure d'expiration
const K_PAID = `${SHOW.code.toLowerCase()}:paid`;   // compteur : places payées (a, k, s)

async function cmd(args) {
  const r = await fetch(URL_(), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = new Error(j.error || `Redis ${r.status}`); e.code = 'redis'; throw e; }
  return j.result;
}

// Calcule les places restantes ; si ARGV[3] vaut 1, réserve aussi a/k/s pour la référence donnée.
const LUA = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local ua = tonumber(redis.call('HGET', KEYS[2], 'a') or '0')
local uk = tonumber(redis.call('HGET', KEYS[2], 'k') or '0')
local us = tonumber(redis.call('HGET', KEYS[2], 's') or '0')
for _, m in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  local x, y, z = string.match(m, '^[^|]+|(%d+)|(%d+)|(%d+)$')
  if x then ua = ua + tonumber(x); uk = uk + tonumber(y); us = us + tonumber(z) end
end
local ra = tonumber(ARGV[4]) - ua
local rk = tonumber(ARGV[5]) - uk
local rs = tonumber(ARGV[6]) - us
if ARGV[3] == '1' then
  local a, k, s = tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9])
  if a > ra or k > rk or s > rs then return {0, ra, rk, rs} end
  redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[10] .. '|' .. a .. '|' .. k .. '|' .. s)
  return {1, ra - a, rk - k, rs - s}
end
return {1, ra, rk, rs}
`;

const norm = (r) => ({ ok: r[0] === 1, left: { a: Math.max(0, r[1]), k: Math.max(0, r[2]), s: Math.max(0, r[3]) } });

// Places restantes (sans rien réserver)
async function left() {
  const c = SHOW.cap;
  return norm(await cmd(['EVAL', LUA, '2', K_HOLDS, K_PAID, String(Date.now()), '0', '0', String(c.a), String(c.k), String(c.s), '0', '0', '0', '-']));
}

// Garde a/k/s places pour la référence, jusqu'à expiration. ok=false si la jauge est atteinte.
async function hold(ref, a, k, s) {
  const c = SHOW.cap;
  const expires = Date.now() + SHOW.holdMinutes * 60 * 1000;
  return norm(await cmd(['EVAL', LUA, '2', K_HOLDS, K_PAID, String(Date.now()), String(expires), '1', String(c.a), String(c.k), String(c.s), String(a), String(k), String(s), ref]));
}

// Libère la garde d'une réservation (paiement refusé ou création du paiement en échec)
async function release(ref, a, k, s) {
  return cmd(['ZREM', K_HOLDS, `${ref}|${a}|${k}|${s}`]);
}

// Paiement confirmé : compte définitivement les places, une seule fois par référence (SumUp peut rappeler).
const LUA_PAID = `
if redis.call('SET', KEYS[3], '1', 'NX', 'EX', 31536000) then
  redis.call('HINCRBY', KEYS[2], 'a', tonumber(ARGV[2]))
  redis.call('HINCRBY', KEYS[2], 'k', tonumber(ARGV[3]))
  redis.call('HINCRBY', KEYS[2], 's', tonumber(ARGV[4]))
  redis.call('ZREM', KEYS[1], ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3] .. '|' .. ARGV[4])
  return 1
end
return 0
`;
async function markPaid(ref, a, k, s) {
  return (await cmd(['EVAL', LUA_PAID, '3', K_HOLDS, K_PAID, `${SHOW.code.toLowerCase()}:counted:${ref}`, ref, String(a), String(k), String(s)])) === 1;
}

// Pose un drapeau une seule fois (ex. « e-mail déjà envoyé »). Renvoie true si c'est la première fois.
async function once(name) { return (await cmd(['SET', `${SHOW.code.toLowerCase()}:${name}`, '1', 'NX', 'EX', '31536000'])) === 'OK'; }
async function forget(name) { return cmd(['DEL', `${SHOW.code.toLowerCase()}:${name}`]); }

module.exports = { enabled, left, hold, release, markPaid, once, forget };
