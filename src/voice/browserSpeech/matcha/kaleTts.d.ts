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
  /** Numbers, money, dates and the like as words, ready for speakSentence. */
  normalize(text: string): string;
  speakSentence(
    sentence: string,
    options?: { lengthScale?: number; noiseScale?: number },
  ): Promise<Sentence>;
}

