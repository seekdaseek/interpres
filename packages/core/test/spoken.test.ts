import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgePattern,
  compileWholeValue,
  declaredDigitRun,
  allowsInteriorSpace,
  longestDigitRun,
  spokenVariants,
  applyNormaliser,
  applyNormalisers,
} from '../src/spoken.ts';

/**
 * The control set is the docs' own table (tools/overview, "Parameter hints").
 * Every row there is presented as a GOOD value, so every row must survive; the
 * one pattern the docs call out as broken must be dropped.
 */
const DOCS_GOOD: Array<[label: string, pattern: string, examples: string[]]> = [
  ['US ZIP', String.raw`\d{5}(-\d{4})?`, ['94103', '10001-2201']],
  ['E.164 phone', String.raw`\+[1-9]\d{1,14}`, ['+14155552671', '+442071838750']],
  ['Order ID', String.raw`[A-Z]{2}-\d{5}`, ['AB-12345']],
  ['ISO date', String.raw`\d{4}-\d{2}-\d{2}`, ['2026-06-09']],
  ['spoken card (docs recommendation)', String.raw` *([0-9] *){13,19}`, [
    '4242424242424242',
    '4242 4242 4242 4242',
    '4 2 4 2 4 2 4 2 4 2 4 2 4 2 4 2',
  ]],
];

test('regex harness itself works before anything relies on it', () => {
  // G1: prove the compiler matches a known positive and rejects a known
  // negative, so a later "all patterns pass" is not a broken-harness artefact.
  const re = compileWholeValue(String.raw`\d{5}`);
  assert.ok(re, 'pattern must compile');
  assert.equal(re!.test('94103'), true, 'known positive must match');
  assert.equal(re!.test('9410'), false, 'too short must not match');
  assert.equal(re!.test('94103x'), false, 'whole-value anchoring must reject a suffix');
  assert.equal(compileWholeValue('('), null, 'uncompilable pattern must report null');
});

test('anchors are redundant and must not double-anchor', () => {
  const bare = compileWholeValue(String.raw`\d{3}`)!;
  const anchored = compileWholeValue(String.raw`^\d{3}$`)!;
  for (const v of ['123', '12', '1234', 'a123']) {
    assert.equal(anchored.test(v), bare.test(v), `anchored and bare must agree on ${v}`);
  }
});

for (const [label, pattern, examples] of DOCS_GOOD) {
  test(`docs "good value" survives: ${label}`, () => {
    const v = judgePattern(pattern, examples);
    assert.equal(v.kept, true, `${label} was dropped: ${v.kept === false ? v.reason : ''}`);
  });

  test(`docs "good value" matches its own examples: ${label}`, () => {
    const re = compileWholeValue(pattern)!;
    for (const ex of examples) assert.equal(re.test(ex), true, `${ex} must match ${pattern}`);
  });
}

test('the pattern the docs call broken is dropped, with a normaliser', () => {
  // "A pattern that only accepts the tidy form (^\d{16}$) will reject the
  // spaced form and trap the caller in a re-ask loop."
  const v = judgePattern(String.raw`\d{16}`, ['4242424242424242']);
  assert.equal(v.kept, false);
  assert.equal(v.kept === false && v.normaliser, 'strip_non_digits');
  assert.match(v.kept === false ? v.reason : '', /16 consecutive digits/);
  // The reason must carry measured evidence: a spoken form it really rejects.
  assert.match(v.kept === false ? v.reason : '', /it rejects "4 2 4 2/);
});

test('a long digit run is dropped even with no examples to test', () => {
  const v = judgePattern(String.raw`\d{13,19}`);
  assert.equal(v.kept, false);
  assert.equal(v.kept === false && v.normaliser, 'strip_non_digits');
  assert.match(v.kept === false ? v.reason : '', /13 consecutive digits/);
});

test('a pattern rejecting its own example is dropped as self-inconsistent', () => {
  const v = judgePattern(String.raw`[A-Z]{2}-\d{5}`, ['ab-12345']);
  assert.equal(v.kept, false);
  assert.match(v.kept === false ? v.reason : '', /rejects its own example/);
});

test('an uncompilable pattern is dropped without a normaliser', () => {
  const v = judgePattern('([0-9]{3}');
  assert.equal(v.kept, false);
  assert.equal(v.kept === false && v.normaliser, undefined);
});

test('declaredDigitRun reads the lower bound, which is what keeps E.164 safe', () => {
  assert.equal(declaredDigitRun(String.raw`\d{16}`), 16);
  assert.equal(declaredDigitRun(String.raw`\d{13,19}`), 13);
  assert.equal(declaredDigitRun(String.raw`\+[1-9]\d{1,14}`), 1, 'E.164 insists on one digit');
  assert.equal(declaredDigitRun(String.raw`\d{5}(-\d{4})?`), 5);
  assert.equal(declaredDigitRun(String.raw`[0-9]{12}`), 12);
  assert.equal(declaredDigitRun(String.raw`\d\d\d\d\d\d\d\d\d\d\d`), 11, 'repeated atoms count');
  assert.equal(declaredDigitRun(String.raw` *([0-9] *){13,19}`), 0, 'quantifier is on the group');
});

test('allowsInteriorSpace recognises the forms that appear in real patterns', () => {
  assert.equal(allowsInteriorSpace(String.raw` *([0-9] *){13,19}`), true, 'space-star');
  assert.equal(allowsInteriorSpace(String.raw`[\d\s]{13,19}`), true, 'backslash-s');
  assert.equal(allowsInteriorSpace(String.raw`[0-9 ]{13,19}`), true, 'space in a class');
  assert.equal(allowsInteriorSpace(String.raw`\d{16}`), false);
  assert.equal(allowsInteriorSpace(String.raw`[A-Z]{2}-\d{5}`), false);
});

test('a long run that does allow spaces is kept', () => {
  const v = judgePattern(String.raw`[0-9 ]{13,25}`);
  assert.equal(v.kept, true);
});

test('longestDigitRun measures runs, not totals', () => {
  assert.equal(longestDigitRun('10001-2201'), 5, 'ZIP+4 is 9 digits but runs of 5 and 4');
  assert.equal(longestDigitRun('4242424242424242'), 16);
  assert.equal(longestDigitRun('4242 4242 4242 4242'), 4);
  assert.equal(longestDigitRun('no digits here'), 0);
});

test('spokenVariants produces the forms the docs describe', () => {
  const v = spokenVariants('4242424242424242');
  assert.ok(v.includes('4 2 4 2 4 2 4 2 4 2 4 2 4 2 4 2'), 'one digit at a time');
  assert.ok(v.includes('4242 4242 4242 4242'), 'grouped by four');
  assert.ok(!v.includes('4242424242424242'), 'the tidy form is not a variant of itself');
  assert.deepEqual(spokenVariants('no digits'), []);
});

test('normalisers behave, and leave non-strings alone', () => {
  assert.equal(applyNormaliser('strip_non_digits', '4 2 4 2 4 2 4 2 4 2 4 2 4 2 4 2'), '4242424242424242');
  assert.equal(applyNormaliser('strip_non_digits', '+1 (415) 555-2671'), '14155552671');
  assert.equal(applyNormaliser('collapse_whitespace', '  a   b  '), 'a b');
  assert.equal(applyNormaliser('trim', '  x  '), 'x');
  assert.equal(applyNormaliser('strip_non_digits', 42), 42, 'a number passes through');
  assert.deepEqual(applyNormaliser('trim', { a: 1 }), { a: 1 }, 'an object passes through');
});

test('quantified digit atoms written back to back are summed', () => {
  // \d{4}\d{4}\d{4}\d{4} is sixteen in a row, spelled four ways.
  assert.equal(declaredDigitRun(String.raw`\d{4}\d{4}\d{4}\d{4}`), 16);
  assert.equal(judgePattern(String.raw`\d{4}\d{4}\d{4}\d{4}`).kept, false);
  // A separator breaks the chain: the caller has somewhere to breathe.
  assert.equal(declaredDigitRun(String.raw`\d{3}-\d{3}-\d{4}`), 4);
  assert.equal(judgePattern(String.raw`\d{3}-\d{3}-\d{4}`).kept, true);
});

test('the threshold sits between a well-known shape and an account number', () => {
  // Below the line stays, at the line goes. Pinning both sides means a change
  // to DIGIT_RUN_RISK_THRESHOLD cannot pass unnoticed.
  assert.equal(judgePattern(String.raw`\d{9}`).kept, true, '9 in a row is still a known shape');
  assert.equal(judgePattern(String.raw`\d{10}`).kept, false, '10 in a row is account territory');
});

test('normalisers reach the argument they were recorded against', () => {
  const { args, applied } = applyNormalisers(
    { card_number: '4 2 4 2 4 2 4 2 4 2 4 2 4 2 4 2', note: 'leave me alone' },
    [{ path: 'card_number', normaliser: 'strip_non_digits' }],
  );
  assert.equal(args.card_number, '4242424242424242');
  assert.equal(args.note, 'leave me alone');
  assert.deepEqual(applied, ['card_number:strip_non_digits']);
});

test('a nested and an array path both normalise', () => {
  const { args } = applyNormalisers(
    { payment: { card: '4 2 4 2 4 2 4 2 4 2 4 2 4 2 4 2' }, codes: ['1 2 3', '4 5 6'] },
    [
      { path: 'payment.card', normaliser: 'strip_non_digits' },
      { path: 'codes[]', normaliser: 'strip_non_digits' },
    ],
  );
  assert.equal((args.payment as any).card, '4242424242424242');
  assert.deepEqual(args.codes, ['123', '456']);
});

test('the caller-owned arguments object is never mutated', () => {
  const original = { card: '1 2 3 4 5 6 7 8 9 0' };
  const { args } = applyNormalisers(original, [{ path: 'card', normaliser: 'strip_non_digits' }]);
  assert.equal(original.card, '1 2 3 4 5 6 7 8 9 0');
  assert.equal(args.card, '1234567890');
});

test('a path that is absent, or a value of the wrong type, is skipped quietly', () => {
  const { args, applied } = applyNormalisers({ other: 1 }, [{ path: 'missing', normaliser: 'strip_non_digits' }]);
  assert.deepEqual(args, { other: 1 });
  assert.deepEqual(applied, []);
  const n = applyNormalisers({ card: 42 }, [{ path: 'card', normaliser: 'strip_non_digits' }]);
  assert.equal(n.args.card, 42, 'a number is left as it is');
  assert.deepEqual(n.applied, []);
});

test('no normalisers means the very same object back', () => {
  const args = { a: 1 };
  assert.equal(applyNormalisers(args, []).args, args);
});

test('a value already tidy is not reported as changed', () => {
  const { applied } = applyNormalisers({ card: '4242424242424242' }, [{ path: 'card', normaliser: 'strip_non_digits' }]);
  assert.deepEqual(applied, [], 'nothing changed, so nothing is reported');
});
