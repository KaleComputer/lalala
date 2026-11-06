// From Presence's call-frame bar, recoloured green.
// The connecting line as ASCII, restored (the user, 23 Oct: "bring back the ASCII shader for the connecting
// state, the one we had before"). This is the shader from cd87111 (KAL-1485, public/shared/line-gl.mjs,
// after movAX13h's "ASCII Art" on Shadertoy), which drew the lost line until #168 put the call frame's 2D
// glyph static (callwave.mjs) in its place. Only its connecting path is kept: the resting line (a crisp
// warm-white core, a tight halo, a warm glow) is lit per pixel, then per 9 px cell the line's brightness
// where it crosses the cell's column picks a 5x5 glyph by density (. : * o & 8 @ #), drawn in the line's
// own colour at 60% over the room; the characters flicker ten times a second. The line lies just above
// a row's edge, as it did on the old page, so it reads as two rows of glyphs with a dotted one each side.
// The line runs the room edge to edge (#216): from the room's left end to the key's divider, on the
// room's middle; its soft ends keep the faintest glyphs at the room's ends. It draws into a detached WebGL canvas that callwave.mjs
// copies into its own 2D canvas inside the room's clip, so the page keeps one canvas and the room's
// shape (#220's straight divider or a slant) is the 2D clip's. Drawn only while connecting and only
// when a glyph changes (10 a second) or the size does. WebGL2 first, else WebGL1 with the same
// GLSL ES 1.00 source; null when neither compiles (callwave.mjs then keeps its 2D static).

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;      // backing px
uniform vec3 uLine;     // x0, x1, y: backing px, y from the top
uniform float uDpr;     // backing px per CSS px
uniform float uK;       // glow scale: 1 on a wide line, smaller on a short one or in the bar
uniform vec4 uState;    // time (s), idle breath, opacity over the room, the cell grid's vertical offset (backing px)
uniform float uFill;    // a model download's edge (backing px): glyphs left of it light green; < 0, no download

const vec3 WHITE = vec3(1.0, 0.955, 0.90);
const vec3 WARM = vec3(1.0, 0.56, 0.24);
const vec3 HUD = vec3(0.239, 1.0, 0.561);
const vec3 BG = vec3(0.003035, 0.002732, 0.002428);

float sq(float x) { return x * x; }

// The resting line's light at p (backing px, y from the top), linear (cd87111's lineAt, idle weight).
vec3 lineAt(vec2 p) {
  float L = max(1.0, uLine.y - uLine.x);
  float u = (p.x - uLine.x) / L;
  float uc = clamp(u, 0.0, 1.0);
  float d = length(vec2((u - uc) * L, p.y - uLine.z)) / uDpr;
  // cd87111's soft ends, held up so the faintest glyphs still touch the room's ends (edge to edge, #216).
  float along = mix(END, 1.0, smoothstep(0.0, 0.16, u)) * mix(END, 1.0, smoothstep(1.0, 0.84, u)) * step(0.0, u) * step(u, 1.0);
  float level = 0.40 + 0.06 * uState.y;
  float thick = 0.55;
  float core = exp(-0.5 * sq(d / (0.46 + 0.52 * thick)));
  float halo = 1.0 / (1.0 + sq(d / (1.4 + 1.6 * thick)));
  float glow = exp(-d / (7.0 * mix(1.0, uK, 0.5)));
  float reach = exp(-sq(d / (28.0 * uK)));
  vec3 col = WHITE * core * 2.4 + mix(WHITE, WARM, 0.4) * halo * 0.14 + WARM * glow * 0.03 + WARM * reach * 0.016;
  return col * along * level;
}

// Linear light over the room to display sRGB (tone-mapped).
vec3 toS(vec3 col) {
  col = 1.0 - exp(-(col + BG));
  return mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), col));
}

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
  vec3 room = toS(vec3(0.0));
  // Each cell samples the line where it crosses the cell's column (its brightest point there), maps
  // that to a glyph by density and draws it in the line's own colour; the characters flicker a little.
  float cs = CELL * uDpr;
  vec2 q = p - vec2(0.0, uState.w);
  vec2 cell = floor(q / cs);
  vec2 c0 = cell * cs;
  float cx = c0.x + 0.5 * cs;
  vec3 cc = toS(lineAt(vec2(cx, clamp(uLine.z, c0.y + uState.w, c0.y + uState.w + cs))));
  float gray = clamp(dot(cc - room, vec3(0.3, 0.59, 0.11)) * 1.15, 0.0, 1.0);
  float n = fract(sin(dot(cell, vec2(12.9898, 78.233)) + floor(uState.x * 10.0) * 7.31) * 43758.5453);
  gray *= 1.0 + 0.22 * (n - 0.5);
  float on = ascii(gray, floor((q - c0) / cs * 7.0) - 1.0);
  vec3 tint = cc / max(1e-3, max(cc.r, max(cc.g, cc.b)));
  // Over the room at the line's opacity (about 60% while lost): premultiplied, so the frame shows through.
  float a = on * uState.z;
  vec3 col = tint * min(1.0, 0.35 + gray);
  // A download fills the line green from the left (Tim, 6 Nov: design A's glyphs, D's green fill).
  if (uFill >= 0.0) {
    if (cx <= uFill) {
      col = HUD * min(1.0, 0.55 + gray);
      a = on * min(1.0, uState.z + 0.3);
    } else {
      col *= 0.6;
      a *= 0.55;
    }
  }
  gl_FragColor = vec4(col * a, a);
}`;

/** The character cell, CSS px (KAL-1485). */
export const ASCII_CELL = 9;
/** The lost line's opacity over the room (KAL-1485: connecting at about 60%). */
export const ASCII_OPACITY = 0.6;
// movAX13h's glyphs (25 bits each: . : * o & 8 @ #) as "high, low" halves of 13 and 12 bits.
const GLYPHS = [4096, 65600, 332772, 15255086, 23385164, 15252014, 13199452, 11512810];
/** How much light the soft ends keep at the room's very ends (cd87111: none, on a short line). */
export const ASCII_END = 0.1;
/** The line sits this far (CSS px) above a cell row's edge, as it fell on the old page: a dense row over a lighter one, a dotted row each side. */
export const ASCII_ROW = 0.75;
const DEFINES = [`#define CELL ${ASCII_CELL.toFixed(1)}`, `#define END ${ASCII_END.toFixed(3)}`, ...GLYPHS.map((n, i) => `#define GLYPH${i} ${Math.floor(n / 4096).toFixed(1)}, ${(n % 4096).toFixed(1)}`)].join("\n");
const UNIFORMS = ["uRes", "uLine", "uDpr", "uK", "uState", "uFill"];

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

  function draw({ width, height, dpr = 1, x0 = 0, x1 = width, y = height / 2, time = 0, breath = 0.5, glow = 0.8, fill = null }) {
    if (lost || gl.isContextLost()) return null;
    const W = Math.max(1, Math.round(width * dpr));
    const H = Math.max(1, Math.round(height * dpr));
    // The glyphs change ten times a second: between steps the last frame stands.
    const key = `${W}x${H}|${x0}|${x1}|${y}|${Math.floor(time * 10)}|${fill === null ? "" : fill.toFixed(3)}`;
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
    gl.uniform1f(loc.uK, Math.min(1, Math.max(0.55, (x1 - x0) / 860)) * glow);
    gl.uniform1f(loc.uFill, fill === null ? -1 : (x0 + Math.min(1, Math.max(0, fill)) * (x1 - x0)) * dpr);
    gl.uniform4f(loc.uState, time, breath, ASCII_OPACITY, ((((y + ASCII_ROW) * dpr) % cs) + cs) % cs);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  return { draw, kind };
}
