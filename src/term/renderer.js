/*
 * The terminal player's renderer: `render(rgba, width, height, cols, rows)`
 * resolves to `rows` lines of ANSI. `halfblock` renders inline (it is a
 * single pass over the cells); every chafa mode runs in a worker thread.
 */
import { Worker } from 'node:worker_threads';
import { renderHalfblock } from './halfblock.js';
import { applyContrast } from './options.js';

/**
 * @param {{symbols:string, colors:string, fgOnly:boolean, dither:boolean, contrast:number}} opts
 * @returns {{ render(rgba: Uint8Array, width: number, height: number, cols: number, rows: number): Promise<string>, close(): Promise<void> }}
 * `rgba` is top-down RGBA and is consumed (the chafa path transfers it).
 */
export function createTermRenderer(opts) {
  if (opts.symbols === 'halfblock') {
    return {
      async render(rgba, w, h, cols, rows) {
        if (opts.contrast !== 1) applyContrast(rgba, opts.contrast);
        return renderHalfblock(rgba, w, h, cols, rows);
      },
      async close() {},
    };
  }
  const worker = new Worker(new URL('./chafaWorker.js', import.meta.url));
  worker.unref();
  const pending = new Map();
  let nextId = 1, failure = null;
  const fail = (e) => {
    failure = e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  worker.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`chafa: ${m.error}`)); else p.resolve(m.ansi);
  });
  worker.on('error', fail);
  worker.on('exit', (code) => { if (code) fail(new Error(`chafa worker exited ${code}`)); });
  const o = { symbols: opts.symbols, colors: opts.colors, fgOnly: !!opts.fgOnly, dither: !!opts.dither, contrast: opts.contrast };
  return {
    render(rgba, width, height, cols, rows) {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      const buf = rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength ? rgba.buffer : rgba.slice().buffer;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, rgba: buf, width, height, cols, rows, opts: o }, [buf]);
      });
    },
    async close() { await worker.terminate(); },
  };
}
