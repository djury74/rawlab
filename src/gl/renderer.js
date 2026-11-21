import * as S from './shaders.js';
import { buildCurveLUT, buildBaseLUT, hsvToRgb, wbGains } from '../color.js';
import { applyAffine } from '../geometry.js';

const PROFILES = { standard: 0, vivid: 1, linear: 2 };
const BLUR_EDGE = 320;
const MASK_EDGE = 1280;
export const MAX_LOCALS = 8;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This GPU cannot render to floating-point textures.');
    }
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.progs = {
      importU16: this.#program(S.FRAG_IMPORT_U16),
      importSrgb: this.#program(S.FRAG_IMPORT_SRGB),
      geom: this.#program(S.FRAG_GEOM),
      blur: this.#program(S.FRAG_BLUR),
      denoise: this.#program(S.FRAG_DENOISE),
      develop: this.#program(S.FRAG_DEVELOP),
    };
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.fbo = gl.createFramebuffer();
    this.targets = new Map();
    this.src = null;
    this.curveTex = this.#texture(gl.LINEAR);
    this.curveKey = null;
    this.baseTex = this.#texture(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1024, 1, 0, gl.RGBA, gl.FLOAT, buildBaseLUT());
    this.blurKey = null;
    this.maskTex = gl.createTexture();
    this.maskSize = { w: 1, h: 1 };
    this.maskTags = [];
    this.#allocMasks(1, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  }

  #program(frag) {
    const gl = this.gl;
    const compile = (type, text) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, text);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, S.VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, u: uniforms };
  }

  #texture(filter, wrap) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap ?? gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap ?? gl.CLAMP_TO_EDGE);
    return t;
  }

  #allocMasks(w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, w, h, MAX_LOCALS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, v);
    }
    this.maskSize = { w, h };
    this.maskTags = [];
  }

  // Upload a painted brush mask (a canvas of maskSize) into a layer, once per tag.
  uploadMask(layer, canvas, tag) {
    if (this.maskTags[layer] === tag) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, this.maskSize.w, this.maskSize.h, 1, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    this.maskTags[layer] = tag;
  }

  // Cached render target, reallocated when its size changes.
  #target(name, w, h, format) {
    const gl = this.gl;
    let t = this.targets.get(name);
    if (!t) { t = { tex: this.#texture(gl.LINEAR), w: 0, h: 0 }; this.targets.set(name, t); }
    if (t.w !== w || t.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      if (format === 'rgba8') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      t.w = w; t.h = h;
    }
    return t;
  }

  #draw(prog, target, w, h, textures, set) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? this.fbo : null);
    if (target) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(prog.u[name], unit++);
    }
    set?.(gl, prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // source: { kind: 'raw', data: Uint16Array (RGB), width, height } or { kind: 'bitmap', bitmap, width, height }
  setSource(source) {
    const gl = this.gl;
    const { width: w, height: h } = source;
    if (w > this.maxTex || h > this.maxTex) throw new Error(`Image is ${w}x${h}; this GPU supports at most ${this.maxTex}px.`);
    if (this.src) gl.deleteTexture(this.src.tex);
    const staging = this.#texture(gl.NEAREST);
    let prog;
    if (source.kind === 'raw') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, w, h, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, source.data);
      prog = this.progs.importU16;
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source.bitmap);
      prog = this.progs.importSrgb;
    }
    const tex = this.#texture(gl.LINEAR_MIPMAP_LINEAR);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA16F, w, h);
    this.#draw(prog, tex, w, h, { uSrc: staging }, (gl, u) => gl.uniform1f(u.uScale, source.scale ?? 1));
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.deleteTexture(staging);
    this.src = { tex, w, h, id: (this.src?.id ?? 0) + 1 };
    const mk = MASK_EDGE / Math.max(w, h);
    this.#allocMasks(Math.max(1, Math.round(w * mk)), Math.max(1, Math.round(h * mk)));
    this.blurKey = null;
  }

  #affineUniforms(gl, u, names, af, w, h, map) {
    const o = map(applyAffine(af, 0, 0)), x = map(applyAffine(af, w, 0)), y = map(applyAffine(af, 0, h));
    gl.uniform2f(u[names[0]], o[0], o[1]);
    gl.uniform2f(u[names[1]], x[0] - o[0], x[1] - o[1]);
    gl.uniform2f(u[names[2]], y[0] - o[0], y[1] - o[1]);
  }

  // Low-resolution blurred copy of the whole frame, used for local tone and clarity.
  #updateBlur(g, s, lens) {
    const gl = this.gl;
    const key = [this.src.id, s.rot, s.flipH, s.flipV, JSON.stringify(lens), JSON.stringify(s.spots || [])].join();
    const k = BLUR_EDGE / Math.max(g.Wf, g.Hf);
    const bw = Math.max(8, Math.round(g.Wf * k)), bh = Math.max(8, Math.round(g.Hf * k));
    const a = this.#target('blurA', bw, bh), b = this.#target('blurB', bw, bh);
    if (key === this.blurKey) return a;
    const af = { A: [0, 0], U: [g.Wf / bw, 0], V: [0, g.Hf / bh] };
    this.#draw(this.progs.geom, a.tex, bw, bh, { uSrc: this.src.tex }, (gl, u) => {
      this.#affineUniforms(gl, u, ['uO', 'uX', 'uY'], af, bw, bh, g.frameToSrc);
      this.#lensUniforms(gl, u, lens);
      this.#spotUniforms(gl, u, s.spots);
    });
    this.#draw(this.progs.blur, b.tex, bw, bh, { uTex: a.tex }, (gl, u) => gl.uniform2f(u.uDir, 1 / bw, 0));
    this.#draw(this.progs.blur, a.tex, bw, bh, { uTex: b.tex }, (gl, u) => gl.uniform2f(u.uDir, 0, 1 / bh));
    this.blurKey = key;
    return a;
  }

  #updateCurve(curve) {
    const key = JSON.stringify(curve);
    if (key === this.curveKey) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1024, 1, 0, gl.RGBA, gl.FLOAT, buildCurveLUT(curve));
    this.curveKey = key;
  }

  /**
   * Render the develop pipeline.
   *  g       geometry() for these settings
   *  af      affine map target px -> frame px
   *  w, h    target size
   *  dest    'canvas' or 'buffer' (RGBA8, read back with readPixels)
   */
  render({ settings: s, wb, g, af, w, h, dest = 'canvas', clip = false, maskCrop = false, bg = [0, 0, 0], slot = 'main', showMask = null, lens = null, x = 0 }) {
    if (!this.src) return;
    const gl = this.gl;
    const px = 1 / Math.hypot(af.U[0], af.U[1]);
    const blur = this.#updateBlur(g, s, lens);
    this.#updateCurve(s.curve);

    let view = this.#target(slot + ':viewA', w, h);
    this.#draw(this.progs.geom, view.tex, w, h, { uSrc: this.src.tex }, (gl, u) => {
      this.#affineUniforms(gl, u, ['uO', 'uX', 'uY'], af, w, h, g.frameToSrc);
      this.#lensUniforms(gl, u, lens);
      this.#spotUniforms(gl, u, s.spots);
    });

    if ((s.nrLuma > 0 || s.nrColor > 0) && px > 0.4) {
      const out = this.#target(slot + ':viewB', w, h);
      this.#draw(this.progs.denoise, out.tex, w, h, { uTex: view.tex }, (gl, u) => {
        gl.uniform2f(u.uStep, px / w, px / h);
        gl.uniform1f(u.uLuma, s.nrLuma / 100);
        gl.uniform1f(u.uChroma, s.nrColor / 100);
      });
      view = out;
    }

    // 'buffer' is 8-bit for normal export; 'float' keeps full precision for 16-bit files.
    const target = dest === 'buffer' ? this.#target(slot + ':out', w, h, 'rgba8').tex
      : dest === 'float' ? this.#target(slot + ':outf', w, h).tex : null;
    const tint = (hue, sat) => {
      const rgb = hsvToRgb(hue, 1, 1);
      const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      return rgb.map((v) => (v - l) * (sat / 100) * 0.35);
    };
    this.#draw(this.progs.develop, target, w, h, { uView: view.tex, uBlur: blur.tex, uCurve: this.curveTex, uBase: this.baseTex }, (gl, u) => {
      if (!target && x) gl.viewport(x, 0, w, h);          // draw into part of the canvas (side-by-side view)
      gl.uniform2f(u.uTexel, 1 / w, 1 / h);
      gl.uniform1f(u.uPx, px);
      this.#affineUniforms(gl, u, ['uFO', 'uFX', 'uFY'], af, w, h, (p) => [p[0] / g.Wf, p[1] / g.Hf]);
      this.#affineUniforms(gl, u, ['uCO', 'uCX', 'uCY'], af, w, h, g.frameToCropUV);
      gl.uniform2f(u.uCropPx, g.cw, g.ch);
      gl.uniform3fv(u.uWB, wb);
      gl.uniform1f(u.uExposure, s.exposure);
      for (const k of ['Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks', 'Clarity', 'Dehaze', 'Vibrance', 'Saturation']) {
        gl.uniform1f(u['u' + k], s[k.toLowerCase()] / 100);
      }
      gl.uniform1i(u.uProfile, PROFILES[s.profile] ?? 0);
      gl.uniform1i(u.uBW, s.bw ? 1 : 0);
      gl.uniform1i(u.uClip, clip ? 1 : 0);
      gl.uniform1i(u.uMaskCrop, maskCrop ? 1 : 0);
      gl.uniform1fv(u.uHslH, s.hsl.hue.map((v) => v / 100));
      gl.uniform1fv(u.uHslS, s.hsl.sat.map((v) => v / 100));
      gl.uniform1fv(u.uHslL, s.hsl.lum.map((v) => v / 100));
      gl.uniform3fv(u.uGradeSh, tint(s.grade.shHue, s.grade.shSat));
      gl.uniform3fv(u.uGradeHi, tint(s.grade.hiHue, s.grade.hiSat));
      gl.uniform1f(u.uGradeBal, s.grade.balance / 100);
      gl.uniform1f(u.uSharpen, s.sharpen / 100);
      gl.uniform1f(u.uSharpRadius, s.sharpRadius);
      gl.uniform1f(u.uVig, s.vignette / 100);
      gl.uniform1f(u.uVigMid, 0.25 + (s.vigMid / 100) * 0.6);
      gl.uniform1f(u.uVigFeather, 0.02 + (s.vigFeather / 100) * 0.5);
      gl.uniform1f(u.uGrain, s.grain / 100);
      gl.uniform1f(u.uGrainSize, 1 + (s.grainSize / 100) * 3);
      gl.uniform3fv(u.uBg, bg);
      gl.uniform1f(u.uDither, dest === 'float' ? 0 : 1);
      this.#localUniforms(gl, u, s, showMask);
      this.#affineUniforms(gl, u, ['uSO', 'uSX', 'uSY'], af, w, h, g.frameToSrc);
      gl.uniform2f(u.uSrcSize, this.src.w, this.src.h);
      gl.activeTexture(gl.TEXTURE0 + 7);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
      gl.uniform1i(u.uLMask, 7);
    });
  }

  #spotUniforms(gl, u, spots = []) {
    const n = Math.min(spots.length, 40);
    const a = new Float32Array(160), r = new Float32Array(80);
    for (let i = 0; i < n; i++) { const s = spots[i]; a.set([s.x, s.y, s.sx, s.sy], i * 4); r.set([s.r, s.f], i * 2); }
    gl.uniform1i(u.uSpotN, n);
    gl.uniform4fv(u.uSpot, a); gl.uniform2fv(u.uSpotR, r);
    gl.uniform2f(u.uSize, this.src.w, this.src.h);
  }

  // lens: { dist: [a, b, c], tca: [kr, kb], vig: [k1, k2, k3] } or null
  #lensUniforms(gl, u, lens) {
    gl.uniform1i(u.uLens, lens ? 1 : 0);
    if (!lens) return;
    gl.uniform2f(u.uSize, this.src.w, this.src.h);
    gl.uniform3fv(u.uDist, lens.dist);
    gl.uniform2fv(u.uTca, lens.tca);
    gl.uniform3fv(u.uVig, lens.vig);
  }

  #localUniforms(gl, u, s, showMask) {
    const type = new Int32Array(MAX_LOCALS), A = new Float32Array(MAX_LOCALS * 4), B = new Float32Array(MAX_LOCALS * 4);
    const wb = new Float32Array(MAX_LOCALS * 3).fill(1), a1 = new Float32Array(MAX_LOCALS * 4), a2 = new Float32Array(MAX_LOCALS * 2);
    let n = 0, show = -1;
    (s.locals || []).slice(0, MAX_LOCALS).forEach((l, layer) => {
      if (!l.enabled) return;
      if (l.type === 'linear') { type[n] = 0; A.set([...l.p0, ...l.p1], n * 4); }
      else if (l.type === 'radial') { type[n] = 1; A.set([...l.c, l.rx, l.ry], n * 4); B.set([l.angle, l.feather, l.invert ? 1 : 0, 0], n * 4); }
      else { type[n] = 2; B.set([0, 0, 0, layer], n * 4); }
      // Warmth and tint as a relative white balance shift around daylight.
      const ref = { temp: 5500, tint: 0 };
      wb.set(wbGains(ref, 1e6 / (1e6 / 5500 - l.temp * 0.6), l.tint * 0.6), n * 3);
      a1.set([l.exposure, l.contrast / 100, l.highlights / 100, l.shadows / 100], n * 4);
      a2.set([l.clarity / 100, l.saturation / 100], n * 2);
      if (l.id === showMask) show = n;
      n++;
    });
    gl.uniform1i(u.uLN, n); gl.uniform1i(u.uLShow, show);
    gl.uniform1iv(u.uLType, type); gl.uniform4fv(u.uLA, A); gl.uniform4fv(u.uLB, B);
    gl.uniform3fv(u.uLWB, wb); gl.uniform4fv(u.uLAdj1, a1); gl.uniform2fv(u.uLAdj2, a2);
  }

  // Free the render targets of a slot (used after export to release memory).
  release(slot) {
    for (const [name, t] of this.targets) {
      if (name.startsWith(slot + ':')) { this.gl.deleteTexture(t.tex); this.targets.delete(name); }
    }
  }

  // Read the last 'float' render as 16-bit RGB, top row first, into `out` at pixel (dx, dy),
  // skipping `sx`, `sy` source pixels and copying cw x ch.
  readFloatInto(out, outW, w, h, dx, dy, sx, sy, cw, ch) {
    const gl = this.gl;
    const raw = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw);
    for (let y = 0; y < ch; y++) {
      let i = ((h - 1 - (sy + y)) * w + sx) * 4, o = ((dy + y) * outW + dx) * 3;
      for (let x = 0; x < cw; x++, i += 4, o += 3) {
        out[o] = Math.min(1, Math.max(0, raw[i])) * 65535 + 0.5;
        out[o + 1] = Math.min(1, Math.max(0, raw[i + 1])) * 65535 + 0.5;
        out[o + 2] = Math.min(1, Math.max(0, raw[i + 2])) * 65535 + 0.5;
      }
    }
  }

  // Read the last 'buffer' render, top row first.
  readPixels(w, h) {
    const gl = this.gl;
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8ClampedArray(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }
}
