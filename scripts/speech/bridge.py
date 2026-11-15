"""lalala.talk's way to the speech service on the computer running T3 Code.

lalala.talk has no server of its own: it reaches this computer only through the paired T3 Code,
which can read and write files in the voice thread's project and run commands in its terminal.
So lalala.talk writes this folder (.lalala/speech/), starts this script in a T3 terminal, and then
talks to it through files:

  status.json      written here every second: {"state", "reason", "at"} (starting, loading, ready, down)
  wanted           touched by the page while it wants speech here; idle for 30 min, this script ends
  in/<id>.json     a request: {"task": "stt", "wav": base64} or {"task": "tts", "text": ...}
  out/<id>.json    its answer: {"text": ...}, {"pcm": base64 16-bit 24 kHz} or {"error": ...}

It starts the speech service (scripts/speech.sh start, the same one the lalala app uses) when it
doesn't answer, and keeps it going. Standard library only: it runs on any python3.
"""

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
IN = os.path.join(HERE, "in")
OUT = os.path.join(HERE, "out")
STATUS = os.path.join(HERE, "status.json")
WANTED = os.path.join(HERE, "wanted")
RETRY = os.path.join(HERE, "retry")  # written by the page's Retry now: start the service again at once
PID = os.path.join(HERE, "bridge.pid")
SPEECH = os.path.join(HERE, "scripts", "speech.sh")
PORT = int(os.environ.get("LALALA_LOCAL_PORT", "5797"))
LOG = os.path.join(
    os.environ.get("LALALA_SPEECH_HOME", os.path.expanduser("~/.cache/lalala")), f"speech-{PORT}.log"
)
START_WINDOW_S = 600  # the first start installs a venv and downloads ~2.6 GB of models
IDLE_EXIT_S = 30 * 60


def write_json(path, value):
    part = f"{path}.part"
    with open(part, "w") as file:
        json.dump(value, file)
    os.replace(part, path)


def service(path, body=None, content_type=None, timeout=30):
    request = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=body)
    if content_type:
        request.add_header("content-type", content_type)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def health():
    try:
        return "ready" if json.loads(service("/health", timeout=2)).get("ready") else "loading"
    except (OSError, ValueError):
        return None


def log_size():
    try:
        return os.path.getsize(LOG)
    except OSError:
        return 0


def log_tail(since=0):
    """The log's last lines written since `since` (the size it had when this start began)."""
    try:
        with open(LOG, "rb") as file:
            file.seek(max(since, os.path.getsize(LOG) - 4000))
            lines = [line.strip() for line in file.read().decode("utf-8", "replace").splitlines()]
        return [line for line in lines if line]
    except OSError:
        return []


def why_down(since):
    for line in reversed(log_tail(since)):
        if "needs" in line or "Error" in line or "error" in line:
            return line[:200]
    return "It didn't answer on 127.0.0.1:%d." % PORT


def answer(name):
    path = os.path.join(IN, name)
    try:
        with open(path) as file:
            ask = json.load(file)
    except (OSError, ValueError):
        # T3 may still be writing it: a fresh file gets another look, an old broken one goes.
        try:
            if time.time() - os.path.getmtime(path) > 5:
                os.remove(path)
        except OSError:
            pass
        return
    try:
        os.remove(path)
    except OSError:
        pass
    reply = {}
    try:
        if ask.get("task") == "stt":
            text = json.loads(service("/stt", base64.b64decode(ask["wav"]), "audio/wav"))
            reply = {"text": text.get("text", "")}
        elif ask.get("task") == "tts":
            pcm = service("/tts", json.dumps({"text": ask.get("text", "")}).encode(), "application/json")
            reply = {"pcm": base64.b64encode(pcm).decode()}
        else:
            reply = {"error": "unknown task"}
    except urllib.error.HTTPError as error:
        reply = {"error": error.read().decode("utf-8", "replace")[:200] or str(error)}
    except Exception as error:  # noqa: BLE001 - every failure goes back to the page as its answer
        reply = {"error": str(error)[:200]}
    write_json(os.path.join(OUT, name), reply)


def alone():
    try:
        with open(PID) as file:
            other = int(file.read().strip() or 0)
        if other and other != os.getpid():
            os.kill(other, 0)
            return False
    except (OSError, ValueError):
        pass
    with open(PID, "w") as file:
        file.write(str(os.getpid()))
    return True


def main():
    os.makedirs(IN, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    if not alone():
        print("lalala speech bridge: already running")
        return
    print(f"lalala speech bridge: answering lalala.talk through {HERE}")
    started_at = 0.0
    log_from = 0
    state, reason = "starting", None
    checked = 0.0
    while True:
        now = time.time()
        if now - checked >= 1:
            checked = now
            found = health()
            if found is None and os.path.exists(RETRY):
                started_at = 0.0
            try:
                os.remove(RETRY)
            except OSError:
                pass
            if found is not None:
                state, reason = found, None
            elif started_at == 0 or (state == "down" and now - started_at > 30):
                log_from = log_size()
                subprocess.run(["bash", SPEECH, "start"], capture_output=True, timeout=30)
                started_at = now
                state, reason = "starting", None
            elif now - started_at > START_WINDOW_S or any("needs" in line for line in log_tail(log_from)):
                state, reason = "down", why_down(log_from)
            else:
                tail = log_tail(log_from)
                state = "starting"
                reason = "Installing (first time, ~2.6 GB)" if any(
                    "Preparing" in line for line in tail[-5:]
                ) else None
            write_json(STATUS, {"state": state, "reason": reason, "at": now})
            for name in os.listdir(OUT):
                path = os.path.join(OUT, name)
                try:
                    if now - os.path.getmtime(path) > 60:
                        os.remove(path)
                except OSError:
                    pass
            try:
                if now - os.path.getmtime(WANTED) > IDLE_EXIT_S:
                    break
            except OSError:
                pass
        for name in sorted(os.listdir(IN)):
            if name.endswith(".json"):
                answer(name)
        time.sleep(0.03)
    write_json(STATUS, {"state": "off", "reason": None, "at": time.time()})
    try:
        os.remove(PID)
    except OSError:
        pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
