const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MANUALOS_PRODUCT_TAX_CODE,
  collectManualosProducts,
  formatTaxCodeReport,
  applyTaxCodePlan,
  main,
} = require('../scripts/set-manualos-tax-codes');

function notFound(id) {
  const err = new Error(`No such price: ${id}`);
  err.statusCode = 404;
  err.code = 'resource_missing';
  return err;
}

function memoryStripe(seed) {
  const products = new Map(seed.products.map((product) => [product.id, {
    ...product,
    metadata: { ...(product.metadata || {}) },
  }]));
  const prices = seed.prices.map((price) => ({ ...price }));
  const updates = [];

  function page(items, query) {
    const start = query && query.starting_after;
    const index = start ? items.findIndex((item) => item.id === start) + 1 : 0;
    const slice = items.slice(index, index + 1);
    return { data: slice, has_more: index + 1 < items.length };
  }

  return {
    updates,
    products: {
      async list(query) {
        return page([...products.values()], query);
      },
      async retrieve(id) {
        const product = products.get(id);
        if (!product) throw notFound(id);
        return { ...product, metadata: { ...product.metadata } };
      },
      async update(id, body) {
        updates.push({ id, body });
        const product = products.get(id);
        const next = { ...product, tax_code: body.tax_code, metadata: product.metadata };
        products.set(id, next);
        return { ...next, metadata: { ...next.metadata } };
      },
    },
    prices: {
      async list(query) {
        return page(prices, query);
      },
      async retrieve(id) {
        const price = prices.find((item) => item.id === id);
        if (!price) throw notFound(id);
        const product = products.get(price.product);
        return {
          ...price,
          product: product ? { ...product, metadata: { ...product.metadata } } : price.product,
        };
      },
    },
    snapshot() {
      return {
        products: [...products.values()].map((product) => ({
          id: product.id,
          tax_code: product.tax_code,
          metadata: { ...product.metadata },
        })),
        prices: prices.map((price) => ({ id: price.id, lookup_key: price.lookup_key, product: price.product })),
      };
    },
  };
}

function catalog() {
  return memoryStripe({
    products: [
      { id: 'prod_starter', name: 'ManualOS Starter', tax_code: null, livemode: false, metadata: { brand: 'manualos' } },
      { id: 'prod_pro', name: 'ManualOS Pro', tax_code: 'txcd_10103001', livemode: false, metadata: { brand: 'manualos' } },
      { id: 'prod_int', name: 'ManualOS Integrator', tax_code: 'txcd_99999999', livemode: false, metadata: { brand: 'ManualOS' } },
      { id: 'prod_extra', name: 'ManualOS extra manual', tax_code: null, livemode: false, metadata: {} },
      { id: 'prod_other', name: 'HTS Atlas', tax_code: null, livemode: false, metadata: { brand: 'htsatlas' } },
    ],
    prices: [
      { id: 'price_starter', product: 'prod_starter', lookup_key: 'manualos_starter' },
      { id: 'price_pro', product: 'prod_pro', lookup_key: 'manualos_pro_monthly' },
      { id: 'price_int', product: 'prod_int', lookup_key: 'manualos_integrator_monthly' },
      { id: 'price_extra', product: 'prod_extra', lookup_key: 'manualos_integrator_overage' },
      { id: 'price_other', product: 'prod_other', lookup_key: 'htsatlas_single_user_monthly' },
    ],
  });
}

const env = {
  STRIPE_SECRET_KEY: 'sk_test_not_a_live_secret',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
  MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY: 'price_int',
  MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: 'price_extra',
};

test('dry-run lists ManualOS tax code changes and does not write', async () => {
  const stripe = catalog();
  const before = stripe.snapshot();
  const collected = await collectManualosProducts(stripe, env);
  const report = formatTaxCodeReport(collected, { apply: false });
  assert.equal(report.includes('sk_test_not_a_live_secret'), false);
  assert.match(report, /dry-run: no products will be updated/);
  assert.match(report, /prod_starter.*would set \(none\) -> txcd_10103001/);
  assert.match(report, /lookup_keys=manualos_starter/);
  assert.match(report, /brand=manualos/);
  assert.match(report, /prod_pro.*unchanged txcd_10103001 -> txcd_10103001/);
  assert.match(report, /prod_int.*would set txcd_99999999 -> txcd_10103001/);
  assert.match(report, /prod_extra.*would set \(none\) -> txcd_10103001/);
  assert.equal(report.includes('prod_other'), false);
  assert.equal(report.includes('htsatlas'), false);
  assert.match(report, /metadata and lookup_key are not modified/);
  const wrote = await applyTaxCodePlan(stripe, collected.planned, false);
  assert.deepEqual(wrote, []);
  assert.deepEqual(stripe.updates, []);
  assert.deepEqual(stripe.snapshot(), before);
  assert.equal(MANUALOS_PRODUCT_TAX_CODE, 'txcd_10103001');
});

test('apply sets only tax_code and a second run is unchanged', async () => {
  const stripe = catalog();
  const first = await main(['--apply'], env, stripe);
  assert.equal(first.report.includes('sk_test_not_a_live_secret'), false);
  assert.match(first.report, /apply: writing tax_code txcd_10103001/);
  assert.deepEqual(first.wrote.sort(), ['prod_extra', 'prod_int', 'prod_starter']);
  for (const call of stripe.updates) {
    assert.deepEqual(Object.keys(call.body), ['tax_code']);
    assert.equal(call.body.tax_code, 'txcd_10103001');
  }
  const after = stripe.snapshot();
  assert.equal(after.products.find((product) => product.id === 'prod_starter').metadata.brand, 'manualos');
  assert.equal(after.products.find((product) => product.id === 'prod_int').metadata.brand, 'ManualOS');
  assert.equal(after.products.find((product) => product.id === 'prod_extra').metadata.brand, undefined);
  assert.equal(after.prices.find((price) => price.id === 'price_starter').lookup_key, 'manualos_starter');
  assert.equal(after.prices.find((price) => price.id === 'price_pro').lookup_key, 'manualos_pro_monthly');
  assert.equal(after.products.find((product) => product.id === 'prod_other').tax_code, null);

  stripe.updates.length = 0;
  const second = await main(['--apply'], env, stripe);
  assert.equal(stripe.updates.length, 0);
  assert.deepEqual(second.wrote, []);
  assert.match(second.report, /prod_starter.*unchanged txcd_10103001 -> txcd_10103001/);
  assert.match(second.report, /prod_int.*unchanged txcd_10103001 -> txcd_10103001/);
});

test('a missing price is a note and an unrelated brand is ignored', async () => {
  const stripe = catalog();
  const collected = await collectManualosProducts(stripe, {
    STRIPE_PRICE_STARTER: 'price_missing',
    STRIPE_PRICE_PRO: '',
  });
  assert.deepEqual(collected.notes, ['STRIPE_PRICE_STARTER did not match a price']);
  const ids = collected.planned.map((row) => row.id).sort();
  assert.deepEqual(ids, ['prod_extra', 'prod_int', 'prod_pro', 'prod_starter']);
  const report = formatTaxCodeReport(collected, { apply: false });
  assert.match(report, /note: STRIPE_PRICE_STARTER did not match a price/);
  assert.equal(report.includes('price_missing'), false);
});

test('HTS Atlas products and non-manualos brands are refused', async () => {
  const stripe = memoryStripe({
    products: [
      { id: 'prod_starter', name: 'ManualOS Starter', tax_code: null, livemode: true, metadata: {} },
      { id: 'prod_hts', name: 'HTS Atlas', tax_code: null, livemode: true, metadata: { brand: 'HTSAtlas' } },
      { id: 'prod_other', name: 'Other brand', tax_code: null, livemode: false, metadata: { brand: 'WidgetCo' } },
      { id: 'prod_mixed', name: 'Mixed', tax_code: null, livemode: false, metadata: { brand: 'manualos' } },
    ],
    prices: [
      { id: 'price_starter', product: 'prod_starter', lookup_key: null },
      { id: 'price_hts', product: 'prod_hts', lookup_key: 'htsatlas_single_user_monthly' },
      { id: 'price_hts_case', product: 'prod_hts', lookup_key: 'HTSATLAS_annual' },
      { id: 'price_other', product: 'prod_other', lookup_key: null },
      { id: 'price_mixed', product: 'prod_mixed', lookup_key: 'manualos_mixed' },
      { id: 'price_mixed_hts', product: 'prod_mixed', lookup_key: 'htsatlas_mixed' },
    ],
  });
  const result = await main(['--apply'], {
    STRIPE_SECRET_KEY: 'sk_test_not_a_live_secret',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_hts',
    MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY: 'price_other',
  }, stripe);
  assert.deepEqual(result.wrote, ['prod_starter']);
  assert.equal(result.report.includes('sk_test_not_a_live_secret'), false);
  assert.match(result.report, /refused prod_hts/);
  assert.match(result.report, /brand HTSAtlas is not manualos/);
  assert.match(result.report, /lookup_key starts with htsatlas_/);
  assert.match(result.report, /refused prod_other/);
  assert.match(result.report, /brand WidgetCo is not manualos/);
  assert.match(result.report, /refused prod_mixed/);
  assert.match(result.report, /Live Starter and Pro products are found only through STRIPE_PRICE_STARTER and STRIPE_PRICE_PRO/);
  const after = stripe.snapshot();
  assert.equal(after.products.find((product) => product.id === 'prod_starter').tax_code, 'txcd_10103001');
  assert.equal(after.products.find((product) => product.id === 'prod_hts').tax_code, null);
  assert.equal(after.products.find((product) => product.id === 'prod_other').tax_code, null);
  assert.equal(after.products.find((product) => product.id === 'prod_mixed').tax_code, null);
  assert.equal(after.products.find((product) => product.id === 'prod_hts').metadata.brand, 'HTSAtlas');
  assert.equal(after.prices.find((price) => price.id === 'price_hts').lookup_key, 'htsatlas_single_user_monthly');
  for (const call of stripe.updates) assert.notEqual(call.id, 'prod_hts');
});

test('help text does not require a key', async () => {
  const result = await main(['--help'], {}, null);
  assert.equal(result.code, 0);
  assert.match(result.report, /Dry-run is the default/);
  assert.equal(result.report.includes('sk_'), false);
});
