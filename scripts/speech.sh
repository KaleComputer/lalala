#!/bin/bash
# Local speech for t3voice: Parakeet (speech-to-text) and Kokoro (text-to-speech) on MLX, on
# 127.0.0.1:${T3VOICE_LOCAL_PORT:-5797}. The t3voice server forwards /__t3voice/local/* to it, so the
# browser never talks to this port.
#
#   scripts/speech.sh          run in the foreground (npm run speech)
#   scripts/speech.sh start    start in the background unless it already answers
#   scripts/speech.sh stop     stop the one started in the background
#
# The venv and the models (~2.6 GB, downloaded once) live in $T3VOICE_SPEECH_HOME
# (default ~/.cache/t3voice), and so do the background log and PID file.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
HERE="$ROOT/scripts/speech"
HOME_DIR="${T3VOICE_SPEECH_HOME:-$HOME/.cache/t3voice}"
PORT="${T3VOICE_LOCAL_PORT:-5797}"
PID_FILE="$HOME_DIR/speech-$PORT.pid"
LOG_FILE="$HOME_DIR/speech-$PORT.log"
mkdir -p "$HOME_DIR"

answers() { curl -fsS -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q "\"ready\""; }

case "${1:-}" in
  stop)
    if [ -s "$PID_FILE" ] && pid="$(cat "$PID_FILE")" && kill "$pid" 2>/dev/null; then
      for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      echo "Stopped local speech."
    fi
    rm -f "$PID_FILE"
    exit 0
    ;;
  start)
    if answers; then exit 0; fi
    nohup "$0" >>"$LOG_FILE" 2>&1 </dev/null &
    echo $! >"$PID_FILE"
    echo "Local speech starting on 127.0.0.1:$PORT (log $LOG_FILE)."
    exit 0
    ;;
esac

[ "$(uname -sm)" = "Darwin arm64" ] || { echo "Local speech needs an Apple Silicon Mac (MLX)." >&2; exit 1; }
command -v uv >/dev/null || { echo "Local speech needs uv (https://docs.astral.sh/uv/)." >&2; exit 1; }

# The venv is rebuilt whenever requirements.txt changes.
VENV="$HOME_DIR/venv"
STAMP="$VENV/.t3voice-requirements"
if ! cmp -s "$HERE/requirements.txt" "$STAMP" 2>/dev/null; then
  echo "Preparing the local speech venv in $VENV ..."
  rm -rf "$VENV"
  uv venv -q -p 3.12 "$VENV"
  VIRTUAL_ENV="$VENV" uv pip install -q -r "$HERE/requirements.txt"
  cp "$HERE/requirements.txt" "$STAMP"
fi

export HF_HUB_CACHE="$HOME_DIR/hf" HF_XET_CACHE="$HOME_DIR/xet" HF_HUB_DISABLE_TELEMETRY=1 T3VOICE_LOCAL_PORT="$PORT"
exec "$VENV/bin/python" -I "$HERE/server.py"
