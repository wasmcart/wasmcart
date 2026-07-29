// Peer-connection ABI (v3) — drives a real cart that imports wc_peer_* and
// exports the four callbacks, through the reference host. Uses a fake channel
// for host-registered peers so nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CartHost } from '../index.js';
import {
  PEER_OPEN, PEER_CLOSED, TRANSPORT_UNKNOWN,
  TRANSPORT_RELIABLE, TRANSPORT_ORDERED,
} from '../src/abi.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PEERNET = join(HERE, 'fixtures', 'peernet.wasc');

/** A stand-in for a host-managed channel (WebRTC, LAN, serial — cart can't tell). */
function fakeChannel() {
  const sent = [];
  return {
    sent,
    send(bytes) { sent.push(Uint8Array.from(bytes)); },
    close() { this.onclose?.(); },
    onmessage: null,
    onclose: null,
  };
}

/** Repack the fixture with a given manifest so we can vary the net grant. */
async function loadWith(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-peer-'));
  const wasc = readFileSync(PEERNET);
  const path = join(dir, 'cart.wasc');
  writeFileSync(path, wasc);
  const cart = new CartHost();
  await cart.load(path);
  if (manifest !== undefined) cart._manifest = manifest;
  // load() resolves the WebSocket impl eagerly only when the packed manifest
  // asked for networking. These tests swap the manifest in afterwards, so inject
  // a stub here — otherwise every open fails on "no WebSocket" and the gate
  // assertions below would pass without exercising a single gate.
  cart._WebSocketImpl = class StubWebSocket {
    constructor(url) {
      StubWebSocket.opened.push(url);
      this.url = url;
      this.readyState = 1;
      this.binaryType = 'blob';
    }
    send() {}
    close() {}
  };
  cart._WebSocketImpl.opened = [];
  return {
    cart,
    opened: () => cart._WebSocketImpl.opened,
    cleanup: () => { cart.destroy(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const str = (cart, s) => {
  // Park a string in the cart's scratch buffer and return [ptr, len].
  const ptr = cart.instance.exports.t_scratch();
  const bytes = new TextEncoder().encode(s);
  new Uint8Array(cart.memory.buffer).set(bytes, ptr);
  return [ptr, bytes.length];
};

const readCStr = (cart, ptr) => {
  const u8 = new Uint8Array(cart.memory.buffer);
  let end = ptr;
  while (u8[end] !== 0) end++;
  return new TextDecoder().decode(u8.slice(ptr, end));
};

test('cart declaring WC_FLAG_NET_PEER is reported as wanting net', async () => {
  const { cart, cleanup } = await loadWith({ net: { domains: ['example.com'] } });
  assert.equal(cart.getInfo().wantsNet, true);
  cleanup();
});

test('host-registered peers are visible to the cart by id and name', async () => {
  const { cart, cleanup } = await loadWith({ net: { lan: true } });
  const ex = cart.instance.exports;
  const ch = fakeChannel();

  cart.addPeer(7, 'luis', ch, TRANSPORT_RELIABLE | TRANSPORT_ORDERED);

  assert.equal(ex.t_count(), 1, 'peer_count sees the registered peer');
  assert.equal(ex.t_id_at(0), 7, 'peer_id enumerates the real id');
  assert.equal(ex.t_state(7), PEER_OPEN);
  assert.equal(ex.t_transport(7), TRANSPORT_RELIABLE | TRANSPORT_ORDERED);

  const dest = ex.t_scratch();
  const n = ex.t_name(7, dest, 64);
  assert.ok(n > 0, 'peer_name returns bytes written');
  assert.equal(readCStr(cart, dest), 'luis');
  cleanup();
});

test('connect / message / disconnect reach the cart callbacks', async () => {
  const { cart, cleanup } = await loadWith({ net: { lan: true } });
  const ex = cart.instance.exports;
  const ch = fakeChannel();

  cart.addPeer(3, 'peer3', ch, TRANSPORT_UNKNOWN);
  cart.runFrame([]);
  assert.equal(ex.t_connects(), 1, 'on_connect fired');
  assert.equal(ex.t_last_peer(), 3, 'callback carries the peer id');
  assert.equal(readCStr(cart, ex.t_last_name_ptr()), 'peer3');

  ch.onmessage({ data: new Uint8Array([1, 2, 3, 4]) });
  cart.runFrame([]);
  assert.equal(ex.t_messages(), 1, 'on_message fired');
  assert.equal(ex.t_last_msg_len(), 4);
  const msg = new Uint8Array(cart.memory.buffer, ex.t_last_msg_ptr(), 4);
  assert.deepEqual([...msg], [1, 2, 3, 4], 'payload arrived intact');

  ch.close();
  cart.runFrame([]);
  assert.equal(ex.t_disconnects(), 1, 'on_disconnect fired');
  assert.equal(ex.t_state(3), PEER_CLOSED, 'state flips to CLOSED after disconnect');
  cleanup();
});

test('send and broadcast reach the channel', async () => {
  const { cart, cleanup } = await loadWith({ net: { lan: true } });
  const ex = cart.instance.exports;
  const a = fakeChannel(), b = fakeChannel();
  cart.addPeer(1, 'a', a);
  cart.addPeer(2, 'b', b);

  const [ptr, len] = str(cart, 'hi');
  assert.equal(ex.t_send(1, ptr, len), len, 'send returns bytes sent');
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0, 'send is unicast');
  assert.deepEqual([...a.sent[0]], [...new TextEncoder().encode('hi')]);

  assert.equal(ex.t_broadcast(ptr, len), 2, 'broadcast returns peer count');
  assert.equal(a.sent.length, 2);
  assert.equal(b.sent.length, 1);
  cleanup();
});

test('peer_name always NUL-terminates, truncating the text not the terminator', async () => {
  const { cart, cleanup } = await loadWith({ net: { lan: true } });
  const ex = cart.instance.exports;
  cart.addPeer(1, 'a-very-long-display-name', fakeChannel());

  const dest = ex.t_scratch();
  new Uint8Array(cart.memory.buffer).fill(0xAA, dest, dest + 16);
  const n = ex.t_name(1, dest, 8);
  assert.equal(n, 8, 'writes exactly max_len bytes (7 text + NUL)');
  assert.equal(readCStr(cart, dest), 'a-very-', 'text truncated to fit');
  assert.equal(new Uint8Array(cart.memory.buffer)[dest + 7], 0, 'terminator survives');
  cleanup();
});

test('unknown peer ids fail closed rather than throwing', async () => {
  const { cart, cleanup } = await loadWith({ net: { lan: true } });
  const ex = cart.instance.exports;
  assert.equal(ex.t_state(999), PEER_CLOSED);
  assert.equal(ex.t_transport(999), TRANSPORT_UNKNOWN);
  assert.equal(ex.t_name(999, ex.t_scratch(), 32), -1);
  assert.equal(ex.t_id_at(0), -1, 'index past the end returns -1');
  const [ptr, len] = str(cart, 'x');
  assert.equal(ex.t_send(999, ptr, len), -1);
  assert.equal(ex.t_broadcast(ptr, len), -1, 'broadcast with no peers is an error');
  cleanup();
});

// --- Controls: these MUST fail to open. If they pass, the gate is broken. ---

test('CONTROL: open fails with no manifest net grant', async () => {
  const { cart, cleanup } = await loadWith({});
  const [ptr, len] = str(cart, 'wss://example.com/x');
  assert.equal(cart.instance.exports.t_open(ptr, len), -1, 'no net object = denied');
  cleanup();
});

test('CONTROL: open fails for a domain outside the allowlist', async () => {
  const { cart, cleanup } = await loadWith({ net: { domains: ['allowed.example'] } });
  const [ptr, len] = str(cart, 'wss://evil.example/x');
  assert.equal(cart.instance.exports.t_open(ptr, len), -1, 'unlisted domain = denied');
  cleanup();
});

test('CONTROL: open fails for a transport class the manifest never granted', async () => {
  // net.lan is granted, but a ws:// address is a domain-class transport and
  // net.domains is absent — the grant must not leak across classes.
  const { cart, cleanup } = await loadWith({ net: { lan: true } });
  const [ptr, len] = str(cart, 'wss://example.com/x');
  assert.equal(cart.instance.exports.t_open(ptr, len), -1, 'lan grant is not a domain grant');
  cleanup();
});

test('CONTROL: open fails for an address this host cannot interpret', async () => {
  const { cart, cleanup } = await loadWith({ net: { domains: ['example.com'], serial: true } });
  for (const addr of ['serial:/dev/ttyUSB0', 'room:ABCD', 'not-a-url']) {
    const [ptr, len] = str(cart, addr);
    assert.equal(cart.instance.exports.t_open(ptr, len), -1, `${addr} is not implemented here`);
  }
  cleanup();
});

test('net.websocket is still honoured as the superseded spelling', async () => {
  const { cart, cleanup } = await loadWith({ net: { websocket: ['listed.example'] } });
  const [p1, l1] = str(cart, 'wss://unlisted.example/x');
  assert.equal(cart.instance.exports.t_open(p1, l1), -1, 'unlisted still denied');
  const [p2, l2] = str(cart, 'wss://listed.example/x');
  assert.ok(cart.instance.exports.t_open(p2, l2) >= 0, 'old manifest key still grants');
  cleanup();
});

test('a granted, allowlisted address DOES open — proving the controls discriminate', async () => {
  const { cart, opened, cleanup } = await loadWith({ net: { domains: ['allowed.example'] } });
  const [ptr, len] = str(cart, 'wss://allowed.example/lobby');
  const id = cart.instance.exports.t_open(ptr, len);
  assert.ok(id >= 0, 'granted + allowlisted opens');
  assert.deepEqual(opened(), ['wss://allowed.example/lobby'], 'host dialed the address');
  assert.equal(cart.instance.exports.t_count(), 1, 'the connection is an enumerable peer');
  assert.equal(cart.instance.exports.t_id_at(0), id);
  cleanup();
});

// --- The gate is asymmetric by design: dialing out is gated, being handed a
// --- peer is not. Both directions pinned, since either drifting is a security
// --- change that would otherwise pass silently.

test('a host-registered peer needs NO manifest grant', async () => {
  const { cart, cleanup } = await loadWith({});
  const ex = cart.instance.exports;
  cart.addPeer(1, 'host-chose-me', fakeChannel());
  assert.equal(ex.t_count(), 1, 'the host already made this decision');
  cart.runFrame([]);
  assert.equal(ex.t_connects(), 1, 'on_connect still fires with an empty manifest');
  cleanup();
});

test('CONTROL: the same cart still cannot dial out without a grant', async () => {
  // Same empty manifest as above. Proves the previous test is about direction,
  // not about the gate being switched off wholesale.
  const { cart, cleanup } = await loadWith({});
  const [ptr, len] = str(cart, 'wss://example.com/x');
  assert.equal(cart.instance.exports.t_open(ptr, len), -1);
  cleanup();
});
