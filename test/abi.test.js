// ABI contract sanity - the machine-readable spec (src/abi.js) must stay internally
// consistent and match the documented layout. If these drift, hosts and carts disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABI_VERSION, MIN_ABI_VERSION, BUTTON, PAD_SIZE, MAX_PADS, INPUT_REGION_SIZE,
  INFO_FIELDS, FLAG_NET_WS, FLAG_NET_DC, FLAG_POINTER, FLAG_KEYBOARD,
  FLAG_DEBUG, DEBUG_TYPE, DEBUG_TYPE_WIDTH, DEBUG_TYPE_NAME, DEBUG_FIELD_SIZE,
} from '../src/abi.js';

test('ABI version is current (3) and min-supported is sane', () => {
  assert.equal(ABI_VERSION, 3);
  assert.ok(MIN_ABI_VERSION >= 1 && MIN_ABI_VERSION <= ABI_VERSION);
});

test('BUTTON bitmask has 14 distinct single-bit values', () => {
  const vals = Object.values(BUTTON);
  assert.equal(vals.length, 14);
  // every value is a single set bit
  for (const v of vals) assert.equal(v & (v - 1), 0, `${v} is not a single bit`);
  // all distinct
  assert.equal(new Set(vals).size, vals.length);
});

test('pad + input region layout is consistent', () => {
  assert.equal(PAD_SIZE, 16);
  assert.equal(MAX_PADS, 4);
  assert.equal(INPUT_REGION_SIZE, PAD_SIZE * MAX_PADS);
});

test('feature flags are distinct single bits', () => {
  const flags = [FLAG_NET_WS, FLAG_NET_DC, FLAG_POINTER, FLAG_KEYBOARD];
  for (const f of flags) assert.equal(f & (f - 1), 0, `flag ${f} not a single bit`);
  assert.equal(new Set(flags).size, flags.length);
});

test('INFO_FIELDS describes the wc_info_t struct', () => {
  assert.ok(INFO_FIELDS && typeof INFO_FIELDS === 'object');
});

test('debug ABI: FLAG_DEBUG is a distinct single bit above the v3 flags', () => {
  assert.equal(FLAG_DEBUG, 1 << 5);
  for (const other of [FLAG_NET_WS, FLAG_NET_DC, FLAG_POINTER, FLAG_KEYBOARD]) {
    assert.notEqual(FLAG_DEBUG, other);
  }
  assert.equal(FLAG_DEBUG & (FLAG_DEBUG - 1), 0);
});

test('debug field: type table is complete and widths line up', () => {
  assert.equal(DEBUG_FIELD_SIZE, 16);
  for (const [name, id] of Object.entries(DEBUG_TYPE)) {
    assert.equal(typeof DEBUG_TYPE_WIDTH[id], 'number', `${name} has a width`);
    assert.equal(typeof DEBUG_TYPE_NAME[id], 'string', `${name} has a name`);
  }
  assert.equal(DEBUG_TYPE_WIDTH[DEBUG_TYPE.U8], 1);
  assert.equal(DEBUG_TYPE_WIDTH[DEBUG_TYPE.F64], 8);
});
