// wasmcart ABI v3 definitions (backward compatible with v1 and v2)

export const ABI_VERSION = 3;
export const MIN_ABI_VERSION = 1; // oldest version we still support

// Button bitmask positions (matches common gamepad layout)
export const BUTTON = {
  A:       1 << 0,
  B:       1 << 1,
  X:       1 << 2,
  Y:       1 << 3,
  L:       1 << 4,
  R:       1 << 5,
  START:   1 << 6,
  SELECT:  1 << 7,
  UP:      1 << 8,
  DOWN:    1 << 9,
  LEFT:    1 << 10,
  RIGHT:   1 << 11,
  L3:      1 << 12,
  R3:      1 << 13,
};

// WCPad struct layout (16 bytes per pad)
// u16 buttons
// i16 left_x, left_y, right_x, right_y
// u8  left_trigger, right_trigger, connected, _pad
export const PAD_SIZE = 16;
export const MAX_PADS = 4;
export const INPUT_REGION_SIZE = PAD_SIZE * MAX_PADS; // 64 bytes

// WCTime struct layout (20 bytes)
// f64 time_ms (offset 0)
// f64 delta_ms (offset 8)
// u32 frame (offset 16)
export const TIME_SIZE = 20;

// WCInfo struct field offsets (returned by wc_get_info)
// All fields are u32
export const INFO_FIELDS = {
  VERSION:     0,
  WIDTH:       4,
  HEIGHT:      8,
  FB_PTR:      12,
  AUDIO_PTR:   16,
  AUDIO_CAP:   20,  // capacity in stereo frames
  AUDIO_WRITE: 24,  // cart's write cursor offset (pointer to u32 in cart memory)
  INPUT_PTR:   28,
  SAVE_PTR:    32,
  SAVE_SIZE:   36,
  TIME_PTR:    40,
  HOST_INFO_PTR: 44, // pointer to wc_host_info_t (host writes before wc_init)
};
export const INFO_STRUCT_SIZE = 48;

// WCHostInfo struct layout (written by host before wc_init)
// All fields are u32
export const HOST_INFO_FIELDS = {
  PREFERRED_WIDTH:  0,
  PREFERRED_HEIGHT: 4,
  HOST_FPS:         8,
  AUDIO_SAMPLE_RATE: 12,
  FLAGS:            16,
};
export const HOST_INFO_SIZE = 20;

// Cart info flags (wc_info_t.flags)
export const FLAG_AUDIO_F32 = 1 << 0;  // audio ring buffer uses float32
export const FLAG_NET_WS    = 1 << 1;  // cart wants WebSocket imports
export const FLAG_NET_DC    = 1 << 2;  // cart wants data channel imports
export const FLAG_POINTER   = 1 << 3;  // cart wants pointer input
export const FLAG_KEYBOARD  = 1 << 4;  // cart wants raw keyboard input

// Extended info fields (v3) - byte offsets from wc_info_t start
export const INFO_FIELDS_V3 = {
  POINTER_PTR: 56,  // u32 index 14
  KEYS_PTR:    60,  // u32 index 15
  GPU_API:     64,  // u32 index 16 - 0=2D, 1=WebGL2/GLES3, 2=WebGPU, 3=Vulkan
};

// GPU API values for wc_info_t.gpu_api
export const GPU_API_NONE    = 0;  // 2D framebuffer only
export const GPU_API_WEBGL2  = 1;  // WebGL2 / GLES3
export const GPU_API_WEBGPU  = 2;  // reserved
export const GPU_API_VULKAN  = 3;  // reserved

// Pointer struct layout (8 bytes per pointer)
// i16 x, i16 y, u8 buttons, u8 active, u8[2] pad
export const POINTER_SIZE = 8;
export const MAX_POINTERS = 10;
export const POINTER_REGION_SIZE = POINTER_SIZE * MAX_POINTERS; // 80 bytes

// Keyboard state bitmask size
export const KEYS_STATE_SIZE = 32; // 256 bits = 32 bytes
