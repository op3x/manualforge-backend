// Same ceilings as the inputs on manualos.com/upload.html.
const FIELD_LIMITS = {
  brand: 200,
  manufacturer_name: 200,
  manufacturer_address: 200,
  product_name: 200,
  model: 200,
  doc_number: 80,
  revision: 40,
  language: 80,
  date: 40,
};

const FILE_LIMIT = 25;

function overLengthField(body) {
  const source = body && typeof body === 'object' ? body : {};
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    if (typeof source[key] === 'string' && source[key].length > max) return { field: key, max };
  }
  return null;
}

module.exports = { FIELD_LIMITS, FILE_LIMIT, overLengthField };
