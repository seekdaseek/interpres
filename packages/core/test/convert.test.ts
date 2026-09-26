import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertCatalog, convertTool, sanitiseName, truncate, humanise, buildNameMap, NAME_MAX } from '../src/convert.ts';
import { assertPhaseValid, initialPhase } from '../src/phases.ts';
import type { McpTool } from '../src/types.ts';
import { allFixtures, loadFixture } from './fixtures.ts';

// ------------------------------------------------------------ real servers

test('the fixtures are real captures, not hand-written', () => {
  const fx = allFixtures();
  assert.ok(fx.length >= 3, `expected at least 3 fixtures, found ${fx.length}`);
  for (const f of fx) {
    assert.match(f.captured.url, /^https:\/\//, `${f.name} must record the URL it came from`);
    assert.ok(Date.parse(f.captured.at) > 0, `${f.name} must record when it was captured`);
    assert.ok(f.tools.length > 0, `${f.name} must carry tools`);
  }
});


/**
 * The keywords used anywhere in a schema. Property names are not keywords: a
 * tool whose argument is called "title" (a book's title) is fine, so a string
 * search for "title" in the JSON would be a false alarm.
 */
function schemaKeywords(schema: unknown, out: Set<string>): Set<string> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return out;
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    out.add(k);
    if ((k === 'properties' || k === '$defs' || k === 'definitions' || k === 'patternProperties') && v && typeof v === 'object') {
      for (const sub of Object.values(v as Record<string, unknown>)) schemaKeywords(sub, out);
    } else if ((k === 'allOf' || k === 'anyOf' || k === 'oneOf' || k === 'prefixItems') && Array.isArray(v)) {
      for (const sub of v) schemaKeywords(sub, out);
    } else if (k === 'items' || k === 'additionalProperties' || k === 'not' || k === 'contains' || k === 'if' || k === 'then' || k === 'else') {
      schemaKeywords(v, out);
    }
  }
  return out;
}

for (const fx of allFixtures()) {
  test(`every tool converts: ${fx.name}`, () => {
    const { converted, failures, stats } = convertCatalog(fx.tools);
    assert.deepEqual(failures, [], `no tool may fail to convert`);
    assert.equal(stats.toolsConverted, fx.tools.length);
    assert.equal(converted.length, fx.tools.length);
  });

  test(`output satisfies the API's own requirements: ${fx.name}`, () => {
    const { converted } = convertCatalog(fx.tools);
    for (const { tool } of converted) {
      // ToolDefinition.required = [type, name, description, parameters]
      assert.equal(tool.type, 'function');
      assert.ok(tool.name.length > 0 && tool.name.length <= NAME_MAX, `name length: ${tool.name}`);
      assert.match(tool.name, /^[A-Za-z0-9_-]+$/, `name charset: ${tool.name}`);
      assert.ok(tool.description.length > 0, `${tool.name} must have a description`);
      assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be an object schema`);
      assert.equal(typeof tool.parameters.properties, 'object');
    }
  });

  test(`nothing structural survives into the output: ${fx.name}`, () => {
    const { converted } = convertCatalog(fx.tools);
    const used = new Set<string>();
    for (const c of converted) schemaKeywords(c.tool.parameters, used);
    for (const banned of ['$ref', '$defs', 'definitions', 'allOf', 'anyOf', 'oneOf', '$schema', 'title']) {
      assert.ok(!used.has(banned), `${banned} must not reach the Voice Agent API`);
    }
  });

  test(`every property carries a description: ${fx.name}`, () => {
    // "Every property should have a `description`. That string is how the model
    // extracts argument values from user speech." - voice-agent-api.yaml
    const { converted } = convertCatalog(fx.tools);
    const walk = (schema: Record<string, any>, where: string): void => {
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        const p = prop as Record<string, any>;
        assert.ok(
          typeof p.description === 'string' && p.description.trim().length > 0,
          `${where}.${key} has no description`,
        );
        if (p.properties) walk(p, `${where}.${key}`);
      }
    };
    for (const { tool } of converted) walk(tool.parameters, tool.name);
  });

  test(`required names only properties that exist: ${fx.name}`, () => {
    const { converted } = convertCatalog(fx.tools);
    const walk = (schema: Record<string, any>, where: string): void => {
      const have = new Set(Object.keys(schema.properties ?? {}));
      for (const r of schema.required ?? []) {
        assert.ok(have.has(r), `${where} requires "${r}" which is not in properties`);
      }
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if ((prop as any).properties) walk(prop as any, `${where}.${key}`);
      }
    };
    for (const { tool } of converted) walk(tool.parameters, tool.name);
  });

  test(`the opening phase is valid: ${fx.name}`, () => {
    const { converted } = convertCatalog(fx.tools);
    const phase = initialPhase({ catalog: converted, server: fx.initialize.serverInfo, instructions: fx.initialize.instructions });
    assertPhaseValid(phase);
  });
}

test('the afg fixture really exercises $ref and nullable unwrapping', () => {
  // Guards against a future re-capture quietly turning a hard fixture into an
  // easy one, which would leave the resolver untested while staying green.
  const fx = loadFixture('afg-marketplace');
  const { stats } = convertCatalog(fx.tools);
  assert.ok(stats.refsResolved >= 7, `expected >= 7 $refs resolved, got ${stats.refsResolved}`);
  assert.ok(stats.nullableUnwrapped >= 25, `expected >= 25 nullables unwrapped, got ${stats.nullableUnwrapped}`);
});

test('a $ref is resolved into real structure, not a bare object', () => {
  const fx = loadFixture('afg-marketplace');
  const { converted } = convertCatalog(fx.tools);
  const upload = converted.find((c) => c.report.mcpName === 'afg_upload_artifact');
  assert.ok(upload, 'afg_upload_artifact must be present');
  const signed = upload!.tool.parameters.properties?.signed_request as Record<string, any>;
  assert.equal(signed.type, 'object');
  assert.ok(signed.properties?.headers, '#/$defs/SignedRequestIn.headers must be inlined');
  assert.ok(signed.properties?.body, '#/$defs/SignedRequestIn.body must be inlined');
});

test('unwrapping a nullable drops the null default it came with', () => {
  const fx = loadFixture('afg-marketplace');
  const { converted } = convertCatalog(fx.tools);
  for (const { tool } of converted) {
    for (const [key, prop] of Object.entries(tool.parameters.properties ?? {})) {
      const p = prop as Record<string, any>;
      if (p.type !== undefined && p.default === null) {
        assert.fail(`${tool.name}.${key} keeps default:null against type ${String(p.type)}`);
      }
    }
  }
});

test('the docs server has a description long enough to be truncated', () => {
  const fx = loadFixture('assemblyai-docs-mcp');
  const { converted, stats } = convertCatalog(fx.tools);
  assert.ok(stats.descriptionsTruncated >= 1, 'expected at least one truncated description');
  for (const { tool } of converted) assert.ok(tool.description.length <= 1024);
});

// ------------------------------------------------------------ name handling

test('names are sanitised to the charset we chose, and stay unique', () => {
  const taken = new Set<string>();
  assert.deepEqual(sanitiseName('get_weather', taken), { name: 'get_weather', changed: false });
  taken.add('get_weather');
  assert.deepEqual(sanitiseName('search.docs', new Set()), { name: 'search_docs', changed: true });
  assert.deepEqual(sanitiseName('a b/c:d', new Set()), { name: 'a_b_c_d', changed: true });
  assert.deepEqual(sanitiseName('__weird__', new Set()), { name: 'weird', changed: true });
  assert.deepEqual(sanitiseName('!!!', new Set()), { name: 'tool', changed: true });
  assert.deepEqual(sanitiseName('', new Set()), { name: 'tool', changed: true });
});

test('two names that sanitise the same way do not collide', () => {
  const taken = new Set<string>();
  const a = sanitiseName('do.thing', taken); taken.add(a.name);
  const b = sanitiseName('do/thing', taken); taken.add(b.name);
  const c = sanitiseName('do thing', taken); taken.add(c.name);
  assert.deepEqual([a.name, b.name, c.name], ['do_thing', 'do_thing_2', 'do_thing_3']);
  assert.equal(new Set([a.name, b.name, c.name]).size, 3);
});

test('an over-long name is capped and a capped collision still resolves', () => {
  const long = 'x'.repeat(200);
  const taken = new Set<string>();
  const a = sanitiseName(long, taken); taken.add(a.name);
  const b = sanitiseName(`${long}y`, taken); taken.add(b.name);
  assert.equal(a.name.length, NAME_MAX);
  assert.ok(b.name.length <= NAME_MAX, `collision suffix must stay within ${NAME_MAX}`);
  assert.notEqual(a.name, b.name);
});

test('reserved names are respected, so find_tools cannot be shadowed', () => {
  const tools: McpTool[] = [{ name: 'find_tools', description: 'a server tool that clashes' }];
  const { converted } = convertCatalog(tools, { reserved: ['find_tools'] });
  assert.equal(converted[0]!.tool.name, 'find_tools_2');
  assert.equal(converted[0]!.report.mcpName, 'find_tools', 'the MCP name must be preserved for tools/call');
});

test('the name map reverses the sanitiser, which tools/call depends on', () => {
  const tools: McpTool[] = [{ name: 'weird.name!', description: 'd' }, { name: 'plain', description: 'd' }];
  const { converted } = convertCatalog(tools);
  const map = buildNameMap(converted);
  assert.equal(map.get('weird_name'), 'weird.name!');
  assert.equal(map.get('plain'), 'plain');
});

// ------------------------------------------------------- descriptions etc.

test('a missing description is synthesised, never left empty', () => {
  const { converted } = convertCatalog([{ name: 'do_the_thing' }]);
  const t = converted[0]!;
  assert.ok(t.tool.description.length > 0);
  assert.equal(t.report.descriptionSynthesised, true);
  assert.match(t.tool.description, /do the thing/);
});

test('a title is used before falling back to the name', () => {
  const { converted } = convertCatalog([{ name: 'x', title: 'Fetch the ledger' }]);
  assert.match(converted[0]!.tool.description, /Fetch the ledger/);
  assert.equal(converted[0]!.report.descriptionSynthesised, true);
});

test('a destructive tool is flagged in its own description', () => {
  const { converted } = convertCatalog([
    { name: 'delete_everything', description: 'Deletes it all.', annotations: { destructiveHint: true } },
  ]);
  assert.match(converted[0]!.tool.description, /cannot be undone/);
});

test('truncate cuts at a boundary and marks itself', () => {
  assert.deepEqual(truncate('short', 50), { text: 'short', truncated: false });
  const r = truncate('One sentence here. Then a second one that runs past the limit.', 30);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 30, `got ${r.text.length}`);
  assert.equal(r.text, 'One sentence here....');
  const w = truncate('aaaa bbbb cccc dddd eeee ffff', 14);
  assert.ok(w.text.length <= 14);
  assert.ok(!w.text.includes('cc'), 'must not cut mid-word');
});

test('humanise splits the naming styles that appear in real catalogs', () => {
  assert.equal(humanise('advisors_catalog_match_service'), 'advisors catalog match service');
  assert.equal(humanise('getWeatherNow'), 'get weather now');
  assert.equal(humanise('search-docs.v2'), 'search docs v2');
});

// ---------------------------------------------------------------- failures

test('one unusable tool does not cost us the rest of the catalog', () => {
  const tools = [
    { name: 'good_one', description: 'fine' },
    { name: '' } as McpTool,
    { description: 'no name at all' } as McpTool,
    { name: 'good_two', description: 'also fine' },
  ];
  const { converted, failures, stats } = convertCatalog(tools);
  assert.equal(converted.length, 2);
  assert.equal(failures.length, 2);
  assert.equal(stats.failed, 2);
  assert.deepEqual(converted.map((c) => c.tool.name), ['good_one', 'good_two']);
});

test('a tool with no inputSchema still gets a valid parameters object', () => {
  const { converted } = convertCatalog([{ name: 'no_args', description: 'takes nothing' }]);
  assert.deepEqual(converted[0]!.tool.parameters, { type: 'object', properties: {} });
});

test('a cyclic $ref is broken rather than followed', () => {
  const tool: McpTool = {
    name: 'cyclic',
    description: 'd',
    inputSchema: {
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
    },
  };
  const { converted, failures } = convertCatalog([tool]);
  assert.deepEqual(failures, []);
  const report = converted[0]!.report;
  assert.ok(report.warnings.some((w) => /cyclic \$ref/.test(w)), `warnings: ${report.warnings.join('; ')}`);
  assert.ok(JSON.stringify(converted[0]!.tool.parameters).length < 2000, 'must not blow up');
});

test('an unresolvable $ref degrades to an object and says so', () => {
  const { converted } = convertCatalog([
    { name: 't', description: 'd', inputSchema: { type: 'object', properties: { x: { $ref: '#/$defs/Missing' } } } },
  ]);
  assert.equal((converted[0]!.tool.parameters.properties!.x as any).type, 'object');
  assert.ok(converted[0]!.report.warnings.some((w) => /unresolvable \$ref/.test(w)));
});

test('a remote $ref is never followed', () => {
  const { converted } = convertCatalog([
    { name: 't', description: 'd', inputSchema: { type: 'object', properties: { x: { $ref: 'https://evil.example/schema.json' } } } },
  ]);
  assert.ok(converted[0]!.report.warnings.some((w) => /unresolvable \$ref/.test(w)));
  assert.ok(!JSON.stringify(converted[0]!.tool).includes('evil.example'));
});

test('a pattern the docs call broken is dropped and a normaliser recorded', () => {
  const { converted, stats } = convertCatalog([
    {
      name: 'charge',
      description: 'd',
      inputSchema: {
        type: 'object',
        properties: { card: { type: 'string', description: 'Card number.', pattern: '\\d{16}', examples: ['4242424242424242'] } },
        required: ['card'],
      },
    },
  ]);
  assert.equal(stats.patternsDropped, 1);
  const card = converted[0]!.tool.parameters.properties!.card as Record<string, any>;
  assert.equal(card.pattern, undefined, 'the unsafe pattern must not reach the API');
  assert.match(card.description, /Expected shape/, 'the shape must survive in prose');
  assert.deepEqual(converted[0]!.report.normalisers, [
    { path: 'card', normaliser: 'strip_non_digits', droppedPattern: '\\d{16}' },
  ]);
});

test("a pattern from the docs' good-values table is kept", () => {
  const { converted, stats } = convertCatalog([
    {
      name: 'callback',
      description: 'd',
      inputSchema: {
        type: 'object',
        properties: { phone: { type: 'string', description: 'E.164.', pattern: '\\+[1-9]\\d{1,14}', examples: ['+14155552671'] } },
      },
    },
  ]);
  assert.equal(stats.patternsKept, 1);
  assert.equal((converted[0]!.tool.parameters.properties!.phone as any).pattern, '\\+[1-9]\\d{1,14}');
});

test('a property named "title" survives conversion: it is an argument, not the keyword', () => {
  const fx = loadFixture('most-recommended-books');
  const { converted } = convertCatalog(fx.tools);
  const summary = converted.find((c) => c.tool.name === 'get_summary')!;
  assert.ok('title' in (summary.tool.parameters.properties as Record<string, unknown>), 'the book title argument must survive');
  assert.ok(!schemaKeywords(summary.tool.parameters, new Set()).has('title'), 'and no title keyword may');
});
