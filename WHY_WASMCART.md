# Why wasmcart?

wasmcart sits between fantasy consoles (too constrained for real games) and full game engines (too heavy, not sandboxed). It's a portable, sandboxed game cartridge format with no artificial limits.

## For Players

- **Zero install** - a `.wasc` file is a single self-contained artifact. No dependencies, no drivers, no runtime. Click or run, game is playing.
- **True sandbox** - WASM provides real security guarantees: no filesystem access, no arbitrary network (only manifest-declared domains), no syscalls. Run untrusted carts safely.
- **Runs everywhere** - the same cart runs in a browser, in a terminal, on ARM handhelds (Knulli, Raspberry Pi), on desktop. The host adapts to the platform, the cart doesn't care.
- **Retro console feel** - load a cart, play. No launcher, no store, no account, no updates. Simple and immediate.

## For Developers

- **No artificial constraints** - unlike PICO-8 (128x128, 16 colors) or TIC-80, there's no resolution cap, color limit, or code size restriction. Full OpenGL ES 3.0, float audio, up to 4GB of assets. Port Quake III Arena or write a 2KB snake game - same ABI.
- **Any language** - anything that compiles to WASM works: C, C++, Rust, Zig, Go, AssemblyScript. The ABI is three exported functions and a struct.
- **Port existing games easily** - the SDL2 backend approach lets existing SDL2/C games run with minimal new code. 16+ games already ported including DOOM, Neverball, OpenArena, Celeste, Extreme Tux Racer, and full Godot 4.4 engine games.
- **One build, every platform** - no cross-compilation. A single `.wasc` file runs on the web, Node.js, ARM handhelds, and terminal renderers. The host handles GL, audio, and input.
- **Opt-in complexity** - a minimal cart is ~40 lines of C. Need mouse input? Set `"pointer": true`. Need networking? Add a WebSocket domain allowlist. Need peer-to-peer? Enable data channels. The ABI grows with the game's needs, not upfront.
- **GPU access is real** - GLES3/WebGL2 draw calls go straight to the hardware GPU. No emulation, no translation layer. The WASM performance tax only applies to game logic between frames.
- **Modern hardware has headroom** - WASM SIMD + threads handle CPU-bound work. Real GPU handles rendering. Games up through PS3/360-era complexity (2012 and earlier) run comfortably on any modern x86 or Apple Silicon machine.
- **GLES3 is the practical limit, not CPU** - the ceiling isn't WASM performance. It's the GPU API surface (no compute shaders, no tessellation) and the 4GB WASM32 memory cap. For the vast catalog of games that fit within those bounds, performance is not a concern.
