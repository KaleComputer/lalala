"""
Local speech for t3voice: Parakeet TDT 0.6B v2 (speech-to-text) and Kokoro 82M (text-to-speech,
American "af_heart" voice), both on MLX. Binds loopback only; the browser reaches it through the
t3voice server (`/__t3voice/local/*`), never directly.

  GET  /health       {"ready": bool, ...}
  POST /tts          {"text"} -> raw 16-bit 24 kHz mono PCM, streamed per sentence
  POST /stt          16 kHz mono 16-bit WAV -> {"text"}
  WS   /stt/stream   ElevenLabs Scribe realtime's message shapes: input_audio_chunk in (base64
                     16 kHz PCM, `commit`), session_started ({"vad"}) / partial_transcript /
                     committed_transcript ({"speech_s"}) out. Partials re-transcribe the open
                     segment's last 20 s; a commit all of it. Silero VAD runs first: no
                     speech, no transcript.

Start with scripts/speech.sh, which owns the venv and the model cache.
"""

import asyncio
import base64
import io
import json
import os
import re
import sys
import time
import wave
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor

import mlx.core as mx
import numpy as np
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

STT_MODEL = os.environ.get("T3VOICE_LOCAL_STT", "mlx-community/parakeet-tdt-0.6b-v2")
VAD_MODEL = os.environ.get("T3VOICE_LOCAL_VAD", "mlx-community/silero-vad")
TTS_MODEL = os.environ.get("T3VOICE_LOCAL_TTS", "mlx-community/Kokoro-82M-bf16")
VOICE = os.environ.get("T3VOICE_LOCAL_VOICE", "af_heart")
SPEED = float(os.environ.get("T3VOICE_LOCAL_SPEED", "1.0"))
PORT = int(os.environ.get("T3VOICE_LOCAL_PORT", "5797"))
STT_RATE = 16_000
# An utterance is kept whole, no length limit (2 Nov: a 108 s turn lost its first 48 s to a 60 s
# cap). Commits transcribe it in 30 s chunks, joined in order; partials only its last 20 s.
CHUNK_S = 30.0
CHUNK_OVERLAP_S = 2.0
PARTIAL_WINDOW_S = 20
PARTIAL_EVERY_S = 0.25
MIN_PARTIAL_S = 0.4
MAX_TTS_CHARS = 1_200
# Parakeet has no voice detection and turns faint noise into "I'm sorry.", "Yeah.", "Okay." (eval
# 2 Nov: 36 of them during replies). Silero decides first: no speech, no transcript.
VAD_THRESHOLD = 0.5
VAD_FRAME_S = 512 / STT_RATE  # Silero's 32 ms window
MIN_SPEECH_S = 0.15
# What Parakeet makes of breath and noise (never a real answer like "yes" or "okay"); dropped when
# that is all there is and the speech was short.
NOISE_PHRASES = re.compile(
    r"^(?:i'?m sorry|sorry|mm+-?hmm+|hmm+|uh+|um+|thank you|thanks|bye|you|oh|ah)$"
)
NOISE_PHRASE_MAX_S = 0.7

# One thread runs every model call: MLX work stays ordered and never runs concurrently.
gpu = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")
models: dict = {}


def log(*parts) -> None:
    print(time.strftime("%H:%M:%S"), *parts, file=sys.stderr, flush=True)


def load_models() -> None:
    from mlx_audio.stt import load as load_stt
    from mlx_audio.tts.utils import load as load_tts

    # Keep freed Metal buffers from piling up next to T3 and its agents.
    mx.set_cache_limit(256 * 1024 * 1024)
    started = time.time()
    models["stt"] = load_stt(STT_MODEL)
    # The published Parakeet weights are fp32 (2.3 GB); bf16 halves that with the same transcripts.
    models["stt"].set_dtype(mx.bfloat16)
    models["tts"] = load_tts(TTS_MODEL)
    try:
        from mlx_audio.vad import load as load_vad

        models["vad"] = load_vad(VAD_MODEL)
    except Exception as error:  # noqa: BLE001 - without it, transcripts are just ungated
        log(f"no voice detection ({VAD_MODEL}): {error}")
    # First calls load the phonemizer and compile kernels (~1.5 s); pay that before anyone waits.
    # Real speech, so the transcriber's decoder runs too: silence never reaches it.
    spoken = b"".join(synthesize("Ready when you are. What should we work on first?"))
    at_24k = pcm16_to_float(spoken)
    transcribe_pcm(np.interp(np.arange(0, at_24k.size, 1.5), np.arange(at_24k.size), at_24k))
    mx.clear_cache()
    log(f"models ready in {time.time() - started:.1f}s ({STT_MODEL}, {TTS_MODEL} {VOICE})")


def speech_frames(samples: np.ndarray) -> np.ndarray | None:
    """Silero's speech probability per 32 ms frame; None without the model."""
    vad = models.get("vad")
    if vad is None:
        return None
    return np.array(vad.predict_proba(samples, sample_rate=STT_RATE)).reshape(-1) > VAD_THRESHOLD


def transcribe_pcm(samples: np.ndarray, window_s: float | None = None) -> tuple[str, float | None]:
    """Text and seconds of speech Silero found (None without it). Only speech gets a transcript."""
    if window_s is not None and samples.size > window_s * STT_RATE:
        samples = samples[-int(window_s * STT_RATE) :]
    if samples.size < STT_RATE // 10:
        return "", 0.0
    speech = speech_frames(samples)
    speech_s = None if speech is None else float(speech.sum()) * VAD_FRAME_S
    if speech_s is not None and speech_s < MIN_SPEECH_S:
        return "", speech_s
    try:
        long = samples.size > CHUNK_S * STT_RATE
        result = models["stt"].generate(
            mx.array(samples),
            chunk_duration=CHUNK_S if long else None,
            overlap_duration=CHUNK_OVERLAP_S if long else None,
        )
    finally:
        mx.clear_cache()
    text = result.text.strip()
    if speech is not None and result.sentences:
        # Only sentences that overlap speech (a word made up from the noise around it goes).
        kept = [
            sentence.text.strip()
            for sentence in result.sentences
            if speech[
                max(0, int((sentence.start - 0.1) / VAD_FRAME_S)) : int((sentence.end + 0.1) / VAD_FRAME_S) + 1
            ].any()
        ]
        text = " ".join(part for part in kept if part)
    bare = re.sub(r"[^\w' -]", "", text.lower()).strip()
    if speech_s is not None and speech_s < NOISE_PHRASE_MAX_S and NOISE_PHRASES.match(bare):
        return "", speech_s
    return text, speech_s


def synthesize(text: str):
    """Yields 16-bit PCM bytes, one piece per sentence of `text`."""
    try:
        for result in models["tts"].generate(
            text=text,
            voice=VOICE,
            speed=SPEED,
            lang_code="a",
            split_pattern=r"(?<=[.!?;:])\s+|\n+",
        ):
            audio = trim_silence(np.clip(np.array(result.audio, dtype=np.float32), -1.0, 1.0))
            yield (audio * 32767).astype("<i2").tobytes()
    finally:
        mx.clear_cache()


def trim_silence(audio: np.ndarray, rate: int = 24_000) -> np.ndarray:
    """Kokoro pads each sentence with ~0.4 s before and ~0.5 s after; that is pure latency here."""
    loud = np.flatnonzero(np.abs(audio) > 0.015)
    if loud.size == 0:
        return audio
    start = max(0, loud[0] - rate * 20 // 1000)
    end = min(audio.size, loud[-1] + rate * 150 // 1000)
    return audio[start:end]


def pcm16_to_float(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


@asynccontextmanager
async def lifespan(_app):
    # Serve /health ("ready": false) while the models load, so a slow start never looks like "down".
    loading = asyncio.get_running_loop().run_in_executor(gpu, load_models)
    yield
    loading.cancel()


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    return {"ready": "tts" in models, "stt": STT_MODEL, "tts": TTS_MODEL, "voice": VOICE}


@app.post("/tts")
async def tts(request: Request):
    if "tts" not in models:
        return JSONResponse({"error": "local speech is still loading"}, status_code=503)
    body = await request.json()
    text = str(body.get("text", "")).strip()[:MAX_TTS_CHARS]
    if not text:
        return JSONResponse({"error": "no text"}, status_code=400)
    loop = asyncio.get_running_loop()
    pieces = synthesize(text)
    done = object()

    async def stream():
        try:
            while not await request.is_disconnected():
                piece = await loop.run_in_executor(gpu, next, pieces, done)
                if piece is done:
                    return
                yield piece
        finally:
            # A reply cut off by barge-in stops after the sentence piece in progress.
            await loop.run_in_executor(gpu, pieces.close)

    return StreamingResponse(stream(), media_type="application/octet-stream")


@app.post("/stt")
async def stt(request: Request):
    if "stt" not in models:
        return JSONResponse({"error": "local speech is still loading"}, status_code=503)
    raw = await request.body()
    try:
        with wave.open(io.BytesIO(raw)) as wav:
            if wav.getframerate() != STT_RATE or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                return JSONResponse({"error": "expected 16 kHz mono 16-bit wav"}, status_code=400)
            pcm = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError):
        return JSONResponse({"error": "not a wav file"}, status_code=400)
    text, speech_s = await asyncio.get_running_loop().run_in_executor(
        gpu, transcribe_pcm, pcm16_to_float(pcm)
    )
    return {"text": text, "speech_s": speech_s}


@app.websocket("/stt/stream")
async def stt_stream(socket: WebSocket):
    await socket.accept()
    if "stt" not in models:
        await socket.send_json({"message_type": "error", "error": "local speech is still loading"})
        await socket.close()
        return
    loop = asyncio.get_running_loop()
    segment: list[np.ndarray] = []
    samples = 0
    since_partial = 0
    partial: asyncio.Task | None = None
    generation = 0

    async def send_partial(audio: np.ndarray, of_generation: int) -> None:
        text, _speech_s = await loop.run_in_executor(gpu, transcribe_pcm, audio, PARTIAL_WINDOW_S)
        # A partial that finishes after its segment was committed would mislabel the next one.
        if text and of_generation == generation:
            await socket.send_json({"message_type": "partial_transcript", "text": text})

    # `vad`: transcripts come only from speech Silero found (the client lets them cut a reply).
    await socket.send_json({"message_type": "session_started", "vad": "vad" in models})
    try:
        while True:
            message = json.loads(await socket.receive_text())
            if message.get("message_type") != "input_audio_chunk":
                continue
            chunk = pcm16_to_float(base64.b64decode(message.get("audio_base_64") or ""))
            segment.append(chunk)
            samples += chunk.size
            since_partial += chunk.size
            if message.get("commit"):
                audio = np.concatenate(segment) if segment else np.zeros(0, np.float32)
                segment, samples, since_partial = [], 0, 0
                generation += 1
                text, speech_s = await loop.run_in_executor(gpu, transcribe_pcm, audio)
                await socket.send_json(
                    {"message_type": "committed_transcript", "text": text, "speech_s": speech_s}
                )
            elif (
                since_partial >= PARTIAL_EVERY_S * STT_RATE
                and samples >= MIN_PARTIAL_S * STT_RATE
                and (partial is None or partial.done())
            ):
                since_partial = 0
                recent = np.concatenate(segment[-int(PARTIAL_WINDOW_S * STT_RATE / 1600) - 1 :])
                partial = asyncio.create_task(send_partial(recent, generation))
    except (WebSocketDisconnect, RuntimeError):
        pass


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning", ws_max_size=4 * 1024 * 1024)
