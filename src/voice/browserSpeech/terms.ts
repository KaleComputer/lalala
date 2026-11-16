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
  const lookUp = (text: string) => text.replace(pattern, (form) => terms.get(form) ?? form);
  // Again after the split, for the words it frees ("getUserById" -> "... By Id" -> "... by ID").
  return (text) => lookUp(splitCamelCase(lookUp(text)));
}

/**
 * camelCase code names as their words ("getUserById" -> "get User By Id"): a word starting in lower
 * case with capitals inside reads as one garbled word otherwise. Only that form, after the
 * dictionary, so listed names (useEffect, WebGPU, iOS) keep their own reading.
 */
const CAMEL = /(?<![\p{L}\p{N}_])[a-z]+(?:[A-Z][a-z0-9]*)+(?![\p{L}\p{N}_])/gu;
const splitCamelCase = (text: string) =>
  text.replace(CAMEL, (word) => word.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " "));
