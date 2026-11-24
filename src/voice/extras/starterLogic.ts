import type { TemplateId } from "../templates/registry";
import type { Rect } from "./canvasStore";

/** The Starter Selector card's stable id on the canvas. */
export const STARTER_CARD_ID = "starter";

/** Room the device bar and its rail take at the bottom of the first view (matches Landing.tsx / CanvasCard.tsx). */
export const STARTER_BAR_ROOM = 188;

const SETTINGS_KEY = "lalala:settings";
const SETTINGS_EVENT = "lalala:settings";
const STARTER_EVENT = "lalala:starter";
const BRAIN_CARDS_KEY = "lalala:brain-cards";
const AGENT_MONITOR_STORAGE_KEY = "lalala:agent-monitor-pinned";
const AGENT_MONITOR_EVENT = "lalala:agent-monitor";

export type StarterPreset = {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly description: string;
  readonly w: number;
  readonly h: number;
  readonly defaultSelected: boolean;
  /** Built-in M3 template spawned when selected; omitted for native cards like Agent Monitor. */
  readonly template?: TemplateId;
};

/** Built-in starter cards a new user can drop onto their canvas in one click. */
export const STARTER_PRESETS: ReadonlyArray<StarterPreset> = [
  {
    id: "today-todo",
    title: "Today Todo",
    tag: "TASKS",
    description: "Daily checklist for tasks and quick Notion pulls.",
    w: 360,
    h: 420,
    defaultSelected: true,
    template: "todo",
  },
  {
    id: "agent-monitor",
    title: "Threads",
    tag: "THREADS",
    description: "Track active top-level threads and jump straight to them.",
    w: 420,
    h: 360,
    defaultSelected: true,
  },
  {
    id: "quick-chat",
    title: "Quick Chat",
    tag: "CHAT",
    description: "Scratchpad for prompts and quick voice notes.",
    w: 380,
    h: 440,
    defaultSelected: false,
    template: "chat",
  },
  {
    id: "image-gen",
    title: "Image Gen",
    tag: "IMAGE",
    description: "Draft image prompts with aspect ratio and style.",
    w: 400,
    h: 480,
    defaultSelected: false,
    template: "image-gen",
  },
  {
    id: "video-gen",
    title: "Video Gen",
    tag: "VIDEO",
    description: "Plan video shots with duration and camera motion.",
    w: 420,
    h: 500,
    defaultSelected: false,
    template: "video-gen",
  },
];

/** Pins the native M1 Agent Monitor card onto `canvas` via its shared storage/event contract. */
export function pinAgentMonitorFromStarter(canvas?: string): void {
  const payload = canvas && canvas !== "" && canvas !== "main" ? { pinned: true, canvas } : { pinned: true };
  try {
    localStorage.setItem(AGENT_MONITOR_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // No storage: stays for this visit only.
  }
  if (typeof document !== "undefined") {
    document.dispatchEvent(new Event(AGENT_MONITOR_EVENT));
  }
}

/** Whether the native M1 Agent Monitor card is currently pinned on `activeCanvas`. */
export function isAgentMonitorPinnedOn(activeCanvas: string): boolean {
  try {
    const raw = localStorage.getItem(AGENT_MONITOR_STORAGE_KEY);
    if (!raw || raw === "0" || raw === "false") return false;
    if (raw === "1" || raw === "true") return activeCanvas === "main";
    const parsed = JSON.parse(raw) as { pinned?: unknown; canvas?: unknown } | null;
    if (!parsed || parsed.pinned !== true) return false;
    const pinnedCanvas = typeof parsed.canvas === "string" && parsed.canvas !== "" ? parsed.canvas : "main";
    return pinnedCanvas === activeCanvas;
  } catch {
    return false;
  }
}

export const DEFAULT_STARTER_IDS: ReadonlyArray<string> = STARTER_PRESETS.filter(
  (preset) => preset.defaultSelected,
).map((preset) => preset.id);

export type StarterVisibilityInput = {
  readonly enabled: boolean;
  readonly layoutReady: boolean;
  readonly activeCanvas: string;
  readonly userCardCount: number;
  readonly dismissed: boolean;
  readonly forcedOpen: boolean;
};

/**
 * Whether the Starter Selector card should mount now:
 * - Auto-mounts on fresh local launches when Main has 0 cards and onboarding wasn't dismissed.
 * - Mounts on any active canvas whenever explicitly opened from the Canvases menu.
 */
export function shouldShowStarter(input: StarterVisibilityInput): boolean {
  if (!input.layoutReady || input.activeCanvas === "") return false;
  if (input.forcedOpen) return true;
  if (!input.enabled || input.dismissed) return false;
  return input.activeCanvas === "main" && input.userCardCount === 0;
}

/**
 * First placement for the Starter Selector: centred in the room above the device bar (same
 * viewport clearance as Landing.tsx's `landingAt()`), shrinking cleanly on phones and short screens.
 */
export function starterAt(viewW: number, viewH: number): Rect {
  const safeW = Number.isFinite(viewW) && viewW > 0 ? viewW : 960;
  const safeH = Number.isFinite(viewH) && viewH > 0 ? viewH : 720;
  const w = Math.max(280, Math.min(520, safeW - 24));
  const availH = Math.max(260, safeH - STARTER_BAR_ROOM - 64);
  const h = Math.min(440, availH);
  const x = Math.round(Math.max(12, (safeW - w) / 2));
  const y = Math.round(Math.max(48, (safeH - STARTER_BAR_ROOM - h) / 2));
  return { x, y, w, h };
}

/** Toggles one preset id inside an ordered selection list. */
export function toggleStarterSelection(
  selected: ReadonlyArray<string>,
  id: string,
): ReadonlyArray<string> {
  return selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
}

/** Resolves selected preset ids in canonical order, skipping cards already present on the canvas. */
export function presetsToSpawn(
  selectedIds: ReadonlyArray<string>,
  existingIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<StarterPreset> {
  const picked = new Set(selectedIds);
  return STARTER_PRESETS.filter((preset) => picked.has(preset.id) && !existingIds.has(preset.id));
}

const SHARED_CARD_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:12px;font-size:12px;line-height:1.45}
.stack{display:grid;gap:10px}
.muted{opacity:.64;font-size:11px}
.row{display:flex;gap:6px;align-items:center}
.grow{flex:1;min-width:0}
input,textarea,select,button{
  font:inherit;color:inherit;
  background:color-mix(in srgb,currentColor 6%,transparent);
  border:1px solid color-mix(in srgb,currentColor 24%,transparent);
  border-radius:3px;padding:6px 8px;
}
input:focus,textarea:focus,select:focus,button:focus-visible{
  outline:1px solid currentColor;outline-offset:1px;
}
textarea{width:100%;resize:vertical;min-height:66px}
button{cursor:pointer;font-weight:600;letter-spacing:.04em}
button:hover{background:color-mix(in srgb,currentColor 14%,transparent)}
ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
li{
  display:flex;align-items:center;gap:8px;padding:6px 8px;
  border:1px solid color-mix(in srgb,currentColor 16%,transparent);
  background:color-mix(in srgb,currentColor 3%,transparent);
}
li.done span{text-decoration:line-through;opacity:.5}
.pill{
  font-size:10px;letter-spacing:.08em;text-transform:uppercase;
  padding:2px 6px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);
}
.out{
  padding:8px;min-height:46px;white-space:pre-wrap;
  border:1px dashed color-mix(in srgb,currentColor 22%,transparent);
  font-size:11px;opacity:.85;
}
`;

/** Self-contained monochrome starter card HTML rendered inside BrainCards' sandboxed iframe. */
export function starterCardHtml(preset: StarterPreset): string {
  const wrap = (body: string, script = "") =>
    `<style>${SHARED_CARD_CSS}</style>${body}${script ? `<script>${script}</script>` : ""}`;

  switch (preset.id) {
    case "today-todo":
      return wrap(
        `<div class="stack">
          <div class="muted">Check off tasks or ask voice to sync today's list.</div>
          <form class="row" id="f">
            <input class="grow" id="in" placeholder="Add a task for today…" autocomplete="off" />
            <button type="submit">Add</button>
          </form>
          <ul id="list"></ul>
        </div>`,
        `var items=[{t:"Review today's priorities",d:false},{t:"Ask voice to pull tasks from Notion",d:false}];
        var ul=document.getElementById("list"),inp=document.getElementById("in");
        function draw(){ul.innerHTML="";items.forEach(function(it,i){
          var li=document.createElement("li");if(it.d)li.className="done";
          var cb=document.createElement("input");cb.type="checkbox";cb.checked=it.d;
          cb.onchange=function(){it.d=cb.checked;draw();window.lalala&&window.lalala.log("todo.toggle",it);};
          var sp=document.createElement("span");sp.className="grow";sp.textContent=it.t;
          var rm=document.createElement("button");rm.type="button";rm.textContent="×";rm.setAttribute("aria-label","Remove");
          rm.onclick=function(){items.splice(i,1);draw();};
          li.append(cb,sp,rm);ul.append(li);
        });}
        document.getElementById("f").onsubmit=function(e){e.preventDefault();var v=inp.value.trim();if(!v)return;
          items.unshift({t:v,d:false});inp.value="";draw();window.lalala&&window.lalala.log("todo.add",{text:v});};
        draw();`,
      );
    case "agent-monitor":
      return wrap(
        `<div class="stack">
          <div class="row"><span class="pill">Ready</span><span class="muted">No active runs logged yet</span></div>
          <div class="out" id="log">Background workers and completion times appear as you delegate tasks.\n\nTry asking: "Check what my agents are doing."</div>
          <div class="row">
            <button type="button" id="stamp">Log check-in</button>
            <span class="muted" id="at"></span>
          </div>
        </div>`,
        `var out=document.getElementById("log"),at=document.getElementById("at");
        document.getElementById("stamp").onclick=function(){
          var now=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});
          at.textContent="Checked "+now;
          out.textContent="["+now+"] Ready — waiting for delegated agent runs.\\n"+out.textContent;
          window.lalala&&window.lalala.log("agents.checkin",{at:now});
        };`,
      );
    case "quick-chat":
      return wrap(
        `<div class="stack">
          <div class="muted">Jot prompts or ideas before speaking or typing in the bar.</div>
          <div class="out" id="feed">Try: "Summarize this repo" or "Build a release checklist card."</div>
          <form class="row" id="f">
            <input class="grow" id="in" placeholder="Draft a prompt…" autocomplete="off" />
            <button type="submit">Save</button>
          </form>
        </div>`,
        `var feed=document.getElementById("feed"),inp=document.getElementById("in"),notes=[];
        document.getElementById("f").onsubmit=function(e){e.preventDefault();var v=inp.value.trim();if(!v)return;
          notes.push("› "+v);inp.value="";feed.textContent=notes.join("\\n");
          window.lalala&&window.lalala.log("chat.note",{text:v});};`,
      );
    case "image-gen":
      return wrap(
        `<div class="stack">
          <div class="muted">Draft an image brief and ask voice to generate it.</div>
          <textarea id="p" placeholder="Describe the image you want…"></textarea>
          <div class="row">
            <select id="r" aria-label="Aspect ratio"><option>1:1</option><option>16:9</option><option>9:16</option></select>
            <select id="s" aria-label="Style"><option>Minimal</option><option>Editorial</option><option>Photo</option><option>Diagram</option></select>
            <button type="button" id="go">Stage</button>
          </div>
          <div class="out" id="out">Staged prompt appears here.</div>
        </div>`,
        `var p=document.getElementById("p"),r=document.getElementById("r"),s=document.getElementById("s"),out=document.getElementById("out");
        document.getElementById("go").onclick=function(){
          var brief=(p.value.trim()||"Monochrome product visual")+" · "+r.value+" · "+s.value;
          out.textContent="Image brief: "+brief;
          window.lalala&&window.lalala.log("image.brief",{prompt:p.value.trim(),ratio:r.value,style:s.value});
        };`,
      );
    case "video-gen":
    default:
      return wrap(
        `<div class="stack">
          <div class="muted">Outline a shot brief and ask voice to render a clip.</div>
          <textarea id="p" placeholder="Describe the scene and motion…"></textarea>
          <div class="row">
            <select id="d" aria-label="Duration"><option>5s</option><option>10s</option></select>
            <select id="m" aria-label="Camera motion"><option>Static</option><option>Slow push</option><option>Pan</option></select>
            <button type="button" id="go">Stage</button>
          </div>
          <div class="out" id="out">Staged shot brief appears here.</div>
        </div>`,
        `var p=document.getElementById("p"),d=document.getElementById("d"),m=document.getElementById("m"),out=document.getElementById("out");
        document.getElementById("go").onclick=function(){
          var brief=(p.value.trim()||"Clean studio reveal")+" · "+d.value+" · "+m.value;
          out.textContent="Video brief: "+brief;
          window.lalala&&window.lalala.log("video.brief",{prompt:p.value.trim(),duration:d.value,motion:m.value});
        };`,
      );
  }
}

declare global {
  var __lalalaOnboarding:
    | {
        readonly isDismissed: () => boolean;
        readonly setDismissed: (dismissed: boolean) => void;
      }
    | undefined;
}

/** Reads `onboardingDismissed` from synced settings (bridged from settingsStore or localStorage). */
export function isOnboardingDismissed(): boolean {
  const bridge = globalThis.__lalalaOnboarding;
  if (bridge !== undefined) return bridge.isDismissed();
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as {
      onboardingDismissed?: unknown;
    } | null;
    return raw?.onboardingDismissed === true;
  } catch {
    return false;
  }
}

/** Persists onboarding dismissal through settingsStore (synced across devices) with localStorage fallback. */
export function setOnboardingDismissedFromExtras(dismissed: boolean): void {
  const bridge = globalThis.__lalalaOnboarding;
  if (bridge !== undefined) {
    bridge.setDismissed(dismissed);
    return;
  }
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Record<
      string,
      unknown
    > | null;
    const prev = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const prevAt = typeof prev.at === "number" ? prev.at : 0;
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...prev, onboardingDismissed: dismissed, at: Math.max(Date.now(), prevAt + 1) }),
    );
  } catch {
    // No storage: stays for this visit only.
  }
  if (typeof document !== "undefined") document.dispatchEvent(new Event(SETTINGS_EVENT));
}

export function subscribeOnboarding(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_KEY) listener();
  };
  document.addEventListener(SETTINGS_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener(SETTINGS_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

let forcedOpen = false;
const starterListeners = new Set<() => void>();

function emitStarter(): void {
  for (const listener of starterListeners) listener();
  if (typeof document !== "undefined") document.dispatchEvent(new Event(STARTER_EVENT));
}

export const isStarterForcedOpen = (): boolean => forcedOpen;

export function openStarterState(): void {
  if (forcedOpen) return;
  forcedOpen = true;
  emitStarter();
}

export function closeStarterState(): void {
  if (!forcedOpen) return;
  forcedOpen = false;
  emitStarter();
}

export function subscribeStarter(listener: () => void): () => void {
  starterListeners.add(listener);
  return () => void starterListeners.delete(listener);
}

/** IDs of BrainCards currently stored in localStorage, for showing "Added" badges in the picker. */
export function readStoredBrainCardIds(): ReadonlySet<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(BRAIN_CARDS_KEY) ?? "null") as Record<
      string,
      unknown
    > | null;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? new Set(Object.keys(raw))
      : new Set();
  } catch {
    return new Set();
  }
}
