// GL teardown — a destroyed cart deletes every GL object it created.
//
// The object tables in webgl_imports.js track every buffer/texture/FBO/
// program/etc. the cart allocates, and until _releaseAll nothing ever walked
// them at end of life. On an OWNED context that is invisible (destroying the
// context frees everything); on a BORROWED context it is a leak with no
// ceiling, because the shared context outlives every cart. Measured on a
// romdev server driving formix gate suites through one shared offscreen
// context: VRAM climbed ~1 GB per burst of runs until the 8 GB card filled,
// then spilled into GTT -- GPU-mapped SYSTEM RAM -- reaching 26.69 GB of a
// 54 GB machine in ~90 minutes, invisible to ps/top the whole time. With
// _releaseAll wired into destroy(), the same bursts hold flat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CartHost } from '../index.js';
import { createWebGLImports } from '../src/webgl_imports.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLCART = path.join(HERE, 'fixtures', 'glcart.wasc');

/** Recording WebGL2 mock: every method exists, and creates return distinct
 *  objects so the delete side can be matched against them. */
function recordingGl(log) {
  let nextId = 1;
  return new Proxy({}, {
    get(t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      if (!(prop in t)) {
        t[prop] = (...args) => {
          log.push([String(prop), args.length]);
          // create* must return a truthy object; everything else 0 is fine.
          return String(prop).startsWith('create') ? { id: nextId++ } : 0;
        };
      }
      return t[prop];
    },
  });
}

/** Drive the import table the way cart code does: gen objects via wasm memory. */
function harness(log) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const funcs = createWebGLImports({
    getMemory: () => memory,
    ctx: recordingGl(log),
    getMalloc: () => null,
    nativeGL: null,
  });
  return { funcs, memory };
}

test('_releaseAll deletes every tracked object, in container-before-contents order', () => {
  const log = [];
  const { funcs, memory } = harness(log);

  // Allocate through the same entry points the cart uses.
  funcs.glGenTextures(3, 16);
  funcs.glGenBuffers(2, 64);
  funcs.glGenFramebuffers(1, 96);
  log.length = 0; // only interested in the teardown half

  funcs._releaseAll();

  const deletes = log.filter(([name]) => name.startsWith('delete')).map(([name]) => name);
  assert.equal(deletes.filter((d) => d === 'deleteTexture').length, 3, 'all three textures deleted');
  assert.equal(deletes.filter((d) => d === 'deleteBuffer').length, 2, 'both buffers deleted');
  assert.equal(deletes.filter((d) => d === 'deleteFramebuffer').length, 1, 'the framebuffer deleted');
  // Containers before contents: an FBO references textures/renderbuffers, so
  // deleting it first keeps every later delete a clean detach-free case.
  assert.ok(
    deletes.indexOf('deleteFramebuffer') < deletes.indexOf('deleteTexture'),
    'framebuffers must be deleted before the textures they may reference',
  );
});

test('_releaseAll resets the tables so ids restart cleanly -- and is safe twice', () => {
  const log = [];
  const { funcs } = harness(log);

  funcs.glGenTextures(2, 16);
  funcs._releaseAll();
  funcs._releaseAll(); // second call must be a no-op, not a double delete

  const deletesAfterFirst = log.filter(([n]) => n === 'deleteTexture').length;
  assert.equal(deletesAfterFirst, 2, 'exactly the two live textures, no double delete');

  // The tables kept their [null] slot: a new gen after release starts at id 1
  // again rather than colliding with stale entries.
  log.length = 0;
  funcs.glGenTextures(1, 16);
  assert.equal(log.filter(([n]) => n === 'createTexture').length, 1);
});

test('_releaseAll deletes the redirect FBO trio, which lives OUTSIDE the tables', () => {
  // The redirect FBO/texture/renderbuffer are created directly on the context
  // rather than through the object tables, so they leak separately if
  // teardown only sweeps the tables. (The redirect arms via CartHost only for
  // carts reporting a nonzero resolution, so it is exercised here through the
  // same funcs entry point CartHost uses.)
  const log = [];
  const { funcs } = harness(log);

  funcs._setupRedirectFBO(320, 240);
  assert.ok(log.some(([n]) => n === 'createFramebuffer'), 'redirect FBO was created');
  log.length = 0;

  funcs._releaseAll();

  const deletes = log.filter(([n]) => n.startsWith('delete')).map(([n]) => n);
  assert.ok(deletes.includes('deleteFramebuffer'), 'redirect FBO deleted');
  assert.ok(deletes.includes('deleteTexture'), 'redirect texture deleted');
  assert.ok(deletes.includes('deleteRenderbuffer'), 'redirect renderbuffer deleted');
});

test('destroy() invokes the GL release for a cart on a borrowed context', async () => {
  // The wiring half: whatever the cart created, destroy() must hand it to
  // _releaseAll. Asserted by spying the hook rather than by counting deletes,
  // because THIS fixture (glClear/glClearColor only, no reported resolution)
  // legitimately creates no objects -- the wiring is what must not regress.
  const host = new CartHost({ glBackend: recordingGl([]) });
  await host.load(GLCART);

  let released = false;
  assert.ok(host._glFuncs, 'a GL cart holds its import table');
  host._glFuncs._releaseAll = () => { released = true; };

  host.destroy();

  assert.equal(released, true, 'destroy() must release the GL objects');
});
