// Pronunciation regression guard (21 Nov 2026):
// Catches the sunday -> "someday" (d03 en-gb) regression, the 21 Nov override regressions
// (cosimo, italo, elisha gb, iwatani, plato, othniel, ullrich, guillermo, jurado, elizabeth us),
// and preserves the vetted public overrides (leia, kwame, mozart).
// Run: node --experimental-strip-types --test scripts/pron/check.test.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { BritishG2p, britishNormalizer } from "../../src/voice/browserSpeech/matcha/enGb.js";
import {
  G2p,
  G2pModel,
  VOICE_MOODS,
  VOICE_MOOD_SPECS,
  normalizer,
  parseMoodText,
  readTable,
  readTokens,
  sentences,
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
    assert.equal(fe("an"), "ˈæn", `${label}: isolated an`);
    assert.ok(fe("The word is the.").startsWith("ðə ") && fe("The word is the.").endsWith(" ðˈʌ."), `${label}: The word is the.`);
    assert.ok(fe("Copy the word the.").endsWith(" ðˈʌ."), `${label}: Copy the word the.`);
    assert.ok(fe("Copy the word a.").endsWith(" ˈeɪ."), `${label}: Copy the word a.`);
    assert.ok(fe("Copy the word an.").endsWith(" ˈæn."), `${label}: Copy the word an.`);
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

test("KAL-3173: exact four mood tags are parsed and stripped before G2P while arbitrary brackets stay untouched", () => {
  assert.deepEqual(parseMoodText("[excited] 20. Yes!"), { mood: "excited", text: "20. Yes!" });
  assert.deepEqual(parseMoodText("  [WARM]  You worked hard today. "), { mood: "warm", text: "You worked hard today." });
  assert.deepEqual(parseMoodText("[gentle] Time for bed."), { mood: "gentle", text: "Time for bed." });
  assert.deepEqual(parseMoodText("[excited] Good night.", "gentle"), { mood: "gentle", text: "Good night." });
  assert.deepEqual(parseMoodText("What does [x] mean?"), { mood: "neutral", text: "What does [x] mean?" });
  assert.deepEqual(parseMoodText("[excited] Yay! [warm] Nice job! [neutral] Next one."), {
    mood: "excited",
    text: "Yay! Nice job! Next one.",
  });
  assert.equal(stripMoodTags("Look at [1, 2, 3] and [x]."), "Look at [1, 2, 3] and [x].");
  assert.equal(stripMoodTags("[[QUESTION_JAR]]"), "[[QUESTION_JAR]]");
  assert.equal(stripMoodTags("See [cat](https://example.com)."), "See [cat](https://example.com).");
  // Structured mood specs cover every mood in VOICE_MOODS.
  assert.deepEqual(
    VOICE_MOOD_SPECS.map((s) => s.mood).sort(),
    [...VOICE_MOODS].sort(),
  );
  // The four mood tags never reach G2P or spoken output in either accent.
  assert.equal(us("[excited] 20. Yes!"), us("20. Yes!"));
  assert.equal(gb("[warm] Good job!"), gb("Good job!"));
  assert.equal(us("[gentle] Good night."), us("Good night."));
});

test("24–26 Nov: Monday uses secondary-stressed -dˌeɪ like Sunday, and word-gate-dropped xhigh stays absent", () => {
  const usOverride = readTable(readFileSync(new URL("override.tsv", MATCHA), "utf8"));
  const gbOverride = readTable(readFileSync(new URL("en-gb/override.tsv", MATCHA), "utf8"));
  assert.equal(usOverride.has("xhigh"), false, "en-us override.tsv must not carry xhigh");
  assert.equal(gbOverride.has("xhigh"), false, "en-gb override.tsv must not carry xhigh");

  for (const [label, fe] of [["en-us", us], ["en-gb", gb]]) {
    assert.equal(fe("Monday"), "mˈʌndˌeɪ", `${label}: Monday`);
    assert.equal(fe("monday"), "mˈʌndˌeɪ", `${label}: monday`);
    assert.equal(fe("Mondays"), "mˈʌndˌeɪz", `${label}: Mondays`);
    assert.equal(fe("Monday's"), "mˈʌndˌeɪz", `${label}: Monday's`);
  }
  assert.equal(us("Monday and Tuesday."), "mˈʌndˌeɪ ænd tˈuːzdeɪ.");
  assert.equal(gb("Monday and Tuesday."), "mˈʌndˌeɪ ænd tjˈuːzdeɪ.");
});

test("26 Nov: ellipsis maps to ... (never dropped by Kokoro vocab) and token-table ID-7 parity holds", () => {
  const kokoroVocab = JSON.parse(
    readFileSync(new URL("../../src/voice/browserSpeech/kaleKokoro/ipa2kokoro.json", import.meta.url), "utf8"),
  );
  const matchaTokens = readTokens(readFileSync(new URL("tokens.txt", MATCHA), "utf8"));

  // Matcha tokens.txt (used by matcha-f40warm.onnx) maps ¡ -> 7 and U+0329 -> 175,
  // while Kokoro / Hazel models map U+0329 -> 7 and omit ¡. All 52 other symbols match identically.
  assert.equal(Object.keys(kokoroVocab).length, 53);
  assert.equal(kokoroVocab["\u0329"], 7);
  assert.equal("¡" in kokoroVocab, false);
  assert.equal(matchaTokens.get("¡"), 7);
  assert.equal(matchaTokens.get("\u0329"), 175);
  for (const [sym, id] of Object.entries(kokoroVocab)) {
    if (sym === "\u0329") continue;
    assert.equal(matchaTokens.get(sym), id, `symbol ${JSON.stringify(sym)} id mismatch between kokoro and matcha`);
  }

  // Every bundled Kokoro/Hazel tokenizer.json agrees with ipa2kokoro.json (including ID 7 = U+0329, never ¡).
  const modelsDir = new URL("../../public/models/", import.meta.url);
  const modelNames = readdirSync(modelsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (d.name.startsWith("kale-") || existsSync(new URL(`${d.name}/tokenizer.json`, modelsDir))))
    .map((d) => d.name);
  assert.ok(modelNames.length > 0);
  for (const name of modelNames) {
    const tok = JSON.parse(readFileSync(new URL(`${name}/tokenizer.json`, modelsDir), "utf8"));
    const vocab = tok.model.vocab;
    assert.equal(vocab["\u0329"], 7, `${name}: U+0329 must be ID 7`);
    assert.equal("¡" in vocab, false, `${name}: ¡ must not collide with ID 7`);
    for (const [sym, id] of Object.entries(kokoroVocab)) {
      assert.equal(vocab[sym], id, `${name}: symbol ${JSON.stringify(sym)} id mismatch`);
    }
  }

  // Ellipsis maps to "..." so every emitted IPA codepoint is in Kokoro's 53-symbol vocab (zero silent drops).
  for (const [label, fe] of [["en-us", us], ["en-gb", gb]]) {
    assert.equal(fe("Getting the picture ready…"), fe("Getting the picture ready..."), `${label}: terminal ellipsis`);
    assert.ok(fe("Getting the picture ready…").endsWith("..."), `${label}: keeps pause dots`);
    assert.equal(fe("Wait… did you see that?"), fe("Wait... did you see that?"), `${label}: mid-sentence ellipsis`);
    for (const s of ["Getting the picture ready…", "Wait… did you see that?", "Let's go — right now!", "A–B"]) {
      const ipa = fe(s);
      for (const ch of ipa) {
        assert.ok(ch in kokoroVocab, `${label}: dropped char ${JSON.stringify(ch)} in ${JSON.stringify(s)} -> ${ipa}`);
      }
    }
  }

  // All 9 weekday overrides resolve cleanly to -deɪ / -dˌeɪ over unmodified CMUdict lexicon.tsv.
  const weekdays = [
    ["Monday", "mˈʌndˌeɪ"],
    ["Monday's", "mˈʌndˌeɪz"],
    ["Mondays", "mˈʌndˌeɪz"],
    ["Tuesday", "tˈuːzdeɪ"],
    ["Wednesday", "wˈɛnzdeɪ"],
    ["Friday", "fɹˈaɪdeɪ"],
    ["Fridays", "fɹˈaɪdeɪz"],
    ["Saturday", "sˈæɾɚdeɪ"],
    ["Saturdays", "sˈæɾɚdeɪz"],
  ];
  for (const [word, want] of weekdays) {
    assert.equal(us(word), want, `en-us weekday: ${word}`);
  }
});
