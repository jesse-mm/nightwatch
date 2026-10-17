// Settings storage (server/static/config/settings.js) and the JSON Schemas in
// docs/schema, which must stay in step with the code.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const settingsLib = require('../src/pkjs/settings.js');
const looks = require('../src/pkjs/looks.js');

const schema = (name) => JSON.parse(readFileSync(new URL(`../../docs/schema/${name}.schema.json`, import.meta.url)));
const settingsSchema = schema('settings');
const looksSchema = schema('looks');

/** Just enough JSON Schema for these two files: errors as strings, [] = valid. */
function validate(s, value, root = s, path = '$') {
  if (s.$ref) return validate(root.$defs[s.$ref.replace('#/$defs/', '')], value, root, path);
  const errors = [];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if ('const' in s && value !== s.const) errors.push(`${path}: expected ${s.const}`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${s.enum}`);
  if (s.type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: not an integer`);
  else if (s.type && s.type !== 'integer' && s.type !== type) errors.push(`${path}: not ${s.type}`);
  if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below ${s.minimum}`);
  if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: above ${s.maximum}`);
  if (type === 'object') {
    for (const key of s.required || []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (s.propertyNames?.pattern && !new RegExp(s.propertyNames.pattern).test(key)) errors.push(`${path}: bad key ${key}`);
      if (s.properties?.[key]) errors.push(...validate(s.properties[key], v, root, `${path}.${key}`));
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
      else if (typeof s.additionalProperties === 'object') errors.push(...validate(s.additionalProperties, v, root, `${path}.${key}`));
    }
  }
  return errors;
}

describe('settings', () => {
  test('fills defaults and drops unknown settings', () => {
    assert.deepEqual(settingsLib.load(null), settingsLib.DEFAULTS);
    const s = settingsLib.load({ version: 1, frame: 'gold', sparkle: true });
    assert.equal(s.frame, 'gold');
    assert.equal('sparkle' in s, false);
    assert.equal('version' in s, false);
  });

  test('migrates settings saved before versioning', () => {
    assert.equal(settingsLib.load({ textCol: 'left' }).textCol, 'start');
    assert.equal(settingsLib.load({ textCol: 'right' }).textCol, 'end');
    assert.equal(settingsLib.load({ version: 1, textCol: 'center' }).textCol, 'center');
  });

  test('stores the current version', () => {
    assert.equal(settingsLib.toStored({}).version, settingsLib.VERSION);
  });
});

describe('schemas', () => {
  test('stored settings match settings.schema.json', () => {
    assert.deepEqual(validate(settingsSchema, settingsLib.toStored(settingsLib.DEFAULTS)), []);
    assert.deepEqual(validate(settingsSchema, settingsLib.toStored({ ...settingsLib.DEFAULTS, textCol: 'end', brightness: 40 })), []);
    assert.notDeepEqual(validate(settingsSchema, settingsLib.toStored({ ...settingsLib.DEFAULTS, frame: 'velvet' })), []);
  });

  test('settings.schema.json lists every setting with its default', () => {
    const props = settingsSchema.properties;
    assert.equal(props.version.const, settingsLib.VERSION);
    assert.deepEqual(Object.keys(props).filter((k) => k !== 'version').sort(), Object.keys(settingsLib.DEFAULTS).sort());
    for (const [key, value] of Object.entries(settingsLib.DEFAULTS)) assert.equal(props[key].default, value, key);
  });

  test('looks.schema.json matches looks.js', () => {
    assert.equal(looksSchema.properties.version.const, looks.VERSION);
    const lookProps = looksSchema.$defs.look.properties;
    assert.deepEqual(Object.keys(lookProps), looks.KEYS);
    for (const [key, allowed] of Object.entries(looks.FIELDS)) {
      if (allowed) assert.deepEqual(lookProps[key].enum, allowed, key);
      else assert.equal(lookProps[key].type, 'integer', key);
    }
  });

  test('saved looks match looks.schema.json', () => {
    const items = new Map();
    const storage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
    looks.save(storage, '200108369', { ...settingsLib.DEFAULTS, frame: 'gold', textCol: 'start', contrast: -20 });
    assert.deepEqual(validate(looksSchema, JSON.parse(items.get('tt-looks'))), []);
  });
});
