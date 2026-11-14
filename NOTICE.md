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

## Kale's voice, Llama Matcha (included: `src/voice/browserSpeech/matcha`)

**Built with Llama.** The phones' reply voice ships with this repository and runs in the browser:

| Part | What it is | License |
| --- | --- | --- |
| `llama-matcha-f40warm.onnx` | A [Matcha-TTS](https://github.com/shivammehta25/Matcha-TTS) model trained by Kale from random initialisation on speech generated with [Maya1](https://huggingface.co/maya-research/maya1) (149 voices), one voice (f40warm) baked in, weights stored in 8 bits | MIT, as this repository, subject to the Llama 3.2 Community License below; Maya1: Apache-2.0; Matcha-TTS code: MIT, Copyright (c) 2023 Shivam Mehta |
| `vocos-maya-noclip.onnx` | [BSC-LT/vocos-mel-22khz](https://huggingface.co/BSC-LT/vocos-mel-22khz) (`mel_spec_22khz_univ`, via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)) fine-tuned by Kale on Maya1 audio, weights stored in 16 bits. The original was trained by BSC-LT on LibriTTS-R (CC BY 4.0), LJSpeech (public domain), Festcat (CC BY-SA 3.0) and OpenSLR69 (CC BY-SA 4.0) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0); [Vocos](https://github.com/gemelo-ai/vocos) code: MIT |
| `lexicon.tsv` | English word list made from [CMUdict](https://github.com/cmusphinx/cmudict) | BSD-2-Clause, Copyright (C) 1993-2015 Carnegie Mellon University (the notice is at the top of the file) |
| `override.tsv`, `g2p.bin`, `kaleTts.js` | Kale's hand-checked words, a small model for unknown words (trained on the word list) and the code that turns text into speech | MIT, as this repository |

Maya1 is built on Llama 3.2, so this voice is "Built with Llama" and its name starts with "Llama".
Llama 3.2 is licensed under the Llama 3.2 Community License, Copyright © Meta Platforms, Inc. All
Rights Reserved. The license and Meta's Acceptable Use Policy are in
`src/voice/browserSpeech/matcha/LLAMA-3.2-LICENSE.txt` and `LLAMA-3.2-USE-POLICY.md`; use of this
voice must follow them.

No espeak-ng (or other GPL code or data) is used at runtime. The runtime is
[onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT), loaded from jsDelivr.

## Sounds

The topic sounds in `src/voice/extras/topicSounds-*.mp3` were generated with ElevenLabs (sound
effects, and text to speech for the spoken ones) on a paid plan with a commercial license, and are
released with this repository under its MIT License.

## Fonts

Bundled in `src/voice/presence/fonts`: Geist and Geist Mono (Vercel, SIL Open Font License 1.1),
Oxanium (SIL OFL 1.1), Rajdhani (Indian Type Foundry, SIL OFL 1.1). Inter comes from
`@fontsource-variable/inter` (SIL OFL 1.1).
