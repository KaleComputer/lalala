# kale-tts-1-tiny

Kale's small text-to-speech model (k10c), 61 MB, speaking in Hazel's voice at 24 kHz. It is
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)'s text side, fine-tuned by Kale, with Kale's
own 3.65M decoder writing audio directly. It is one ONNX graph: the text side in 16 bits and the
decoder weights in 8 bits.

This folder is laid out like a Transformers.js model (`model_type: style_text_to_speech_2`, as
Kokoro's ONNX release), so it loads the way kokoro-js loads Kokoro:

```js
import { AutoTokenizer, StyleTextToSpeech2Model, Tensor, env } from "@huggingface/transformers"; // 3.8.x

env.localModelPath = "/models/"; // where this folder is served
env.allowLocalModels = true;
const model = await StyleTextToSpeech2Model.from_pretrained("kale-tts-1-tiny", { dtype: "fp32", device: "wasm" });
const tokenizer = await AutoTokenizer.from_pretrained("kale-tts-1-tiny");
const voice = new Float32Array(await (await fetch("/models/kale-tts-1-tiny/voices/hazel.bin")).arrayBuffer());

const { input_ids } = tokenizer(ipa, { truncation: true }); // IPA in, as Kokoro's tokenizer
const n = input_ids.dims.at(-1) - 2;
const style = new Tensor("float32", voice.slice((n - 1) * 256, n * 256), [1, 256]);
const { waveform } = await model({ input_ids, style, speed: new Tensor("float32", [1], [1]) });
```

The input is IPA in Kokoro's symbol set. lalala makes it with its own front end
(`src/voice/browserSpeech/matcha/kaleTts.js`: text rules, word list and a small model for unknown
words); Kokoro's misaki or espeak-ng phonemes also work. `voices/hazel.bin` is a raw float32
[510, 256] style table, one row per input length, as Kokoro's voices.

Runs on the CPU (wasm). On WebGPU, Transformers.js 3.8 refuses one of the decoder's ops, and on
iOS, WebGPU ended the browser tab (15 Nov 2026), so lalala uses the CPU everywhere.

License and credits: see lalala's `NOTICE.md`.
