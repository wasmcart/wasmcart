// Input actions (SPEC.md, "Input actions") through both real hosts, with a C
// cart (fixtures/actioncart.c) that declares two sets and three actions, plays
// in "driving" and re-reads its prompts when wc_input_revision changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CartHost } from '../src/CartHost.js';
import { CartHostWeb } from '../src/CartHostWeb.js';
import { ActionTable, IN, DEVICE, GLYPH, glyphId, padOrigin, padFamily, WORKER_ACTION_IMPORTS } from '../src/actions.js';
import { BUTTON } from '../src/abi.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CART = join(HERE, 'fixtures/actioncart.wasc');
const IMPORTS = Object.keys(WORKER_ACTION_IMPORTS);

const reader = (host, ptrs) => (n) => new DataView(host.memory.buffer).getInt32(ptrs[n], true);
let PTRS = null;
async function ptrs() {
  if (PTRS) return PTRS;
  const h = new CartHost();
  await h.load(CART);
  PTRS = Object.fromEntries(h.readDebugState().map((f) => [f.name, f.valuePtr]));
  h.destroy();
  return PTRS;
}
const label = (host, p) => {
  const u8 = new Uint8Array(host.memory.buffer, p.pedal_label, 16);
  return new TextDecoder().decode(u8.subarray(0, u8.indexOf(0)));
};

const HOSTS = [
  ['CartHost', () => new CartHost(), (h) => h.load(CART)],
  ['CartHostWeb', () => new CartHostWeb(), (h) => h.load(new Uint8Array(readFileSync(CART)), {})],
];

for (const [name, make, load] of HOSTS) {
  test(`${name}: declarations, state from the default binding, unknown origins`, async () => {
    const p = await ptrs();
    const host = make();
    await load(host);
    const v = reader(host, p);
    assert.deepEqual([v('set_menu'), v('set_drive')], [0, 1]);
    assert.deepEqual([v('act_confirm'), v('act_pedal'), v('act_steer')], [0, 1, 2]);
    assert.equal(v('bad_kind'), -1, 'an unknown kind is refused');
    assert.equal(v('dup_pedal'), 1, 'redeclaring the same action returns its id');

    await host.runFrame([{ connected: true, buttons: BUTTON.A, leftX: -32767 }]);
    assert.equal(v('pedal'), 1, 'Pedal follows its default, A');
    assert.equal(v('steer_x1000'), -1000, 'Steer follows its default, the left stick');
    assert.equal(v('steer_ret'), 1);
    assert.equal(v('pedal_len'), -1, 'no describer: the host does not know, and says so');
    assert.equal(v('device'), DEVICE.UNKNOWN);
    assert.equal(v('prompts'), 1);

    const list = host.getActions(0);
    assert.deepEqual(list.map((a) => [a.name, a.setName, a.kind, a.active]),
      [['Confirm', 'menu', 'digital', false], ['Pedal', 'driving', 'digital', true], ['Steer', 'driving', 'analog', true]]);
    host.destroy();
  });

  test(`${name}: a describer, a device switch and a remap reach the cart's prompts`, async () => {
    const p = await ptrs();
    const host = make();
    await load(host);
    const v = reader(host, p);
    const KEYS = { [IN.A]: { label: 'Space', glyph: glyphId(GLYPH.KEY, 0x2c) }, [IN.B]: { label: 'Z', glyph: glyphId(GLYPH.KEY, 0x1d) } };
    host.setInputDescriber((player, input, device) => (device === DEVICE.GAMEPAD
      ? padOrigin(GLYPH.PLAYSTATION, input) : (KEYS[input] ?? null)));
    host.setInputDevice(0, DEVICE.KEYBOARD_MOUSE);
    await host.runFrame([{ connected: true, buttons: 0 }]);
    assert.equal(label(host, p), 'Space');
    assert.equal(v('pedal_len'), 5);
    assert.equal(v('steer_len'), 0, 'the stick is not on the keyboard: unbound, hide the prompt');
    assert.equal(v('pedal_glyph'), glyphId(GLYPH.KEY, 0x2c));

    const prompts = v('prompts');
    await host.runFrame([{ connected: true, buttons: 0 }]);
    assert.equal(v('prompts'), prompts, 'no change, no re-read');

    host.setInputDevice(0, DEVICE.GAMEPAD);
    await host.runFrame([{ connected: true, buttons: 0 }]);
    assert.equal(v('prompts'), prompts + 1, 'the revision moved within one frame');
    assert.equal(label(host, p), 'Cross');
    assert.equal(v('pedal_glyph'), glyphId(GLYPH.PLAYSTATION, IN.A));
    assert.equal(v('device'), DEVICE.GAMEPAD);

    host.setActionBinding(0, 1, IN.RTRIGGER); // the player puts Pedal on R2
    await host.runFrame([{ connected: true, buttons: BUTTON.A, rightTrigger: 30000 }]);
    assert.equal(label(host, p), 'R2', 'origins reflect the remap');
    assert.equal(v('pedal'), 1, 'state reflects the remap (trigger past half)');
    await host.runFrame([{ connected: true, buttons: BUTTON.A, rightTrigger: 0 }]);
    assert.equal(v('pedal'), 0, 'MUST FAIL control: A no longer pedals after the remap');

    host.setActionBinding(0, 1, null);
    await host.runFrame([{ connected: true, buttons: BUTTON.A }]);
    assert.equal(v('pedal_len'), 0, 'unbound');
    assert.equal(v('pedal'), 0);
    host.setActionBinding(0, 1, undefined);
    await host.runFrame([{ connected: true, buttons: BUTTON.A }]);
    assert.equal(v('pedal'), 1, 'back to the default');
    host.destroy();
  });
}

test('MUST FAIL: an action outside the active set reads 0', () => {
  let pads = [{ connected: true, buttons: BUTTON.A }];
  const t = new ActionTable({ getPads: () => pads });
  const menu = t.addSet('menu'); const drive = t.addSet('driving');
  const confirm = t.add(menu, 0, IN.A, 'Confirm');
  const pedal = t.add(drive, 0, IN.A, 'Pedal');
  assert.equal(t.digital(0, confirm), 1, 'set 0 is active by default');
  assert.equal(t.digital(0, pedal), 0);
  t.activate(0, drive);
  assert.equal(t.digital(0, confirm), 0);
  assert.equal(t.digital(0, pedal), 1);
  assert.equal(t.digital(1, confirm), 0, 'player 1 has no pad');
  pads = [];
  assert.equal(t.digital(0, pedal), 0, 'disconnected pad: nothing pressed');
});

test('MUST FAIL: bad declarations are refused, limits hold', () => {
  const t = new ActionTable({ getPads: () => [] });
  const s = t.addSet('s');
  assert.equal(t.add(5, 0, IN.A, 'x'), -1, 'unknown set');
  assert.equal(t.add(s, 0, 25, 'x'), -1, 'not an input');
  assert.equal(t.add(s, 0, IN.A, ''), -1, 'no name');
  const a = t.add(s, 0, IN.A, 'x');
  assert.equal(t.add(s, 1, IN.A, 'x'), -1, 'same name, different kind');
  assert.equal(t.add(s, 0, -1, 'unbound by default'), a + 1);
  for (let i = 0; i < 70; i++) t.add(s, 0, IN.A, `a${i}`);
  assert.equal(t.actions.length, 64);
});

test('origin labels truncate on a codepoint and NUL-terminate; the revision skips 0', () => {
  const mem = new Uint8Array(64);
  const t = new ActionTable({ getPads: () => [] });
  t.add(t.addSet('s'), 0, IN.A, 'a');
  t.setDescriber(() => ({ label: 'Ünter' }));
  const imp = t.imports(() => mem);
  assert.equal(imp.wc_action_origin(0, 0, 0, 3), 6, 'full length returned');
  assert.deepEqual([...mem.subarray(0, 3)], [0xc3, 0x9c, 0], '"Ü" fits, NUL after it');
  assert.equal(imp.wc_action_origin(0, 0, 0, 2), 6);
  assert.equal(mem[0], 0, 'half a codepoint is never written');
  assert.equal(imp.wc_action_origin(0, 9, 0, 8), -1, 'unknown action');
  t.revision = 0xffffffff; t.bump();
  assert.equal(t.revision, 1);
});

test('pad families and labels', () => {
  assert.equal(padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)'), GLYPH.XBOX);
  assert.equal(padFamily('DualSense Wireless Controller'), GLYPH.PLAYSTATION);
  assert.equal(padFamily('Nintendo Switch Pro Controller'), GLYPH.NINTENDO);
  assert.equal(padFamily('8BitDo'), GLYPH.GAMEPAD);
  assert.equal(padOrigin(GLYPH.NINTENDO, IN.A).label, 'B', 'south on a Nintendo pad is B');
  assert.equal(padOrigin(GLYPH.XBOX, IN.TOUCHPAD), null, 'no touchpad on an Xbox pad');
});

test('CartHostWeb with no describer answers from the Gamepad API pad', async () => {
  const p = await ptrs();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true,
    value: { getGamepads: () => [{ connected: true, id: 'Xbox Wireless Controller', mapping: 'standard' }] } });
  try {
    const host = new CartHostWeb();
    await host.load(new Uint8Array(readFileSync(CART)), {});
    await host.runFrame([{ connected: true, buttons: 0 }]);
    assert.equal(label(host, p), 'A');
    assert.equal(reader(host, p)('device'), DEVICE.GAMEPAD);
    host.destroy();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
  }
});

test('the action imports are real on every instantiation path', () => {
  // CartHostWeb and the workers auto-stub unknown env imports, which would
  // link and then answer 0 ("unbound") where the truth is -1 ("unknown").
  for (const f of ['../src/CartHost.js', '../src/CartHostWeb.js']) {
    assert.ok(readFileSync(join(HERE, f), 'utf8').includes('...this._actions.imports('), f);
  }
  for (const f of ['../src/cartWorker.js', '../src/cartWorkerWeb.js']) {
    assert.ok(readFileSync(join(HERE, f), 'utf8').includes('...WORKER_ACTION_IMPORTS'), f);
  }
  const t = new ActionTable({ getPads: () => [] });
  assert.deepEqual(Object.keys(t.imports(() => new Uint8Array(0))).sort(), [...IMPORTS].sort());
});
