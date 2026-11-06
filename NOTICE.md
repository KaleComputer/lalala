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

## Fonts

Bundled in `src/voice/presence/fonts`: Geist and Geist Mono (Vercel, SIL Open Font License 1.1),
Oxanium (SIL OFL 1.1), Rajdhani (Indian Type Foundry, SIL OFL 1.1). Inter comes from
`@fontsource-variable/inter` (SIL OFL 1.1).
