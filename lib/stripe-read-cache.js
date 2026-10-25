// One webhook delivery fetches the same charge from the classifier and from
// each handler. Cache charge, PaymentIntent, and invoice retrieves for that
// delivery. A later update of the same id drops the cache entry.

function isMissing(err) {
  return Boolean(err) && (err.statusCode === 404 || err.status === 404 || err.code === 'resource_missing');
}

function wrapResource(resource, group, hits) {
  if (!resource || typeof resource.retrieve !== 'function') return resource;

  function drop(id) {
    const prefix = `${group}:${id}:`;
    for (const key of hits.keys()) {
      if (key.startsWith(prefix)) hits.delete(key);
    }
  }

  return new Proxy(resource, {
    get(target, prop, receiver) {
      if (prop === 'retrieve') {
        return async (id, ...args) => {
          const cacheable = args.length === 0 && (typeof id === 'string' || typeof id === 'number');
          const key = `${group}:${id}:`;
          if (cacheable && hits.has(key)) {
            const hit = hits.get(key);
            if (hit.error) throw hit.error;
            return hit.value;
          }
          try {
            const value = await target.retrieve.call(target, id, ...args);
            if (cacheable) hits.set(key, { value });
            return value;
          } catch (err) {
            if (cacheable && isMissing(err)) hits.set(key, { error: err });
            throw err;
          }
        };
      }
      if (prop === 'update' || prop === 'cancel') {
        const original = target[prop];
        if (typeof original !== 'function') return original;
        return async (id, ...args) => {
          const value = await original.call(target, id, ...args);
          drop(id);
          return value;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  });
}

function withStripeReadCache(stripe) {
  if (!stripe || typeof stripe !== 'object') return stripe;
  const hits = new Map();
  const wrapped = new Map();
  return new Proxy(stripe, {
    get(target, prop, receiver) {
      if (prop === 'charges' || prop === 'paymentIntents' || prop === 'invoices') {
        if (!wrapped.has(prop)) wrapped.set(prop, wrapResource(target[prop], prop, hits));
        return wrapped.get(prop);
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  });
}

module.exports = { withStripeReadCache };
