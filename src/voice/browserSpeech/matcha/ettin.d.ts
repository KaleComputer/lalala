/** Ettin's byte-level BPE (jhu-clsp/ettin-encoder-17m's tokenizer.json, MIT). */
export class EttinTokenizer {
  constructor(json: unknown);
  readonly cls: number;
  readonly sep: number;
  encode(text: string): { ids: number[]; offsets: [number, number][] };
}
/** One sentence's ettin_ids / ettin_mask / wavg (W words x S sub-tokens); prev is Ettin's left context. */
export function ettinInputs(
  tok: EttinTokenizer,
  text: string,
  prev?: string,
): { ettin_ids: number[]; ettin_mask: number[]; wavg: Float32Array; W: number; S: number };
/** The graph's widx: one word index per sound id of the sentence. */
export function wordIndex(sentIds: number[], wordIds: number[][], nWords: number, spaceId?: number): number[];
