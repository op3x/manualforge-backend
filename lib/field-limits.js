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

// A repeated multipart field arrives as an array. Use the first string so the
// value is length-checked and kept. Anything else in that array is not text.
function readTextFields(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const fields = {};
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    if (!Object.hasOwn(source, key)) continue;
    const raw = source[key];
    let value = raw;
    if (Array.isArray(raw)) {
      if (typeof raw[0] !== 'string') return { error: { field: key, code: 'invalid_field' } };
      value = raw[0];
    } else if (typeof raw !== 'string') {
      continue;
    }
    if (value.length > max) return { error: { field: key, code: 'field_too_long', max } };
    fields[key] = value;
  }
  return { fields };
}

function overLengthField(body) {
  const read = readTextFields(body);
  if (read.error && read.error.code === 'field_too_long') return { field: read.error.field, max: read.error.max };
  return null;
}

module.exports = { FIELD_LIMITS, FILE_LIMIT, overLengthField, readTextFields };
