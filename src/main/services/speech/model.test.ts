import path from 'node:path';
import { SPEECH_MODEL_IDS } from '@shared/types/speech';
import { describe, expect, it } from 'vitest';
import { recognizerConfig, SPEECH_MODELS, speechModelIdFromSettings } from './model';

const dir = path.resolve('/models/x');

describe('speech model registry', () => {
  it('falls back to Qwen3-ASR for missing or unknown selections', () => {
    expect(speechModelIdFromSettings({})).toBe('qwen3-asr');
    expect(speechModelIdFromSettings({ voiceModel: 'whisper' })).toBe('qwen3-asr');
    expect(speechModelIdFromSettings({ voiceModel: 'enso-asr' })).toBe('qwen3-asr');
    expect(speechModelIdFromSettings({ voiceModel: 'enso-asr-streaming' })).toBe('qwen3-asr');
    expect(speechModelIdFromSettings({ voiceModel: 'x-asr' })).toBe('x-asr');
  });

  it('marks the streaming models and gives every local model a download path', () => {
    expect(SPEECH_MODEL_IDS.filter((id) => SPEECH_MODELS[id].streaming)).toEqual([
      'x-asr-streaming',
      'hanbao',
      'gemini-live',
    ]);
    expect(SPEECH_MODEL_IDS.filter((id) => SPEECH_MODELS[id].remote)).toEqual(['gemini-live']);
    for (const id of SPEECH_MODEL_IDS.filter((id) => !SPEECH_MODELS[id].remote)) {
      const spec = SPEECH_MODELS[id];
      expect(spec.id).toBe(id);
      const direct = spec.files.length > 0 && spec.files.every((f) => f.urls?.length);
      expect([spec.sources, spec.archive, direct].filter(Boolean)).toHaveLength(1);
      expect(spec.approxBytes).toBeGreaterThan(0);
      expect(spec.memoryBytes).toBeGreaterThan(0);
    }
  });

  it('builds an online transducer config for the streaming model', () => {
    const { kind, config } = recognizerConfig(SPEECH_MODELS['x-asr-streaming'], dir);
    expect(kind).toBe('online');
    expect(config).toMatchObject({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(dir, 'encoder.int8.onnx'),
          decoder: path.join(dir, 'decoder.onnx'),
          joiner: path.join(dir, 'joiner.int8.onnx'),
        },
        tokens: path.join(dir, 'tokens.txt'),
      },
      enableEndpoint: 1,
    });
  });

  it('builds offline configs whose files all live inside the model directory', () => {
    expect(recognizerConfig(SPEECH_MODELS['x-asr'], dir)).toMatchObject({
      kind: 'offline',
      config: {
        modelConfig: {
          transducer: { encoder: path.join(dir, 'encoder-epoch-99-avg-1.int8.onnx') },
          tokens: path.join(dir, 'tokens.txt'),
        },
      },
    });
    expect(recognizerConfig(SPEECH_MODELS['qwen3-asr'], dir)).toMatchObject({
      kind: 'offline',
      config: {
        modelConfig: {
          qwen3Asr: {
            convFrontend: path.join(dir, 'conv_frontend.onnx'),
            tokenizer: path.join(dir, 'tokenizer'),
          },
        },
      },
    });
    expect(recognizerConfig(SPEECH_MODELS['sense-voice'], dir)).toMatchObject({
      kind: 'offline',
      config: { modelConfig: { senseVoice: { model: path.join(dir, 'model.int8.onnx') } } },
    });
  });
});
