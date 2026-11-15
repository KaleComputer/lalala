export class Normalizer {
  constructor(isWord?: (word: string) => boolean);
  rewrite(text: string): string;
}
export function spokenText(text: string, normalizer: Normalizer, spell: (letters: string) => string): string;
export function cardinal(number: number): string;
export function ordinal(number: number): string;
export function year(number: number): string;
