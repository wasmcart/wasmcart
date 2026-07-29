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
| tetris, invaders, pacman | 16 MB | 16 MB |
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

## Current ABI

Two families exist today. They predate the model above and do not yet match it.

**WebSocket** (`wc_ws_*`) - client-only, URL-addressed, allowlisted by domain in
the manifest. `wc_ws_open`, `wc_ws_close`, `wc_ws_send`, `wc_ws_send_text`,
`wc_ws_state`; callbacks `wc_ws_on_open`, `wc_ws_on_message`,
`wc_ws_on_message_text`, `wc_ws_on_close`, `wc_ws_on_error`.

**Data channel** (`wc_dc_*`) - peer-to-peer, host manages signaling, binary
only. `wc_dc_peer_count`, `wc_dc_peer_info`, `wc_dc_send`, `wc_dc_broadcast`;
callbacks `wc_dc_on_connect`, `wc_dc_on_disconnect`, `wc_dc_on_message`.

See [SPEC.md](../SPEC.md) for the authoritative definitions of both.

## Planned: merge into one family

Under the model above, `wc_ws_send` and `wc_dc_send` are the same function with
two names. The split makes a cart care about how a connection was established,
which is precisely the thing it should not know - and it means a cart written
against a relay server cannot run over a serial cable without a rewrite.

The merged surface is roughly:

```
open(address)          close(id)         send(id, data)    broadcast(data)
state(id)              peer_count()      peer_id(index)    peer_name(id, dest)
transport(id)          [optional]

on_connect(id, name)   on_message(id, data)
on_disconnect(id)      on_error(id)
```

`wc_dc_*` is already most of this. What it is missing is an explicit open and a
state query; what it gets wrong is the name - "dc" says WebRTC, the one
implementation detail this design most wants to hide.

### Open questions

Both are decisions rather than problems, and both should be settled before
anything is renamed:

- **Text frames.** `wc_ws_send_text` / `wc_ws_on_message_text` are meaningful
  for WebSocket and meaningless for a serial cable or raw TCP. Under one family
  they become either a transport-specific wart or something dropped in favor of
  binary-only with carts doing their own framing. The two families currently
  disagree with each other about this: the `wc_dc_*` notes already say "binary
  only - games serialize their own protocols".
- **Manifest gating.** `net.websocket` is a domain allowlist, which does not
  describe a serial port or a LAN peer. Gating likely has to become
  per-transport-class - internet hosts allowlisted by domain as today, with
  LAN, local, and serial as separate coarse grants. This is the security story,
  so it is the part that cannot be quietly changed later.

A rename is cheap now and expensive after carts adopt `wc_ws_*`.

## Related

- [fetch.md](fetch.md) - `wc_fetch`, request/response HTTP. Lower priority:
  games ship assets in the .wasc and peer connections cover real-time comms, so
  fetch is mainly leaderboards and analytics.
- [input.md](input.md) - gamepads, including local multiplayer.
