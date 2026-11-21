// Pronunciation regression guard (KAL-3115, 21 Nov 2026):
// Catches the sunday -> "someday" (d03 en-gb) regression, the 21 Nov override regressions
// (cosimo, italo, elisha gb, iwatani, plato, othniel, ullrich, guillermo, jurado, elizabeth us),
// and preserves the known improvements (activityjigsawhalf, leia, languag, kwame, mozart).
// Run: node --experimental-strip-types --test scripts/pron/check.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BritishG2p, britishNormalizer } from "../../src/voice/browserSpeech/matcha/enGb.js";
import { G2p, G2pModel, normalizer, readTable, sentences } from "../../src/voice/browserSpeech/matcha/kaleTts.js";

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

test("21 Nov regression words use their clean pronunciations (no corrupted overrides)", () => {
  const expected = [
    ["cosimo", "koʊsˈiːmoʊ", "kəʊsˈiːməʊ"],
    ["italo", "ɪtˈɑːloʊ", "ɪtˈɑːləʊ"],
    ["elisha", "ᵻlˈaɪʃə", "ˈɛlɪʃə"],
    ["iwatani", "ˌiːwɑːtˈɑːni", "ˌɪwətˈɑːni"],
    ["plato", "plˈeɪɾoʊ", "plˈeɪtəʊ"],
    ["othniel", "ˈɑːθniəl", "ˈɒθniəl"],
    ["ullrich", "ˈʊlɹɪk", "ˈʊlɹɪk"],
    ["guillermo", "ɡwɪljˈɛɹmoʊ", "ɡwɪljˈɛəməʊ"],
    ["jurado", "jʊɹˈɑːdoʊ", "jʊəɹˈɑːdəʊ"],
    ["elizabeth", "əlˈɪzəbəθ", "ɪlˈɪzəbɪθ"],
  ];
  for (const [word, wantUs, wantGb] of expected) {
    assert.equal(us(word), wantUs, `${word} (en-us)`);
    assert.equal(gb(word), wantGb, `${word} (en-gb)`);
  }
});

test("21 Nov improvements stay intact in both accents", () => {
  const keep = [
    ["activityjigsawhalf", "ˈæktɪvˌɪɾidʒˌɪɡsɑːhˌæf", "ˈæktɪvˌɪtidʒˌɪɡsɑːhˌæf"],
    ["leia", "lˈeɪɐ", "lˈeɪɐ"],
    ["languag", "lˈæŋɡwɪdʒ", "lˈæŋɡwɪdʒ"],
    ["kwame", "kwˈɑːmeɪ", "kwˈɒmeɪ"],
    ["mozart", "mˈoʊtsɑːɹt", "mˈəʊtsɑːt"],
  ];
  for (const [word, wantUs, wantGb] of keep) {
    assert.equal(us(word), wantUs, `${word} (en-us)`);
    assert.equal(gb(word), wantGb, `${word} (en-gb)`);
  }
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
    assert.ok(fe("to go").startsWith("tə "), `${label}: proclitic to`);
  }
});

test("KAL-3132: 20. Yes! stays one sentence for prosody", () => {
  assert.deepEqual(us.sentences("20. Yes!"), ["twenty. Yes!"]);
  assert.deepEqual(gb.sentences("20. Yes!"), ["twenty. Yes!"]);
});
