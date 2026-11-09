// No signal's glitch: Presence's original shader glitch (kale agent-dashboard fe2ebf3, 18 Oct, "the original
// shader glitch is back"; public/t3/line-gl.mjs GLITCH and light.mjs's bursts), restored for the call frame's
// error state (9 Nov: "this awesome shader we had at some point"). The line is drawn to a texture and a
// post pass tears it apart live: a cyan and a magenta copy split, pieces ripped up and down with a smear,
// block tears, scanlines, a slice dropping out. Bursts of 90-300 ms follow each other with no gap, the tear
// changing every 40-70 ms. Drawn on a detached WebGL canvas that callwave.js copies into the room.

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform sampler2D uTex; // the line's frame
uniform vec2 uRes;      // backing px
uniform float uDpr;
uniform float uAmt;     // the burst's strength now, 0..1
uniform float uSeed;    // changes every few frames inside a burst: a new tear
uniform float uLineY;   // the line's height, backing px from the bottom

float hash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float hash2(vec2 v) { return fract(sin(dot(v, vec2(127.1, 311.7))) * 43758.5453); }
vec3 at(vec2 px) {
  vec2 uv = px / uRes;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  return texture2D(uTex, uv).rgb;
}
// Magenta up and one way, cyan down and the other; white where they still overlap.
vec3 split(vec2 px, vec2 d) {
  vec3 m = at(px + d);
  vec3 c = at(px - d);
  return vec3(m.r, c.g, max(m.b, c.b));
}

void main() {
  vec2 p = gl_FragCoord.xy;
  // It fades in over the band's last few pixels, so nothing ends on a hard edge.
  float fx = smoothstep(0.0, 12.0 * uDpr, p.x) * smoothstep(uRes.x, uRes.x - 12.0 * uDpr, p.x);
  float fy = smoothstep(0.0, 8.0 * uDpr, p.y) * smoothstep(uRes.y, uRes.y - 8.0 * uDpr, p.y);
  float a = uAmt * fx * fy;
  // Columns: the line breaks into pieces 10 to 90 px wide; about two in five jump up or down and a little sideways.
  float colW = (10.0 + 80.0 * hash(uSeed * 2.9)) * uDpr;
  float col = floor(p.x / colW);
  float rc = hash(col * 1.71 + uSeed * 5.3);
  float jump = step(0.6, rc);
  vec2 off = jump * vec2((hash(col * 4.1 + uSeed) - 0.5) * 30.0, (hash(col * 2.3 + uSeed * 1.3) - 0.5) * 2.0 * (5.0 + 26.0 * hash(col + uSeed))) * uDpr * a;
  // Rows: thin slices of the glow slide sideways.
  float bandH = (2.0 + 10.0 * hash(uSeed * 3.7)) * uDpr;
  float row = floor(p.y / bandH);
  float rr = hash(row * 1.13 + uSeed * 7.1);
  off.x += step(0.8, rr) * (hash(row * 5.3 + uSeed) - 0.5) * 120.0 * uDpr * a;
  vec2 q = p - off;
  // The split: a magenta and a cyan copy, apart sideways and up and down.
  vec2 d = vec2(3.0 + 9.0 * hash(uSeed * 5.1), (2.0 + 5.0 * hash(uSeed * 6.7)) * (hash(col + uSeed * 9.0) > 0.5 ? 1.0 : -1.0)) * uDpr * a;
  d *= mix(0.45, 1.0, jump); // whole pieces keep a white core with coloured fringes
  vec3 c = split(q, d);
  // A jumped piece leaves a smear back towards where it was.
  if (jump > 0.5) {
    vec2 back = off / 6.0;
    for (int k = 1; k <= 5; k++) c = max(c, split(q + back * float(k), d) * (0.75 - 0.12 * float(k)));
  }
  // The colour bleeds: a soft cyan and magenta blur above and below.
  vec3 bloom = vec3(0.0);
  for (int k = 1; k <= 4; k++) {
    float o = float(k) * 4.0 * uDpr;
    bloom += split(q + vec2(0.0, o), d * 2.0) * vec3(1.0, 0.25, 1.0) + split(q - vec2(0.0, o), d * 2.0) * vec3(0.25, 1.0, 1.0);
  }
  c += bloom / 8.0 * 0.55 * a;
  // Blocks: a few rectangles near the line light up cyan or magenta, grained.
  vec2 cell = floor(p / (vec2(44.0, 7.0) * uDpr));
  float near = 1.0 - smoothstep(18.0, 40.0, abs(p.y - uLineY) / uDpr);
  float block = step(0.955, hash2(cell + uSeed * 13.0)) * near;
  if (block > 0.5) {
    vec3 tint = hash2(cell + 3.0) > 0.5 ? vec3(0.1, 0.95, 1.0) : vec3(1.0, 0.1, 0.95);
    c = max(c * tint, tint * (0.22 + 0.25 * hash2(floor(p / (3.0 * uDpr)) + uSeed)) * a);
  }
  // Scanlines, and now and then a slice drops out.
  c *= 1.0 - 0.3 * a * step(1.0, mod(floor(p.y / uDpr), 2.0));
  c *= 1.0 - 0.9 * a * step(0.94, hash(row * 3.1 + uSeed * 1.9));
  c = mix(at(p), c, min(1.0, fx * fy * 4.0));
  // Over the room, not over a colour of its own: light only (premultiplied, alpha its brightest channel).
  c = min(c, vec3(1.0));
  gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
}`;

const UNIFORMS = ["uTex", "uRes", "uDpr", "uAmt", "uSeed", "uLineY"];
const fract = (x) => x - Math.floor(x);

/**
 * The glitching line on a detached canvas: `draw({ width, height, dpr, y, now, reduced })` (CSS px, `now` ms)
 * renders it and returns the canvas to copy, or null when WebGL is unavailable or lost. Reduced motion: one
 * still tear.
 */
export function createGlitchLine() {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true };
  const gl = canvas.getContext("webgl2", opts) || canvas.getContext("webgl", opts);
  if (!gl) return null;
  // The clean line, drawn once per size: a warm-white core in its glow.
  const base = document.createElement("canvas");
  let loc = {};
  let tex = null;
  let lost = false;
  let last = "";
  let baseKey = "";
  // light.mjs's bursts.
  let at = -1e9;
  let next = 0;
  let step = 50;

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
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(prog) || "link");
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    loc = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]));
    gl.uniform1i(loc.uTex, 0);
    last = "";
    baseKey = "";
  }
  try {
    build();
  } catch (e) {
    console.warn("presence: glitch line unavailable", e);
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

  function paintBase(W, H, dpr, y) {
    const key = `${W}x${H}|${y}`;
    if (key === baseKey) return;
    baseKey = key;
    base.width = W;
    base.height = H;
    const ctx = base.getContext("2d");
    // On black, so the texture's colours are the light itself (a cleared canvas would upload its glow's
    // edge as full-strength colour).
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const yb = y * dpr;
    const glow = ctx.createLinearGradient(0, yb - 14 * dpr, 0, yb + 14 * dpr);
    glow.addColorStop(0, "rgba(255,243,230,0)");
    glow.addColorStop(0.5, "rgba(255,243,230,.22)");
    glow.addColorStop(1, "rgba(255,243,230,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, yb - 14 * dpr, W, 28 * dpr);
    ctx.fillStyle = "rgb(255,243,230)";
    ctx.fillRect(0, yb - 0.9 * dpr, W, 1.8 * dpr);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, base);
  }

  function draw({ width, height, dpr = 1, y = height / 2, now = 0, reduced = false }) {
    if (lost || gl.isContextLost()) return null;
    const W = Math.max(1, Math.round(width * dpr));
    const H = Math.max(1, Math.round(height * dpr));
    let amt = 0.8;
    let seed = 3.1;
    let flicker = 1;
    if (!reduced) {
      if (now > next) {
        at = now;
        const len = 90 + Math.random() * 210;
        step = 40 + Math.random() * 30;
        next = now + len;
      }
      const tear = Math.floor((now - at) / step);
      seed = (at % 997) * 0.1 + tear * 1.37;
      amt = 0.6 + 0.4 * fract(Math.sin(seed * 91.7) * 43758.5);
      flicker = tear % 2 ? 0.8 : 1;
    }
    // Between tears the last frame stands.
    const key = `${W}x${H}|${y}|${seed.toFixed(3)}`;
    if (key === last) return canvas;
    last = key;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    paintBase(W, H, dpr, y);
    gl.viewport(0, 0, W, H);
    gl.uniform2f(loc.uRes, W, H);
    gl.uniform1f(loc.uDpr, dpr);
    gl.uniform1f(loc.uAmt, amt * flicker);
    gl.uniform1f(loc.uSeed, seed);
    gl.uniform1f(loc.uLineY, H - y * dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  return { draw };
}
