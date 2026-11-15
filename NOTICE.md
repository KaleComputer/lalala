# Third-party notices

## T3 Code

Parts of this repository are copied or adapted from [T3 Code](https://github.com/pingdotgg/t3code):
`src/index.css`, `src/components/ui/*`, `src/lib/*`, the T3 Code stand-ins in `src/t3` and
`src/state`, and the voice canvas under `src/voice`. T3 Code is licensed under the MIT License:

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

lalala is an independent project and is not affiliated with or endorsed by T3 Tools Inc.

## Speech models (downloaded at runtime, not included)

`scripts/speech.sh` downloads these from Hugging Face on first start:

| Model | Author | License |
| --- | --- | --- |
| [Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) (MLX port: `mlx-community/parakeet-tdt-0.6b-v2`) | NVIDIA | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (MLX port: `mlx-community/Kokoro-82M-bf16`) | hexgrad | Apache-2.0 |
| [Silero VAD](https://github.com/snakers4/silero-vad) (MLX port: `mlx-community/silero-vad`) | Silero Team | MIT |

Speech-to-text uses NVIDIA's Parakeet TDT 0.6B v2, licensed under CC-BY-4.0.

Python packages installed into the speech service's own environment: `mlx-audio` (MIT),
`misaki` (Apache-2.0; Kokoro's phonemizer), spaCy `en_core_web_sm` (MIT), FastAPI (MIT),
Uvicorn (BSD-3-Clause), websockets (BSD-3-Clause). `misaki` can fall back to espeak-ng (GPL-3.0)
for unknown words if it is installed on the system; lalala does not bundle or install it.

## Kale's voice, Kokoro (included: `src/voice/browserSpeech/llamaKokoro`, front end in `src/voice/browserSpeech/matcha`)

The reply voice (Automatic, every device) ships with this repository and runs in the browser:

| Part | What it is | License |
| --- | --- | --- |
| `llamaKokoro/llama-kokoro-f40warm.onnx` | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)'s text side, fine-tuned by Kale on speech generated with [Maya1](https://huggingface.co/maya-research/maya1) (one voice, f40warm), and Kale's own 8.4M decoder (a [Paradee](https://github.com/sahilmahendrakar/paradee) source-filter head and AdaIN trunk) trained from random initialisation on the same Maya1 audio; one graph, text side in 16 bits, decoder weights in 8 bits | MIT, as this repository, subject to the Llama 3.2 Community License below; Kokoro-82M weights: Apache-2.0; Maya1: Apache-2.0; module code: kokoro (Apache-2.0), kikiri-tts (Apache-2.0), StyleTTS2 (MIT), Paradee (Apache-2.0) |
| `public/models/kale-storyteller/` (the cheerful storyteller, Automatic: `onnx/model.onnx`, `voices/storyteller.bin`, Transformers.js config and tokenizer) | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)'s text side, fine-tuned by Kale on speech generated with [Maya1](https://huggingface.co/maya-research/maya1) (one voice, the cheerful storyteller), and Kale's own small decoder (a [Paradee](https://github.com/sahilmahendrakar/paradee) source-filter head and AdaIN trunk) trained on the same Maya1 audio; one graph, text side in 16 bits, decoder weights in 8 bits; runs through [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0) | As Kale's Kokoro in the row above (based on Maya: the Llama 3.2 terms below apply); the tokenizer is Kokoro's IPA-to-id table (Apache-2.0) |
| `public/models/kale-tts-1-tiny-preview/` (two voices: `voices/storyteller.bin`, `voices/m3.bin`, with a volcano line each in `samples/`) | The kale-tts-1-tiny preview: the same graph family as kale-tts-1-tiny (Hazel's model underneath), fine-tuned on speech generated with [Maya1](https://huggingface.co/maya-research/maya1) in two voices (the cheerful storyteller and M3); runs through [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0) | As Kale's Kokoro above (based on Maya: the Llama 3.2 terms below apply); the tokenizer is Kokoro's IPA-to-id table (Apache-2.0) |
| `public/models/kale-tts-1-tiny/` (kale-tts-1-tiny, k10c: `onnx/model.onnx`, `voices/hazel.bin`, Transformers.js config and tokenizer) | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)'s text side, fine-tuned by Kale, and Kale's own 3.65M decoder, Hazel's voice; one graph, text side in 16 bits, decoder weights in 8 bits; runs through [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0) | As Kale's Kokoro in the row above; the tokenizer is Kokoro's IPA-to-id table (Apache-2.0) |
| `llamaKokoro/voicepack-f40warm.f32`, `llamaKokoro/ipa2kokoro.json` | The voice's style vector and Kokoro's IPA-to-id table | Apache-2.0 (Kokoro-82M); the voicepack, Kale's: MIT |
| `matcha/lexicon.tsv` | English word list made from [CMUdict](https://github.com/cmusphinx/cmudict) | BSD-2-Clause, Copyright (C) 1993-2015 Carnegie Mellon University (the notice is at the top of the file) |
| `matcha/override.tsv`, `matcha/g2p.bin`, `matcha/kaleTts.js` | Kale's hand-checked words, a small model for unknown words (trained on the word list) and the code that turns text into sounds | MIT, as this repository |

Based on Maya: the voice learned from audio made with Maya1 (Apache-2.0), which is built on Llama 3.2
(Llama 3.2 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved; the license and
Meta's Acceptable Use Policy are in `src/voice/browserSpeech/matcha/LLAMA-3.2-LICENSE.txt` and
`LLAMA-3.2-USE-POLICY.md`).

Kale's earlier voice, Matcha (`matcha/llama-matcha-f40warm.onnx`, a Matcha-TTS model, MIT, and
`matcha/vocos-maya-noclip-g0485.onnx`, BSC-LT's vocos-mel-22khz fine-tuned on Maya1 audio, Apache-2.0;
based on Maya under the same terms) stays in the repository but is no longer used by the app
(15 Nov).

No espeak-ng (or other GPL code or data) is used at runtime. The runtime is
[onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT), loaded from jsDelivr.

## dizione's text rules (included: `src/voice/browserSpeech/dizione`)

Both browser voices read numbers, money, dates, times, units, codes and abbreviations with a
JavaScript port of the text rules of [dizione](https://github.com/n4ze3m/dizione) by Muhammed
Nazeem (`spoken.js`, `tables.js` from its `normalize.py` and `data/`), and Kale's Kokoro picks the
reading of words like "read" and "live" with a port of its homograph picker (`homographs.js`;
`homographs.data.js` is its built `homographs.json`, weights trained on the Wikipedia Homograph
Data). Apache-2.0; the license is in `src/voice/browserSpeech/dizione/LICENSE`.

## Sounds

The topic sounds in `src/voice/extras/topicSounds-*.mp3` were generated with ElevenLabs (sound
effects, and text to speech for the spoken ones) on a paid plan with a commercial license, and are
released with this repository under its MIT License.

## Fonts

Bundled in `src/voice/presence/fonts`: Geist and Geist Mono (Vercel, SIL Open Font License 1.1),
Oxanium (SIL OFL 1.1), Rajdhani (Indian Type Foundry, SIL OFL 1.1). Inter comes from
`@fontsource-variable/inter` (SIL OFL 1.1).
