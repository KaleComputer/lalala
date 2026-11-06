// From Presence's call-frame bar, recoloured green.
// The call frame's look (v3, 21 Oct; media/presence/cyberpunk-call): what the frame around the line shows
// for what Presence is doing, in glyphs and light instead of words. The page (main.mjs) tells it the
// line's state, the call's start, the hold, a reading's parts, learning their
// voice and the call sounds as they play; bar.css draws it. DOM only, no state of Presence's own.
//
//   idle         a dim frame, a hollow square, the room START CALL  connecting  the edge draws itself on, three cells filling,
//                (hatched, a cut plate; bar.css .fr-idle)                       the ASCII line (asciiline.mjs)
//   listening    LISTENING with level bars, the call's timer, the warm wash: one steady look whether the user
//                talks or not ("the listening state is steady with no layout shift"); their
//                voice moves the bars and the line, never the tab
//   working      (thinking) the tab's four cells, one sweeping across; the line's beads fill the room edge to
//                edge (callwave.mjs); nothing runs along the bottom edge
//   speaking     her amber bars
//   stopped      a filled red tab with ■, a red tick cutting the line (a moment after the stop cue)
//   no signal    NO SIGNAL, four cells emptying per retry, the frame torn, the retry sweep
//   a thread     a cyan pip and her bars in the tab while she tells it (no cyan left end any more)
//   waiting      a thread's reply or an agent's question waits to be told: the frame stays as it is; the small
//                cyan squares in the rail under it and their few words show it (main.mjs, squares.mjs)
//   asked        a question the user asked a thread and still waits on: a small red square first in the rail, in
//                every look, cyan for a moment when its answer comes, then gone (pending.mjs)
//   learning     LEARNING VOICE . . . 60%, the scan fill along the top edge
// Only no signal shakes the bar ("it should only shake for an error, and for no other
// state"); every other change is still. The tab's glyph has one fixed slot, so a word never moves.

const STOPPED_MS = 1200;

const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};
const bars = (amb = false) => {
  const s = el("span", `g-bars${amb ? " amb" : ""}`);
  for (let i = 0; i < 4; i++) s.append(el("i"));
  return s;
};
const cells = (kind, n) => {
  const s = el("span", `g-cells ${kind}`);
  for (let i = 0; i < n; i++) s.append(el("i"));
  return s;
};
const GLYPH = {
  standby: () => el("i", "g-hollow"),
  stop: () => el("i", "g-stop"),
  pip: () => el("i", "g-pip"),
  level: () => bars(false),
  voice: () => bars(true),
  cells: () => cells("fill", 3),
  work: () => cells("work", 4),
  retry: () => cells("retry", 4),
};

/** `createFrame({ bar, frame, reduced })`: `bar` the footer, `frame` its [data-frame]. */
export function createFrame({ bar, frame, reduced = false }) {
  const tab = frame.querySelector("[data-tab]");
  // lalala moves the glyph out of the tab (VoiceBar makeStatusTab), so find it in the frame.
  const glyph = frame.querySelector("[data-glyph]");
  const word = tab.querySelector("[data-word]");
  const timer = frame.querySelector("[data-timer]");
  const segs = frame.querySelector("[data-segs]");
  const hold = frame.querySelector("[data-hold]");
  const waits = frame.querySelector("[data-pending]");
  const st = { line: "idle", voice: "idle", thread: false, stoppedUntil: 0, learning: null, liveAt: 0, look: "", key: "" };
  let stopTimer = null;
  let clock = null;

  const fw = () => frame.style.setProperty("--fw", `${frame.offsetWidth}px`);
  new ResizeObserver(fw).observe(frame);
  fw();

  /** A colour split and a jolt for a few frames: the line lost (no signal), the one error the bar shows; motion only. */
  function glitch() {
    if (reduced) return;
    bar.removeAttribute("data-glitch");
    void bar.offsetWidth;
    bar.setAttribute("data-glitch", "");
    setTimeout(() => bar.removeAttribute("data-glitch"), 500);
  }

  /** Which look the frame shows now, from everything it was told. */
  function shown() {
    const s = st.line;
    if (st.learning != null) return "learning";
    if (["error", "disconnected", "reconnecting"].includes(st.voice) || s === "error") return "nosignal";
    if (s === "connecting" || st.voice === "connecting") return "connecting";
    if (Date.now() < st.stoppedUntil) return "stopped";
    if (s === "speaking") return st.thread ? "thread" : "speaking";
    if (s === "thinking") return "working";
    if (s === "listening") return "listening";
    return st.voice === "idle" || st.voice === "no-key" || !st.liveAt ? "idle" : "listening";
  }

  function setTab({ glyphs = [], text = "", hot = false, learn = false }) {
    glyph.replaceChildren(...glyphs.map((g) => (typeof g === "string" ? GLYPH[g]() : g)));
    word.textContent = text;
    tab.toggleAttribute("data-hot", hot);
    tab.toggleAttribute("data-learn", learn);
  }

  function paint() {
    const look = shown();
    const flags = [];
    if (look === "idle" || look === "connecting") flags.push("off");
    if (look === "connecting") flags.push("draw");
    if (look === "stopped") flags.push("hot");
    if (look === "nosignal") flags.push("off", "broken");
    const key = `${look}|${flags.join(" ")}|${st.learning != null ? Math.round(st.learning * 100) : ""}`;
    if (key === st.key) return;
    const was = st.look;
    st.key = key;
    st.look = look;
    frame.dataset.state = look;
    frame.dataset.look = flags.join(" ");
    if (look !== was && look === "nosignal") glitch();
    switch (look) {
      case "idle": setTab({ glyphs: ["standby"] }); break;
      case "connecting": setTab({ glyphs: ["cells"] }); break;
      case "listening": setTab({ glyphs: ["level"], text: "listening" }); break;
      case "working": setTab({ glyphs: ["work"] }); break;
      case "speaking": setTab({ glyphs: ["voice"] }); break;
      case "thread": setTab({ glyphs: ["pip", "voice"] }); break;
      case "stopped": setTab({ glyphs: ["stop"], hot: true }); break;
      case "nosignal": setTab({ glyphs: ["retry"], text: "no signal", hot: true }); break;
      case "learning": setTab({ glyphs: [Object.assign(el("b"), { textContent: `${Math.round((st.learning ?? 0) * 100)}%` })], text: "learning voice . . .", learn: true }); break;
    }
    if (look === "learning") {
      hold.hidden = false;
      hold.setAttribute("data-learn", "");
      hold.style.setProperty("--hold-right", "0px");
      hold.firstElementChild.style.setProperty("--p", `${Math.round((st.learning ?? 0) * 100)}%`);
    } else if (hold.hasAttribute("data-learn")) {
      hold.removeAttribute("data-learn");
      hold.firstElementChild.style.removeProperty("--p");
      hold.hidden = true;
    }
  }

  // The call's timer: since the session went live, over the key.
  function tickClock() {
    if (!st.liveAt) return void (timer.hidden = true);
    const s = Math.max(0, Math.floor((Date.now() - st.liveAt) / 1000));
    timer.firstElementChild.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    timer.hidden = false;
  }

  function stopped() {
    st.stoppedUntil = Date.now() + STOPPED_MS;
    clearTimeout(stopTimer);
    stopTimer = setTimeout(paint, STOPPED_MS + 20);
    paint();
  }

  return {
    /** The line's state (tools.mjs lineShows) and the voice's own state; the user talking is listening (one look). */
    state({ line, voice }) {
      st.line = line;
      st.voice = voice;
      const live = ["listening", "thinking", "speaking"].includes(voice);
      if (live && !st.liveAt) {
        st.liveAt = Date.now();
        tickClock();
        clock ??= setInterval(tickClock, 1000);
      } else if (!live && !["reconnecting", "disconnected"].includes(voice) && st.liveAt) {
        st.liveAt = 0;
        clearInterval(clock);
        clock = null;
        tickClock();
      }
      paint();
    },
    /** A thread's answer (or an agent's question) is on the line while she tells it. */
    thread(on) {
      st.thread = Boolean(on);
      paint();
    },
    stopped,
    /** A call sound played (voice.mjs on.cue): its visual match. */
    cue(name) {
      if (name === "stop") stopped();
    },
    /** Learning their voice: 0..1, or null when it ends. */
    learning(p) {
      st.learning = p == null ? null : Math.max(0, Math.min(1, p));
      paint();
    },
    /** A reading in parts: the rail becomes `n` part segments, `i` the one she reads (filling over `ms`); null ends it. */
    parts(r) {
      if (!r || r.n < 2) return void ((segs.hidden = true), segs.replaceChildren());
      const n = Math.min(r.n, 16);
      const i = Math.min(r.i, n - 1);
      const have = segs.children.length === n && segs.dataset.i === String(i);
      if (have) return;
      segs.dataset.i = String(i);
      segs.replaceChildren(...Array.from({ length: n }, (_, k) => {
        const s = el("i", k < i ? "done" : k === i ? "cur" : "");
        if (k === i) s.style.setProperty("--seg-ms", `${Math.max(1500, r.ms ?? 6000)}ms`);
        return s;
      }));
      segs.hidden = false;
    },
    /**
     * The questions the user still waits on (pending.mjs pendingOf): one small square each, first in the rail
     * under the frame, kept by id so one that arrived turns cyan in place before it goes.
     */
    pending(list = []) {
      if (!waits) return;
      const have = new Map([...waits.children].map((i) => [i.dataset.id, i]));
      const items = list.map((q) => {
        const i = have.get(q.id) ?? el("i");
        i.dataset.id = q.id;
        i.dataset.state = q.state;
        return i;
      });
      if (items.length !== waits.children.length || items.some((i, k) => waits.children[k] !== i)) waits.replaceChildren(...items);
    },
    /** Typing: the frame opens upward into the field. */
    open(on) {
      frame.toggleAttribute("data-open", Boolean(on));
    },
    get look() {
      return st.look;
    },
    /** Whose sound the line carries now: "her" while she speaks, "user" while it listens (their microphone), else "". */
    get audio() {
      if (st.look === "nosignal" || st.look === "connecting" || st.look === "stopped" || st.look === "idle") return "";
      return st.line === "speaking" ? "her" : st.line === "listening" ? "user" : "";
    },
  };
}
