# lalala

talk to all your agents [lalala.talk](https://lalala.talk)

lalala is a voice-first canvas on top of
[T3 Code](https://github.com/pingdotgg/t3code): you speak, a "brain" thread in T3 Code listens,
answers out loud in a sentence or two, and hands real work to other agent threads in the
background. When something is worth looking at, the brain builds it as a card on an endless
canvas next to you: a list, a comparison, a diagram, a small tool, even a game.

Speech runs in your browser: speech-to-text is NVIDIA Parakeet, text-to-speech is Kokoro, and
Silero VAD hears when you stop, all on ONNX (WebGPU or WASM). On phones, the app hands Kokoro to a
small speech service on your Mac (MLX). No audio leaves your devices.

## How it works

```
browser (mic, canvas) ──▶ lalala server :5780 ──▶ T3 Code server   (pairing + /ws RPC, brain thread)
                                    └─────────────▶ local speech :5797 (phones: Kokoro TTS on MLX)
```

- **lalala server** (`npm start`): serves the canvas, keeps one connection to T3 Code that follows
  the brain thread, serves your cards folder, and forwards a phone's speech to the local speech
  service. The browser only talks to it.
- **Brain thread**: an ordinary T3 Code thread in a project rooted at this folder (or the folder
  `LALALA_WORKSPACE_ROOT` names). Its instructions
  are `src/voice/brain.md` plus how this host makes cards (`brain-files.md` or `brain-cards.md`),
  which lalala sends into the thread on the first turn, after compaction and whenever they change. The brain keeps replies short (they are read aloud) and delegates
  real work to other threads with T3 Code's own tools, so it stays free to listen.
- **Local speech** (`npm run speech`): a small Python service on `127.0.0.1` that speaks for phones
  (and listens for a tab whose own model crashed).
- **Canvas**: pan, pinch-zoom, several named canvases, cards you drag by the header and resize
  from the corner. It starts empty; the brain adds cards when you ask for them. The layout is
  saved in `.lalala/canvas.json`, so it survives restarts and is the same on every device.

### One codebase, two hosts

The app and [lalala.talk](https://lalala.talk) (`site/`, Next.js) run the same canvas, cards, bar,
settings and call code from `src/voice`. Only the adapters in `src/voice/adapters` differ, picked
once at startup (`src/main.tsx` for the app, `site/app/canvas/adapters.ts` for the site):

- **storage**: layout and settings on the lalala server (`server.ts`), or in this browser only (`browser.ts`).
- **harness**: T3 Code through the lalala server, or straight from the browser to T3 Code.
  The site's harness also reads files from the brain's project, which is how its cards arrive.

Speech is the same on both (`src/voice/browserSpeech`); only the app can hand a phone's speech to
the Mac. The site imports `src/voice` with the app's own aliases (`site/next.config.mjs` mirrors
`vite.config.mjs`).

## Requirements

- **Mac with Apple silicon** (M1 or later) for the phone speech service, which runs on MLX.
  On a computer alone, the browser's own models are enough.
- **Node.js 22.12 or later**.
- **[uv](https://docs.astral.sh/uv/)** (`brew install uv`). It installs Python 3.12 for the speech
  service by itself.
- **T3 Code** running on the same Mac (the desktop app, or `npx t3`), with at least one provider
  signed in (Claude Code, Codex, …).
- **The `t3` command.** The desktop app installs it as `~/.t3/bin/t3` when it starts; lalala finds
  it there. Add `~/.t3/bin` to your `PATH` to type `t3` yourself, or use `npx t3` instead of `t3`
  in the steps below (that also works if you run T3 Code with `npx t3`).
- **Disk**: about 4 GB under `~/.cache/lalala` (models and the Python environment), downloaded
  once.
- **A microphone** and speakers or headphones. Headphones work best.
- **Browser**: Chrome, Arc, Safari or Firefox. The mic only works on `localhost`/`127.0.0.1` or
  over HTTPS.

## Setup

1. **Clone and install**

   ```sh
   git clone https://github.com/KaleComputer/lalala.git
   cd lalala
   npm install
   cp .env.example .env
   ```

2. **Prepare local speech** (first run downloads ~4 GB; a few minutes)

   ```sh
   npm run speech
   ```

   Wait until it prints `models ready`, then stop it with Ctrl-C. You can skip this
   step: lalala starts the service by itself when the page opens. Doing it once up front just
   means your first call doesn't wait for the download.

3. **Start T3 Code** (desktop app, or `npx t3`) and leave it running. lalala finds it through
   T3 Code's runtime file in `~/.t3/userdata`. If yours lives elsewhere, set `T3CODE_HOME` in
   `.env`, or `LALALA_T3_ORIGIN=http://127.0.0.1:<port>`.

4. **Pair lalala with T3 Code** (once)

   ```sh
   npm run pair
   ```

   This asks the `t3` command for a one-time pairing token with only the two scopes lalala needs
   (`orchestration:read`, `orchestration:operate`), exchanges it for a session and stores it in
   `.lalala/session.json` (mode 0600, gitignored). Nothing secret is printed. The session renews
   itself a week before it expires. You can see and revoke it in T3 Code under Settings →
   Connections, listed as "lalala".

   The settings (gear in the bar) show the connection too: state, server, session and a Test
   button, plus pairing by a T3 pairing link (made in T3 Code under Settings → Connections) or with
   this machine's T3 Code, and Disconnect. A link pairing does not renew itself; pair again before
   it ends.

5. **The brain thread**

   Nothing to do: once paired, lalala uses this folder's T3 Code project (or makes it once, named
   "lalala") and starts a thread called "brain" there, on the project's or T3 Code's default model.
   It remembers that thread in `.lalala/brain.json`. Your cards go in `cards/` in that project
   (gitignored here); see [Cards](#cards).

   The brain answers every time you speak, so give it a fast model (a Haiku-class or "mini"
   model): change it in the settings (gear in the bar) or in T3 Code. Delegated threads do the
   heavy work. To use a thread of your own instead, put its id (all of it, including any prefix
   such as `mcp:`) in `.env` as `LALALA_THREAD_ID=<thread id>`.

   You don't paste `brain.md` anywhere; lalala sends it into the thread before your first spoken
   message.

6. **Start lalala**

   ```sh
   npm start
   ```

7. **Open http://127.0.0.1:5780**, allow the microphone, and press **Start call** in the bar at
   the bottom (or Ctrl+Option+V). Say "put a clock on the canvas" and watch it appear.

   The first call downloads the speech models into the browser (a few hundred MB, once). On a
   phone, lalala starts the Mac's speech service in the background when needed and leaves it
   running after `npm start` stops; `scripts/speech.sh stop` stops it.

## Phone and tablet (optional)

The phone needs HTTPS for the microphone, so `http://<mac-ip>:5780` loads the canvas but can't
listen. Expose the local port under a URL only you can open:

- **NetBird**: `netbird expose` publishes a local port over HTTPS through NetBird's reverse proxy,
  behind your NetBird SSO and only for the user groups you list:

  ```sh
  netbird expose 5780 --with-name-prefix lalala --with-user-groups <your-group>
  ```

  Open the URL it prints on your phone and sign in with a NetBird user in that group. For a fixed
  URL, add `--with-custom-domain <domain>` (the domain must be set up in your NetBird account).
  It stays up while the command runs. Never expose lalala without `--with-user-groups` (or at
  least `--with-password`).

- **Tailscale**: `tailscale serve --bg 5780`, then open `https://<mac>.<tailnet>.ts.net` on the
  phone (both devices in your tailnet). `tailscale serve reset` stops it.

Anyone who can open the URL can talk to your brain thread, and through it to your agents. Keep it
private to your own devices: never use `tailscale funnel` or an unrestricted NetBird expose.

## Cards

Your cards live in `cards/` in the brain's project folder, never in this repo, so you can clone
lalala, pull its updates, and keep your cards to yourself (make `cards/` a private git repo of its
own if you like; the brain then commits each change, so "undo that" is a `git revert`). Ask the
brain for something ("put a list of my open threads on the canvas") and it makes one of two kinds:

- **HTML** (the default, and the only kind on lalala.talk): one self-contained file,
  `cards/<id>.html`, named in the brain's reply with `[card id="timer" title="Pomodoro" size="320x200"]`.
  It runs in a sandboxed frame (inline and CDN scripts run; no network, no storage, no access to
  the page). For live data it calls `lalala.data()`, which reads `cards/<id>.data.json`; a small
  helper the brain writes and starts in the same folder keeps that file current. `lalala.log()`
  notes a pick for the brain. `[card remove id="timer"]` takes a card off.
- **React** (the app only): a component in `cards/`, mounted with one line in `cards/index.tsx`,
  whose default export renders your cards. It hot-reloads on every device within seconds:

  ```tsx
  <CanvasCard id="timer" title="Pomodoro" at={{ x: 40, y: 40, w: 320, h: 200 }}>
    <Pomodoro />
  </CanvasCard>
  ```

  A React card imports lalala's canvas files as if they sat next to it (`./CanvasCard`,
  `./cardState`, `./streamer`, `./cutFrame.css`) and styles itself with a plain CSS file.
  `cards/server/*.mjs` may add routes to the app's dev server (each default-exports a Vite plugin).

- `at` is only a wish: a new card lands in the nearest free space next to the others.
- `canvas="…"` puts a card on a named canvas; without it, it lives on Main.
- **Follow** (in the settings, or say "follow"): when on, a reply about a card moves your view to it. "Show me the timer" does that
  once. "Tidy up" repacks the open canvas with even gaps.

Your own brain rules go in `src/voice/brain.user.md` (gitignored); lalala appends them to
`brain.md`, and they win where the two differ.

## Configuration

Set in `.env` (see `.env.example`).

| Variable | Default | What |
| --- | --- | --- |
| `LALALA_THREAD_ID` | made after pairing | The brain thread, if not the one lalala makes |
| `LALALA_PORT` | `5780` | lalala server port |
| `LALALA_LOCAL_PORT` | `5797` | Local speech service port |
| `LALALA_LOCAL_VOICE` | `af_heart` | Kokoro voice |
| `LALALA_LOCAL_SPEED` | `1.0` | Speaking speed |
| `LALALA_SPEECH_HOME` | `~/.cache/lalala` | Models, Python environment, speech log |
| `LALALA_STATE_DIR` | `.lalala` in this folder | T3 session, canvas layout, call log |
| `LALALA_WORKSPACE_ROOT` | this folder | The brain's T3 project folder |
| `LALALA_CARDS_DIR` | `cards/` in that folder | Your cards |
| `T3CODE_HOME` | `~/.t3` | Where T3 Code keeps its state |
| `LALALA_T3_ORIGIN` | from T3 Code's runtime file | T3 Code server URL |
| `T3CODE_CLI_PATH` | `~/.t3/bin/t3`, then `t3`, then `npx t3` | The `t3` command used for pairing |

## Privacy

- Audio, transcripts and synthesized speech stay on your Mac. The speech service listens on
  `127.0.0.1` only; models download once from Hugging Face (telemetry off).
- What you say becomes a message in your brain thread, so it goes to whichever model provider that
  thread uses, exactly like typing it into T3 Code.
- `.lalala/logs` holds a log of your calls (transcripts and timings, never audio). Delete it
  whenever you like.
- lalala's T3 Code session can read threads and start turns, nothing more. Revoke it in T3 Code.
- On lalala.talk, a card's pictures, scripts and stylesheets from sites that don't allow embedding
  load through lalala.talk itself (`/x/`), fetched without cookies and cached; nothing else is kept.

## Limits

- Apple silicon only, English only.
- One brain thread, one listener: two browsers in the same call talk over each other.
- Speakers without headphones can trigger false barge-ins.
- The page runs on Vite's dev server, so the first load over a slow connection takes a while.
- The brain edits code in this repo live. It commits each change, but a bad edit can break the
  page until it reverts; `git log` shows what it did.
- Real agent turns cost money on your provider plan.

## License

MIT, see [LICENSE](LICENSE). Parts are adapted from T3 Code (MIT, © T3 Tools Inc.); lalala is not
affiliated with T3 Tools. Model, font and package credits are in [NOTICE.md](NOTICE.md).

Speech-to-text uses [NVIDIA Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)
(CC-BY-4.0); text-to-speech uses [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
(Apache-2.0); voice activity detection uses [Silero VAD](https://github.com/snakers4/silero-vad) (MIT).
The models are downloaded at runtime and not part of this repository.
