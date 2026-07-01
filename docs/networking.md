# Networking - Future Design Notes

## Current ABI

WebSocket client-only:
- `wc_ws_open(url, len)` - connect outbound
- `wc_ws_send` / `wc_ws_send_text` - send data
- `wc_ws_close` / `wc_ws_state` - lifecycle
- `wc_ws_on_open` / `wc_ws_on_message` / `wc_ws_on_close` - callbacks (host → cart)

Manifest allowlist controls which domains the cart can connect to.

## Planned: Peer-to-Peer Multiplayer

### Concept
One player "hosts", another "joins" - like classic LAN play. No cloud infrastructure required.

### Cart-Side API
The cart uses the same WebSocket ABI with one addition:

- `wc_ws_listen(port)` - cart thinks it's hosting a WebSocket server
- `wc_ws_on_connect(conn_id)` - host notifies cart of new peer
- All data flows through existing `wc_ws_send` / `wc_ws_on_message`

The cart has NO idea what transport is underneath.

### Host-Side Reality
The host implements "listen" as WebRTC data channels:

1. Cart calls `wc_ws_listen` → host creates WebRTC peer connection
2. Signaling handshake (SDP/ICE exchange) - could be:
   - Local network discovery (mDNS/broadcast)
   - QR code displayed on screen
   - Simple signaling server (tiny, stateless)
3. Data channel established → host calls `wc_ws_on_connect(conn_id)`
4. All subsequent send/receive goes through the data channel
5. Cart sees it as a normal WebSocket connection

### Why WebRTC Under the Hood
- **NAT traversal** - works over the internet, not just LAN
- **Peer-to-peer** - no relay server needed (STUN is free, Google/Cloudflare run public ones)
- **Low latency** - UDP-based data channels, ideal for games
- **No infrastructure** - the user doesn't need to run servers
- **Browser-compatible** - browser wasmcart hosts get WebRTC for free

### Why the Cart Doesn't Know
- Same ABI for LAN and internet play
- Cart code stays simple - just WebSocket send/receive
- Host can swap transport (WebRTC, actual WebSocket, Bluetooth, etc.) without cart changes
- Security - cart can't access raw WebRTC APIs (no fingerprinting, no media capture)

### Signaling Options (Lightweight)
- **QR code** - host player's screen shows QR with SDP offer, joining player scans it
- **Local network** - mDNS/UDP broadcast discovers peers on same WiFi
- **Room codes** - 4-digit code, tiny stateless signaling relay matches peers
- **Manual IP** - old school, type in the IP (works on LAN without any service)

### Example Flow
```
Player 1 (host):
  game calls wc_ws_listen(0)
  host creates WebRTC peer, shows room code "ABCD" on screen
  waits for peer...

Player 2 (join):
  game calls wc_ws_open("room:ABCD")
  host creates WebRTC peer, signals via room code
  data channel established

Both carts:
  wc_ws_on_connect(conn_id) fires
  wc_ws_send(conn_id, game_packet, len) - just works
  wc_ws_on_message(conn_id, data, len) - just works
```

## Planned: wc_fetch

See [fetch.md](fetch.md). Lower priority - games ship assets in .wasc, WebSocket covers real-time comms. Fetch is mainly for leaderboards/analytics which most non-browser games don't need.
