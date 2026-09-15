import { rmSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Bound an endless response while retaining the .wasc format's large-archive
// use case. The download is streamed to disk rather than retained in memory.
export const MAX_REMOTE_CART_BYTES = 4 * 1024 * 1024 * 1024;

export function isRemoteCart(source) {
  try {
    const protocol = new URL(source).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Download an HTTP(S) cart to a temporary file for CartHost's lazy ZIP reader. */
export async function downloadRemoteCart(url, options = {}) {
  if (!isRemoteCart(url)) return null;

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('this Node.js runtime has no fetch implementation');
  }

  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow' });
  } catch (error) {
    throw new Error(`could not fetch ${url}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`could not fetch ${url}: HTTP ${response.status} ${response.statusText}`.trim());
  }

  const maxBytes = options.maxBytes ?? MAX_REMOTE_CART_BYTES;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`remote cart is too large (${declaredLength} bytes; limit ${maxBytes})`);
  }
  if (!response.body) throw new Error(`could not fetch ${url}: response has no body`);

  const dir = await mkdtemp(join(tmpdir(), 'wasmcart-remote-'));
  const path = join(dir, 'cart.wasc');
  const file = await open(path, 'w');
  let bytes = 0;

  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await response.body.cancel().catch(() => {});
        throw new Error(`remote cart is too large (limit ${maxBytes} bytes)`);
      }
      await file.write(chunk);
    }
    await file.close();
  } catch (error) {
    try { await file.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  return {
    path,
    bytes,
    url: response.url || url,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
