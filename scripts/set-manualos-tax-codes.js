#!/usr/bin/env node
// Set the Managed Payments tax code on ManualOS products.
//
// Dry-run is the default. This process prints the tax_code change and does
// not write. Pass --apply to update. The update body is only { tax_code }.
// metadata.brand and price lookup_key are read to find products and are not
// written back.
//
//   node scripts/set-manualos-tax-codes.js
//   node scripts/set-manualos-tax-codes.js --apply
//
// Matches a product when metadata.brand is manualos, when a price lookup_key
// starts with "manualos", or when the price id is one of the ManualOS price
// env vars. The live Starter and Pro products have no brand and no lookup_key,
// so a run finds them only when STRIPE_PRICE_STARTER and STRIPE_PRICE_PRO are
// set (Integrator prices: MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY, _ANNUAL,
// and _OVERAGE). A product is refused, and not written, when its brand is set
// to anything other than manualos (including htsatlas) or when any of its
// prices has a lookup_key that starts with htsatlas_. Do not point this at
// live mode until the dry-run output is what you expect. This file does not
// print STRIPE_SECRET_KEY.

const Stripe = require('stripe');
const { MANUALOS_PRODUCT_TAX_CODE } = require('../lib/managedPayments');

const PRICE_ENV_KEYS = [
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_PRO',
  'MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY',
  'MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL',
  'MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE',
];

const USAGE = `Usage: node scripts/set-manualos-tax-codes.js [--apply]

Dry-run is the default and does not write. --apply sets tax_code to ${MANUALOS_PRODUCT_TAX_CODE} on matched ManualOS products. metadata and lookup_key are not modified.`;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function taxCodeId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.id === 'string') return value.id;
  return null;
}

function productIdOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.id === 'string') return value.id;
  return '';
}

function brandOf(product) {
  if (!isRecord(product) || !isRecord(product.metadata)) return '';
  const brand = product.metadata.brand;
  return brand == null ? '' : String(brand).trim();
}

function isManualosBrand(product) {
  return brandOf(product).toLowerCase() === 'manualos';
}

function lookupKeyOf(price) {
  const key = price && price.lookup_key;
  return typeof key === 'string' ? key.trim() : '';
}

function isManualosLookup(price) {
  return lookupKeyOf(price).toLowerCase().startsWith('manualos');
}

function isHtsLookup(price) {
  return lookupKeyOf(price).toLowerCase().startsWith('htsatlas_');
}

function refusalReasons(row, htsProductIds) {
  const reasons = [];
  const brand = (row.brand || '').trim().toLowerCase();
  if (brand && brand !== 'manualos') reasons.push(`brand ${row.brand} is not manualos`);
  const htsKeys = (row.lookupKeys || []).filter((key) => String(key).trim().toLowerCase().startsWith('htsatlas_'));
  if (htsProductIds.has(row.id) || htsKeys.length) reasons.push('lookup_key starts with htsatlas_');
  return reasons;
}

function isNotFound(err) {
  if (!err) return false;
  return err.statusCode === 404 || err.code === 'resource_missing';
}

function redact(text, env) {
  let out = String(text == null ? '' : text);
  const key = env && env.STRIPE_SECRET_KEY;
  const secret = key == null ? '' : String(key).trim();
  if (secret) out = out.split(secret).join('[redacted]');
  return out;
}

async function listAll(listFn) {
  const items = [];
  let startingAfter = '';
  for (;;) {
    const query = { limit: 100 };
    if (startingAfter) query.starting_after = startingAfter;
    const page = await listFn(query);
    const data = page && Array.isArray(page.data) ? page.data : [];
    items.push(...data);
    if (!page || !page.has_more || data.length === 0) break;
    const last = data[data.length - 1];
    if (!last || !last.id || last.id === startingAfter) break;
    startingAfter = last.id;
  }
  return items;
}

function blankRow(id) {
  return {
    id,
    name: '',
    tax_code: undefined,
    brand: '',
    livemode: false,
    lookupKeys: [],
    reasons: [],
  };
}

function note(row, reason, lookupKeys) {
  if (reason && !row.reasons.includes(reason)) row.reasons.push(reason);
  for (const key of lookupKeys || []) {
    if (key && !row.lookupKeys.includes(key)) row.lookupKeys.push(key);
  }
}

function absorb(rows, product, reason, lookupKeys) {
  const id = productIdOf(product);
  if (!id) return;
  const row = rows.get(id) || blankRow(id);
  if (product && typeof product.name === 'string' && product.name) row.name = product.name;
  if (product && Object.hasOwn(product, 'livemode')) row.livemode = Boolean(product.livemode);
  const brand = brandOf(product);
  if (brand) row.brand = brand;
  if (product && Object.hasOwn(product, 'tax_code')) row.tax_code = taxCodeId(product.tax_code);
  note(row, reason, lookupKeys);
  rows.set(id, row);
}

async function loadProduct(stripe, rows, id, reason, lookupKeys) {
  if (!id) return;
  if (rows.has(id) && rows.get(id).tax_code !== undefined && reason === 'list') return;
  try {
    const product = await stripe.products.retrieve(id);
    absorb(rows, product, reason, lookupKeys);
  } catch (err) {
    if (isNotFound(err)) {
      absorb(rows, { id, tax_code: null }, reason, lookupKeys);
      return;
    }
    throw err;
  }
}

async function collectManualosProducts(stripe, env) {
  const source = env && typeof env === 'object' ? env : {};
  const rows = new Map();
  const notes = [];
  const products = await listAll((query) => stripe.products.list(query));
  for (const product of products) {
    if (isManualosBrand(product)) absorb(rows, product, 'metadata.brand=manualos', []);
  }

  const prices = await listAll((query) => stripe.prices.list(query));
  const htsProductIds = new Set();
  for (const price of prices) {
    if (!isHtsLookup(price)) continue;
    const id = productIdOf(price.product);
    if (id) htsProductIds.add(id);
  }
  for (const price of prices) {
    if (!isManualosLookup(price)) continue;
    const id = productIdOf(price.product);
    const lookup = String(price.lookup_key).trim();
    if (rows.has(id)) note(rows.get(id), `lookup_key ${lookup}`, [lookup]);
    else await loadProduct(stripe, rows, id, `lookup_key ${lookup}`, [lookup]);
  }

  for (const key of PRICE_ENV_KEYS) {
    const priceId = source[key] == null ? '' : String(source[key]).trim();
    if (!priceId) continue;
    let price;
    try {
      price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    } catch (err) {
      if (isNotFound(err)) {
        notes.push(`${key} did not match a price`);
        continue;
      }
      throw err;
    }
    const lookup = typeof price.lookup_key === 'string' ? price.lookup_key.trim() : '';
    const lookups = lookup ? [lookup] : [];
    const expanded = isRecord(price.product) ? price.product : null;
    const id = productIdOf(price.product);
    if (expanded) absorb(rows, expanded, key, lookups);
    else await loadProduct(stripe, rows, id, key, lookups);
  }

  const planned = [];
  const refused = [];
  for (const row of rows.values()) {
    const current = row.tax_code === undefined ? null : row.tax_code;
    const record = {
      id: row.id,
      name: row.name,
      brand: row.brand,
      livemode: row.livemode,
      lookupKeys: row.lookupKeys.slice(),
      reasons: row.reasons.slice(),
      from: current,
      to: MANUALOS_PRODUCT_TAX_CODE,
    };
    const blocked = refusalReasons(row, htsProductIds);
    if (blocked.length) {
      refused.push({ ...record, action: 'refused', reasons: blocked });
      continue;
    }
    planned.push({
      ...record,
      action: current === MANUALOS_PRODUCT_TAX_CODE ? 'unchanged' : 'update',
    });
  }
  planned.sort((a, b) => a.id.localeCompare(b.id));
  refused.sort((a, b) => a.id.localeCompare(b.id));
  return { planned, notes, refused };
}

function formatTaxCodeReport(result, options) {
  const apply = Boolean(options && options.apply);
  const lines = [
    apply
      ? `apply: writing tax_code ${MANUALOS_PRODUCT_TAX_CODE} where it differs`
      : `dry-run: no products will be updated (tax_code ${MANUALOS_PRODUCT_TAX_CODE})`,
  ];
  const planned = result && Array.isArray(result.planned) ? result.planned : [];
  const refused = result && Array.isArray(result.refused) ? result.refused : [];
  if (!planned.length && !refused.length) lines.push('No ManualOS products matched.');
  for (const row of planned) {
    const brand = row.brand ? `brand=${row.brand}` : 'brand=(none)';
    const lookups = row.lookupKeys && row.lookupKeys.length ? row.lookupKeys.join(',') : '(none)';
    const from = row.from == null || row.from === '' ? '(none)' : row.from;
    const verb = row.action === 'unchanged' ? 'unchanged' : (apply ? 'set' : 'would set');
    lines.push(
      `${row.id}  ${row.name || '(unnamed)'}  ${brand}  lookup_keys=${lookups}  livemode=${row.livemode ? 'true' : 'false'}  ${verb} ${from} -> ${row.to}  matched=${row.reasons.join(', ')}`
    );
  }
  for (const row of refused) {
    const brand = row.brand ? `brand=${row.brand}` : 'brand=(none)';
    const lookups = row.lookupKeys && row.lookupKeys.length ? row.lookupKeys.join(',') : '(none)';
    lines.push(
      `refused ${row.id}  ${row.name || '(unnamed)'}  ${brand}  lookup_keys=${lookups}  livemode=${row.livemode ? 'true' : 'false'}  not updated  ${row.reasons.join('; ')}`
    );
  }
  for (const note of (result && result.notes) || []) lines.push(`note: ${note}`);
  lines.push('metadata and lookup_key are not modified.');
  lines.push('Live Starter and Pro products are found only through STRIPE_PRICE_STARTER and STRIPE_PRICE_PRO. Integrator products are found through MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY, MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL, and MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE.');
  return lines.join('\n');
}

async function applyTaxCodePlan(stripe, planned, apply) {
  const wrote = [];
  if (!apply) return wrote;
  for (const row of planned || []) {
    if (row.action !== 'update') continue;
    await stripe.products.update(row.id, { tax_code: MANUALOS_PRODUCT_TAX_CODE });
    wrote.push(row.id);
  }
  return wrote;
}

function createClient(env) {
  const key = env && env.STRIPE_SECRET_KEY;
  const secret = key == null ? '' : String(key).trim();
  if (!secret) {
    const err = new Error('STRIPE_SECRET_KEY is not set');
    err.expose = true;
    throw err;
  }
  return new Stripe(secret);
}

async function main(argv, env, stripe) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes('--help') || args.includes('-h')) {
    return { code: 0, report: USAGE, wrote: [] };
  }
  const apply = args.includes('--apply');
  const client = stripe || createClient(env);
  const collected = await collectManualosProducts(client, env);
  const wrote = await applyTaxCodePlan(client, collected.planned, apply);
  return { code: 0, report: formatTaxCodeReport(collected, { apply }), wrote };
}

async function runCli() {
  try {
    const result = await main(process.argv.slice(2), process.env);
    console.log(result.report);
    process.exit(result.code);
  } catch (err) {
    const message = err && err.expose ? err.message : redact(err && err.message ? err.message : err, process.env);
    console.error(message);
    process.exit(1);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  PRICE_ENV_KEYS,
  MANUALOS_PRODUCT_TAX_CODE,
  collectManualosProducts,
  formatTaxCodeReport,
  applyTaxCodePlan,
  main,
  redact,
};
