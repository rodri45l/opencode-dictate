// opencode-dictate recorder — the microphone half of the plugin.
//
// The plugin could shell out to ffmpeg/parecord/sox, but that means asking the
// user to install one of them first (and on macOS, `brew install ffmpeg`). This
// is the same job with nothing to install: miniaudio (MIT-0) talks to CoreAudio,
// WASAPI, ALSA and PulseAudio directly.
//
// Contract with the plugin — keep it identical to the other recorders:
//   * 16 kHz mono signed 16-bit PCM on stdout, streaming (flushed per callback,
//     never buffered — a buffered pipe is exactly what made ffmpeg blind on macOS)
//   * stop on its own after --seconds, so a killed TUI leaves nothing behind
//   * apply --gain before writing, since some microphones are wildly hot

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#include <signal.h>
#include <time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static ma_device g_device;
static ma_uint64 g_target = 0; // frames at 16 kHz
static ma_uint64 g_written = 0;
static double g_gain = 1.0;

static void on_data(ma_device *device, void *out, const void *in, ma_uint32 frames)
{
  (void)out;
  ma_int16 *samples = (ma_int16 *)in; // mono s16, converted by miniaudio

  if (g_target && g_written + frames > g_target)
    frames = (ma_uint32)(g_target - g_written);
  if (frames == 0) {
    ma_device_stop(device);
    return;
  }

  for (ma_uint32 i = 0; i < frames; i++) {
    double v = samples[i] * g_gain;
    if (v > 32767.0) v = 32767.0;
    if (v < -32768.0) v = -32768.0;
    samples[i] = (ma_int16)v;
  }

  fwrite(samples, sizeof(ma_int16), frames, stdout);
  fflush(stdout); // stream immediately; the plugin's VAD reads this pipe live
  g_written += frames;

  if (g_target && g_written >= g_target) ma_device_stop(device);
}

static void on_signal(int sig)
{
  (void)sig;
  // Leave immediately: stopping the device politely can block on a backend that
  // never acknowledges, and the plugin only needs this process (and its stdout
  // pipe) to close. Whatever is left is reaped by the OS.
  _exit(0);
}

static void list_devices(void)
{
  ma_context context;
  if (ma_context_init(NULL, 0, NULL, &context) != MA_SUCCESS) {
    fprintf(stderr, "could not initialise audio\n");
    return;
  }
  ma_device_info *playback;
  ma_uint32 playback_count;
  ma_device_info *capture;
  ma_uint32 capture_count;
  if (ma_context_get_devices(&context, &playback, &playback_count, &capture, &capture_count) == MA_SUCCESS) {
    for (ma_uint32 i = 0; i < capture_count; i++)
      printf("%u\t%s%s\n", i, capture[i].name, capture[i].isDefault ? "\t(default)" : "");
  }
  ma_context_uninit(&context);
}

int main(int argc, char **argv)
{
  ma_uint32 rate = 16000;
  double seconds = 60.0;
  int device_index = -1;

  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--seconds") && i + 1 < argc) seconds = atof(argv[++i]);
    else if (!strcmp(argv[i], "--gain") && i + 1 < argc) g_gain = atof(argv[++i]);
    else if (!strcmp(argv[i], "--rate") && i + 1 < argc) rate = (ma_uint32)atoi(argv[++i]);
    else if (!strcmp(argv[i], "--device-index") && i + 1 < argc) device_index = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--list")) { list_devices(); return 0; }
  }
  g_target = (ma_uint64)(seconds * (double)rate);

  ma_context context;
  if (ma_context_init(NULL, 0, NULL, &context) != MA_SUCCESS) {
    fprintf(stderr, "could not initialise audio backend\n");
    return 2;
  }

  ma_device_id *chosen = NULL;
  if (device_index >= 0) {
    ma_device_info *playback;
    ma_uint32 playback_count;
    ma_device_info *capture;
    ma_uint32 capture_count;
    if (ma_context_get_devices(&context, &playback, &playback_count, &capture, &capture_count) == MA_SUCCESS &&
        (ma_uint32)device_index < capture_count) {
      chosen = &capture[device_index].id;
    } else {
      fprintf(stderr, "capture device %d not found\n", device_index);
      ma_context_uninit(&context);
      return 2;
    }
  }

  ma_device_config config = ma_device_config_init(ma_device_type_capture);
  config.capture.pDeviceID = chosen;
  config.capture.format = ma_format_s16;
  config.capture.channels = 1;
  config.sampleRate = rate;
  config.dataCallback = on_data;
  config.periodSizeInMilliseconds = 20; // small periods: the VAD wants a live level

  if (ma_device_init(&context, &config, &g_device) != MA_SUCCESS) {
    fprintf(stderr, "could not open the microphone\n");
    ma_context_uninit(&context);
    return 2;
  }

  signal(SIGTERM, on_signal);
  signal(SIGINT, on_signal);

  if (ma_device_start(&g_device) != MA_SUCCESS) {
    fprintf(stderr, "could not start capture\n");
    ma_device_uninit(&g_device);
    ma_context_uninit(&context);
    return 2;
  }

  // Deadline on the wall clock, never on delivered audio: if the OS withholds the
  // microphone the callback never fires, and waiting for frames hangs forever —
  // which is exactly what happened on both macOS and WSL. Stopping the device can
  // block too, so we simply leave.
  struct timespec start;
  clock_gettime(CLOCK_MONOTONIC, &start);
  for (;;) {
    if (g_target && g_written >= g_target) break;
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    double elapsed = (double)(now.tv_sec - start.tv_sec) + (double)(now.tv_nsec - start.tv_nsec) / 1e9;
    if (elapsed >= seconds) break;
    ma_sleep(20);
  }

  if (g_written == 0) {
    // The plugin puts this on stderr, so a silent capture names its own cause
    // instead of looking like a quiet room.
    fprintf(stderr, "no audio captured — is microphone access allowed for this app?\n");
  }
  fflush(stdout);
  _exit(0);
}
