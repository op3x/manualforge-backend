const { XMLParser } = require('fast-xml-parser');
const { exposed } = require('../errors');
const { decodeXmlEntities } = require('../text');

const ARRAY_TAGS = new Set([
  'Program', 'Routine', 'Rung', 'Tag', 'Module', 'Task', 'Line',
  'pou', 'variable', 'rung', 'network', 'body', 'POU',
  'Sheet', 'Step', 'Transition', 'Stop', 'Block', 'IRef', 'ORef', 'TextBox',
  'AddOnInstructionDefinition', 'Parameter', 'Member',
  'Action', 'Method', 'step', 'transition', 'action', 'block',
  'inVariable', 'outVariable',
]);

function assertNoDtd(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw exposed(422, 'This XML file declares a DOCTYPE or entity and was rejected. Export the project again without a DTD.');
  }
}

function parseXml(xml) {
  assertNoDtd(xml);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
    processEntities: false,
    htmlEntities: false,
    trimValues: true,
    cdataPropName: '__cdata',
    removeNSPrefix: true,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  try {
    return parser.parse(xml);
  } catch (err) {
    throw exposed(400, 'This XML file could not be parsed. Check that it is a complete export.');
  }
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function child(node, name) {
  if (!node || typeof node !== 'object') return [];
  return asArray(node[name]);
}

function attr(node, name) {
  if (!node || typeof node !== 'object') return '';
  const value = node[`@_${name}`];
  return value == null ? '' : decodeXmlEntities(String(value));
}

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return decodeXmlEntities(String(node));
  }
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join('\n');
  if (typeof node !== 'object') return '';
  if (typeof node.__cdata === 'string') return decodeXmlEntities(node.__cdata);
  if (typeof node['#text'] === 'string') return decodeXmlEntities(node['#text']);
  const parts = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    const text = textOf(value);
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

module.exports = { assertNoDtd, parseXml, asArray, child, attr, textOf };
