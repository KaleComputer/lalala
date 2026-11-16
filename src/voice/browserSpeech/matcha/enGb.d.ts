import { G2p } from "./kaleTts.js";

/** G2p with the British files; dizione's homograph readings and letter fallback come out British too. */
export class BritishG2p extends G2p {}
/** kaleTts's normalizer with British dates (3/4/2026 = "the third of April"). */
export function britishNormalizer(lex: Map<string, string>): (text: string) => string;
/** The en-us -> en-gb sound rules. */
export function toBritish(ipa: string, key?: string): string;
