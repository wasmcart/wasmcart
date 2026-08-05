# Networking - Design Notes

## The concept

wasmcart has a handful of top-level concepts: display, input, audio, saving,
time, and multiplayer. **Multiplayer is two unrelated things**, and conflating
them is the mistake this document exists to avoid:

- **Local multiplayer** - several gamepads, one screen. This is *input*. There
  is no transport, no latency, no failure mode, nothing asynchronous. It has
  nothing to do with the rest of this document. See [input.md](input.md).
- **Network play** - the cart talks to something that isn't on this machine.
  That is what follows.

Emulators tie these together: RetroArch's rollback netplay exists specifically
to make network play *impersonate* local play, by keeping two machines
bit-identical and shipping only controller input between them. wasmcart does
not inherit that constraint and should not inherit the conflation. A wasmcart
cart ships its own netcode and does real networked play - lobbies, persistent
servers, asymmetric roles, whatever the game wants.

## One concept: the peer connection

There is exactly one networking primitive: a **connection to a peer**.

A cart does four things with it: open one, send bytes, receive bytes, and learn
when it opens or closes. That is the whole surface, and it is identical no
matter what the connection actually is underneath.

**The transport is the host's business.** A connection might be a WebSocket to
a server, a WebRTC data channel, direct TCP, a relay, MQTT, or a serial cable
if the host supports one. The cart cannot tell and must not care. This is what
makes a cart portable: the same binary works on a host with a matchmaking
service and on a host where you type in an IP address.

**There is no client/server split in the ABI.** Which end dialed which is a
host-side fact. Both ends just have connections. A cart may of course *behave*
as a server or a client - that is game logic, expressed in the messages it
sends - but the ABI does not distinguish, and a cart may hold as many
connections as it chooses to accept.

### Addressing

What a cart passes to open a connection is a string that **the host
interprets**. The spec deliberately does not define its grammar. Depending on
the host, meaningful addresses might look like:

```
wss://game.example.com/lobby     a WebSocket server
room:ABCD                        a room code, host does the signaling
192.168.1.7:9000                 a LAN peer
serial:/dev/ttyUSB0              a cable
```

A host that doesn't understand an address fails the open. That is the seam that
lets a serial cable and a WebRTC data channel be the same feature.

## Peer identity

A connection carries two things the cart needs to manage who is who:

- **Connection id** - a small integer, stable for the session. This is the
  handle. It is what the cart keys its player table on and what it passes to
  send.
- **Name** - a display string supplied by the host. A username, a room
  nickname, an OS account name, whatever identity the host has.

That is enough to run a game. The server-ish end tracks players by id and shows
names; the client end does the same.

**Normative, and the source of a real bug class:** the **id is the handle, the
name is display-only**. A cart MUST NOT assume names are unique, stable across
sessions, or trustworthy. A host with real accounts may guarantee all three; a
host that prompts for a nickname guarantees none. Names arrive from remote
machines, so they are attacker-controlled text: bound the length, do not assume
valid UTF-8, and never use one as a key for anything that matters.

### Transport info (optional)

A cart MAY ask what a connection's transport is like. Most carts never will.
It exists for the narrow case of a cart doing tight per-frame synchronization
that needs to know whether it is running over something with inherent latency,
or whether delivery is reliable and ordered, before it assumes it can.

It is optional in both directions: optional for the cart to ask, and **optional
for the host to answer** - a host that does not characterize its transport
reports unknown, and carts MUST handle that. It is a side query, not a field in
the peer info, so the common path stays id + name.

Prefer reporting *properties* (reliable, ordered, latency class) over a
transport name. A name invites carts to write `if (transport == "webrtc")`,
which re-couples them to the implementations this design exists to hide. A
human-readable name is fine for debug and UI display.

## What is deliberately NOT in the spec

**Auth and matchmaking are host territory.** They are *how a connection comes to
exist*; the cart's world begins the moment one exists and has an id and a name.
A host may do accounts, signed tokens, lobbies, room codes, LAN discovery, QR
codes, or nothing at all. None of it changes a line of cart code.

This is not just tidiness - it means a cart cannot leak a credential, cannot be
tricked into trusting an identity, and cannot get authentication wrong, because
it never participates in it. The host is the only thing holding credentials and
it never hands them down. The name field is where the two worlds meet: by the
time the cart sees a peer, the host has already decided who that peer is.

**Custom game attributes are cart-layer data.** Character select, team, color,
ready state, protocol version - a cart sends these itself as its first message
after connect, in its own format. They are not in the ABI. The host must never
parse cart traffic; the moment it does, it has invented a schema that
constrains every future game.

**Rollback netplay is not a wasmcart feature.** See below.

## Why not frontend rollback netplay

Worth recording, because it looks attractive until you check the numbers.

RetroArch-style rollback works by snapshotting emulator state every frame into a
ring buffer, then rewinding and replaying when remote input disagrees with what
was predicted. It works because emulator state is *tiny*: NES under 20 KB, SNES
around 200 KB.

A wasmcart cart's state is its entire linear memory, because there is nowhere
else for it to live. Declared memory in the shipped examples:

| Cart | Initial | Max |
|---|---|---|
| openarena | 1024 MB | 2048 MB |
| flare | 768 MB | 768 MB |
| neverputt, etr_4p | 128 MB | 2048 MB |
| craft | 64 MB | 2048 MB |
| small 2D arcade carts | 16 MB | 16 MB |
| lmdave | 2 MB | 2 MB |

A 30-frame ring at 128 MB is ~3.8 GB of buffer and a 128 MB `memcpy` every
frame - milliseconds of pure memory bandwidth before a single rollback happens.
At 768 MB it is off by orders of magnitude. The property that makes wasmcart
serialization *correct* (state is all in one place, so a snapshot can't miss a
latch the way an emulator core can) is exactly what makes it too big to snapshot
per frame.

Note this is not a wasmcart limitation so much as a general one: real fighting
games using GGPO hand-roll a small explicit rollback state precisely because
snapshotting a whole engine is impossible. A cart that wants rollback can do the
same thing, over ordinary peer connections, rolling back only the few hundred KB
it knows matter. That is a cart-author concern, not a spec one.

`retro_serialize` in the libretro bridge remains correct and useful for what it
is actually for - manual save states and regression snapshots, where a one-off
full-memory copy is fine.

## The ABI

The peer-connection family is normative in [SPEC.md](../SPEC.md#peer-connection):

```
wc_peer_open(addr, len)        wc_peer_close(id)
wc_peer_send(id, data, len)    wc_peer_broadcast(data, len)
wc_peer_state(id)              wc_peer_count()
wc_peer_id(index)              wc_peer_name(id, dest, max)
wc_peer_transport(id)          // optional, both ways

wc_peer_on_connect(id, name, len)   wc_peer_on_message(id, data, len)
wc_peer_on_disconnect(id)           wc_peer_on_error(id)
```

Gating is per DIRECTION. Connections the cart opens (`wc_peer_open`) need
`WC_FLAG_NET_PEER` **and** a manifest `net.domains` grant - dial-out is the
one capability where the cart's own declaration is not sufficient, because
reaching a remote machine the packager never anticipated is a permission the
packager grants. Peers the HOST registers (`addPeer()`) need only the cart's
flag: the host already chose that connection, so no manifest key permits it
(see "Bring your own transport" below).

Binary only. Text frames were dropped in the merge: they are meaningful for
WebSocket and meaningless for a serial cable or raw TCP, so framing belongs to
the cart.

### Manifest gating

`net.domains` is the shipped grant: the allowlist for addresses the cart may
dial, matched against the address itself (a `net.lan` grant does not open a
`wss://` address). The reference hosts currently accept only `ws:`/`wss:`
addresses from `wc_peer_open`.

Addresses are not always domains, so the DESIGN is per-transport-class grants,
each independently defaulting to denied - but `lan` and `serial` below are
**prospective**, reserved spellings; no host reads them yet:

```json
{
  "net": {
    "domains": ["game.example.com"],
    "lan": true,
    "serial": false
  }
}
```

### Superseded

This replaces two earlier families, `wc_ws_*` (WebSocket, client-only,
URL-addressed) and `wc_dc_*` (data channel, peer-to-peer, host-signalled).
`wc_ws_send` and `wc_dc_send` were the same function under two names; the split
forced a cart to care about how a connection was established, and meant a cart
written against a relay server could not run over a serial cable without a
rewrite.

`WC_FLAG_NET_DC` (0x04) is reserved and unused. `net.websocket` is superseded by
`net.domains`; hosts SHOULD still read it from older manifests.


## Bring your own transport

`wc_peer_open()` is only one way a peer appears. A host can also hand the cart a
connection it made itself, over anything at all:

```js
host.addPeer(peerId, name, channel, transport);
```

The cart cannot tell the difference. It sees an id and bytes either way, which is
the whole reason transport is absent from the ABI.

**No manifest grant is required, deliberately.** Grants exist because
`wc_peer_open()` lets the *cart* name a destination the packager may not have
anticipated. When the *host* establishes a connection it has already made that
decision, and requiring it to also write a manifest key permitting its own action
would be ceremony. Dial-out is allowlisted; host-supplied peers are not.

### The channel contract

Anything satisfying this shape works. It is three members, and it is deliberately
the same shape `WebSocket` and `RTCDataChannel` already have:

```js
const channel = {
  // The host calls this with a Uint8Array when the cart sends.
  send(bytes) { /* put bytes on your transport */ },

  // Assigned BY the host. Call it when bytes arrive.
  // `data` may be an ArrayBuffer or a Uint8Array.
  onmessage: null,

  // Assigned BY the host. Call it when the connection goes away;
  // the cart sees wc_peer_on_disconnect on the next frame.
  onclose: null,
};
```

The host assigns `onmessage` and `onclose` when you call `addPeer`, so do not set
them yourself — pass a fresh object, or one whose handlers you do not mind being
replaced.

### Ownership

**A channel you supply stays yours.** `destroy()` forgets it and stops delivering
its events, but does not close it, and detaches the handlers it assigned. A socket
the host dialled through `wc_peer_open()` *is* closed, because the host opened it.

That distinction lets one connection outlive a cart instance:

```js
await hostA.load(cartA);
hostA.addPeer(1, 'peer', channel);
// ...run...
hostA.destroy();            // channel survives

const hostB = new CartHost();
await hostB.load(cartB);
hostB.addPeer(1, 'peer', channel);   // same connection, different cart
```

The same applies to any long-lived connection a host keeps across cart loads.
Before 0.16.2 `destroy()` closed borrowed channels, so a transport that is
expensive to re-establish — a WebRTC data channel needs fresh signalling and ICE
— had to be rebuilt even though nothing about it had changed.

### Worked example: a relay standing in for peer-to-peer

`test/wsserver.mjs` has a `/relay/<room>` endpoint that forwards frames between
clients in a room. Because the cart cannot see transport, relaying over a plain
WebSocket exercises peer-to-peer semantics honestly — no WebRTC, no signalling,
no second machine:

```js
const ws = new WebSocket('ws://127.0.0.1:8787/relay/game1');
ws.binaryType = 'arraybuffer';
ws.onopen = () => host.addPeer(1, 'other-player', {
  send: (bytes) => ws.send(bytes),
  onmessage: null,   // host assigns
  onclose: null,     // host assigns
}, TRANSPORT_RELIABLE | TRANSPORT_ORDERED);
ws.onmessage = (e) => /* forward to the peer's onmessage */ 0;
```

`test/peer.test.js` drives this end to end against that server.

### WebRTC is a host decision, not an ABI one

Nothing here mentions `RTCPeerConnection`, and the reference hosts deliberately
do not implement it. Signalling, ICE and STUN/TURN configuration are policy a
host owns: a LAN socket, a serial link or a relay are all equally valid, and the
node host could not use a browser-only dependency anyway.

A host that wants WebRTC builds the `RTCPeerConnection`, waits for the data
channel to open, and passes it to `addPeer` — an `RTCDataChannel` already
satisfies the contract above. The ABI stays out of it.

## Related

- [fetch.md](fetch.md) - `wc_fetch`, request/response HTTP. Lower priority:
  games ship assets in the .wasc and peer connections cover real-time comms, so
  fetch is mainly leaderboards and analytics.
- [input.md](input.md) - gamepads, including local multiplayer.
