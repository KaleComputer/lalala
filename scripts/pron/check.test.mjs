// Pronunciation regression guard (21 Nov 2026):
// Catches the sunday -> "someday" (d03 en-gb) regression, the 21 Nov override regressions
// (cosimo, italo, elisha gb, iwatani, plato, othniel, ullrich, guillermo, jurado, elizabeth us),
// and preserves the vetted public overrides (leia, kwame, mozart).
// Run: node --experimental-strip-types --test scripts/pron/check.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BritishG2p, britishNormalizer } from "../../src/voice/browserSpeech/matcha/enGb.js";
import {
  G2p,
  G2pModel,
  normalizer,
  parseMoodText,
  readTable,
  sentences,
  splitMoodSegments,
  stripMoodTags,
} from "../../src/voice/browserSpeech/matcha/kaleTts.js";
import { termsReplacer } from "../../src/voice/browserSpeech/terms.ts";

const MATCHA = new URL("../../src/voice/browserSpeech/matcha/", import.meta.url);

function loadFrontend(british) {
  const dir = british ? new URL("en-gb/", MATCHA) : MATCHA;
  const lex = readTable(readFileSync(new URL("lexicon.tsv", dir), "utf8"));
  readTable(readFileSync(new URL("override.tsv", dir), "utf8"), lex);
  const raw = readFileSync(new URL("g2p.bin", dir));
  const model = new G2pModel(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const g2p = british ? new BritishG2p(lex, model) : new G2p(lex, model);
  const norm = british ? britishNormalizer(lex) : normalizer(lex);
  const fn = (text) => g2p.phonemes(norm(text));
  fn.norm = norm;
  fn.sentences = (text) => sentences(text, norm);
  return fn;
}

const us = loadFrontend(false);
const gb = loadFrontend(true);

test("sunday carries secondary stress on -deɪ so d03 never blurs 'see you sunday at noon.' into 'someday'", () => {
  assert.equal(gb("see you sunday at noon."), "sˈiː juː sˈʌndˌeɪ æt nˈuːn.");
  assert.equal(us("see you sunday at noon."), "sˈiː juː sˈʌndˌeɪ æt nˈuːn.");
  assert.equal(gb("sundays"), "sˈʌndˌeɪz");
  assert.equal(us("sundays"), "sˈʌndˌeɪz");
});

test("21–22 Nov regression words use their clean pronunciations (no corrupted or dropped overrides)", () => {
  const expected = [
    ["cosimo", "koʊsˈiːmoʊ", "kəʊsˈiːməʊ"],
    ["italo", "ɪtˈɑːloʊ", "ɪtˈɑːləʊ"],
    ["elisha", "ᵻlˈaɪʃə", "ɪlˈaɪʃə"],
    ["iwatani", "ˌiːwɑːtˈɑːni", "ˌɪwətˈɑːni"],
    ["plato", "plˈeɪɾoʊ", "plˈeɪtəʊ"],
    ["muybridge", "mˈaɪbɹɪdʒ", "mˈaɪbɹɪdʒ"],
    ["othniel", "ˈɑːθniəl", "ˈɒθniəl"],
    ["ullrich", "ˈʊlɹɪk", "ˈʊlɹɪk"],
    ["guillermo", "ɡwɪljˈɛɹmoʊ", "ɡwɪljˈɛəməʊ"],
    ["jurado", "hʊɹˈɑːdoʊ", "hʊəɹˈɑːdəʊ"],
    ["elizabeth", "ᵻlˈɪzəbɪθ", "ɪlˈɪzəbɪθ"],
    ["brunel", "bɹˈuːnəl", "bɹˈuːnəl"],
    ["cauchy", "kˈoʊʃi", "kˈəʊʃi"],
    ["ruffalo", "ɹˈʌfᵻlˌoʊ", "ɹˈʌfɪlˌəʊ"],
    ["wenceslas", "wˈɛnsɪslɑːs", "wˈɛnsɪslɑːs"],
    ["langevin", "lˈɑːndʒɚvˌɪn", "lˈɑːndʒəvˌɪn"],
  ];
  for (const [word, wantUs, wantGb] of expected) {
    assert.equal(us(word), wantUs, `${word} (en-us)`);
    assert.equal(gb(word), wantGb, `${word} (en-gb)`);
  }
  // h013f canary: Elizabeth met Socrates (prevents "Elizabeth Metz Socrates" blur)
  assert.equal(us("Elizabeth met Socrates."), "ᵻlˈɪzəbɪθ mˈɛt sˈɑːkɹətˌiːz.");
  assert.equal(gb("Elizabeth met Socrates."), "ɪlˈɪzəbɪθ mˈɛt sˈɒkɹətˌiːz.");
  assert.equal(us("Elizabeth wore Elizabeth's crown."), "ᵻlˈɪzəbɪθ wˈoːɹ ᵻlˈɪzəbɪθs kɹˈaʊn.");
  assert.equal(gb("Elizabeth wore Elizabeth's crown."), "ɪlˈɪzəbɪθ wˈɔː ɪlˈɪzəbɪθs kɹˈaʊn.");
  assert.equal(us("Elizabeth’s"), "ᵻlˈɪzəbɪθs");
  assert.equal(gb("Elizabeth’s"), "ɪlˈɪzəbɪθs");
  assert.equal(us("Elizabeths'"), "ᵻlˈɪzəbɪθs");
  assert.equal(gb("Elizabeths'"), "ɪlˈɪzəbɪθs");
  assert.equal(us("Sundays'"), "sˈʌndˌeɪz");
  assert.equal(gb("Sundays'"), "sˈʌndˌeɪz");
});

test("21 Nov improvements stay intact in both accents", () => {
  const keep = [
    ["leia", "lˈeɪɐ", "lˈeɪɐ"],
    ["kwame", "kwˈɑːmeɪ", "kwˈɑːmeɪ"],
    ["mozart", "mˈoʊtsɑːɹt", "mˈəʊtsɑːt"],
  ];
  for (const [word, wantUs, wantGb] of keep) {
    assert.equal(us(word), wantUs, `${word} (en-us)`);
    assert.equal(gb(word), wantGb, `${word} (en-gb)`);
  }
});

test("24 Nov: kwame uses PALM vowel in en-gb, dropped internal/typo keys stay absent, camelCase identifiers split cleanly", () => {
  assert.equal(gb("kwame"), "kwˈɑːmeɪ");
  assert.equal(gb("Ask Kwame today."), "ˈɑːsk kwˈɑːmeɪ tədˈeɪ.");
  assert.equal(us("Ask Kwame today."), "ˈæsk kwˈɑːmeɪ tədˈeɪ.");

  const usOverride = readTable(readFileSync(new URL("override.tsv", MATCHA), "utf8"));
  const gbOverride = readTable(readFileSync(new URL("en-gb/override.tsv", MATCHA), "utf8"));
  for (const dropped of ["activityjigsawhalf", "activityjigsawnudge", "languag"]) {
    assert.equal(usOverride.has(dropped), false, `en-us override.tsv must not carry ${dropped}`);
    assert.equal(gbOverride.has(dropped), false, `en-gb override.tsv must not carry ${dropped}`);
  }

  const usTerms = termsReplacer(readFileSync(new URL("terms.tsv", MATCHA), "utf8"));
  const gbTerms = termsReplacer(readFileSync(new URL("en-gb/terms.tsv", MATCHA), "utf8"));
  assert.equal(usTerms("activityJigsawHalf"), "activity Jigsaw Half");
  assert.equal(gbTerms("activityJigsawHalf"), "activity Jigsaw Half");
  assert.equal(us(usTerms("activityJigsawHalf")), "æktˈɪvᵻɾi dʒˈɪɡsɔː hˈæf");
  assert.equal(gb(gbTerms("activityJigsawHalf")), "æktˈɪvɪti dʒˈɪɡsɔː hˈɑːf");
});

test("KAL-3132: structured math subtraction equations read minus without affecting ranges or dates", () => {
  for (const [label, fe] of [["en-us", us], ["en-gb", gb]]) {
    assert.equal(fe.norm("10 - 4 = ?"), "ten minus four equals?", `${label}: 10 - 4 = ?`);
    assert.equal(fe.norm("10 − 4 = ?"), "ten minus four equals?", `${label}: 10 − 4 = ?`);
    assert.equal(fe.norm("10 - ? = 4"), "ten minus? equals four", `${label}: 10 - ? = 4`);
    assert.equal(fe.norm("10 - 4 - 2 = ?"), "ten minus four minus two equals?", `${label}: 10 - 4 - 2 = ?`);
    assert.equal(
      fe.norm("5 + 4 = 9, so 9 - 4 = ?"),
      "five plus four equals nine, so nine minus four equals?",
      `${label}: fact family`
    );
    assert.equal(fe.norm("Ages 6-9."), "Ages six to nine.", `${label}: range stays to`);
    assert.deepEqual(fe.sentences("8 - ? = 5"), ["eight minus? equals five"], `${label}: sentence split keeps 8 - ? = 5 intact`);
    assert.deepEqual(fe.sentences("8 - ? = 5. Great job!"), ["eight minus? equals five.", "Great job!"], `${label}: 8 - ? = 5. Great job!`);
    assert.deepEqual(fe.sentences("8 - 5 = ? Next one."), ["eight minus five equals?", "Next one."], `${label}: trailing ? still splits`);
  }
});

test("KAL-3132: well read uses past-tense heteronym while Well, read stays present", () => {
  for (const [label, fe] of [["en-us", us], ["en-gb", gb]]) {
    assert.equal(fe("Well read!"), "wˈɛl ɹˈɛd!", `${label}: Well read!`);
    assert.ok(fe("I heard you read it. Well read!").endsWith("wˈɛl ɹˈɛd!"), `${label}: readBackHeard`);
    assert.ok(fe("She is well-read.").endsWith("wˈɛl ɹˈɛd."), `${label}: well-read`);
    assert.equal(fe("Well, read this!"), "wˈɛl, ɹˈiːd ðɪs!", `${label}: Well, read this!`);
    assert.ok(fe("You can read well.").endsWith("ɹˈiːd wˈɛl."), `${label}: You can read well.`);
  }
});

test("KAL-3132: sentence-final or isolated the/a/an/to take stressed strong forms while proclitics stay weak", () => {
  for (const [label, fe] of [["en-us", us], ["en-gb", gb]]) {
    assert.equal(fe("the"), "ðˈʌ", `${label}: isolated the`);
    assert.ok(fe("The word is the.").startsWith("ðə ") && fe("The word is the.").endsWith(" ðˈʌ."), `${label}: The word is the.`);
    assert.ok(fe("Copy the word the.").endsWith(" ðˈʌ."), `${label}: Copy the word the.`);
    assert.ok(fe("Copy the word a.").endsWith(" ˈeɪ."), `${label}: Copy the word a.`);
    assert.ok(fe("Peek whenever you need to.").endsWith(" tˈuː."), `${label}: final to`);
    assert.ok(fe("the cat").startsWith("ðə "), `${label}: proclitic the`);
    assert.ok(fe("a dog").startsWith("ɐ "), `${label}: proclitic a`);
    assert.ok(fe("an egg").startsWith("ɐn "), `${label}: proclitic an`);
    assert.ok(fe("to go").startsWith("tə "), `${label}: proclitic to`);
  }
  // Full-sentence running speech check: "the", "to", "a", and "an" stay unstressed (weak/prevocalic)
  assert.equal(us("The dog ran to the house."), "ðə dˈɔɡ ɹˈæn tə ðə hˈaʊs.");
  assert.equal(gb("The dog ran to the house."), "ðə dˈɒɡ ɹˈæn tə ðə hˈaʊs.");
  assert.equal(us("The cat went to a park for an apple."), "ðə kˈæt wɛnt tʊ ɐ pˈɑːɹk fɔːɹɐn ˈæpəl.");
  assert.equal(gb("The cat went to a park for an apple."), "ðə kˈæt wɛnt tʊ ɐ pˈɑːk fɔːɹɐn ˈæpəl.");
  assert.equal(us("We saw an owl in a tree."), "wiː sˈɔː ɐn ˈaʊl ɪn ɐ tɹˈiː.");
  assert.equal(gb("We saw an owl in a tree."), "wiː sˈɔː ɐn ˈaʊl ɪn ɐ tɹˈiː.");
});

test("KAL-3132: 20. Yes! stays one sentence for prosody", () => {
  assert.deepEqual(us.sentences("20. Yes!"), ["twenty. Yes!"]);
  assert.deepEqual(gb.sentences("20. Yes!"), ["twenty. Yes!"]);
});

test("KAL-3173: mood tags are parsed, stripped before G2P, and unknown tags fall back to neutral", () => {
  assert.deepEqual(parseMoodText("[excited] 20. Yes!"), { mood: "excited", text: "20. Yes!" });
  assert.deepEqual(parseMoodText("  [WARM]  You worked hard today. "), { mood: "warm", text: "You worked hard today." });
  assert.deepEqual(parseMoodText("[gentle] Time for bed."), { mood: "gentle", text: "Time for bed." });
  assert.deepEqual(parseMoodText("[excited] Good night.", "gentle"), { mood: "gentle", text: "Good night." });
  assert.deepEqual(parseMoodText("[happy] Great job!"), { mood: "neutral", text: "Great job!" });
  assert.deepEqual(splitMoodSegments("[excited] Yay! [warm] Nice job! [unknown] Next one."), [
    { mood: "excited", text: "Yay!" },
    { mood: "warm", text: "Nice job!" },
    { mood: "neutral", text: "Next one." },
  ]);
  assert.equal(stripMoodTags("Look at [1, 2, 3]."), "Look at [1, 2, 3].");
  assert.equal(stripMoodTags("[[QUESTION_JAR]]"), "[[QUESTION_JAR]]");
  assert.equal(stripMoodTags("See [cat](https://example.com)."), "See [cat](https://example.com).");
  // Tags never reach G2P or spoken output in either accent.
  assert.equal(us("[excited] 20. Yes!"), us("20. Yes!"));
  assert.equal(gb("[warm] Good job!"), gb("Good job!"));
  assert.equal(us("[happy] Hello explorer!"), us("Hello explorer!"));
});
