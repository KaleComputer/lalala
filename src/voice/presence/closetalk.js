// From Presence's call-frame bar, recoloured green.
// The close-talk gate: only the user talking straight into the phone counts (21 Oct 2026). Walking the
// dog, a shout down the street, people talking a few metres away or a TV next door are speech too,
// and ElevenLabs took them for turns: they cut Presence off mid-sentence and, on the page, flipped
// thinking back to listening. the user's own voice, a hand's width from the microphone, is far louder
// than all of that, so the gate is a level gate against two references it measures as it goes:
//
//   floor  the ambient level (the quiet between sounds), tracked down fast and up slowly, frozen
//          while the gate is open or Presence speaks (her echo is not the street);
//   voice  the user's close voice: how loud his turns are, learned from each turn he takes (clamped, so
//          noise that slips through cannot drag it down far).
//
// Speech counts when it is MARGIN dB over the floor, within VOICE_RANGE dB of the user's voice and over
// ABS_MIN, for ATTACK_MS. However loud the floor, the bar stays HEADROOM dB under the user's own voice:
// he is never locked out by wind or a road (22 Oct). While Presence speaks the bar is BARGE dB higher and must hold for
// BARGE_MS (about 300 ms of clearly-the user); while she thinks (a tool runs, a reply is on its way) it
// is higher again and longer: no barge-in at all unless the user says "stop" or "wait" loudly and close.
// Once open, the user keeps the floor through his pauses (KEEP dB of hysteresis, HOLD_MS after his last
// loud sound). `sensitivity` (-2..2, the user's "be less/more sensitive", prefs.mjs) moves every bar by
// STEP dB.
//
// the user's sentence goes on after Presence took the turn: ElevenLabs ended his turn in a pause and
// thinks, but he is not done. Within CONTINUE_MS of his last close sound the thinking bar is the
// listening bar, so the rest of his sentence reaches ElevenLabs (and stops her reply) instead of
// being cut as noise.
//
// `voiced` is the page's own word on someone talking close to the phone (turns.mjs: nothing Presence
// starts by herself goes in while it is true): the listening bar (the speaking one while she talks,
// her echo is not the user), ATTACK_MS to start, HOLD_MS of quiet to end, and no stage can say no to it.
// So the user talking while the gate is held shut (learning his voice, the speaker check not yet sure, a
// thinking bar he does not reach) is still the user talking.
//
// Stages: a later check (on-device VAD, the user's enrolled voice) plugs in with `stage(name, verdict)`.
// false holds the gate shut, true or null leave it to the levels; the gate opens only when the
// levels say so and no stage says no. A stage fails open: one that has never said true in this
// gate's life can hold it shut for UNPROVEN_MS of someone talking close (SPEAKER_UNPROVEN_MS for
// the speaker check the user turned on: another voice talking first stays out), then it no longer counts
// until it says true once (22 Oct: the user's iPhone, a stage said no to every word and three calls sent
// ElevenLabs nothing but silence; a check that never hears him is broken, not proof). `enroll` is
// deliberate (Presence must not answer while he teaches her his voice) and always counts. The decision is `step()`, one function, pure: the audio
// worklet (closetalk-worklet.js) runs it on the user's microphone and tests run it on synthetic traces.

export const GATE = Object.freeze({
  FLOOR_START: -60, // dBFS before anything is measured
  FLOOR_MIN: -90,
  FLOOR_MAX: -30,
  FLOOR_FALL_MS: 250, // the floor follows a quieter street at once
  FLOOR_RISE_MS: 4000, // and a louder one slowly (a passing shout is not the ambient)
  FLOOR_RISE_SPAN: 20, // only sounds within this of the floor raise it
  MARGIN: 15, // dB over the floor
  VOICE_START: -28, // the user's close voice (dBFS, the mean 10 ms level of his turn's loud part) before he spoke
  VOICE_MIN: -34,
  VOICE_MAX: -20,
  VOICE_RANGE: 10, // speech this far under the user's voice is somebody else, or the user turned away
  HEADROOM: 6, // a loud floor (wind, a road) lifts the listening bar to this far under the user's voice, never over it
  ABS_MIN: -52, // never quieter than this, however quiet the street
  BARGE: 6, // dB more while Presence speaks
  THINK: 3, // and this much more while she thinks
  ATTACK_MS: 90, // a syllable, not a bang or a door (the worklet sends from before it, nothing is lost)
  BARGE_MS: 300,
  THINK_MS: 350,
  KEEP: 6, // once open, the user's quieter syllables keep it open down to this far under the listening bar
  HOLD_MS: 700, // and his pauses this long
  FAR_MS: 1200, // open this long with nothing near his voice (HEADROOM under it): noise holds it (wind), it closes
  CONTINUE_MS: 2000, // after his last close sound, his sentence going on opens at the listening bar while she thinks
  STEP: 4, // dB per sensitivity step
  LEARN_MIN_MS: 400, // a turn this long teaches the gate the user's voice
  SMOOTH_MS: 25, // the level the gate reads: energy averaged this long (one loud 10 ms frame is not speech)
  UNPROVEN_MS: 2500, // a stage that never said true holds the user back this long at most (it fails open)
  SPEAKER_UNPROVEN_MS: 6000, // ... the speaker check this long
});
/** Stages that hold the gate shut on purpose, never failed open. */
const DELIBERATE = new Set(["enroll"]);
export const SENSITIVITY = Object.freeze({ min: -2, max: 2, normal: 0 });
/** Presence's part now, as the gate needs it: listen (nobody), speak (her voice), think (a tool or a reply on its way). */
export const MODES = ["listen", "speak", "think"];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** A mean square (energy) in dBFS. */
export const dbOf = (meanSquare) => 10 * Math.log10(meanSquare + 1e-12);
/** The sensitivity a "less"/"more"/"normal" makes of the current one. */
export function stepSensitivity(cur = 0, said = "normal") {
  if (said === "normal") return SENSITIVITY.normal;
  return clamp((Number(cur) || 0) + (said === "more" ? 1 : said === "less" ? -1 : 0), SENSITIVITY.min, SENSITIVITY.max);
}

/**
 * `createCloseTalk({ sensitivity, ...GATE overrides })`. `step(db, mode, dtMs)` takes one frame's
 * level (dBFS; smoothed over SMOOTH_MS inside) and Presence's mode and returns the gate's decision
 * (one object, reused: read it, don't keep it): `{ open, opened, closed, voiced, bar, floor, voice,
 * by, level }`. `opened` / `closed` are true on the frame it changed; `by` is the mode it opened in;
 * `voiced` is someone talking close to the phone, whatever the stages say (see above).
 */
export function createCloseTalk({ sensitivity = 0, ...over } = {}) {
  const g = { ...GATE, ...over };
  let sens = clamp(Number(sensitivity) || 0, SENSITIVITY.min, SENSITIVITY.max);
  let floor = g.FLOOR_START;
  let voice = g.VOICE_START;
  let open = false;
  let by = null; // the mode it opened in
  let run = 0; // ms over the bar (dips count down, they don't reset: "st-op")
  let quietFor = 0; // ms since the user's last loud sound, while open
  let farFor = 0; // ms since a sound near the user's own voice, while open
  let turnMs = 0;
  let turnSum = 0; // dB over the listening bar this turn, summed (its mean is the turn's loudness)
  let turnN = 0;
  let energy = 10 ** (g.FLOOR_START / 10); // the smoothed level's energy
  let voiced = false; // someone talking close, stages or not
  let vRun = 0; // ms over the voiced bar while not voiced
  let vQuiet = 0; // ms since the last loud sound while voiced
  let sinceVoice = Infinity; // ms since voiced last ended (0 while voiced)
  const stages = new Map();
  const proven = new Set(); // stages that have said true in this gate's life
  let unprovenMs = 0; // someone talking close while only unproven stages held the gate shut
  let heldMs = 0; // someone talking close while a stage held the gate shut (for the call's log line)
  const out = { open: false, opened: false, closed: false, voiced: false, bar: 0, floor, voice, by: null, level: -Infinity, held: 0, vetoes: null };

  /** The bar for a mode: the loudest of the three references, the barge-in extra on top, moved by sensitivity. */
  function barFor(mode) {
    // The floor's part stops HEADROOM under the user's voice: in wind the floor climbed to -30 and the bar
    // over his own voice, and nothing he said reached ElevenLabs (22 Oct, three calls of silence).
    const base = Math.max(Math.min(floor + g.MARGIN, voice - g.HEADROOM), voice - g.VOICE_RANGE, g.ABS_MIN) - sens * g.STEP;
    return base + (mode === "speak" ? g.BARGE : mode === "think" ? g.BARGE + g.THINK : 0);
  }
  const needFor = (mode) => (mode === "speak" ? g.BARGE_MS : mode === "think" ? g.THINK_MS : g.ATTACK_MS);
  const counts = (name) => DELIBERATE.has(name) || proven.has(name) || unprovenMs < (name === "speaker" ? g.SPEAKER_UNPROVEN_MS : g.UNPROVEN_MS);
  const vetoed = () => [...stages].some(([name, v]) => v === false && counts(name));
  /** The stages saying no right now (counted or failed open), or null. */
  const vetoes = () => {
    const no = [...stages].filter(([, v]) => v === false).map(([name]) => (counts(name) ? name : `${name}(ignored)`));
    return no.length ? no.join(",") : null;
  };

  function close(learn = true) {
    open = false;
    // A real turn teaches the user's voice: up quickly (a louder phone, a headset), down slowly.
    if (learn && by === "listen" && turnMs >= g.LEARN_MIN_MS && turnN >= 10) {
      const est = turnSum / turnN;
      voice = clamp(voice + (est - voice) * (est > voice ? 0.3 : 0.05), g.VOICE_MIN, g.VOICE_MAX);
    }
    by = null;
    run = 0;
  }

  function step(frameDb, mode = "listen", dt = 10) {
    out.opened = out.closed = false;
    energy += (10 ** (frameDb / 10) - energy) * (1 - Math.exp(-dt / g.SMOOTH_MS));
    const db = dbOf(energy);
    out.level = db;
    const listenBar = barFor("listen");
    // His sentence going on while she thinks: the listening bar, as if she had not taken the turn.
    const goesOn = mode === "think" && sinceVoice < g.CONTINUE_MS;
    const bar = goesOn ? listenBar : barFor(mode);
    const keepBar = Math.max(listenBar - g.KEEP, floor + g.MARGIN - g.KEEP);
    // Voiced: the listening bar (hers while she speaks), no stage, no barge-in wait.
    const vBar = mode === "speak" ? barFor("speak") : listenBar;
    if (voiced) {
      vQuiet = db >= keepBar ? Math.max(0, vQuiet - 3 * dt) : vQuiet + dt;
      if (vQuiet >= g.HOLD_MS) (voiced = false), (sinceVoice = 0);
    } else {
      vRun = Math.min(db, frameDb) >= vBar ? vRun + dt : Math.max(0, vRun - dt);
      if (vRun >= g.ATTACK_MS) (voiced = true), (vQuiet = 0), (vRun = 0);
      else sinceVoice += dt;
    }
    // Someone talks close and a stage holds the gate shut: counted, and an unproven stage's time runs out.
    if (voiced && !open && vetoed()) {
      heldMs += dt;
      if (![...stages].some(([name, v]) => v === false && (DELIBERATE.has(name) || proven.has(name)))) unprovenMs += dt;
    }
    if (open) {
      turnMs += dt;
      if (db >= listenBar) (turnSum += db), (turnN += 1);
      // A loud frame wins back three quiet ones: speech is dense, a click or a far bang is sparse.
      quietFor = db >= keepBar ? Math.max(0, quietFor - 3 * dt) : quietFor + dt;
      // His syllables reach near his own voice several times a second; wind and breath holding the gate
      // open sit under it (22 Oct: a gust opened it, the wind kept it open and his turn never ended).
      // Near: HEADROOM under his voice (moved by sensitivity), never over a little above the listening bar.
      farFor = db >= Math.min(voice - g.HEADROOM - sens * g.STEP, listenBar + 2) ? 0 : farFor + dt;
      if (vetoed()) close(false), (out.closed = true); // a stage said it is not the user: nothing to learn
      else if (quietFor >= g.HOLD_MS) close(), (out.closed = true);
      else if (farFor >= g.FAR_MS) {
        // Noise, not the user: nothing to learn, and it is the floor now, so it does not open the gate again.
        close(false);
        out.closed = true;
        floor = clamp(Math.max(floor, db - g.MARGIN + 1), g.FLOOR_MIN, g.FLOOR_MAX);
      }
    } else {
      // Over the bar: the smoothed level and this frame both (the average's tail is not more sound).
      run = Math.min(db, frameDb) >= bar ? run + dt : Math.max(0, run - dt);
      if (run >= (goesOn ? g.ATTACK_MS : needFor(mode)) && !vetoed()) {
        open = true;
        by = goesOn ? "listen" : mode;
        quietFor = 0;
        farFor = 0;
        turnMs = run;
        turnSum = db;
        turnN = 1;
        out.opened = true;
      }
    }
    // The ambient floor: measured only while nobody counts as talking (voiced too) and Presence is silent.
    if (!open && !voiced && mode !== "speak") {
      if (db < floor) floor += (db - floor) * (1 - Math.exp(-dt / g.FLOOR_FALL_MS));
      else if (db < floor + g.FLOOR_RISE_SPAN) floor += (db - floor) * (1 - Math.exp(-dt / g.FLOOR_RISE_MS));
      floor = clamp(floor, g.FLOOR_MIN, g.FLOOR_MAX);
    }
    // The gate open is someone talking close too (a barge-in it let through).
    if (open && !voiced) (voiced = true), (vQuiet = 0), (vRun = 0);
    out.open = open;
    out.voiced = voiced;
    out.bar = bar;
    out.floor = floor;
    out.voice = voice;
    out.by = by;
    out.held = heldMs;
    out.vetoes = stages.size ? vetoes() : null;
    return out;
  }

  return {
    step,
    barFor,
    /** A later stage's verdict on the current sound: false holds the gate shut, true/null leave it to the levels. */
    stage(name, verdict) {
      if (verdict === null || verdict === undefined) stages.delete(name);
      else stages.set(name, Boolean(verdict));
      if (verdict === true) proven.add(name);
    },
    get sensitivity() {
      return sens;
    },
    set sensitivity(v) {
      sens = clamp(Number(v) || 0, SENSITIVITY.min, SENSITIVITY.max);
    },
    get open() {
      return open;
    },
    get voiced() {
      return voiced;
    },
    snapshot: () => ({ open, voiced, by, floor, voice, sensitivity: sens, held: heldMs, vetoes: vetoes(), bars: Object.fromEntries(MODES.map((m) => [m, barFor(m)])) }),
  };
}

/**
 * Runs a trace through a gate (tests, tuning): `frames` is [{ db, mode, ms, stages }] or [db]
 * (`stages` sets stage verdicts from that frame on); returns the gate's turns as [{ at, until, by }]
 * (ms), the voiced spans as [{ at, until }] and the last snapshot.
 */
export function runTrace(frames, { dt = 10, ...opts } = {}) {
  const gate = createCloseTalk(opts);
  const turns = [];
  const voiced = [];
  let t = 0;
  for (const f of frames) {
    const { db, mode = "listen", ms = dt, stages = null } = typeof f === "number" ? { db: f } : f;
    for (const [name, verdict] of Object.entries(stages ?? {})) gate.stage(name, verdict);
    const was = gate.voiced;
    const d = gate.step(db, mode, ms);
    if (d.opened) turns.push({ at: t, until: null, by: d.by });
    if (d.closed) turns[turns.length - 1].until = t;
    if (d.voiced && !was) voiced.push({ at: t, until: null });
    if (!d.voiced && was) voiced[voiced.length - 1].until = t;
    t += ms;
  }
  return { turns, voiced, gate, snapshot: gate.snapshot() };
}
