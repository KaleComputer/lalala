// Pronunciation regression guard (KAL-3115, 21 Nov 2026):
// Catches the sunday -> "someday" (d03 en-gb) regression, the 21 Nov override regressions
// (cosimo, italo, elisha gb, iwatani, plato, othniel, ullrich, guillermo, jurado, elizabeth us),
// and preserves the known improvements (activityjigsawhalf, leia, languag, kwame, mozart).
// Run: node --experimental-strip-types --test scripts/pron/check.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BritishG2p, britishNormalizer } from "../../src/voice/browserSpeech/matcha/enGb.js";
import { G2p, G2pModel, normalizer, readTable } from "../../src/voice/browserSpeech/matcha/kaleTts.js";

const MATCHA = new URL("../../src/voice/browserSpeech/matcha/", import.meta.url);

function loadFrontend(british) {
  const dir = british ? new URL("en-gb/", MATCHA) : MATCHA;
  const lex = readTable(readFileSync(new URL("lexicon.tsv", dir), "utf8"));
  readTable(readFileSync(new URL("override.tsv", dir), "utf8"), lex);
  const raw = readFileSync(new URL("g2p.bin", dir));
  const model = new G2pModel(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const g2p = british ? new BritishG2p(lex, model) : new G2p(lex, model);
  const norm = british ? britishNormalizer(lex) : normalizer(lex);
  return (text) => g2p.phonemes(norm(text));
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
