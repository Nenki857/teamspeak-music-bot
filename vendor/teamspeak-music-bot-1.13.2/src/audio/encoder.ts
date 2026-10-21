import opusModule from "@discordjs/opus";
const { OpusEncoder } = opusModule;

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
// TeamSpeak SDK's Opus Music quality-10 reference rate (audio payload only).
// Do not leave libopus on AUTO: here it reports 120 kbps initially and
// selects about 99 kbps once 20ms stereo frames are encoded.
export const TS_OPUS_MUSIC_BITRATE = 79_200;
const OPUS_SET_VBR_REQUEST = 4006;
const OPUS_RESET_STATE = 4028;
export const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
export const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * 2; // 3840 bytes (16-bit stereo)

export interface Encoder {
  encode(pcm: Buffer): Buffer;
  decode(opus: Buffer): Buffer;
  reset?(): void;
  getSettings?(): { codec: string; sampleRate: number; channels: number; frameDurationMs: number; bitrate: number; variableBitrate: boolean };
}

export function createOpusEncoder(): Encoder {
  const opus = new OpusEncoder(SAMPLE_RATE, CHANNELS);
  opus.setBitrate(TS_OPUS_MUSIC_BITRATE);
  // Hard CBR: each 20ms audio payload is 198 bytes, including during
  // transients and silence. Avoid unconfigured VBR packet-size bursts.
  opus.applyEncoderCTL(OPUS_SET_VBR_REQUEST, 0);

  return {
    reset() { opus.applyEncoderCTL(OPUS_RESET_STATE, 0); },
    getSettings() {
      return { codec: 'opus-music', sampleRate: SAMPLE_RATE, channels: CHANNELS, frameDurationMs: FRAME_DURATION_MS,
        bitrate: opus.getBitrate(), variableBitrate: false };
    },
    encode(pcm: Buffer): Buffer {
      return opus.encode(pcm);
    },
    decode(opusData: Buffer): Buffer {
      return opus.decode(opusData);
    },
  };
}
