import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSchema, newCounters, asParametersObject } from '../src/jsonschema.ts';
import type { JsonSchema } from '../src/types.ts';

const norm = (s: JsonSchema, root: JsonSchema = s) => {
  const c = newCounters();
  return { out: normaliseSchema(s, root, c, { maxDepth: 12 }), c };
};

test('a local $ref is inlined and counted', () => {
  const root: JsonSchema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/A' } },
    $defs: { A: { type: 'string', description: 'from the def' } },
  };
  const { out, c } = norm(root);
  assert.deepEqual(out.properties!.a, { type: 'string', description: 'from the def' });
  assert.equal(c.refsResolved, 1);
});

test('a sibling of a $ref wins over the target, because it is local to the use site', () => {
  const root: JsonSchema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/A', description: 'local wins' } },
    $defs: { A: { type: 'string', description: 'from the def' } },
  };
  const { out } = norm(root);
  assert.equal((out.properties!.a as JsonSchema).description, 'local wins');
  assert.equal((out.properties!.a as JsonSchema).type, 'string');
});

test('legacy "definitions" resolves as well as "$defs"', () => {
  const root: JsonSchema = {
    type: 'object',
    properties: { a: { $ref: '#/definitions/A' } },
    definitions: { A: { type: 'number' } },
  };
  assert.equal((norm(root).out.properties!.a as JsonSchema).type, 'number');
});

test('an escaped JSON Pointer segment resolves', () => {
  const root: JsonSchema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/with~1slash' } },
    $defs: { 'with/slash': { type: 'boolean' } },
  };
  assert.equal((norm(root).out.properties!.a as JsonSchema).type, 'boolean');
});

test('allOf members are merged and counted', () => {
  const s: JsonSchema = {
    allOf: [
      { type: 'object', properties: { a: { type: 'string', description: 'a' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'number', description: 'b' } }, required: ['b'] },
    ],
  };
  const { out, c } = norm(s);
  assert.deepEqual(Object.keys(out.properties!), ['a', 'b']);
  assert.deepEqual(out.required!.sort(), ['a', 'b']);
  assert.equal(c.allOfFlattened, 2);
  assert.ok(!('allOf' in out));
});

test('an earlier allOf member keeps its description against a later one', () => {
  const s: JsonSchema = {
    allOf: [{ type: 'string', description: 'first' }, { type: 'string', description: 'second' }],
  };
  assert.equal(norm(s).out.description, 'first');
});

test('the Pydantic optional anyOf:[T,null] becomes T', () => {
  const s: JsonSchema = {
    type: 'object',
    properties: {
      a: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null, description: 'opt' },
    },
  };
  const { out, c } = norm(s);
  assert.deepEqual(out.properties!.a, { type: 'string', description: 'opt' });
  assert.equal(c.nullableUnwrapped, 1);
});

test('a real default survives the unwrap; only null is dropped', () => {
  const s: JsonSchema = {
    type: 'object',
    properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }], default: 'keep me' } },
  };
  assert.equal((norm(s).out.properties!.a as JsonSchema).default, 'keep me');
});

test('a same-type union merges and unions its enums', () => {
  const s: JsonSchema = {
    anyOf: [
      { type: 'string', enum: ['a', 'b'] },
      { type: 'string', enum: ['b', 'c'] },
    ],
  };
  const { out, c } = norm(s);
  assert.equal(out.type, 'string');
  assert.deepEqual((out.enum as string[]).sort(), ['a', 'b', 'c']);
  assert.equal(c.unionsCollapsed, 1);
});

test('a mixed-type union collapses to one shape and says so in the description', () => {
  const s: JsonSchema = {
    anyOf: [{ type: 'object', properties: { x: { type: 'string' } } }, { type: 'string' }],
  };
  const { out, c } = norm(s);
  assert.equal(out.type, 'object');
  assert.match(out.description!, /Accepts object or string; send object\./);
  assert.equal(c.unionsCollapsed, 1);
  assert.ok(c.warnings.some((w) => /mixed-type union/.test(w)));
});

test('oneOf is treated like anyOf', () => {
  const s: JsonSchema = { oneOf: [{ type: 'string' }, { type: 'null' }] };
  const { out, c } = norm(s);
  assert.equal(out.type, 'string');
  assert.equal(c.nullableUnwrapped, 1);
});

test('a union of nothing but null is not left unfillable', () => {
  const { out, c } = norm({ anyOf: [{ type: 'null' }] });
  assert.equal(out.type, 'string');
  assert.ok(c.warnings.some((w) => /only null branches/.test(w)));
});

test('a nullable $ref resolves through both layers', () => {
  const root: JsonSchema = {
    type: 'object',
    properties: { a: { anyOf: [{ $ref: '#/$defs/A' }, { type: 'null' }], default: null } },
    $defs: { A: { type: 'object', properties: { inner: { type: 'string' } } } },
  };
  const { out, c } = norm(root);
  const a = out.properties!.a as JsonSchema;
  assert.equal(a.type, 'object');
  assert.ok(a.properties!.inner);
  assert.equal(c.refsResolved, 1);
  assert.equal(c.nullableUnwrapped, 1);
});

test('noise keywords are pruned and useful ones kept', () => {
  const s: JsonSchema = {
    type: 'object',
    title: 'ArgumentsModel',
    $schema: 'http://json-schema.org/draft-07/schema#',
    additionalProperties: false,
    properties: {
      a: {
        type: 'string', title: 'A', description: 'keep', enum: ['x'], format: 'email',
        examples: ['a@b.c'], pattern: '.+', minLength: 1, maxLength: 9, default: 'x',
      },
    },
    required: ['a'],
  };
  const { out } = norm(s);
  assert.deepEqual(Object.keys(out).sort(), ['properties', 'required', 'type']);
  assert.deepEqual(
    Object.keys(out.properties!.a as JsonSchema).sort(),
    ['default', 'description', 'enum', 'examples', 'format', 'maxLength', 'minLength', 'pattern', 'type'],
  );
});

test('an unknown keyword is dropped rather than forwarded', () => {
  const { out } = norm({ type: 'object', properties: { a: { type: 'string', 'x-vendor': 'nope' } as JsonSchema } });
  assert.ok(!('x-vendor' in (out.properties!.a as JsonSchema)));
});

test('required entries naming absent properties are dropped with a warning', () => {
  const { out, c } = norm({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'ghost'] });
  assert.deepEqual(out.required, ['a']);
  assert.ok(c.warnings.some((w) => /absent properties/.test(w)));
});

test('array items recurse, and a tuple is reduced with a warning', () => {
  const { out } = norm({ type: 'object', properties: { xs: { type: 'array', items: { $ref: '#/$defs/A' } } }, $defs: { A: { type: 'string' } } });
  assert.equal(((out.properties!.xs as JsonSchema).items as JsonSchema).type, 'string');

  const { out: t, c } = norm({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] });
  assert.equal((t.items as JsonSchema).type, 'string');
  assert.ok(c.warnings.some((w) => /tuple-form/.test(w)));
});

test('depth is bounded, so a pathological schema cannot hang the request', () => {
  let deep: JsonSchema = { type: 'string' };
  for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { n: deep } };
  const c = newCounters();
  const out = normaliseSchema(deep, deep, c, { maxDepth: 5 });
  assert.ok(c.warnings.some((w) => /deeper than 5/.test(w)));
  assert.ok(JSON.stringify(out).length < 1000);
});

test('asParametersObject always yields the shape the API requires', () => {
  assert.deepEqual(asParametersObject({}), { type: 'object', properties: {} });
  assert.deepEqual(asParametersObject({ type: 'string' }), { type: 'object', properties: {} });
  assert.deepEqual(
    asParametersObject({ properties: { a: { type: 'string' } }, required: ['a'] }),
    { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
  );
  assert.ok(!('required' in asParametersObject({ properties: {}, required: [] })));
});

test('the input schema is never mutated', () => {
  const input: JsonSchema = { type: 'object', title: 'keep me', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] } } };
  const before = JSON.stringify(input);
  norm(input);
  assert.equal(JSON.stringify(input), before, 'converting must not alter the caller-owned schema');
});
