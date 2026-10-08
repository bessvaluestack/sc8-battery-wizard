#!/usr/bin/env node
// Build a deployable copy of the app.
//
//   node scripts/build.mjs [--client] [--out <dir>]      (default dist/)
//
// Without --client the source tree is copied as-is: the internal edition.
// With --client the output is the client edition:
//   - js/edition.client.js ships as js/edition.js (text without vintages,
//     internal tooling or diagnostics; see js/edition.js);
//   - comments are stripped from js/ and css/ (they cite internal sources);
//   - data/ JSON loses its provenance fields (vintages, status, lineage,
//     source files, notes) and the tariff keys lose their origin prefix;
//   - a leak scan fails the build if an internal term or a vintage string
//     is left anywhere in the output.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Data fields that only record where a number came from (no engine reads them).
const PROVENANCE_KEYS = new Set([
  'book_vintage', 'vintage', 'status', 'lineage', 'source_file', 'conversion_notes', 'unmodelled',
  'document_id', 'networks_source', 'notes', 'note', 'indexed_not_compiled', 'generated_by', 'seed',
  'file',   // statement source file
  'source', // LBMP dataset tag
]);
// Their string values are also searched for in the output.
const VINTAGE_KEYS = ['book_vintage', 'vintage', 'document_id', 'document_ids', 'source_file'];

const LEAK_TERMS = [
  /corpus/i, /vintage/i, /candidate/i, /lineage/i, /compil/i,
  /psc10/i, /make_profiles/i, /nyiso_bundled/i, /owner decision/i, /\bleaf\b/i, /platform/i, /http\.server/i,
];
// Internal names, checked in every file (vendor/ too). Stored as SHA-256 of
// the lowercased word so the repo does not spell them out.
const BANNED_WORDS = new Set([
  'b1807399f7ecf6fc2564aed9d0532547241ff9e546ed26cb75aea4c2d3bcbbbd',
  '564fc6e7a74683baca51cdda84e904936e9bae68db60a9805aad5242805796d2',
  '18889a721a537ee1d9f6de4268a9ccf9f3e59bfebac6441f393996fa66ac80a0',
]);

// The banned words in a text: a letters-only word matches on its own or run
// together with the next one ("Two Words" -> "twowords").
export function bannedWords(text, hashes = BANNED_WORDS) {
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  const seen = new Set(), found = new Set();
  const check = (w) => {
    if (seen.has(w)) return;
    seen.add(w);
    if (hashes.has(createHash('sha256').update(w).digest('hex'))) found.add(w);
  };
  for (let k = 0; k < words.length; k++) { check(words[k]); if (k + 1 < words.length) check(words[k] + words[k + 1]); }
  return [...found];
}

// ---------------------------------------------------------------- comments
// Strip // and /* */ comments from JavaScript, leaving string, template and
// regex literals intact. A comment alone on its line takes the line with it.
export function stripJsComments(src) {
  const n = src.length;
  let out = '', i = 0, prev = '';
  const tpl = []; // brace depth outside each open template `${`
  let depth = 0;

  const regexCanStart = () => !prev || '(,=:[!&|?{};+-*%<>~^'.includes(prev)
    || /(?:^|[^\w$])(?:return|typeof|case|of|in|void|delete|throw|new|yield|await|else|do)$/.test(out.trimEnd());
  const endOfString = (s) => {
    let j = s + 1;
    while (src[j] !== src[s]) {
      if (src[j] === '\\') j++;
      if (j >= n || src[j] === '\n') throw new Error(`unterminated string at offset ${s}`);
      j++;
    }
    return j + 1;
  };
  const endOfRegex = (s) => {
    let j = s + 1, cls = false;
    for (; ; j++) {
      const ch = src[j];
      if (j >= n || ch === '\n') throw new Error(`unterminated regex at offset ${s}`);
      if (ch === '\\') { j++; continue; }
      if (cls) { if (ch === ']') cls = false; } else if (ch === '[') cls = true; else if (ch === '/') break;
    }
    j++;
    while (j < n && /[a-z]/i.test(src[j])) j++;
    return j;
  };
  const readTemplate = () => { // from just inside a template, up to its end or the next `${`
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (ch === '`') { out += ch; i++; prev = '`'; return; }
      if (ch === '$' && src[i + 1] === '{') { out += '${'; i += 2; tpl.push(depth); depth = 0; prev = '{'; return; }
      out += ch; i++;
    }
    throw new Error('unterminated template literal');
  };
  const dropComment = (end) => {
    const lineStart = out.lastIndexOf('\n') + 1;
    i = end;
    if (/^[ \t]*$/.test(out.slice(lineStart)) && (i >= n || src[i] === '\n')) { out = out.slice(0, lineStart); i++; return; }
    out = out.replace(/[ \t]+$/, '');
    if (/[\w$]/.test(out.slice(-1)) && /[\w$]/.test(src[i] || '')) out += ' ';
  };

  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); dropComment(e < 0 ? n : e); continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new Error(`unterminated comment at offset ${i}`);
      dropComment(e + 2); continue;
    }
    if (c === '"' || c === "'") { const e = endOfString(i); out += src.slice(i, e); i = e; prev = c; continue; }
    if (c === '`') { out += c; i++; readTemplate(); continue; }
    if (c === '/' && regexCanStart()) { const e = endOfRegex(i); out += src.slice(i, e); i = e; prev = ')'; continue; }
    if (c === '{') depth++;
    if (c === '}') {
      if (depth === 0 && tpl.length) { depth = tpl.pop(); out += c; i++; readTemplate(); continue; }
      depth--;
    }
    out += c; i++;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

export const stripCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\/\n?/g, '');

// ---------------------------------------------------------------- data
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!PROVENANCE_KEYS.has(k)) out[k] = sanitize(v);
    return out;
  }
  return value;
}

function collectVintages(value, acc) {
  if (Array.isArray(value)) value.forEach((v) => collectVintages(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (VINTAGE_KEYS.includes(k)) [v].flat().forEach((s) => { if (typeof s === 'string' && s) acc.add(s); });
      collectVintages(v, acc);
    }
  }
  return acc;
}

function sanitizeDataFile(name, doc) {
  doc = sanitize(doc);
  if (name === 'tariffs_sc8.json') {
    doc = Object.fromEntries(Object.entries(doc).map(([k, t]) => {
      const id = k.replace(/^corpus_/, '');
      return [id, { ...t, id }];
    }));
  }
  return doc;
}

// ---------------------------------------------------------------- build
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

export function build({ client = false, out = join(ROOT, 'dist') } = {}) {
  out = resolve(out);
  if (out === ROOT || ROOT.startsWith(out + sep) || ['js', 'css', 'data', 'img', 'vendor', 'scripts', 'tests'].some((d) => out === join(ROOT, d))) {
    throw new Error(`refusing to build into ${out}`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  cpSync(join(ROOT, 'index.html'), join(out, 'index.html'));
  cpSync(join(ROOT, 'vendor'), join(out, 'vendor'), { recursive: true });
  cpSync(join(ROOT, 'img'), join(out, 'img'), { recursive: true });
  mkdirSync(join(out, 'css'));
  for (const f of readdirSync(join(ROOT, 'css'))) {
    const src = readFileSync(join(ROOT, 'css', f), 'utf8');
    writeFileSync(join(out, 'css', f), client ? stripCssComments(src) : src);
  }
  mkdirSync(join(out, 'js'));
  for (const f of readdirSync(join(ROOT, 'js'))) {
    if (f === 'edition.client.js') continue;
    const src = readFileSync(join(ROOT, 'js', client && f === 'edition.js' ? 'edition.client.js' : f), 'utf8');
    if (!client) { writeFileSync(join(out, 'js', f), src); continue; }
    try { writeFileSync(join(out, 'js', f), stripJsComments(src)); } catch (e) { throw new Error(`js/${f}: ${e.message}`); }
  }

  const vintages = new Set();
  for (const file of walk(join(ROOT, 'data'))) {
    const rel = relative(ROOT, file);
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    if (!client) { cpSync(file, join(out, rel)); continue; }
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    collectVintages(doc, vintages);
    writeFileSync(join(out, rel), JSON.stringify(sanitizeDataFile(rel.split(sep).pop(), doc)));
  }

  const files = walk(out);
  if (client) {
    const problems = [];
    for (const file of files.filter((f) => f.endsWith('.js'))) {
      const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(file) });
      if (r.status !== 0) problems.push(`${relative(out, file)}: does not parse after comment stripping\n${r.stderr}`);
    }
    for (const file of files.filter((f) => /\.(html|css|js|mjs|json)$/.test(f))) {
      const rel = relative(out, file);
      const vendor = rel.startsWith('vendor' + sep);
      const text = readFileSync(file, 'utf8');
      for (const w of bannedWords(text)) problems.push(`${rel}: contains the banned word "${w}"`);
      if (vendor) continue;
      for (const re of LEAK_TERMS) {
        const m = text.match(re);
        if (m) problems.push(`${rel}: "${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}" matches ${re}`);
      }
      for (const v of vintages) if (text.includes(v)) problems.push(`${rel}: contains the vintage string "${v}"`);
    }
    if (problems.length) throw new Error(`client build is not clean:\n  ${problems.join('\n  ')}`);
  }
  return { client, out, files: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const known = (a, k) => a === '--client' || (outAt >= 0 && (k === outAt || k === outAt + 1));
  if (args.some((a, k) => !known(a, k)) || (outAt >= 0 && !args[outAt + 1])) {
    console.error('usage: node scripts/build.mjs [--client] [--out <dir>]');
    process.exit(2);
  }
  try {
    const r = build({ client: args.includes('--client'), out: outAt >= 0 ? args[outAt + 1] : undefined });
    console.log(`${r.client ? 'client' : 'internal'} edition: ${r.files} files in ${relative(process.cwd(), r.out) || '.'}`);
  } catch (e) {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  }
}
