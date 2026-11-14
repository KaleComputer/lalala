/**
 * Words Kokoro says wrong, with the phonemes it should use (misaki's set, as Kokoro prints them;
 * the stress mark ˈ goes before the stressed vowel). Add a word only after hearing it come out wrong.
 */
const PRONUNCIATIONS: Record<string, string> = {
  Qwen: "kwˈɛn",
  AWS: "ˌAdˌʌbᵊljuˈɛs",
  ONNX: "ˈɑnɪks",
};

const PATTERNS = Object.entries(PRONUNCIATIONS).map(
  ([word, phonemes]) =>
    [new RegExp(`(?<![\\p{L}\\p{N}])${word}(?!\\p{L})`, "giu"), phonemes] as const,
);

/**
 * Rewrites listed words as misaki's inline markup, `[Qwen](/kwˈɛn/)`, which Kokoro speaks as those
 * phonemes. Misaki drops digits glued to the markup ("Qwen3"), so they get a space.
 */
export function withPronunciations(text: string): string {
  let marked = text;
  for (const [pattern, phonemes] of PATTERNS) {
    marked = marked.replace(pattern, (word, offset: number, whole: string) => {
      const spaced = /\d/.test(whole[offset + word.length] ?? "") ? " " : "";
      return `[${word}](/${phonemes}/)${spaced}`;
    });
  }
  return marked;
}
