// Renders scripts/tech-terms/lines.json with one of lalala's Kale voices through lalala's own front end
// (terms.tsv, dizione, word list), one wav a line: node render.mjs <lalala root> <model folder> <out dir> [voice].
// Needs onnxruntime-node (npm i onnxruntime-node@1.24.1 next to it); score.py then counts misheard lines.
import fs from "node:fs";
import path from "node:path";
import ort from "onnxruntime-node";
const [lalala, model, outDir] = process.argv.slice(2);
const bs = path.join(lalala, "src/voice/browserSpeech"), dir = path.join(lalala, "public/models", model);
const { G2p, G2pModel, normalizer, readTable } = await import(path.join(bs, "matcha/kaleTts.js"));
const { termsReplacer } = await import(path.join(bs, "terms.ts"));
const lex = readTable(fs.readFileSync(path.join(bs, "matcha/lexicon.tsv"), "utf8"));
readTable(fs.readFileSync(path.join(bs, "matcha/override.tsv"), "utf8"), lex);
const b = fs.readFileSync(path.join(bs, "matcha/g2p.bin"));
const g2p = new G2p(lex, new G2pModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
const terms = termsReplacer(fs.readFileSync(path.join(bs, "matcha/terms.tsv"), "utf8"));
const normalize = normalizer(lex);
const vocab = JSON.parse(fs.readFileSync(path.join(dir, "tokenizer.json"), "utf8")).model.vocab;
const inputs = fs.existsSync(path.join(dir, "voice_inputs.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "voice_inputs.json"), "utf8")) : [];
const session = await ort.InferenceSession.create(path.join(dir, "onnx/model.onnx"), { graphOptimizationLevel: "disabled" });
fs.mkdirSync(outDir, { recursive: true });
const f32 = (file) => { const buf = fs.readFileSync(file); return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)); };
const voice = process.argv[5] ?? "v7", pack = f32(path.join(dir, "voices", voice + ".bin"));
const extra = {};
if (inputs.length) { const v = f32(path.join(dir, "voices", voice + ".extra.bin")); let at = 0; for (const s of inputs) { const n = s.dims.reduce((a, d) => a * d, 1); extra[s.name] = new ort.Tensor("float32", v.slice(at, at + n), s.dims); at += n; } }
const lines = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "lines.json"), "utf8"));
const wav = (pcm) => { const n = pcm.length, buf = Buffer.alloc(44 + n * 2); buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(24000, 24); buf.writeUInt32LE(48000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2); return buf; };
for (const [i, line] of lines.entries()) {
  const ipa = g2p.phonemes(normalize(process.env.NO_TERMS ? line.text : terms(line.text)));
  const ids = [0, ...[...ipa].map((c) => vocab[c]).filter((x) => x !== undefined && x !== 0), 0];
  const n = ids.length - 2, row = Math.min(n, pack.length / 256) - 1;
  const r = await session.run({ input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]), style: new ort.Tensor("float32", pack.slice(row * 256, (row + 1) * 256), [1, 256]), speed: new ort.Tensor("float32", Float32Array.from([1]), [1]), ...extra });
  fs.writeFileSync(path.join(outDir, String(i).padStart(2, "0") + ".wav"), wav(r.waveform.data));
}
console.log("rendered", lines.length);
