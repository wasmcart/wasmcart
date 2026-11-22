import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BUTTON } from '../src/abi.js';
import { FOOT_SWITCHES, reportButtons, openFootSwitches } from '../src/footSwitch.js';

const RS = FOOT_SWITCHES[0];
const report = (b) => Buffer.from([0, 0, b, 0, 0, 0, 0, 0]);

test('Olympus RS pedals map left/middle/right to west/south/east', () => {
  assert.equal(reportButtons(RS, report(0x04)), BUTTON.X);
  assert.equal(reportButtons(RS, report(0x02)), BUTTON.A);
  assert.equal(reportButtons(RS, report(0x01)), BUTTON.B);
  assert.equal(reportButtons(RS, report(0x07)), BUTTON.X | BUTTON.A | BUTTON.B);
  assert.equal(reportButtons(RS, report(0x00)), 0);
});

function fakeHid(devices) {
  const opened = [];
  class HID extends EventEmitter {
    constructor(path) { super(); this.path = path; this.closed = false; opened.push(this); }
    close() { this.closed = true; }
  }
  return { hid: { devices: () => devices, HID }, opened };
}

test('held pedals reach buttons(); an unplug releases them', async () => {
  const devs = [{ vendorId: 0x07b4, productId: 0x0218, path: 'p1' }];
  const { hid, opened } = fakeHid(devs);
  const fs = await openFootSwitches({ hid });
  assert.equal(opened.length, 1);
  assert.equal(fs.buttons(), 0);
  opened[0].emit('data', report(0x06));
  assert.equal(fs.buttons(), BUTTON.X | BUTTON.A);
  opened[0].emit('error', new Error('unplugged'));
  assert.equal(fs.buttons(), 0);
  assert.equal(opened[0].closed, true);
  fs.close();
});

test('unknown HID devices are ignored; a pedal plugged in later is picked up', async () => {
  const devs = [{ vendorId: 0x1234, productId: 0x5678, path: 'kbd' }];
  const { hid, opened } = fakeHid(devs);
  const fs = await openFootSwitches({ hid, pollMs: 10 });
  assert.equal(opened.length, 0);
  devs.push({ vendorId: 0x07b4, productId: 0x0218, path: 'p2' });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(opened.length, 1);
  opened[0].emit('data', report(0x01));
  assert.equal(fs.buttons(), BUTTON.B);
  fs.close();
  assert.equal(opened[0].closed, true);
});
