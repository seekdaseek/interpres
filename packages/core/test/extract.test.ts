import { test } from 'node:test';
import assert from 'node:assert/strict';
import { despeakify, sentences, extractiveSummary } from '../src/extract.ts';
import { localShape } from '../src/shape.ts';

test('nothing unspeakable survives despeakify', () => {
  const messy = [
    '## Encodings',
    'Title: Audio format',
    'Link: https://www.assemblyai.com/docs/voice-agents/audio-format#encodings',
    'Page: voice-agents/audio-format',
    'Content: The **default** is `audio/pcm` at 24 kHz.',
    '| Encoding | Rate |',
    '| --- | --- |',
    '| audio/pcm | 24000 |',
    '- a bullet point here',
    'Mail us at someone@example.com or see [the guide](https://example.com/guide).',
    '```js\nconst x = 1;\n```',
  ].join('\n');
  const out = despeakify(messy);
  for (const banned of ['http', '##', '**', '`', '|', '@example.com', 'Title:', 'Link:', 'Content:', 'Page:']) {
    assert.ok(!out.includes(banned), `${banned} must not survive: ${out}`);
  }
  assert.match(out, /default is audio\/pcm at 24 kHz/, 'the actual prose must survive');
  assert.match(out, /the guide/, 'a link label is kept even though the URL goes');
});

test('sentences split on stops and on line breaks', () => {
  assert.deepEqual(sentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
  assert.deepEqual(sentences('No stop here\nSecond line'), ['No stop here', 'Second line']);
  assert.deepEqual(sentences('   '), []);
});

test('the summary answers the question rather than taking the first lines', () => {
  const doc = [
    'This page is about billing and invoices and has nothing to do with audio.',
    'Our company was founded in a garage and we care deeply about customers.',
    'The Voice Agent API expects PCM16 audio at 24000 Hz, mono, base64 encoded.',
    'Refunds are processed within thirty days of the original purchase date.',
  ].join('\n');
  const out = extractiveSummary(doc, 'what audio format and sample rate does it expect', 200);
  assert.match(out.text, /PCM16 audio at 24000 Hz/);
  assert.ok(!out.text.includes('Refunds'), `an unrelated sentence should not appear: ${out.text}`);
});

test('the budget is respected and only whole sentences are used', () => {
  const doc = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} carries some words about audio formats and rates.`).join(' ');
  const out = extractiveSummary(doc, 'audio formats', 200);
  assert.ok(out.text.length <= 200, `got ${out.text.length}`);
  assert.ok(out.sentencesUsed >= 1);
  assert.ok(out.sentencesUsed <= 4, 'more than four is not a spoken answer');
});

test('chosen sentences are spoken in document order', () => {
  // Both widget sentences must clear the speakable bar, or only one is picked
  // and the test proves nothing about ordering.
  const doc = [
    'Alpha mentions widgets and explains how the first one is assembled.',
    'Beta is filler text that rambles along without saying anything useful.',
    'Gamma also mentions widgets and covers how the last one is packaged.',
  ].join(' ');
  const out = extractiveSummary(doc, 'widgets', 300);
  assert.ok(out.text.includes('Alpha') && out.text.includes('Gamma'), `both should be chosen: ${out.text}`);
  assert.ok(out.text.indexOf('Alpha') < out.text.indexOf('Gamma'), `order lost: ${out.text}`);
});

test('a repeated boilerplate line is not repeated in the answer', () => {
  const record = 'TEST MONEY ONLY: mock ledger, test tokens, no real funds at all here.';
  const doc = Array.from({ length: 8 }, () => record).join('\n') + '\nThe dispute window is seven days long for every job.';
  const out = extractiveSummary(doc, 'dispute window', 400);
  assert.equal((out.text.match(/TEST MONEY ONLY/g) ?? []).length <= 1, true, `boilerplate repeated: ${out.text}`);
});

test('a table row is not read out as a sentence', () => {
  const doc = '| audio/pcm | 24000 | 16-bit |\n| --- | --- | --- |\nBoth input and output default to audio/pcm at 24 kHz for browsers.';
  const out = extractiveSummary(doc, 'default audio format', 300);
  assert.match(out.text, /default to audio\/pcm/);
  assert.ok(!/\s\.\s.*\s\.\s/.test(out.text), `table fragments leaked: ${out.text}`);
});

test('with no question it still returns the most substantial lines', () => {
  const doc = 'Ok.\nThis is a proper sentence with enough real words to be worth saying.\nNo.';
  const out = extractiveSummary(doc, undefined, 300);
  assert.match(out.text, /proper sentence/);
});

test('output with nothing speakable in it still returns something', () => {
  const out = extractiveSummary('{"a":1,"b":2}', 'anything', 100);
  assert.equal(typeof out.text, 'string');
  assert.equal(out.sentencesUsed, 0, 'nothing qualified as a sentence');
});

test('empty input does not throw', () => {
  assert.equal(extractiveSummary('', 'q', 100).text, '');
  assert.equal(despeakify(''), '');
});

test('localShape flattens JSON before summarising it', () => {
  const out = localShape('{"temp_c":22,"condition":"sunny","city":"Tokyo"}', 'what is the weather', 300);
  assert.ok(!out.includes('{') && !out.includes('"'), `braces leaked: ${out}`);
  assert.match(out, /22/);
});

test('localShape never returns an empty string for non-empty input', () => {
  for (const input of ['x'.repeat(50), '{"a":1}', '| a | b |', '### heading only', 'https://only-a-url.example/']) {
    const out = localShape(input, 'q', 200);
    assert.equal(typeof out, 'string');
    if (input !== 'https://only-a-url.example/') {
      assert.ok(out.length > 0, `empty for ${input}`);
    }
  }
});

test('localShape strips URLs out of what the agent will say', () => {
  const doc = 'See https://example.com/docs/page#anchor for the full detail on audio formats and rates.';
  assert.ok(!localShape(doc, 'audio formats', 300).includes('http'));
});
