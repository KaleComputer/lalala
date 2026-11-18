// British English (en-gb) for Kale's voices, next to kaleTts.js (same folder). No espeak, no misaki dictionaries.
//
// The en-gb front end is the en-us one with British files: lexicon.gb.tsv, override.gb.tsv, terms.gb.tsv and g2p.gb.bin
// (built by british-16nov/scripts/build_gb.mjs from the en-us files + Britfone, MIT, + the rules below). This module adds
// three small things on top:
//   BritishG2p        G2p whose homograph readings (dizione's, written in en-us) and letter-by-letter fallback come out
//                      British too (everything else already is, from the files).
//   britishNormalizer  kaleTts's normalizer with day-first numeric dates (3/4/2026 = the third of April) and dates said
//                      "the sixteenth of November". Everything else (numbers, money, units, codes) is the shared rule set.
//   toBritish          the en-us -> en-gb sound rules (non-rhotic r, əʊ, ɒ, BATH ɑː, yod, t for the flap, -ary / -ile),
//                      used by the build for every word and here for the two cases above.
// Usage (worker / release loader): lex = readTable(lexicon.gb) + readTable(override.gb); g2p = new BritishG2p(lex, new
// G2pModel(g2p.gb.bin)); normalize = britishNormalizer(lex) (+ terms). The output IPA uses kokoro's table plus ɒ (id 71).
/* eslint-disable */
import { G2p, dottedNames } from "./kaleTts.js";
import { Normalizer, spokenText } from "../dizione/spoken.js";

// ------------------------------------------------------------------------------------------------ IPA units
const UNITS = ["aɪə", "aʊə", "eɪ", "aɪ", "aʊ", "ɔɪ", "oʊ", "əʊ", "ɪə", "ɛə", "ʊə", "ɑː", "ɔː", "ɜː", "iː", "uː", "oː", "tʃ", "dʒ",
  "n̩", "l̩", "m̩"];
const VOWEL_CH = new Set("aeiouɑɐɒæɔəɛɜɪʊʌᵻɚɝ");
const isVowel = (t) => t === "n̩" || t === "l̩" || t === "m̩" || VOWEL_CH.has([...t][0]);

function units(ipa) {
  const out = [];
  let stress = "";
  for (let i = 0; i < ipa.length;) {
    const ch = ipa[i];
    if (ch === "ˈ" || ch === "ˌ") { stress = ch; i++; continue; }
    let t = UNITS.find((u) => ipa.startsWith(u, i)) ?? ch;
    i += t.length;
    const v = isVowel(t);
    out.push({ t, v, s: v ? stress : "" });
    if (!v && stress) { out[out.length - 1].s = stress; } // a mark before a consonant stays where it was
    stress = "";
  }
  return out;
}
const join = (us) => us.map((u) => u.s + u.t).join("");

/** each vowel sound's spelling (a, ou, ie, ...) when the word's vowel-letter groups line up one to one (silent final e dropped) */
function spellings(word, n) {
  const groups = [...word.matchAll(/[aeiou]+|(?<=[^aeiou])y(?![aeiou])|^y(?![aeiou])/g)].map((m) => ({ at: m.index, g: m[0] }));
  const cands = [groups];
  if (groups.length && /[^aeiou](e|es|ed|e's)$/.test(word) && groups[groups.length - 1].g === "e") cands.push(groups.slice(0, -1));
  for (const g of cands) if (g.length === n) return g;
  return null;
}

// BATH words (Wells' lexical set, said with ɑː in southern British): the stem plus an ending
const BATH = new Set(("after afternoon afterwards answer ask aunt banana basket bath bathroom blast branch brass can't cask cast " +
  "castle caste chance chancellor chant clasp class classroom command commander craft crafty dance dancer demand disaster draft " +
  "draught example fast fasten flask gasp ghastly giraffe glance glass graft grant grasp grass half calf laugh laughter last " +
  "mask master nasty pass passport past pastor pastoral path plant plaster prance raft rafter rasp rather shaft slant staff " +
  "task vast advance advantage disadvantage enhance photograph telegraph paragraph autograph graph sample command " +
  "commando contrast forecast broadcast outcast downcast overcast aghast mast lance france bypass surpass trespass").split(" "));
const BATH_END = ["", "s", "es", "ed", "ing", "er", "ers", "y", "ier", "iest", "ly", "ful", "room", "rooms", "hopper", "hoppers", "land",
  "lands", "work", "time", "word", "words", "ship"];
function isBath(word) {
  if (BATH.has(word)) return true;
  for (const e of BATH_END) if (e && word.endsWith(e) && BATH.has(word.slice(0, -e.length))) return true;
  for (const e of ["ed", "ing", "er", "es"]) if (word.endsWith(e) && BATH.has(word.slice(0, -e.length) + "e")) return true;
  return false;
}
// hurry, worry, courage: ʌ before r + vowel where American has ɜː
const STRUT_R = /(?:^|[^aeiou])(?:urr|orr|our)(?=[aeiouy])/;
const NURSE_R = /^(?:fur|pur|blur|slur|spur|whir|stir|sir|occur|recur|concur|incur|demur|prefer|confer|refer|infer|defer|deter|transfer|aver|inter|astir|chirr|shirr|err)/;

/**
 * en-us IPA (Kale's lexicon style) -> en-gb. `key` is the lexicon key: the word in lower case, "a b" for a pair, "x#v" for the
 * before-a-vowel form (its final r links, as in British "better off").
 */
export function toBritish(ipa, key = "") {
  if (!ipa) return ipa;
  const linking = key.endsWith("#v");
  const word = key.replace(/#v$/, "").toLowerCase().replace(/’/g, "'");
  const letters = word.replace(/[^a-z' ]/g, "");
  let u = units(ipa);
  const vi = u.map((x, i) => (x.v ? i : -1)).filter((i) => i >= 0);
  const sp = spellings(letters.replace(/'/g, ""), vi.length);
  const plain = letters.replace(/'/g, "");
  if (sp) vi.forEach((i, k) => { u[i].g = sp[k].g + (plain[sp[k].at + sp[k].g.length] === "w" ? "w" : ""); u[i].at = sp[k].at; u[i].len = sp[k].g.length; });   // new, dew: "ew"
  const hasT = /t/.test(letters), hasD = /d/.test(letters);
  const vowelBefore = (i) => { for (let j = i - 1; j >= 0; j--) if (u[j].v) return u[j]; return null; };
  const vowelAfter = (i) => { for (let j = i + 1; j < u.length; j++) if (u[j].v) return u[j]; return null; };

  for (let i = 0; i < u.length; i++) {
    const x = u[i], prev = u[i - 1], next = u[i + 1], after = u[i + 2], g = x.g;
    if (x.t === "ɾ") {
      // the flap is a t or a d by its spelling: the letters between the vowels around it
      let d = hasD && !hasT;
      const a = vowelBefore(i), b = vowelAfter(i);
      if (a && b && a.at !== undefined && b.at !== undefined) { const mid = plain.slice(a.at + a.len, b.at); d = !/t/.test(mid) && /d/.test(mid); }
      x.t = d ? "d" : "t";
    } else if (x.t === "ᵻ") x.t = "ɪ";
    else if (x.t === "oʊ") x.t = "əʊ";
    else if (x.t === "ɝ") x.t = "ɜː";
    else if (x.t === "ɔ") x.t = "ɒ";                                     // dog, long, off (CMUdict AO spelled o)
    else if (x.t === "ɑː" || x.t === "ɑ") {
      const rCons = next && next.t === "ɹ" && !(after && after.v);      // car, start: stays ɑː
      if (!rCons) {
        const lot = g ? /o/.test(g) || (g === "a" && prev && prev.t === "w") : /o/.test(letters) && !/a/.test(letters);
        if (lot) x.t = "ɒ";
        else x.t = "ɑː";
      }
    } else if (x.t === "æ" && x.s && isBath(word) && next && "fsθnmlŋ".includes(next.t)) x.t = "ɑː";
    else if ((x.t === "uː" || ((x.t === "ʊ" || x.t === "ʊə") && next && next.t === "ɹ")) && x.s && prev && ["t", "d", "n", "θ"].includes(prev.t) && g &&
      ["u", "ue", "ew", "eu", "ui", "ewe"].includes(g) && !(u[i - 2] && u[i - 2].t === "j")) {
      u.splice(i, 0, { t: "j", v: false, s: "" }); i++;              // new, tune, during, student
    }
  }
  // -ary / -ory / -ery not under main stress: dictionary -> ...ənəɹi, laboratory -> ...ətəɹi
  if (/(ary|ory|ery|aries|ories|eries)$/.test(word)) {
    for (let i = u.length - 3; i >= 0; i--) {
      if (u[i].v && u[i].s !== "ˈ" && ["ɛ", "ɔː", "oː", "eɪ"].includes(u[i].t) && u[i + 1].t === "ɹ" && u[i + 2] && ["i", "iː", "ɪ"].includes(u[i + 2].t)) {
        u[i] = { t: "ə", v: true, s: "" }; break;
      }
    }
  }
  // -ile: fertile, hostile, missile, mobile -> aɪl
  if (/[^aeiou]ile[sd]?$/.test(word)) {
    let k = u.length - 1; if (k > 0 && ["z", "d"].includes(u[k].t)) k--;
    if (u[k].t === "l̩" && !u[k].s) u.splice(k, 1, { t: "aɪ", v: true, s: "" }, { t: "l", v: false, s: "" });
    else if (u[k].t === "l" && u[k - 1] && ["ə", "ɪ", "ʌ"].includes(u[k - 1].t) && !u[k - 1].s) u[k - 1].t = "aɪ";
  }
  // -isation / -ization: organisation -> ɔːɡənaɪzˈeɪʃən
  if (/i[sz]ation/.test(word)) {
    for (let i = 1; i + 2 < u.length; i++) if (["ə", "ɪ"].includes(u[i].t) && !u[i].s && u[i + 1].t === "z" && u[i + 2].t === "eɪ") u[i].t = "aɪ";
  }
  // r: kept before a vowel of the same word (very, story) and, in a before-a-vowel form, at the end; elsewhere it goes and
  // the vowel before it takes the British shape (car ɑː, four ɔː, square ɛə, near ɪə, tour ʊə, nurse ɜː, water ə)
  const out = [];
  for (let i = 0; i < u.length; i++) {
    const x = u[i], next = u[i + 1];
    if (x.t === "ɚ") {
      const keep = next && next.t === "ɹ" && ((u[i + 2] && u[i + 2].v) || (linking && i + 2 === u.length));
      out.push({ ...x, t: "ə" });
      if (keep) { out.push(next); i++; } else if (next && next.t === "ɹ" && !(u[i + 2] && u[i + 2].v)) i++;
      continue;
    }
    if (x.t === "ɹ" && out.length && out[out.length - 1].v) {
      const nx = u[i + 1];
      const p = out[out.length - 1];
      const beforeVowel = (nx && nx.v) || (linking && !nx);
      if (beforeVowel) {
        if (p.t === "oː") p.t = "ɔː";
        const rr = p.at !== undefined && plain.slice(p.at + p.len, p.at + p.len + 2) === "rr";
        if (nx && p.t === "ɛ" && p.g === "a" && rr) p.t = "æ";                                          // carry, marry, arrow
        else if (nx && p.t === "ɛ" && ["ai", "ae", "ea", "ei"].includes(p.g)) p.t = "ɛə";                 // fairy, aerial
        else if (nx && p.t === "ɪ" && ["e", "ea", "ee", "ie", "eo", "ei"].includes(p.g) && !rr) p.t = "ɪə";  // hero, series, period
        else if (nx && p.t === "ʊ" && ["u", "ou", "oo"].includes(p.g) && !rr) p.t = "ʊə";                // jury, during, tourist
        if (p.t === "ɜː" && STRUT_R.test(word) && !NURSE_R.test(word)) p.t = "ʌ";
        if (!nx) { // linking r at the word's end: the British vowel, then r
          p.t = { "ɑː": "ɑː", "ɔː": "ɔː", "ɛ": "ɛə", "ɪ": "ɪə", "ʊ": "ʊə", "iː": "ɪə", "uː": "ʊə", "eɪ": "ɛə", "aɪ": "aɪə", "aʊ": "aʊə" }[p.t] ?? p.t;
        }
        out.push(x); continue;
      }
      p.t = { "ɑː": "ɑː", "ɑ": "ɑː", "ɔː": "ɔː", "oː": "ɔː", "ɒ": "ɔː", "ɛ": "ɛə", "eɪ": "ɛə", "ɪ": "ɪə", "iː": "ɪə", "ʊ": "ʊə", "uː": "ʊə",
        "aɪ": "aɪə", "aʊ": "aʊə", "ɜː": "ɜː", "ə": "ə", "ʌ": "ɜː", "ɐ": "ə", "æ": "ɑː" }[p.t] ?? p.t;
      continue; // r dropped
    }
    out.push(x);
  }
  return join(out);
}

// ------------------------------------------------------------------------------------------------ G2p + normalizer
/** G2p with British files; dizione's homograph readings and the letter-sound fallback are made British too. */
export class BritishG2p extends G2p {
  homograph(token, tokens, index) {
    const r = super.homograph(token, tokens, index);
    return r === null ? r : toBritish(r, token.toLowerCase());
  }
  chunks(w) { return toBritish(super.chunks(w), w); }
  fallback(low) { const r = super.fallback(low); return r == null ? r : toBritish(r, low); }   // en-gb g2p.bin is British already (no-op)
}

/** dizione's rules with British dates: numeric dates day first, every date "the <day> of <month>". */
class BritishNormalizer extends Normalizer {
  date(month, day, yearText) { return super.date(month, day, yearText, true); }
  slashDate(match) { this.dayFirst = true; return super.slashDate(match); }
  shortDate(match) { this.dayFirst = true; return super.shortDate(match); }
}

/** kaleTts.js's normalizer(lex), British dates */
export function britishNormalizer(lex) {
  const rules = new BritishNormalizer((word) => lex.has(word));
  const spell = (letters) => {
    const upper = letters.toUpperCase();
    return upper.length <= 5 && !(upper.length >= 3 && lex.has(letters.toLowerCase())) ? upper : [...upper].join(" ");
  };
  return (text) => dottedNames(spokenText(text.replace(/\bDr\.(?=\s*$)/, "Doctor"), rules, spell));
}
