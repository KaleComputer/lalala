// Words spelled alike and said differently ("I read it yesterday" / "to read", "a live show" / "fish live"):
// which reading is meant, from the neighbouring words. A port of dizione's homographs.py (Apache-2.0, see
// LICENSE): hand rules first, then a small linear classifier per word.
/* eslint-disable */
import DATA from "./homographs.data.js";
import { HOMOGRAPH_RULES } from "./tables.js";

const CLASSES = [
  ["TO", "to"],
  ["DET", "the a an this that these those every each no some any another such what which whose"],
  ["POSS", "my your his her its our their"],
  ["SUBJ", "i you he she it we they who"],
  ["OBJ", "me him us them"],
  ["MODAL", "will would shall should can could may might must 'll 'd won't can't cannot couldn't shouldn't wouldn't let's please"],
  ["DO", "do does did don't doesn't didn't"],
  ["BE", "am is are was were be been being isn't aren't wasn't weren't i'm you're we're they're he's she's it's that's there's"],
  ["HAVE", "have has had having haven't hasn't hadn't i've you've we've they've"],
  ["NEG", "not never"],
  ["PREP", "of in on at by for from with into onto over under about after before between through during without within " +
    "against among around across behind beside near upon toward towards as than like"],
  ["CONJ", "and or but nor so yet if because although though while when where unless until since whether"],
  ["ADV", "very too quite rather more most less least also just only even still always often sometimes usually again " +
    "now then here there soon already almost"],
];
const TAG = new Map(CLASSES.flatMap(([name, list]) => list.split(" ").map((word) => [word, name])));
const SENTENCE_END = new Set([".", "?", "!"]);
const WINDOW = 6;
const isAlpha = (c) => /\p{L}/u.test(c);
const isUpper = (c) => c !== c.toLowerCase() && c === c.toUpperCase();

function tag(token) {
  if (token === "<s>" || token === "</s>") return token;
  if (!isAlpha(token[0])) return /\d/.test(token[0]) ? "NUM" : "PUNCT";
  const lower = token.toLowerCase();
  if (TAG.has(lower)) return TAG.get(lower);
  for (const [ending, name] of [["'s", "POS"], ["ly", "LY"], ["ing", "ING"], ["ed", "ED"]]) {
    if (lower.endsWith(ending) && lower.length > ending.length + 1) return name;
  }
  if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length > 3) return "S";
  return isUpper(token[0]) ? "CAP" : "W";
}

function features(tokens, index) {
  const at = (offset) => {
    const position = index + offset;
    return position >= 0 && position < tokens.length ? tokens[position] : offset < 0 ? "<s>" : "</s>";
  };
  const [p2, p1, n1, n2] = [at(-2), at(-1), at(1), at(2)];
  const [tp2, tp1, tn1, tn2] = [p2, p1, n1, n2].map(tag);
  const out = ["tp1=" + tp1, "tp2=" + tp2, "tn1=" + tn1, "tn2=" + tn2, `tp2p1=${tp2}+${tp1}`, `tp1n1=${tp1}+${tn1}`, `tn1n2=${tn1}+${tn2}`];
  if (index === 0) out.push("first");
  else if (isUpper(tokens[index][0])) out.push("cap");
  out.push("p1=" + p1.toLowerCase(), "p2=" + p2.toLowerCase(), "n1=" + n1.toLowerCase(), "n2=" + n2.toLowerCase());
  const target = tokens[index].toLowerCase();
  const nearby = new Set(tokens.slice(Math.max(0, index - WINDOW), index + WINDOW + 1).filter((t) => isAlpha(t[0])).map((t) => t.toLowerCase()));
  nearby.delete(target);
  for (const word of nearby) out.push("w=" + word);
  return out;
}

function sentenceOf(tokens, index) {
  let start = index;
  while (start > 0 && !SENTENCE_END.has(tokens[start - 1])) start--;
  let end = index;
  while (end < tokens.length && !SENTENCE_END.has(tokens[end])) end++;
  return [tokens.slice(start, end + 1), index - start];
}

const SKIP_FOR_BEFORE = new Set(["ADV", "NEG", "LY"]);
const SKIP_FOR_AUX = new Set([...SKIP_FOR_BEFORE, "SUBJ", "OBJ", "DET", "POSS"]);

function left(tokens, index, skip) {
  for (let position = index - 1; position > Math.max(index - 6, -1); position--) {
    const token = tokens[position];
    if (skip.has(tag(token))) continue;
    const lower = token.toLowerCase();
    return lower.endsWith("'ll") ? "will" : lower.endsWith("'ve") ? "have" : lower;
  }
  return "<s>";
}

const RULES = new Map();
for (const [word, sense, conditions] of HOMOGRAPH_RULES) {
  const parsed = conditions.split(";").map((part) => {
    const text = part.trim(), colon = text.indexOf(":");
    const name = colon < 0 ? text : text.slice(0, colon);
    return [name, new Set(colon < 0 ? [] : text.slice(colon + 1).trim().split(/\s+/))];
  });
  if (!RULES.has(word)) RULES.set(word, []);
  RULES.get(word).push([sense, parsed]);
}

function holds(condition, words, tokens, index) {
  if (condition === "first") return index === 0;
  if (condition === "aux") return words.has(left(tokens, index, SKIP_FOR_AUX));
  if (condition === "before") return words.has(left(tokens, index, SKIP_FOR_BEFORE));
  if (condition === "next") return words.has(index + 1 < tokens.length ? tokens[index + 1].toLowerCase() : "</s>");
  return tokens.slice(Math.max(0, index - WINDOW), index + WINDOW + 1).some((token) => words.has(token.toLowerCase()));
}

const PLURAL_BASES = new Set(DATA.plural_bases);

/** True for a homograph and for the regular -s form of a noun-or-verb one. */
export function covers(word) {
  return word in DATA.words || (word.endsWith("s") && PLURAL_BASES.has(word.slice(0, -1)));
}

function scores(word, tokens, index) {
  const entry = DATA.words[word];
  const names = features(...sentenceOf(tokens, index));
  const model = entry.model;
  if (model.kind === "noun-verb") {
    const sharedNames = names.filter((name) => name[0] === "t" || name === "first" || name === "cap");
    let verb = DATA.pooled.bias + sharedNames.reduce((sum, name) => sum + (DATA.pooled.weights[name] ?? 0), 0);
    verb += model.bias + names.reduce((sum, name) => sum + (model.weights[name] ?? 0), 0);
    return entry.senses.map((sense) => (sense.role === "v" ? verb : -verb));
  }
  return model.bias.map((bias, i) => bias + names.reduce((sum, name) => sum + (model.weights[i][name] ?? 0), 0));
}

function choose(word, tokens, index) {
  const entry = DATA.words[word];
  const [sentence, position] = sentenceOf(tokens, index);
  for (const [sense, conditions] of RULES.get(word) ?? []) {
    if (conditions.every(([name, words]) => holds(name, words, sentence, position))) {
      return entry.senses.find((s) => s.id === sense);
    }
  }
  const list = scores(word, tokens, index);
  let best = 0;
  for (let i = 1; i < list.length; i++) if (list[i] > list[best]) best = i;
  return entry.senses[best];
}

/**
 * The reading `tokens[index]` (lower case `word`, `covers(word)`) has in its sentence: { sense, senses, plural },
 * phones as IPA with stress marks. `plural` asks for the -s ending ("records").
 */
export function pronounce(word, tokens, index) {
  const ipa = (sense) => sense.phones.replace(/ /g, "");
  if (word in DATA.words) {
    return { sense: ipa(choose(word, tokens, index)), senses: DATA.words[word].senses.map(ipa), plural: false };
  }
  const base = word.slice(0, -1), entry = DATA.words[base];
  const adjective = entry.senses.find((sense) => sense.role === "n");
  const chosen = adjective && adjective.id === "adj" ? entry.senses.find((sense) => sense.role === "v") : choose(base, tokens, index);
  return { sense: ipa(chosen), senses: entry.senses.map(ipa), plural: true };
}
