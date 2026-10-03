// ABI contract sanity - the machine-readable spec (src/abi.js) must stay internally
// consistent and match the documented layout. If these drift, hosts and carts disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABI_VERSION, MIN_ABI_VERSION, BUTTON, PAD_SIZE, MAX_PADS, INPUT_REGION_SIZE,
  INFO_FIELDS, FLAG_NET_PEER, FLAG_POINTER, FLAG_KEYBOARD,
  FLAG_DEBUG, DEBUG_TYPE, DEBUG_TYPE_WIDTH, DEBUG_TYPE_NAME, DEBUG_FIELD_SIZE,
} from '../src/abi.js';

test('ABI version is current (4) and min-supported is sane', () => {
  assert.equal(ABI_VERSION, 4);
  assert.ok(MIN_ABI_VERSION >= 1 && MIN_ABI_VERSION <= ABI_VERSION);
  // v4 moved every field after the buttons, so a v1-v3 cart cannot be read
  // with v4 offsets: it must be REFUSED, not reinterpreted. If this ever
  // drops below 4, an old cart loads and reads a shifted struct -- it would
  // see `connected` as a trigger byte and report every pad as unplugged.
  assert.equal(MIN_ABI_VERSION, 4);
});

test('BUTTON bitmask has 21 distinct single-bit values', () => {
  const vals = Object.values(BUTTON);
  // 14 through v3, plus GUIDE, MISC1, PADDLE1-4 and TOUCHPAD in v4, which
  // completes parity with SDL2's controller button set.
  assert.equal(vals.length, 21);
  // every value is a single set bit
  for (const v of vals) assert.equal(v & (v - 1), 0, `${v} is not a single bit`);
  // all distinct
  assert.equal(new Set(vals).size, vals.length);
  // Must all fit the u32 field, and the top 11 bits stay reserved.
  for (const v of vals) assert.ok(v > 0 && v <= 0x00100000, `${v} outside bits 0-20`);
  // The pre-v4 bits keep their meanings: a renumbering would silently remap
  // every existing cart's controls.
  assert.equal(BUTTON.A, 1 << 0);
  assert.equal(BUTTON.R3, 1 << 13);
  assert.equal(BUTTON.GUIDE, 1 << 14);
});

test('pad + input region layout is consistent', () => {
  // 20 as of v4: u32 buttons (4) + 4 sticks (8) + 2 triggers (4) +
  // connected (1) + 3 padding.
  assert.equal(PAD_SIZE, 20);
  assert.equal(MAX_PADS, 4);
  assert.equal(INPUT_REGION_SIZE, PAD_SIZE * MAX_PADS);
});

test('feature flags are distinct single bits', () => {
  const flags = [FLAG_NET_PEER, FLAG_POINTER, FLAG_KEYBOARD];
  for (const f of flags) assert.equal(f & (f - 1), 0, `flag ${f} not a single bit`);
  assert.equal(new Set(flags).size, flags.length);
});

test('INFO_FIELDS describes the wc_info_t struct', () => {
  assert.ok(INFO_FIELDS && typeof INFO_FIELDS === 'object');
});

test('debug ABI: FLAG_DEBUG is a distinct single bit above the v3 flags', () => {
  assert.equal(FLAG_DEBUG, 1 << 5);
  for (const other of [FLAG_NET_PEER, FLAG_POINTER, FLAG_KEYBOARD]) {
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

test('1 << 2 stays reserved: no flag may reclaim the old FLAG_NET_DC bit', () => {
  // The WebSocket and data-channel families merged into one peer-connection
  // family, freeing 1 << 2. A future flag landing there would silently collide
  // with carts built before the merge, so it stays unused.
  const RESERVED = 1 << 2;
  for (const f of [FLAG_NET_PEER, FLAG_POINTER, FLAG_KEYBOARD, FLAG_DEBUG]) {
    assert.notEqual(f, RESERVED, 'a flag reclaimed the reserved 1 << 2 bit');
  }
});
