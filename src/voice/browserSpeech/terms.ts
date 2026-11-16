// Kale's voices: technical terms from matcha/terms.tsv (written form, the words to say), replaced as
// whole tokens before the text rules. A dictionary lookup, so it never decides what something means.
import { readTable } from "./matcha/kaleTts.js";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The replacer for a terms table's text: longest written form first, case as written. */
export function termsReplacer(table: string): (text: string) => string {
  const terms = readTable(table);
  if (terms.size === 0) return (text) => text;
  const forms = [...terms.keys()].toSorted((a, b) => b.length - a.length).map(escape);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${forms.join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  return (text) => text.replace(pattern, (form) => terms.get(form) ?? form);
}
