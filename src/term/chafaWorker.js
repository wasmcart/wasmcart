// The terminal player's chafa worker: renders frames off the main thread, so
// the cart's 60 Hz logic never waits on text conversion. Messages:
//   in  {id, rgba: ArrayBuffer, width, height, cols, rows, opts}
//   out {id, ansi} | {id, error}
import { parentPort } from 'node:worker_threads';
import { createChafaRenderer, loadChafa } from './chafaCore.js';

const ready = loadChafa().then(createChafaRenderer);

parentPort.on('message', async (m) => {
  try {
    const render = await ready;
    const ansi = render(new Uint8Array(m.rgba), m.width, m.height, m.cols, m.rows, m.opts);
    parentPort.postMessage({ id: m.id, ansi });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: e.message });
  }
});
