/*
 * wc_pcm_mixer.h - Multi-channel PCM audio mixer for wasmcart carts
 *
 * Single-header library providing a simple multi-channel audio mixer that
 * writes stereo output to the wasmcart ring buffer. Supports both S16 and
 * Float32 output formats. Includes a WAV file parser.
 *
 * USAGE:
 *   In exactly ONE .c/.cpp file:
 *     #define WC_PCM_MIXER_IMPLEMENTATION
 *     #include "wc_pcm_mixer.h"
 *
 *   In all other files that need the API:
 *     #include "wc_pcm_mixer.h"
 *
 * EXAMPLE:
 *   // In wc_init():
 *   wc_mixer_init();
 *
 *   // Load sounds from .wasc assets:
 *   unsigned char buf[512000];
 *   int len = wc_load_asset("sfx/boom.wav", 12, buf, sizeof(buf));
 *   int snd_boom = wc_mixer_load_wav(buf, len);
 *
 *   // Play a sound:
 *   wc_mixer_play(snd_boom, 1.0f, 0);  // volume 1.0, no loop
 *
 *   // In wc_render():
 *   int frames = time_based_frame_count();  // see below
 *   wc_mixer_mix(ring_buffer, ring_cap, &write_cursor, frames);
 *
 * IMPORTANT: Framerate and audio timing
 *
 *   The `frames` parameter to wc_mixer_mix() controls how many audio
 *   samples are written to the ring buffer each call. Getting this wrong
 *   causes choppy or stuttering audio.
 *
 *   BAD - fixed count assumes constant 60fps:
 *     wc_mixer_mix(..., host_rate / 60);   // 800 at 48kHz
 *     If a frame takes 33ms (loading, state transitions, GC), only 16.7ms
 *     of audio is written, leaving a gap. If two frames run in 8ms each,
 *     audio is written faster than real time, causing buffer overflow.
 *     This is especially noticeable in menus where frame timing is
 *     inconsistent (asset loading, screen transitions).
 *
 *   GOOD - time-based count adapts to actual frame timing:
 *     static uint32_t last_ms = 0;
 *     uint32_t now_ms = <your tick counter>;
 *     uint32_t delta = now_ms - last_ms;
 *     if (delta > 100) delta = 100;       // cap to avoid huge decode
 *     last_ms = now_ms;
 *     int frames = (int)((uint64_t)host_rate * delta / 1000);
 *     wc_mixer_mix(ring_buffer, ring_cap, &write_cursor, frames);
 *
 *   This produces exactly the right number of samples regardless of
 *   whether the frame took 8ms or 50ms, so audio stays smooth even
 *   when the game hitches.
 *
 * CONFIGURATION (define before including):
 *   WC_MIXER_MAX_SOUNDS   - max loaded sounds (default 32)
 *   WC_MIXER_MAX_CHANNELS - max simultaneous voices (default 16)
 *   WC_MIXER_RATE          - output sample rate (default 48000)
 */

#ifndef WC_PCM_MIXER_H
#define WC_PCM_MIXER_H

#include <stdint.h>

#ifndef WC_MIXER_MAX_SOUNDS
#define WC_MIXER_MAX_SOUNDS 32
#endif

#ifndef WC_MIXER_MAX_CHANNELS
#define WC_MIXER_MAX_CHANNELS 16
#endif

#ifndef WC_MIXER_RATE
#define WC_MIXER_RATE 48000
#endif

/* ── Sound slot (loaded PCM data) ─────────────────────────────────── */

typedef struct {
    int16_t *samples;       /* PCM data (interleaved if stereo) */
    int length;             /* length in frames (per channel) */
    int channels;           /* 1 = mono, 2 = stereo */
    int sample_rate;        /* original sample rate */
    int active;             /* 1 if slot is loaded */
} wc_sound_t;

/* ── Playback channel ─────────────────────────────────────────────── */

typedef struct {
    wc_sound_t *sound;      /* pointer to sound slot */
    uint32_t pos_frac;      /* playback position (16.16 fixed-point) */
    uint32_t step_frac;     /* step per output sample (16.16 fixed-point) */
    float volume;           /* 0.0 - 1.0 */
    float pan;              /* -1.0 (left) to 1.0 (right), 0.0 = center */
    int loop;               /* 1 = loop playback */
    int active;             /* 1 = channel is playing */
} wc_channel_t;

/* ── API ──────────────────────────────────────────────────────────── */

/* Initialize the mixer. Call once. */
void wc_mixer_init(void);

/*
 * Parse a WAV file buffer and load it into a sound slot.
 * Returns the sound slot index (0..MAX_SOUNDS-1), or -1 on error.
 * Supports 8-bit unsigned and 16-bit signed PCM, mono or stereo.
 */
int wc_mixer_load_wav(const unsigned char *data, int size);

/*
 * Load raw S16 PCM data directly (no WAV parsing).
 * Returns sound slot index or -1.
 */
int wc_mixer_load_raw(const int16_t *pcm, int length_frames,
                      int channels, int sample_rate);

/*
 * Play a loaded sound. Returns the channel index or -1 if all busy.
 *   sound_id - slot index from wc_mixer_load_wav/load_raw
 *   volume   - 0.0 to 1.0
 *   loop     - 1 to loop, 0 for one-shot
 */
int wc_mixer_play(int sound_id, float volume, int loop);

/*
 * Play with stereo panning.
 *   pan - -1.0 (full left) to 1.0 (full right), 0.0 = center
 */
int wc_mixer_play_pan(int sound_id, float volume, float pan, int loop);

/* Stop a specific channel. */
void wc_mixer_stop(int channel);

/* Stop all channels. */
void wc_mixer_stop_all(void);

/* Check if a channel is still playing. */
int wc_mixer_is_playing(int channel);

/* Set volume on an active channel. */
void wc_mixer_set_volume(int channel, float volume);

/*
 * Mix audio into the wasmcart ring buffer (S16 output).
 * Call this every frame (in wc_render or wc_audio_buf).
 *
 *   ring       - pointer to S16 stereo ring buffer
 *   cap        - ring buffer capacity in stereo frames
 *   write_cur  - pointer to write cursor (updated by this function)
 *   frames     - number of stereo frames to produce.
 *                Use time-based calculation (see header docs), NOT a
 *                fixed value, to avoid choppy audio on variable framerates.
 */
void wc_mixer_mix(int16_t *ring, uint32_t cap, uint32_t *write_cur, int frames);

/*
 * Mix audio into a Float32 wasmcart ring buffer.
 * Same as wc_mixer_mix but writes normalized floats [-1.0, 1.0].
 * Use this when the cart sets WC_FLAG_AUDIO_F32.
 */
void wc_mixer_mix_f32(float *ring, uint32_t cap, uint32_t *write_cur, int frames);

/* Free a loaded sound's memory. */
void wc_mixer_unload(int sound_id);

/* ── Direct access to state (for advanced use) ────────────────────── */

extern wc_sound_t   wc_mixer_sounds[WC_MIXER_MAX_SOUNDS];
extern wc_channel_t wc_mixer_channels[WC_MIXER_MAX_CHANNELS];

#endif /* WC_PCM_MIXER_H */


/* ════════════════════════════════════════════════════════════════════
 *  IMPLEMENTATION
 * ════════════════════════════════════════════════════════════════════ */

#ifdef WC_PCM_MIXER_IMPLEMENTATION

#include <string.h>
#include <stdlib.h>

wc_sound_t   wc_mixer_sounds[WC_MIXER_MAX_SOUNDS];
wc_channel_t wc_mixer_channels[WC_MIXER_MAX_CHANNELS];

void wc_mixer_init(void) {
    memset(wc_mixer_sounds, 0, sizeof(wc_mixer_sounds));
    memset(wc_mixer_channels, 0, sizeof(wc_mixer_channels));
}

/* ── WAV parser ───────────────────────────────────────────────────── */

int wc_mixer_load_wav(const unsigned char *data, int size) {
    if (size < 44) return -1;
    /* Check RIFF/WAVE header */
    if (data[0]!='R' || data[1]!='I' || data[2]!='F' || data[3]!='F') return -1;
    if (data[8]!='W' || data[9]!='A' || data[10]!='V' || data[11]!='E') return -1;

    int pos = 12;
    int fmt_found = 0;
    int num_channels = 1, sample_rate = 44100, bits_per_sample = 16;

    while (pos + 8 <= size) {
        int chunk_size = data[pos+4] | (data[pos+5]<<8) | (data[pos+6]<<16) | (data[pos+7]<<24);

        if (data[pos]=='f' && data[pos+1]=='m' && data[pos+2]=='t' && data[pos+3]==' ') {
            if (pos + 8 + 16 > size) return -1;
            num_channels    = data[pos+10] | (data[pos+11]<<8);
            sample_rate     = data[pos+12] | (data[pos+13]<<8) | (data[pos+14]<<16) | (data[pos+15]<<24);
            bits_per_sample = data[pos+22] | (data[pos+23]<<8);
            fmt_found = 1;
        }

        if (data[pos]=='d' && data[pos+1]=='a' && data[pos+2]=='t' && data[pos+3]=='a') {
            if (!fmt_found) return -1;
            int data_start = pos + 8;
            int data_size = chunk_size;
            if (data_start + data_size > size) data_size = size - data_start;

            int bytes_per_sample = bits_per_sample / 8;
            int total_samples = data_size / bytes_per_sample;
            int frames = total_samples / num_channels;

            /* Find free slot */
            int slot = -1;
            for (int i = 0; i < WC_MIXER_MAX_SOUNDS; i++) {
                if (!wc_mixer_sounds[i].active) { slot = i; break; }
            }
            if (slot < 0) return -1;

            /* Allocate and convert to S16 */
            int16_t *pcm = (int16_t*)malloc(total_samples * sizeof(int16_t));
            if (!pcm) return -1;

            if (bits_per_sample == 16) {
                memcpy(pcm, data + data_start, total_samples * 2);
            } else if (bits_per_sample == 8) {
                for (int i = 0; i < total_samples; i++)
                    pcm[i] = ((int16_t)data[data_start + i] - 128) * 256;
            } else {
                free(pcm);
                return -1;
            }

            wc_mixer_sounds[slot].samples     = pcm;
            wc_mixer_sounds[slot].length      = frames;
            wc_mixer_sounds[slot].channels    = num_channels;
            wc_mixer_sounds[slot].sample_rate = sample_rate;
            wc_mixer_sounds[slot].active      = 1;
            return slot;
        }

        pos += 8 + chunk_size;
        if (chunk_size & 1) pos++; /* word alignment */
    }
    return -1;
}

int wc_mixer_load_raw(const int16_t *pcm, int length_frames,
                      int channels, int sample_rate) {
    int slot = -1;
    for (int i = 0; i < WC_MIXER_MAX_SOUNDS; i++) {
        if (!wc_mixer_sounds[i].active) { slot = i; break; }
    }
    if (slot < 0) return -1;

    int total = length_frames * channels;
    int16_t *copy = (int16_t*)malloc(total * sizeof(int16_t));
    if (!copy) return -1;
    memcpy(copy, pcm, total * sizeof(int16_t));

    wc_mixer_sounds[slot].samples     = copy;
    wc_mixer_sounds[slot].length      = length_frames;
    wc_mixer_sounds[slot].channels    = channels;
    wc_mixer_sounds[slot].sample_rate = sample_rate;
    wc_mixer_sounds[slot].active      = 1;
    return slot;
}

/* ── Playback control ─────────────────────────────────────────────── */

int wc_mixer_play(int sound_id, float volume, int loop) {
    return wc_mixer_play_pan(sound_id, volume, 0.0f, loop);
}

int wc_mixer_play_pan(int sound_id, float volume, float pan, int loop) {
    if (sound_id < 0 || sound_id >= WC_MIXER_MAX_SOUNDS) return -1;
    if (!wc_mixer_sounds[sound_id].active) return -1;

    /* Find free channel */
    int ch = -1;
    for (int i = 0; i < WC_MIXER_MAX_CHANNELS; i++) {
        if (!wc_mixer_channels[i].active) { ch = i; break; }
    }
    /* All busy: steal channel 0 */
    if (ch < 0) ch = 0;

    wc_sound_t *s = &wc_mixer_sounds[sound_id];
    wc_mixer_channels[ch].sound    = s;
    wc_mixer_channels[ch].pos_frac = 0;
    wc_mixer_channels[ch].step_frac = ((uint32_t)s->sample_rate << 16) / WC_MIXER_RATE;
    wc_mixer_channels[ch].volume   = volume;
    wc_mixer_channels[ch].pan      = pan;
    wc_mixer_channels[ch].loop     = loop;
    wc_mixer_channels[ch].active   = 1;
    return ch;
}

void wc_mixer_stop(int channel) {
    if (channel >= 0 && channel < WC_MIXER_MAX_CHANNELS)
        wc_mixer_channels[channel].active = 0;
}

void wc_mixer_stop_all(void) {
    for (int i = 0; i < WC_MIXER_MAX_CHANNELS; i++)
        wc_mixer_channels[i].active = 0;
}

int wc_mixer_is_playing(int channel) {
    if (channel < 0 || channel >= WC_MIXER_MAX_CHANNELS) return 0;
    return wc_mixer_channels[channel].active;
}

void wc_mixer_set_volume(int channel, float volume) {
    if (channel >= 0 && channel < WC_MIXER_MAX_CHANNELS)
        wc_mixer_channels[channel].volume = volume;
}

/* ── Mixer core ───────────────────────────────────────────────────── */

void wc_mixer_mix(int16_t *ring, uint32_t cap, uint32_t *write_cur, int frames) {
    if (!ring || cap == 0 || frames <= 0) return;

    uint32_t wr = *write_cur;

    for (int f = 0; f < frames; f++) {
        int32_t mix_left = 0, mix_right = 0;

        for (int ch = 0; ch < WC_MIXER_MAX_CHANNELS; ch++) {
            wc_channel_t *c = &wc_mixer_channels[ch];
            if (!c->active || !c->sound) continue;

            wc_sound_t *s = c->sound;
            uint32_t pos = c->pos_frac >> 16;

            if ((int)pos >= s->length) {
                if (c->loop) {
                    c->pos_frac = 0;
                    pos = 0;
                } else {
                    c->active = 0;
                    continue;
                }
            }

            /* Read sample */
            int32_t left, right;
            if (s->channels == 2) {
                left  = s->samples[pos * 2];
                right = s->samples[pos * 2 + 1];
            } else {
                left = right = s->samples[pos];
            }

            /* Apply volume */
            float vol = c->volume;
            left  = (int32_t)(left * vol);
            right = (int32_t)(right * vol);

            /* Apply panning: pan -1..1, 0=center */
            if (c->pan != 0.0f) {
                float pan_l = (c->pan <= 0.0f) ? 1.0f : 1.0f - c->pan;
                float pan_r = (c->pan >= 0.0f) ? 1.0f : 1.0f + c->pan;
                left  = (int32_t)(left * pan_l);
                right = (int32_t)(right * pan_r);
            }

            mix_left  += left;
            mix_right += right;

            c->pos_frac += c->step_frac;
        }

        /* Clamp to S16 */
        if (mix_left  >  32767) mix_left  =  32767;
        if (mix_left  < -32768) mix_left  = -32768;
        if (mix_right >  32767) mix_right =  32767;
        if (mix_right < -32768) mix_right = -32768;

        /* Write to ring buffer (stereo interleaved) */
        uint32_t idx = (wr % cap) * 2;
        ring[idx]     = (int16_t)mix_left;
        ring[idx + 1] = (int16_t)mix_right;
        wr++;
    }

    *write_cur = wr;
}

void wc_mixer_mix_f32(float *ring, uint32_t cap, uint32_t *write_cur, int frames) {
    if (!ring || cap == 0 || frames <= 0) return;

    uint32_t wr = *write_cur;

    for (int f = 0; f < frames; f++) {
        float mix_left = 0.0f, mix_right = 0.0f;

        for (int ch = 0; ch < WC_MIXER_MAX_CHANNELS; ch++) {
            wc_channel_t *c = &wc_mixer_channels[ch];
            if (!c->active || !c->sound) continue;

            wc_sound_t *s = c->sound;
            uint32_t pos = c->pos_frac >> 16;

            if ((int)pos >= s->length) {
                if (c->loop) {
                    c->pos_frac = 0;
                    pos = 0;
                } else {
                    c->active = 0;
                    continue;
                }
            }

            /* Read sample and normalize to [-1.0, 1.0] */
            float left, right;
            if (s->channels == 2) {
                left  = s->samples[pos * 2]     * (1.0f / 32768.0f);
                right = s->samples[pos * 2 + 1] * (1.0f / 32768.0f);
            } else {
                left = right = s->samples[pos] * (1.0f / 32768.0f);
            }

            /* Apply volume */
            left  *= c->volume;
            right *= c->volume;

            /* Apply panning */
            if (c->pan != 0.0f) {
                float pan_l = (c->pan <= 0.0f) ? 1.0f : 1.0f - c->pan;
                float pan_r = (c->pan >= 0.0f) ? 1.0f : 1.0f + c->pan;
                left  *= pan_l;
                right *= pan_r;
            }

            mix_left  += left;
            mix_right += right;

            c->pos_frac += c->step_frac;
        }

        /* Clamp to [-1.0, 1.0] */
        if (mix_left  >  1.0f) mix_left  =  1.0f;
        if (mix_left  < -1.0f) mix_left  = -1.0f;
        if (mix_right >  1.0f) mix_right =  1.0f;
        if (mix_right < -1.0f) mix_right = -1.0f;

        /* Write to ring buffer (stereo interleaved) */
        uint32_t idx = (wr % cap) * 2;
        ring[idx]     = mix_left;
        ring[idx + 1] = mix_right;
        wr++;
    }

    *write_cur = wr;
}

void wc_mixer_unload(int sound_id) {
    if (sound_id < 0 || sound_id >= WC_MIXER_MAX_SOUNDS) return;
    /* Stop any channels using this sound */
    for (int i = 0; i < WC_MIXER_MAX_CHANNELS; i++) {
        if (wc_mixer_channels[i].sound == &wc_mixer_sounds[sound_id])
            wc_mixer_channels[i].active = 0;
    }
    if (wc_mixer_sounds[sound_id].samples) {
        free(wc_mixer_sounds[sound_id].samples);
    }
    memset(&wc_mixer_sounds[sound_id], 0, sizeof(wc_sound_t));
}

#endif /* WC_PCM_MIXER_IMPLEMENTATION */
