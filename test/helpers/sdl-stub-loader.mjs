/*
 * Loader hook that resolves @kmamal/sdl to a stub module, so the windowed
 * player can be driven in a process with no display and no audio device.
 * The stub returns whatever the probe put on globalThis, which lets the
 * probe own the fake window.
 */
export async function resolve(specifier, context, next) {
  if (specifier === '@kmamal/sdl') {
    return { url: 'wasmcart-test:sdl-stub', shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === 'wasmcart-test:sdl-stub') {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default globalThis.__WASMCART_TEST_SDL__;',
    };
  }
  return next(url, context);
}
