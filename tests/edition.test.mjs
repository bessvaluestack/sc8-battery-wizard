// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as internal from '../js/edition.js';
import * as client from '../js/edition.client.js';
import { createHash } from 'node:crypto';
import { bannedWords, build, stripJsComments } from '../scripts/build.mjs';

const readJson = (dir, p) => JSON.parse(readFileSync(join(dir, 'data', p), 'utf8'));
const loadData = (dir) => ({
  tariffs: readJson(dir, 'tariffs_sc8.json'), statements: readJson(dir, 'statements_sc8.json'), msc: readJson(dir, 'msc_sc8.json'),
  lbmp: { J: readJson(dir, 'lbmp_J.json'), H: readJson(dir, 'lbmp_H.json'), I: readJson(dir, 'lbmp_I.json') }, programs: readJson(dir, 'programs.json'),
});

test('the two editions export the same names and kinds', () => {
  assert.deepEqual(Object.keys(client).sort(), Object.keys(internal).sort());
  for (const k of Object.keys(internal)) assert.equal(typeof client[k], typeof internal[k], k);
  assert.equal(internal.CLIENT, false);
  assert.equal(client.CLIENT, true);
});

test('comment stripping leaves strings, templates and regexes alone', () => {
  const src = [
    '// header',
    "const url = 'http://example.com'; // trailing",
    'const re = /\\/\\/[^/]*/g, half = a / 2 / b;',
    '  /* block */',
    'const t = `a // not ${f({ k: `x /* y */` })} b`;',
    'return/* gap */x;',
  ].join('\n');
  assert.equal(stripJsComments(src), [
    "const url = 'http://example.com';",
    'const re = /\\/\\/[^/]*/g, half = a / 2 / b;',
    'const t = `a // not ${f({ k: `x /* y */` })} b`;',
    'return x;',
  ].join('\n'));
});

test('banned words match alone or run together, case-insensitively', () => {
  const hashes = new Set([createHash('sha256').update('acmecorp').digest('hex'), createHash('sha256').update('xyz').digest('hex')]);
  assert.deepEqual(bannedWords('Built by ACME Corp.', hashes), ['acmecorp']);
  assert.deepEqual(bannedWords('the acmecorp-xyz-light repo', hashes), ['acmecorp', 'xyz']);
  assert.deepEqual(bannedWords('xyzzy and acme corporation', hashes), []);
});

test('client build: no leaks, and the engine bills the same on sanitized data', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sc8-client-'));
  try {
    build({ client: true, out }); // throws if the leak scan finds anything
    writeFileSync(join(out, 'package.json'), '{"type":"module"}');
    const src = await import('../js/model.js');
    const dist = await import(pathToFileURL(join(out, 'js', 'model.js')).href);
    const srcData = loadData(new URL('..', import.meta.url).pathname), distData = loadData(out);
    assert.ok(Object.keys(distData.tariffs).every((k) => !k.startsWith('corpus_')));
    const kw = Float64Array.from(readJson(out, 'profiles/highrise_central_cooling.json').kw);
    const base = { region: 'nyc', zone: 'J', demandIntervalMin: 15, taxPct: 2.5, adjustments: { kwh: null, sbcDemand: true, extraDemand: 0 } };
    const programs = { enabled: { csrp: true, dlrp: true, term_dlm: false }, network: 'CHELSEA', pledgeKw: 100, participation: 'direct', events: { csrp: 3, dlrp: 2 }, termDlm: {} };
    for (const rateNo of [1, 2, 3]) for (const voltage of ['lt', 'ht']) for (const mode of ['coned_msc', 'coned_mhp', 'esco_fixed', 'esco_lbmp']) {
      const cfg = { ...base, rateNo, voltage, supply: { mode, fixedRate: 0.09, adder: 0.02 }, programs };
      const a = src.buildStack(cfg, srcData), b = dist.buildStack(cfg, distData);
      assert.equal(dist.billFor(b, kw).total, src.billFor(a, kw).total, `Rate ${rateNo} ${voltage} ${mode}`);
      assert.equal(a.programs.programs.length, 2);
      assert.deepEqual(b.programs.programs.map((p) => p.reservationValuePerKw), a.programs.programs.map((p) => p.reservationValuePerKw));
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
