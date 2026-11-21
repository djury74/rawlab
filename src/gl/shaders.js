// GLSL for the develop pipeline. All intermediate data is linear-light,
// half-float, in sRGB primaries, with the camera's as-shot white balance.

export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vT;
void main() { vT = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// 16-bit integer RGB from the RAW decoder -> float.
export const FRAG_IMPORT_U16 = `#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D uSrc;
uniform float uScale;
out vec4 o;
void main() {
  // The decoder always applies the BT.709 transfer curve; undo it to get linear
  // light, then restore the scale so that 1.0 is nominal white. Values above 1.0
  // are highlight detail kept from the colour channels that had not clipped.
  vec3 v = vec3(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb) / 65535.0;
  vec3 lin = mix(v / 4.5, pow((v + 0.099) / 1.099, vec3(1.0 / 0.45)), step(0.081, v));
  o = vec4(lin * uScale, 1.0);
}`;

// sRGB-encoded 8-bit image (JPEG/PNG); the sampler linearises it.
export const FRAG_IMPORT_SRGB = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 o;
void main() { o = vec4(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); }`;

// Resample the source into the target through an affine map.
export const FRAG_GEOM = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uO, uX, uY;
uniform bool uLens;
uniform vec2 uSize;        // source size in pixels
uniform vec3 uDist;        // ptlens a, b, c
uniform vec2 uTca;         // red and blue magnification
uniform vec3 uVig;         // k1, k2, k3
in vec2 vT;
out vec4 o;
void main() {
  vec2 p = vec2(vT.x, 1.0 - vT.y);
  vec2 uv = uO + p.x * uX + p.y * uY;
  vec2 in2 = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  vec3 c;
  if (uLens) {
    // uv is the corrected position; find where the lens actually put that point.
    vec2 d = (uv - 0.5) * uSize;
    float ru = length(d) / (0.5 * min(uSize.x, uSize.y));
    d *= ((uDist.x * ru + uDist.y) * ru + uDist.z) * ru + 1.0 - uDist.x - uDist.y - uDist.z;
    c = vec3(texture(uSrc, 0.5 + d * uTca.x / uSize).r, texture(uSrc, 0.5 + d / uSize).g, texture(uSrc, 0.5 + d * uTca.y / uSize).b);
    float r2 = dot(d, d) / (0.25 * dot(uSize, uSize));
    c /= max(1.0 + r2 * (uVig.x + r2 * (uVig.y + r2 * uVig.z)), 0.25);
  } else {
    c = texture(uSrc, uv).rgb;
  }
  o = vec4(c, in2.x * in2.y);
}`;

export const FRAG_BLUR = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir;
in vec2 vT;
out vec4 o;
void main() {
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = -10; i <= 10; i++) {
    float f = float(i);
    float w = exp(-f * f / 24.5);
    acc += texture(uTex, vT + uDir * f).rgb * w; wsum += w;
  }
  o = vec4(acc / wsum, 1.0);
}`;

// Edge-preserving luminance smoothing plus wider chroma smoothing.
export const FRAG_DENOISE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uStep;       // one image pixel, in texture coordinates
uniform float uLuma, uChroma;
in vec2 vT;
out vec4 o;
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec4 c0 = texture(uTex, vT);
  vec3 g0 = sqrt(max(c0.rgb, 0.0));
  float y0 = dot(g0, LUM);
  float y = y0;
  if (uLuma > 0.0) {
    float sr = 0.004 + uLuma * 0.07;
    float acc = 0.0, ws = 0.0;
    for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
      vec2 d = vec2(float(i), float(j));
      float yy = dot(sqrt(max(texture(uTex, vT + d * uStep).rgb, 0.0)), LUM);
      float dy = (yy - y0) / sr;
      float w = exp(-dot(d, d) / 4.5 - dy * dy);
      acc += yy * w; ws += w;
    }
    y = mix(y0, acc / ws, min(1.0, uLuma * 2.0));
  }
  vec3 ch = g0 - y0;
  if (uChroma > 0.0) {
    float sr = 0.02 + uChroma * 0.12;
    vec3 acc = vec3(0.0); float ws = 0.0;
    for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
      vec2 d = vec2(float(i), float(j));
      vec3 gg = sqrt(max(texture(uTex, vT + d * uStep * 2.5).rgb, 0.0));
      float yy = dot(gg, LUM);
      float dy = (yy - y0) / sr;
      float w = exp(-dot(d, d) / 6.0 - dy * dy);
      acc += (gg - yy) * w; ws += w;
    }
    ch = mix(ch, acc / ws, min(1.0, uChroma * 2.0));
  }
  vec3 g = max(vec3(y) + ch, 0.0);
  o = vec4(g * g, c0.a);
}`;

export const FRAG_DEVELOP = `#version 300 es
precision highp float;
uniform sampler2D uView, uBlur, uCurve, uBase;
uniform vec2 uTexel;
uniform float uPx;                 // target pixels per image pixel
uniform vec2 uFO, uFX, uFY;        // target uv -> frame uv
uniform vec2 uCO, uCX, uCY;        // target uv -> crop uv
uniform vec2 uCropPx;
uniform vec3 uWB;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uClarity, uDehaze, uVibrance, uSaturation;
uniform int uProfile;
uniform bool uBW, uClip, uMaskCrop;
uniform float uHslH[8], uHslS[8], uHslL[8];
uniform vec3 uGradeSh, uGradeHi;
uniform float uGradeBal;
uniform float uSharpen, uSharpRadius;
uniform float uVig, uVigMid, uVigFeather, uGrain, uGrainSize;
uniform vec3 uBg;
// Local adjustments. Masks live in source-image space so they follow the photo
// through crop, rotation and flips.
uniform vec2 uSO, uSX, uSY, uSrcSize;
uniform int uLN, uLShow;
uniform int uLType[8];
uniform vec4 uLA[8], uLB[8];
uniform vec3 uLWB[8];
uniform vec4 uLAdj1[8];            // exposure, contrast, highlights, shadows
uniform vec2 uLAdj2[8];            // clarity, saturation
uniform mediump sampler2DArray uLMask;
in vec2 vT;
out vec4 o;

const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
const float BAND[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0, 360.0);

vec3 oetf(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 1e-6), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float scurve(float v, float g) {
  return v < 0.5 ? 0.5 * pow(2.0 * v, g) : 1.0 - 0.5 * pow(2.0 * (1.0 - v), g);
}
float localMask(int i, vec2 suv) {
  vec2 p = suv * uSrcSize;
  vec4 A = uLA[i], B = uLB[i];
  if (uLType[i] == 0) {            // linear gradient: full at A.xy, zero at A.zw
    vec2 a = A.xy * uSrcSize, d = A.zw * uSrcSize - a;
    return 1.0 - smoothstep(0.0, 1.0, dot(p - a, d) / max(dot(d, d), 1e-6));
  }
  if (uLType[i] == 1) {            // radial: centre, radii, angle, feather, invert
    vec2 d = p - A.xy * uSrcSize;
    float ca = cos(B.x), sa = sin(B.x);
    d = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / (A.zw * max(uSrcSize.x, uSrcSize.y));
    float m = 1.0 - smoothstep(1.0 - B.y, 1.0, length(d));
    return B.z > 0.5 ? 1.0 - m : m;
  }
  return texture(uLMask, vec3(suv, B.w)).a;   // painted brush mask
}
float lumaG(vec2 uv) { return sqrt(max(dot(texture(uView, uv).rgb, LUM), 0.0)); }

void main() {
  vec2 p = vec2(vT.x, 1.0 - vT.y);
  vec4 src = texture(uView, vT);
  vec3 c = max(src.rgb, 0.0);
  vec2 fuv = uFO + p.x * uFX + p.y * uFY;
  vec3 b = max(texture(uBlur, vec2(fuv.x, 1.0 - fuv.y)).rgb, 0.0);
  vec2 cuv = uCO + p.x * uCX + p.y * uCY;

  // Capture sharpening on perceptual luminance.
  if (uSharpen > 0.0) {
    vec2 r = uTexel * uSharpRadius * uPx;
    float g0 = sqrt(max(dot(c, LUM), 1e-6));
    float cross4 = lumaG(vT + vec2(r.x, 0.0)) + lumaG(vT - vec2(r.x, 0.0)) + lumaG(vT + vec2(0.0, r.y)) + lumaG(vT - vec2(0.0, r.y));
    float diag4 = lumaG(vT + r) + lumaG(vT - r) + lumaG(vT + vec2(r.x, -r.y)) + lumaG(vT + vec2(-r.x, r.y));
    float d = g0 - (4.0 * g0 + 2.0 * cross4 + diag4) / 16.0;
    d *= smoothstep(0.0, 0.006, abs(d));
    float g1 = max(g0 + uSharpen * 3.0 * d, 0.0);
    c *= clamp((g1 * g1) / (g0 * g0), 0.25, 4.0);
  }

  // Accumulate local adjustments into per-pixel offsets of the global controls.
  vec2 suv = uSO + p.x * uSX + p.y * uSY;
  vec4 l1 = vec4(0.0); vec2 l2 = vec2(0.0); vec3 lWB = vec3(1.0); float shown = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uLN) break;
    float m = localMask(i, suv);
    l1 += m * uLAdj1[i]; l2 += m * uLAdj2[i];
    lWB *= mix(vec3(1.0), uLWB[i], m);
    if (i == uLShow) shown = m;
  }

  // White balance and exposure, in linear light.
  vec3 ev = uWB * lWB * exp2(uExposure + l1.x);
  c *= ev;
  b *= ev;

  if (uDehaze > 0.0) {
    float dark = clamp(min(min(b.r, b.g), b.b), 0.0, 1.0);
    float t = max(1.0 - uDehaze * 0.85 * dark, 0.2);
    c = max((c - 1.0) / t + 1.0, 0.0);
    b = max((b - 1.0) / t + 1.0, 0.0);
  } else if (uDehaze < 0.0) {
    c = mix(c, vec3(0.75), -uDehaze * 0.45);
    b = mix(b, vec3(0.75), -uDehaze * 0.45);
  }

  // Shadows and highlights: local exposure driven by the blurred image.
  float L = max(dot(c, LUM), 1e-5);
  float Lb = max(dot(b, LUM), 1e-5);
  float mb = sqrt(clamp(Lb, 0.0, 1.0));
  float ws = 1.0 - smoothstep(0.0, 0.55, mb);
  float wh = smoothstep(0.4, 1.0, mb);
  float gain = exp2((uShadows + l1.w) * 1.6 * ws * ws + (uHighlights + l1.z) * 1.4 * wh);
  c *= gain; L *= gain; Lb *= gain;

  // Clarity: midtone local contrast.
  float clarity = uClarity + l2.x;
  if (clarity != 0.0) {
    float g = sqrt(L), gb = sqrt(Lb);
    float w = 1.0 - pow(abs(2.0 * clamp(g, 0.0, 1.0) - 1.0), 2.0);
    float g2 = max(g + clarity * 0.7 * (g - gb) * w, 0.0);
    float k = (g2 * g2) / L;
    c *= k; L *= k;
  }

  // Whites and blacks.
  float e = sqrt(clamp(L, 0.0, 1.0));
  c *= exp2(uWhites * 0.8 * e * e);
  c += uBlacks * 0.05 * pow(1.0 - e, 3.0);

  c = max(c, 0.0);
  bool clipLo = max(max(c.r, c.g), c.b) <= 0.0;
  if (uProfile != 2) {
    // Highlight shoulder: roll tones above 0.8 smoothly into white instead of
    // cutting them off, fading colour out as they approach it.
    float m = max(max(c.r, c.g), c.b);
    if (m > 0.8) {
      float ms = 0.8 + 0.2 * (1.0 - exp(-(m - 0.8) / 0.2));
      c = mix(c * (ms / m), vec3(ms), smoothstep(0.9, 2.2, m));
    }
  }
  bool clipHi = max(max(c.r, c.g), c.b) >= (uProfile != 2 ? 0.985 : 1.0);
  c = clamp(c, 0.0, 1.0);

  // Camera-style base rendering: sensor data is linear and looks dark and flat
  // without the tone curve every camera applies to its own JPEGs. The curve is
  // applied per channel, which also restores the colour saturation.
  if (uProfile != 2) {
    vec3 bc = sqrt(c) * (1023.0 / 1024.0) + 0.5 / 1024.0;
    c = vec3(texture(uBase, vec2(bc.r, 0.5)).r, texture(uBase, vec2(bc.g, 0.5)).r, texture(uBase, vec2(bc.b, 0.5)).r);
  }
  vec3 v = oetf(c);
  if (uProfile != 2) {
    if (uProfile == 1) v = mix(v, v * v * (3.0 - 2.0 * v), 0.3);
    float l = dot(v, LUM);
    v = clamp(mix(vec3(l), v, uProfile == 1 ? 1.3 : 1.1), 0.0, 1.0);
  }

  float contrast = uContrast + l1.y;
  if (contrast != 0.0) {
    float g = exp2(contrast);
    v = vec3(scurve(v.r, g), scurve(v.g, g), scurve(v.b, g));
  }

  // Tone curve.
  vec3 lc = v * (1023.0 / 1024.0) + 0.5 / 1024.0;
  v = vec3(texture(uCurve, vec2(lc.r, 0.5)).r, texture(uCurve, vec2(lc.g, 0.5)).g, texture(uCurve, vec2(lc.b, 0.5)).b);

  // Colour mixer.
  vec3 hsv = rgb2hsv(v);
  float h = hsv.x * 360.0;
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 8; i++) {
    if (h >= BAND[i] && h < BAND[i + 1]) {
      int j = i == 7 ? 0 : i + 1;
      float t = smoothstep(0.0, 1.0, (h - BAND[i]) / (BAND[i + 1] - BAND[i]));
      dh = mix(uHslH[i], uHslH[j], t);
      ds = mix(uHslS[i], uHslS[j], t);
      dl = mix(uHslL[i], uHslL[j], t);
    }
  }
  float sw = smoothstep(0.02, 0.25, hsv.y);
  if (uBW) {
    float l = dot(v, LUM);
    v = vec3(clamp(l * (1.0 + dl * 0.8 * sw), 0.0, 1.0));
  } else {
    hsv.x = fract(hsv.x + dh * sw * (30.0 / 360.0));
    hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
    v = hsv2rgb(hsv);
    v = clamp(v * (1.0 + dl * 0.6 * sw), 0.0, 1.0);
    float l = dot(v, LUM);
    float sat = max(max(v.r, v.g), v.b) - min(min(v.r, v.g), v.b);
    v = mix(vec3(l), v, 1.0 + uVibrance * (1.0 - sat));
    v = mix(vec3(l), v, max(1.0 + uSaturation + l2.y, 0.0));
    v = clamp(v, 0.0, 1.0);
  }

  // Colour grading: tint shadows and highlights.
  float gl = dot(v, LUM);
  float split = clamp(gl + uGradeBal * 0.5, 0.0, 1.0);
  v += uGradeSh * (1.0 - smoothstep(0.0, 0.75, split)) + uGradeHi * smoothstep(0.25, 1.0, split);

  // Vignette follows the crop.
  if (uVig != 0.0) {
    float r = length((cuv - 0.5) * 2.0) / 1.41421;
    float f = smoothstep(uVigMid - uVigFeather, uVigMid + uVigFeather + 1e-3, r);
    v *= 1.0 + uVig * f * (uVig < 0.0 ? 0.9 : 0.6);
  }

  if (uGrain > 0.0) {
    vec2 cell = floor(cuv * uCropPx / uGrainSize);
    float n = hash(cell) + hash(cell + 17.3) - 1.0;
    float m = 1.0 - pow(abs(2.0 * clamp(dot(v, LUM), 0.0, 1.0) - 1.0), 3.0);
    v += n * uGrain * 0.18 * (0.35 + 0.65 * m);
  }

  v = clamp(v, 0.0, 1.0);
  if (uClip) {
    if (clipHi) v = vec3(1.0, 0.1, 0.1);
    else if (clipLo) v = vec3(0.1, 0.35, 1.0);
  }
  v = mix(v, vec3(1.0, 0.16, 0.1), shown * 0.55);
  v += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  float a = src.a;
  if (uMaskCrop) { vec2 m = step(vec2(0.0), cuv) * step(cuv, vec2(1.0)); a *= m.x * m.y; }
  o = vec4(mix(uBg, v, a), a);
}`;
