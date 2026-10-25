const WWW_ORIGIN = 'https://www.manualos.com';
const APEX_ORIGIN = 'https://manualos.com';

// Claude Haiku 5.5: current cheapest Haiku, released October 7, 2026.
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_STARTER_CREDITS = 3;

// Stable Checkout labels. Each suffix is 8 random letters so Dashboard
// comparisons can tell the flows apart (API 2026-03-25.dahlia+).
const INTEGRATION_IDS = {
  starter: 'manualos_starter_kwnqxpdl',
  pro: 'manualos_pro_mhtbvcln',
  integrator_month: 'manualos_integrator_month_bvkqnwpl',
  integrator_year: 'manualos_integrator_year_hxqpdmct',
  integrator_overage: 'manualos_integrator_overage_rlnwvkqb',
};

// Included manuals per month. Unused manuals do not roll over.
const INTEGRATOR_MONTHLY_CREDITS = 25;
// One extra manual, charged only when the customer starts Checkout.
const INTEGRATOR_OVERAGE_AMOUNT_CENTS = 900;
const LOGO_MAX_BYTES = 256 * 1024;

function frontendBase(env) {
  return String(env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
}

function frontendOrigin(env) {
  const base = frontendBase(env);
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function allowedOrigins(env) {
  const origins = new Set([WWW_ORIGIN, APEX_ORIGIN]);
  const origin = frontendOrigin(env);
  if (origin) origins.add(origin);
  return origins;
}

function frontendConfigProblem(env) {
  const raw = env.FRONTEND_URL;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return 'FRONTEND_URL is not set';
  }
  if (!frontendOrigin(env)) return 'FRONTEND_URL is not a valid http(s) URL';
  return null;
}

function isProduction(env) {
  return env.NODE_ENV === 'production' || env.RAILWAY_ENVIRONMENT === 'production';
}

function starterCreditAllowance(env) {
  const raw = env.STARTER_CREDITS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_STARTER_CREDITS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_STARTER_CREDITS;
  return n;
}

function anthropicModel(env) {
  const model = env.ANTHROPIC_MODEL && String(env.ANTHROPIC_MODEL).trim();
  return model || DEFAULT_MODEL;
}

module.exports = {
  WWW_ORIGIN,
  APEX_ORIGIN,
  DEFAULT_MODEL,
  INTEGRATION_IDS,
  INTEGRATOR_MONTHLY_CREDITS,
  INTEGRATOR_OVERAGE_AMOUNT_CENTS,
  LOGO_MAX_BYTES,
  frontendBase,
  frontendOrigin,
  allowedOrigins,
  frontendConfigProblem,
  isProduction,
  starterCreditAllowance,
  anthropicModel,
};
