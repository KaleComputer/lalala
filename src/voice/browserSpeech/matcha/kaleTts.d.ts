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


/** The front end alone (Kale's Kokoro speaks from its IPA): words -> IPA, as Voice does. */
export class G2pModel {
  constructor(buffer: ArrayBuffer);
}
export class G2p {
  constructor(lex: Map<string, string>, model?: G2pModel | null);
  phonemes(sentence: string): string;
}
export function readTable(text: string, into?: Map<string, string>): Map<string, string>;
/** Numbers, money, dates and the like as words (dizione's rules), letter runs decided by the word list. */
export function normalizer(lex: Map<string, string>, Rules?: new (isWord: (word: string) => boolean) => unknown): (text: string) => string;
