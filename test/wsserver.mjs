/*
 * A minimal WebSocket server for testing wasmcart's networking, in two roles:
 *
 *   ECHO   — an outbound target. A cart calls wc_peer_open("ws://…/echo") and
 *            whatever it sends comes back. Exercises the dial-out path and the
 *            manifest allowlist gate.
 *
 *   RELAY  — a stand-in for peer-to-peer. Clients joining the same room are
 *            wired to each other, and anything one sends is forwarded to the
 *            others. That is the shape a data channel presents to the cart,
 *            without WebRTC, signalling, STUN, or a second machine.
 *
 * The point of the relay is that `wc_peer_*` deliberately hides transport: a
 * peer the host hands the cart is the same object whether it arrived over
 * WebRTC, a LAN socket or a serial cable. So a relay over plain WebSocket
 * exercises the ABI honestly — the cart cannot tell the difference, and that
 * is the property being tested.
 *
 * No dependencies: Node ships a WebSocket *client* but no server, and RFC 6455
 * is small enough that a test fixture should not pull in a package for it.
 * Limitations, all fine for tests and all deliberate: no TLS, no permessage-
 * deflate, no continuation frames, payloads < 64 KiB.
 *
 * Usage:
 *   node test/wsserver.mjs [--port 8787] [--verbose]
 *
 * Endpoints:
 *   ws://127.0.0.1:8787/echo         echo every frame back
 *   ws://127.0.0.1:8787/relay/<room> forward frames to everyone else in <room>
 *   ws://127.0.0.1:8787/drop         accept, then close immediately (error path)
 */

import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8787;
const verbose = args.includes('--verbose');
const log = (...a) => verbose && console.error('[wsserver]', ...a);

/** room name -> Set of connections */
const rooms = new Map();

function accept(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one frame. Server->client frames are never masked (RFC 6455 §5.1). */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    // Deliberately unsupported: a test fixture that silently truncated a large
    // payload would produce a confusing failure somewhere else entirely.
    throw new Error(`payload too large for this test server: ${len} bytes`);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Pull complete frames out of a buffer. Returns [frames, remainder] so a
 * partial frame stays buffered rather than being misread — TCP does not
 * preserve message boundaries, and pretending otherwise is the classic bug in
 * hand-rolled WebSocket code.
 */
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p); p += 8;
      if (big > 65535n) throw new Error('frame too large for this test server');
      len = Number(big);
    }
    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4); p += 4;
    }
    if (buf.length - p < len) break;  // incomplete: wait for more bytes
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ opcode, payload });
    off = p + len;
  }
  return [frames, buf.subarray(off)];
}

const server = createServer((sock) => {
  sock.on('error', () => {});           // a peer vanishing is normal here
  let handshaken = false;
  let buf = Buffer.alloc(0);
  let path = '/';
  let room = null;

  const send = (payload, opcode = 2) => {
    if (!sock.destroyed) sock.write(encodeFrame(opcode, payload));
  };

  const leave = () => {
    if (room && rooms.has(room)) {
      const set = rooms.get(room);
      set.delete(sock);
      if (set.size === 0) rooms.delete(room);
      log(`left ${room} (${set.size} remain)`);
    }
  };

  sock.on('close', leave);

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    if (!handshaken) {
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;                     // headers still arriving
      const head = buf.subarray(0, end).toString('utf8');
      buf = buf.subarray(end + 4);

      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1];
      path = /^GET\s+(\S+)/i.exec(head)?.[1] ?? '/';
      if (!key) { sock.destroy(); return; }

      sock.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`
      );
      handshaken = true;
      log(`open ${path}`);

      if (path === '/drop') { sock.end(); return; }

      if (path.startsWith('/relay/')) {
        room = path.slice('/relay/'.length) || 'default';
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(sock);
        log(`joined ${room} (${rooms.get(room).size} present)`);
      }
      return;
    }

    let frames;
    try {
      [frames, buf] = decodeFrames(buf);
    } catch (e) {
      log('protocol error:', e.message);
      sock.destroy();
      return;
    }

    for (const { opcode, payload } of frames) {
      if (opcode === 8) { sock.end(); return; }          // close
      if (opcode === 9) { send(payload, 10); continue; } // ping -> pong
      if (opcode !== 1 && opcode !== 2) continue;

      if (path === '/echo') {
        send(payload, opcode);
      } else if (room) {
        // Forward to everyone else in the room. Not back to the sender: a cart
        // receiving its own broadcast would look like a working peer and mask
        // the case where no peer is actually connected.
        for (const other of rooms.get(room) ?? []) {
          if (other !== sock && !other.destroyed) {
            other.write(encodeFrame(opcode, payload));
          }
        }
      }
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`wsserver listening on ws://127.0.0.1:${port}`);
  console.log(`  /echo         echo frames back`);
  console.log(`  /relay/<room> forward frames to others in <room>`);
  console.log(`  /drop         accept then close (error path)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); process.exit(0); });
}
