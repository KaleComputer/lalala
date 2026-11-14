export type VoiceFiles = {
  model: ArrayBuffer;
  vocoder: ArrayBuffer;
  g2pModel: ArrayBuffer;
  tokens: string;
  lexicon: string;
  override: string;
};

export type Sentence = {
  pcm: Float32Array<ArrayBuffer>;
  ipa: string;
  ids: number[];
  ms: { acoustic: number; vocoder: number };
};

export class Voice {
  static load(ort: unknown, files: VoiceFiles, options?: { sessionOptions?: object }): Promise<Voice>;
  readonly sampleRate: number;
  speakSentence(
    sentence: string,
    options?: { lengthScale?: number; noiseScale?: number },
  ): Promise<Sentence>;
}

export function normalize(text: string): string;
