// Settings storage (site/settings.js) and the JSON Schemas in
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
const backupSchema = schema('backup');

/** Just enough JSON Schema for these two files: errors as strings, [] = valid. */
function validate(s, value, root = s, path = '$') {
  if (s.$ref?.endsWith('.schema.json')) {
    const other = schema(s.$ref.replace('.schema.json', ''));
    return validate(other, value, other, path);
  }
  if (s.$ref) return validate(root.$defs[s.$ref.replace('#/$defs/', '')], value, root, path);
  const errors = [];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if ('const' in s && value !== s.const) errors.push(`${path}: expected ${s.const}`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${s.enum}`);
  const types = s.type === undefined ? [] : [].concat(s.type);
  const typeOk = (t) => (t === 'integer' ? Number.isInteger(value) : t === type);
  if (types.length && !types.some(typeOk)) errors.push(`${path}: not ${types.join(' or ')}`);
  if (typeof value === 'number' && s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below ${s.minimum}`);
  if (typeof value === 'number' && s.maximum !== undefined && value > s.maximum) errors.push(`${path}: above ${s.maximum}`);
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
    for (const [key, field] of Object.entries(looks.FIELDS)) {
      if (Array.isArray(field)) {
        assert.deepEqual(lookProps[key].enum, field, key);
      } else {
        assert.deepEqual([lookProps[key].minimum, lookProps[key].maximum], [field.min, field.max], key);
        assert.deepEqual([].concat(lookProps[key].type), field.empty ? ['integer', 'null'] : ['integer'], key);
      }
    }
  });

  test('saved looks match looks.schema.json', () => {
    const items = new Map();
    const storage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
    looks.save(storage, '200108369', { ...settingsLib.DEFAULTS, frame: 'gold', textCol: 'start', contrast: -20, zoom: 150, focusX: 4000 });
    assert.deepEqual(validate(looksSchema, JSON.parse(items.get('nw-looks'))), []);
  });

  test('a backup matches backup.schema.json', () => {
    const backup = {
      backup: 1,
      settings: settingsLib.toStored({ ...settingsLib.DEFAULTS, frame: 'wood' }),
      looks: looks.toStored({ 200108369: looks.encode({ ...settingsLib.DEFAULTS, frame: 'gold' }) }),
    };
    assert.deepEqual(validate(backupSchema, backup), []);
    assert.notDeepEqual(validate(backupSchema, { ...backup, backup: 2 }), []);
  });
});
