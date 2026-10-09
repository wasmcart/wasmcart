// The WebGPU docs' code must be real: every C block in docs/webgpu.md is
// quoted verbatim from a file the suite builds (marked with
// <!-- snippet: path --> above it), and every JavaScript block in that page
// and in README.md's "WebGPU Carts" section parses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const AsyncFunction = (async () => {}).constructor;

/** fenced blocks with their language and the line before the fence */
function blocks(md) {
  const out = [];
  const re = /(^.*\n)?```(\w*)\n([\s\S]*?)```/gm;
  for (let m; (m = re.exec(md));) out.push({ before: (m[1] || '').trim(), lang: m[2], code: m[3] });
  return out;
}

test('every C block in docs/webgpu.md is quoted from a built source file', () => {
  const cBlocks = blocks(read('docs/webgpu.md')).filter((b) => b.lang === 'c');
  assert.ok(cBlocks.length >= 4);
  for (const b of cBlocks) {
    const m = /<!-- snippet: (\S+) -->/.exec(b.before);
    assert.ok(m, `a C block without a <!-- snippet: file --> marker:\n${b.code.slice(0, 200)}`);
    assert.ok(read(m[1]).includes(b.code), `this block is not in ${m[1]} verbatim:\n${b.code.slice(0, 200)}`);
  }
});

test('the JavaScript blocks in docs/webgpu.md and README.md "WebGPU Carts" parse', () => {
  const readme = read('README.md');
  const start = readme.indexOf('### WebGPU Carts');
  const section = readme.slice(start, readme.indexOf('\n### ', start + 10));
  const js = [...blocks(read('docs/webgpu.md')), ...blocks(section)].filter((b) => b.lang === 'js');
  assert.ok(js.length >= 2);
  for (const b of js) {
    const body = b.code.replace(/^import .*$/gm, '');
    assert.doesNotThrow(() => new AsyncFunction(body), `does not parse:\n${b.code}`);
  }
});
