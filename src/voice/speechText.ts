/** Replies are written for the ear, but strip any markdown that slips through before speaking. */
export function speakableText(text: string): string {
  const spoken = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    // Dots in names stay for the voice's front end, which says them ("lalala dot talk", "redeploy dot S H",
    // "Node J S"); turned into " dot " here, a file ending lost its spelling ("dot sh" read as "shh").
    .replace(/\s+/g, " ")
    .trim();
  return /\p{L}/u.test(spoken) ? spoken.slice(0, 700) : "";
}

const LONG_FRAGMENT = 220;
const MIN_CLAUSE_CUT = 60;
const MIN_STREAM_TAIL = 28;
const TRAILING_SENTENCE_END =
  /(?:[!?…]|\.{3}|(?<!\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|etc))(?<=\p{L}{2})\.)["')\]]*\s*$/u;
const oneWord = (sentence: string) => (sentence.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? []).length === 1;

/** Picks where to split an unfinished streaming run-on: prefer a clause boundary, leaving enough tail to never strand a lone final word. */
function longFragmentCut(rest: string): number {
  const limit = rest.length - MIN_STREAM_TAIL;
  const clause = /[,;:]\s|[—–]\s?/g;
  let clauseCut = -1;
  let match: RegExpExecArray | null;
  while ((match = clause.exec(rest)) !== null) {
    const end = match.index + match[0].length;
    if (end >= MIN_CLAUSE_CUT && end <= limit) clauseCut = end;
  }
  if (clauseCut > 0) return clauseCut;
  const space = rest.lastIndexOf(" ", Math.max(0, limit));
  if (space >= MIN_CLAUSE_CUT) return space + 1;
  const anySpace = rest.lastIndexOf(" ");
  return anySpace > 0 ? anySpace + 1 : -1;
}

/**
 * Splits the not-yet-spoken tail of a reply into sentences ready to speak. While the reply is
 * still streaming, the last fragment waits for its sentence to end; `final` flushes it. `consumed`
 * is how much of `tail` the sentences cover, so the caller can advance its offset.
 */
export function takeSentences(
  tail: string,
  final: boolean,
): { readonly sentences: ReadonlyArray<string>; readonly consumed: number } {
  // Never speak into an unfinished code block or link.
  let safe = tail;
  const fences = safe.split("```").length - 1;
  if (fences % 2 === 1) safe = safe.slice(0, safe.lastIndexOf("```"));
  if (!final) {
    const openLink = safe.lastIndexOf("[");
    if (openLink !== -1 && !safe.slice(openLink).includes(")")) safe = safe.slice(0, openLink);
  }

  const sentences: string[] = [];
  let consumed = 0;
  // A one-word sentence ("Four.", "Monday.") rides with the next one: the small voices garble a word said
  // alone, swallowing its end and adding a tail ("Four." -> "Forwarding", Tim, 19 Nov), and say it right
  // in "Four. Thursday.". It waits for that next sentence, unless it is the reply's last.
  let start = 0;
  const boundary = /[.!?…]+["')\]]*(?=\s)|\n{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(safe)) !== null) {
    const end = match.index + match[0].length;
    const next = safe.slice(end);
    if (oneWord(safe.slice(start, end)) && !/^\s*[\u2063\u2064]/.test(next)) continue;
    sentences.push(safe.slice(start, end));
    consumed = start = end;
  }
  const rest = safe.slice(consumed);
  if (final && fences % 2 === 0) {
    // A reply's last word said alone ("... Fine.") rides with the sentence before it when that one is still here.
    if (oneWord(rest) && sentences.length > 0 && !/^\s*[\u2063\u2064]/.test(rest))
      sentences[sentences.length - 1] += rest;
    else if (rest.trim() !== "") sentences.push(rest);
    consumed = tail.length;
  } else if (rest.length > LONG_FRAGMENT) {
    // A finished sentence arriving while the turn is still streaming (e.g. before tool calls) has no trailing
    // space yet, so boundary didn't match its final period: emit it whole instead of chopping off its last word.
    if (TRAILING_SENTENCE_END.test(rest)) {
      sentences.push(rest);
      consumed += rest.length;
    } else {
      const cut = longFragmentCut(rest);
      if (cut > 0) {
        sentences.push(rest.slice(0, cut));
        consumed += cut;
      }
    }
  }
  return { sentences: sentences.filter((sentence) => sentence.trim() !== ""), consumed };
}

const FILLER = /^(?:[mh]+|u+[hm]*|a+h+|o+h+|e+r+m*|hm+|huh|yeah|yep|yup)$/;
const WORD = /\p{L}[\p{L}'’]*|\d+/gu;
const words = (text: string) => text.toLowerCase().match(WORD) ?? [];

// Speech-to-text of our own echo is fuzzy ("octopus's" for "octopuses"): a shared stem counts.
function spokenMatcher(recentlySpoken: ReadonlyArray<string>): (word: string) => boolean {
  const spoken = new Set(recentlySpoken.flatMap(words));
  const stems = new Set(
    [...spoken].filter((word) => word.length >= 4).map((word) => word.slice(0, 4)),
  );
  // A cut-off fragment ("oxy" for "oxygen") counts too.
  return (word) =>
    spoken.has(word) ||
    (word.length >= 4 && stems.has(word.slice(0, 4))) ||
    (word.length >= 2 && [...spoken].some((said) => said.startsWith(word)));
}

/** The real words in `heard` that are not part of what we just said. */
export function foreignWords(
  heard: string,
  recentlySpoken: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const isSpoken = spokenMatcher(recentlySpoken);
  return words(heard).filter((word) => !FILLER.test(word) && !isSpoken(word));
}

/**
 * Whether `heard` has a run of words we did not say: the user talking over the reply. A garbled echo
 * word comes alone; an interruption ("wait, stop") does not.
 */
export function hasForeignRun(
  heard: string,
  recentlySpoken: ReadonlyArray<string>,
  runLength = 2,
): boolean {
  const isSpoken = spokenMatcher(recentlySpoken);
  let run = 0;
  for (const word of words(heard)) {
    // Garbled echo often comes back as a filler sound ("mm-hmm", "uh").
    if (FILLER.test(word)) continue;
    run = isSpoken(word) ? 0 : run + 1;
    if (run >= runLength) return true;
  }
  return false;
}

// Our own reply coming back through a speaker repeats it word for word: a run of this many of its
// words in order. The user's short answer reusing a word or two of the question ("keep it?" → "yeah,
// keep it") is never echo (2 Nov: three of their answers were dropped as echo, on headphones).
const ECHO_RUN = 4;

function spokenRuns(recentlySpoken: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> {
  return recentlySpoken.map((sentence) => words(sentence).filter((word) => !FILLER.test(word)));
}

/** Indexes (into `heard`) of words that sit in a run of ECHO_RUN or more of a spoken sentence. */
function echoedWordIndexes(
  heard: ReadonlyArray<string>,
  recentlySpoken: ReadonlyArray<string>,
  run = ECHO_RUN,
) {
  const echoed = new Set<number>();
  for (const said of spokenRuns(recentlySpoken)) {
    for (let i = 0; i < heard.length; i += 1) {
      for (let j = 0; j < said.length; j += 1) {
        let n = 0;
        while (i + n < heard.length && j + n < said.length && heard[i + n] === said[j + n]) n += 1;
        if (n >= run) for (let k = 0; k < n; k += 1) echoed.add(i + k);
      }
    }
  }
  return echoed;
}

/**
 * For an utterance that began while a reply was playing: drops the reply's words coming back
 * (runs of ECHO_RUN or more, word for word) and keeps everything else the user said.
 */
export function stripEcho(transcript: string, recentlySpoken: ReadonlyArray<string>): string {
  const matches = [...transcript.matchAll(WORD)].filter(
    (match) => !FILLER.test(match[0].toLowerCase()),
  );
  const echoed = echoedWordIndexes(
    matches.map((match) => match[0].toLowerCase()),
    recentlySpoken,
  );
  if (echoed.size === 0) return transcript.trim();
  const kept = matches.filter((_, index) => !echoed.has(index));
  if (kept.length === 0) return "";
  const first = kept[0]!.index;
  const lastMatch = kept.at(-1)!;
  const last = lastMatch.index + lastMatch[0].length;
  const end = transcript.slice(last).match(/^[.!?…]*/)?.[0].length ?? 0;
  return transcript.slice(first, last + end).trim();
}

/**
 * Whether a transcript is most likely our own reply picked up by the microphone: it repeats the
 * reply word for word (a run of ECHO_RUN) and nearly all of its words are the reply's. A shorter one
 * (3 words) only when all of it is a run of the reply ("sure, go ahead." coming back); with fewer
 * real words it is the user ("yeah, keep it." after "keep it?").
 */
export function isEchoOfSpoken(transcript: string, recentlySpoken: ReadonlyArray<string>): boolean {
  const heard = words(transcript).filter((word) => !FILLER.test(word));
  if (heard.length < 3) return false;
  if (heard.length < ECHO_RUN) {
    return echoedWordIndexes(heard, recentlySpoken, heard.length).size === heard.length;
  }
  return echoedWordIndexes(heard, recentlySpoken).size / heard.length >= 0.8;
}

// What local speech-to-text makes of breath and noise (2 Nov eval: "I'm sorry." 22 times in one walk).
const NOISE_PHRASE = /^(?:i'?m sorry|sorry|mm+-?hmm+|thank you|thanks|bye|you)$/;

/** Whether a transcript is nothing but a phrase the recogniser makes up from noise. */
export function isNoisePhrase(text: string): boolean {
  return NOISE_PHRASE.test(words(text).join(" "));
}

/** Whether a transcript holds any real word, not just filler sounds or punctuation. */
export function hasRealWords(text: string): boolean {
  return words(text).some((word) => !FILLER.test(word));
}
