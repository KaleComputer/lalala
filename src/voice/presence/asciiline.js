// The bar's small ASCII display (Tim, 15 Nov): behind every info state's plate (connecting, voice
// loading, downloading, reconnecting...), as many rows of 5x5 glyphs (. : * o & 8 @ #, movAX13h's "ASCII
// Art" set, from cd87111's old connecting shader) as fit the room's height, in white at low opacity,
// showing a designed motion per state: a travelling waveform, a scan, or rings from the middle. A gap is
// left around the plate. It draws into a detached WebGL canvas that callwave.js copies into its own 2D
// canvas inside the room's clip, only while such a state shows and only when the motion steps (16 a
// second) or the size changes. WebGL2 first, else WebGL1 with the same GLSL ES 1.00 source; null when
// neither compiles (callwave.js then keeps its 2D static).

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;      // backing px
uniform vec3 uLine;     // x0, x1, y: backing px, y from the top
uniform float uDpr;     // backing px per CSS px
uniform vec4 uState;    // time (s), unused, opacity over the room, unused
uniform float uFill;    // a model download's edge (backing px): glyphs left of it brighter; < 0, no download
uniform vec3 uBand;     // the room's top, a glyph row's height and the room's bottom (backing px)
uniform float uMode;    // the motion: 0 waveform, 1 scan, 2 rings
uniform vec2 uHole;     // the state's plate, left and right (backing px), padded: no glyphs there; empty when x >= y

const vec3 WHITE = vec3(1.0, 0.955, 0.90);
// 5x5 glyphs packed in bits, split in a high and a low half so they stay exact in a float (GLSL ES 1.00
// has no bit operations). Bit a = x + 5 y, x from the right, y from the bottom.
float glyph(float hi, float lo, vec2 g) {
  if (g.x < 0.0 || g.x > 4.0 || g.y < 0.0 || g.y > 4.0) return 0.0;
  float a = (4.0 - g.x) + 5.0 * (4.0 - g.y);
  return a < 12.0 ? mod(floor(lo / exp2(a)), 2.0) : mod(floor(hi / exp2(a - 12.0)), 2.0);
}
// Faintest to densest: . : * o & 8 @ #
float ascii(float gray, vec2 g) {
  if (gray < 0.06) return 0.0;
  if (gray < 0.16) return glyph(GLYPH0, g);
  if (gray < 0.28) return glyph(GLYPH1, g);
  if (gray < 0.40) return glyph(GLYPH2, g);
  if (gray < 0.52) return glyph(GLYPH3, g);
  if (gray < 0.64) return glyph(GLYPH4, g);
  if (gray < 0.76) return glyph(GLYPH5, g);
  if (gray < 0.88) return glyph(GLYPH6, g);
  return glyph(GLYPH7, g);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  // A small black-and-white display (Tim, 15 Nov): as many rows of 5x5 glyphs as fit the room's
  // height, each in the middle of its band, showing a designed motion per state (uMode): 0 a
  // travelling waveform (connecting, starting), 1 a scan sweeping left to right (models loading;
  // a download fills from the left), 2 rings from the middle out (reconnecting, offline). It stays
  // dim behind the state's plate, and leaves a gap around it (uHole) so nothing competes with its words.
  float cs = CELL * uDpr;
  // Nothing outside the room: no glyph under the tabs or below the bar, whatever the canvas's clip.
  if (p.y < uBand.x || p.y >= uBand.z) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 cell = vec2(floor(p.x / cs), floor((p.y - uBand.x) / uBand.y));
  vec2 c0 = vec2(cell.x * cs, uBand.x + cell.y * uBand.y + 0.5 * (uBand.y - cs));
  float cx = c0.x + 0.5 * cs;
  if (uHole.y > uHole.x && c0.x + cs > uHole.x && c0.x < uHole.y) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float rows = floor((uBand.z - uBand.x) / uBand.y + 0.5);
  float mid = 0.5 * (rows - 1.0);
  // How far this row is from the middle, 0 (centre) to 1 (the outer rows' edge).
  float d = (abs(cell.y - mid) + 0.5) / max(1.0, mid + 0.5);
  float L = max(1.0, uLine.y - uLine.x);
  float u = clamp((cx - uLine.x) / L, 0.0, 1.0);
  float span = L / cs;
  float t = uState.x;
  float amp;
  if (uMode < 0.5) {
    // Two sines travelling at different speeds: a calm, always-changing waveform.
    float w = 0.62 * sin(u * span * 0.21 - t * 3.0) + 0.38 * sin(u * span * 0.53 + t * 1.9);
    amp = 0.18 + 0.82 * abs(w);
  } else if (uMode < 1.5) {
    // A bright head sweeping left to right every 2.2 s, a fading trail behind it.
    float head = fract(t / 2.2) * 1.3 - 0.15;
    float back = head - u;
    amp = 0.12 + 0.88 * (back < 0.0 ? exp(back * 60.0) : exp(-back * 5.0));
  } else {
    // Rings from the middle out every 1.8 s, like a signal being looked for.
    float r = abs(u - 0.5) * 2.0;
    float ring = fract(t / 1.8) * 1.4 - 0.2;
    amp = 0.15 + 0.85 * exp(-pow((r - ring) * 7.0, 2.0)) * (1.0 - 0.5 * r);
  }
  amp *= smoothstep(0.0, 0.05, u) * smoothstep(1.0, 0.95, u);
  // A row is lit where the waveform reaches it: fully inside, a lighter glyph at its edge.
  float gray = smoothstep(d - 0.45, d + 0.05, amp) * (0.95 - 0.3 * d);
  float on = ascii(gray, floor((p - c0) / cs * 7.0) - 1.0);
  float a = on * uState.z * (0.55 + 0.45 * gray);
  vec3 col = WHITE;
  // A download fills from the left: the part done brighter, the rest dimmer, still white.
  if (uFill >= 0.0) a *= cx <= uFill ? 1.5 : 0.6;
  gl_FragColor = vec4(col * a, a);
}`;

/** The character cell, CSS px (KAL-1485). */
export const ASCII_CELL = 9;
/** The display's opacity over the room: dim, behind the state's plate (Tim, 15 Nov: "it shouldn't be that bright"). */
export const ASCII_OPACITY = 0.3;
// movAX13h's glyphs (25 bits each: . : * o & 8 @ #) as "high, low" halves of 13 and 12 bits.
const GLYPHS = [4096, 65600, 332772, 15255086, 23385164, 15252014, 13199452, 11512810];
const DEFINES = [`#define CELL ${ASCII_CELL.toFixed(1)}`, ...GLYPHS.map((n, i) => `#define GLYPH${i} ${Math.floor(n / 4096).toFixed(1)}, ${(n % 4096).toFixed(1)}`)].join("\n");
const UNIFORMS = ["uRes", "uLine", "uDpr", "uState", "uFill", "uBand", "uMode", "uHole"];
/** The motions by name (callwave's `info`). */
const MODES = { wave: 0, scan: 1, pulse: 2 };
/** Clear room around the state's plate (CSS px). */
const HOLE_PAD = 10;
/** A glyph row's least height (CSS px): the cell plus a gap; as many rows as fit fill the room. */
export const ASCII_ROW_H = ASCII_CELL + 2;

/**
 * The ASCII line on a detached canvas: `draw({ width, height, dpr, x0, x1, y, time, breath, glow, fill })` (CSS
 * px; `fill` a download's 0..1 or null) renders it and returns the canvas to copy, or null when WebGL is unavailable or lost.
 */
export function createAsciiLine({ force } = {}) {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true };
  let kind = "webgl2";
  let gl = force === "webgl" ? null : canvas.getContext("webgl2", opts);
  if (!gl) (gl = canvas.getContext("webgl", opts)), (kind = "webgl");
  if (!gl) return null;
  let loc = {};
  let lost = false;
  let last = "";

  function build() {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `${DEFINES}\n${FRAG}`));
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(prog) || "link");
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    // One triangle that covers the canvas.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    loc = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]));
    last = "";
  }
  try {
    build();
  } catch (e) {
    console.warn("presence: ASCII line unavailable", e);
    return null;
  }
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lost = true;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    try {
      build();
      lost = false;
    } catch {}
  });

  function draw({ width, height, dpr = 1, x0 = 0, x1 = width, y = height / 2, top = 0, bottom = height, time = 0, breath = 0.5, glow = 0.8, fill = null, mode = "wave", hole = null }) {
    if (lost || gl.isContextLost()) return null;
    const W = Math.max(1, Math.round(width * dpr));
    const H = Math.max(1, Math.round(height * dpr));
    // The motion steps 16 times a second: between steps the last frame stands.
    const key = `${W}x${H}|${x0}|${x1}|${y}|${top}|${bottom}|${mode}|${hole}|${Math.floor(time * 16)}|${fill === null ? "" : fill.toFixed(3)}`;
    if (key === last) return canvas;
    last = key;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const cs = ASCII_CELL * dpr;
    const yb = y * dpr;
    gl.uniform2f(loc.uRes, W, H);
    gl.uniform3f(loc.uLine, x0 * dpr, x1 * dpr, yb);
    gl.uniform1f(loc.uDpr, dpr);
    gl.uniform1f(loc.uFill, fill === null ? -1 : (x0 + Math.min(1, Math.max(0, fill)) * (x1 - x0)) * dpr);
    gl.uniform4f(loc.uState, time, breath, ASCII_OPACITY, 0);
    const rows = Math.max(1, Math.floor((bottom - top) / ASCII_ROW_H));
    gl.uniform3f(loc.uBand, top * dpr, ((bottom - top) * dpr) / rows, bottom * dpr);
    gl.uniform1f(loc.uMode, MODES[mode] ?? 0);
    gl.uniform2f(loc.uHole, hole ? (hole[0] - HOLE_PAD) * dpr : 0, hole ? (hole[1] + HOLE_PAD) * dpr : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  return { draw, kind };
}
