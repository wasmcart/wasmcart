# wc_fetch - Network Fetch ABI

## Motivation

Carts currently load local assets via `wc_load_asset` (synchronous, from .wasc bundle). There is no mechanism for carts to make HTTP requests to external servers. Games need this for:

- Loading level data or assets from a CDN
- Posting high scores / leaderboards
- User authentication
- Dynamic content updates
- Analytics

The WebSocket ABI (`wc_ws_*`) exists but is wrong for request/response patterns. A proper fetch ABI gives carts standard HTTP semantics.

## Design

### Manifest Allowlist

The .wasc `manifest.json` declares which domains the cart may fetch from:

```json
{
  "net": {
    "websocket": ["wss://game-server.example.com"],
    "fetch": ["https://api.example.com", "https://cdn.example.com"]
  }
}
```

The host validates every fetch URL against this allowlist before proxying. Domains not in the list get a 403 response. This is the security boundary - carts cannot make arbitrary network requests.

### URL Routing (Host Logic)

The host handles ALL fetch requests - both local and network:

1. **Relative path** (e.g. `sounds/laser.mp3`) → load from .wasc bundle. Same as current `wc_load_asset` but through the fetch ABI.
2. **Absolute URL on allowlist** (e.g. `https://api.example.com/scores`) → host proxies the request using native fetch (Node.js `fetch`, browser `fetch`).
3. **Absolute URL NOT on allowlist** → return 403 Forbidden.
4. **Absolute URL, no `net.fetch` in manifest** → return 403.

The cart never knows or cares whether the response came from the bundle or the network. This is transparent.

### Browser Hosts and CORS

In browser-based wasmcart hosts (e.g. a web page running a .wasc), the host's `fetch` call is subject to standard CORS rules. The API server must return `Access-Control-Allow-Origin` headers. This is the server's responsibility, not the cart's or the host's.

In Node.js hosts, there are no CORS restrictions - the host fetches directly.

### Proposed ABI

Fetch is inherently async. The wasmcart ABI is synchronous (wc_render is called per frame). Two approaches:

#### Option A: Callback-based (like WebSocket)

```c
// Cart imports (host provides):
int wc_fetch_start(const char* url, uint32_t url_len,
                   const char* method, uint32_t method_len,
                   const char* headers, uint32_t headers_len,
                   const void* body, uint32_t body_len);
// Returns request_id, or -1 if URL not allowed.

int wc_fetch_state(int request_id);
// Returns: 0=pending, 1=complete, 2=error

int wc_fetch_response_status(int request_id);
// Returns HTTP status code (200, 404, etc.)

int wc_fetch_response_size(int request_id);
// Returns response body size in bytes, or -1 if not complete.

int wc_fetch_response_read(int request_id, void* buf, uint32_t buf_len);
// Copies response body into buf. Returns bytes copied.

void wc_fetch_response_free(int request_id);
// Frees the response. Cart must call this when done.

// Cart exports (host calls when response arrives):
void wc_fetch_on_complete(int request_id);
void wc_fetch_on_error(int request_id);
```

The host calls `wc_fetch_on_complete` during the next `wc_render` frame after the response arrives. The cart then reads the response synchronously.

#### Option B: Polling (simpler)

Same imports as above but without the callback exports. Cart polls `wc_fetch_state` each frame. Simpler but adds one frame of latency.

### Recommendation

Option A (callback-based) matches the WebSocket pattern and is lower latency. The host already calls into the cart during `wc_render` (for WebSocket messages), so the infrastructure exists.

### Impact on wasmcart-jsgame

The jsgame cart currently has its own C-level fetch implementation that calls `wc_load_asset` for relative paths and fails on absolute URLs. With `wc_fetch`:

1. **Remove C-level URL routing** - pass ALL fetch URLs to the host via `wc_fetch_start`
2. **Host handles routing** - relative paths → .wasc bundle, absolute → network proxy
3. **Simpler cart code** - no URL parsing, no asset loading logic in the cart
4. **Games get network access** - `fetch('https://api.example.com/scores')` just works (if manifest allows it)
5. **Same security model** - host enforces allowlist, cart can't bypass it

### Impact on existing carts

Existing carts that only use `wc_load_asset` continue working. `wc_fetch` is an additional import - carts that don't import it aren't affected. Hosts that don't implement it provide stubs (return -1 from `wc_fetch_start`).
