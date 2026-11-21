// Splits long IPA sentences into pieces small enough to keep ONNX Runtime WASM linear memory
// bounded on phones. WebAssembly linear memory can grow but never shrinks: a single 14-20 s
// sentence (~220-320 phonemes) permanently grows kale-tts-1-nano's WASM heap from 52 MB to
// 240-380 MB on iPhone, pushing the tab into iOS Jetsam kills when returning from phone calls
// or backgrounding. Keeping phone pieces <= 95 IPA chars (~5-6 s) caps WASM growth near ~100 MB.

/** Kokoro reads at most 512 ids, its two pads included. */
export const MAX_IDS = 510;
/** Phone cap: ~5-6 s per ONNX pass, preventing 200-300 MB permanent WASM arena growth on iOS. */
export const PHONE_MAX_IDS = 95;

const CLAUSE_END = new Set([",", ";", ":", "—", "–", ".", "!", "?", "…"]);
/** Gap between pieces after clause punctuation vs mid-clause space split (seconds). */
export const CLAUSE_GAP_S = 0.06;
export const SPACE_GAP_S = 0.025;

export type IpaPiece = {
  readonly ipa: string;
  /** Suggested silence (seconds) before the next piece, or 0 for the last piece. */
  readonly gapAfterS: number;
};

/**
 * Splits `ipa` into pieces of at most `maxIds` characters, preferring natural clause punctuation
 * (`,`, `;`, `:`, `—`, `.`, `!`, `?`) followed by a space in the upper portion of the budget,
 * then falling back to the last space within `maxIds`, and finally a hard cut if no space exists.
 */
export function splitIpaPieces(ipa: string, maxIds = MAX_IDS): IpaPiece[] {
  const limit = Math.max(16, Math.min(MAX_IDS, Math.floor(maxIds)));
  const out: IpaPiece[] = [];
  let rest = [...ipa.trim()];
  while (rest.length > limit) {
    const minClause = Math.floor(limit * 0.4);
    let cut = -1;
    let clause = false;
    // Prefer a space right after clause punctuation so prosody stays natural.
    for (let i = limit; i >= minClause; i -= 1) {
      if (rest[i] === " " && i > 0 && CLAUSE_END.has(rest[i - 1]!)) {
        cut = i;
        clause = true;
        break;
      }
    }
    if (cut <= 0) {
      cut = rest.lastIndexOf(" ", limit);
    }
    if (cut > 0) {
      out.push({ ipa: rest.slice(0, cut).join(""), gapAfterS: clause ? CLAUSE_GAP_S : SPACE_GAP_S });
      rest = rest.slice(cut + 1);
      while (rest[0] === " ") rest.shift();
    } else {
      out.push({ ipa: rest.slice(0, limit).join(""), gapAfterS: SPACE_GAP_S });
      rest = rest.slice(limit);
    }
  }
  if (rest.length > 0 || out.length === 0) {
    out.push({ ipa: rest.join(""), gapAfterS: 0 });
  } else {
    const last = out[out.length - 1]!;
    out[out.length - 1] = { ipa: last.ipa, gapAfterS: 0 };
  }
  return out;
}
