import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RGBShiftShader } from 'three/addons/shaders/RGBShiftShader.js';

import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { audio } from './audio.js';

// ═══════════════════════════════════════════════════
// SCENE SETUP
// ═══════════════════════════════════════════════════
const scene = new THREE.Scene();
const bgColor = '#040a18';
scene.fog = new THREE.FogExp2(bgColor, 0.0035);

const camera = new THREE.PerspectiveCamera(85, innerWidth / innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 2.0;
document.body.appendChild(renderer.domElement);

// ═══════════════════════════════════════════════════
// POST PROCESSING — real bloom + chromatic aberration
// ═══════════════════════════════════════════════════
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.42,  // strength — balanced neon, not washed out
  0.28,  // radius
  0.38   // threshold — only bright surfaces bloom
);
composer.addPass(bloomPass);

const rgbPass = new ShaderPass(RGBShiftShader);
rgbPass.uniforms['amount'].value = 0.0022;
composer.addPass(rgbPass);

// ═══════════════════════════════════════════════════
// TUNNEL CURVE — looping 3D path
// ═══════════════════════════════════════════════════
const curvePoints = [];
const segs = 600;
for (let i = 0; i < segs; i++) {
  const t = i / segs;
  const a = t * Math.PI * 2;

  // Strong base loop with sharp but non-folding wiggles
  const x = Math.cos(a) * 350 + Math.cos(a * 3) * 70 + Math.sin(a * 5) * 25;
  const z = Math.sin(a * 2) * 280 + Math.sin(a * 4) * 50 + Math.cos(a * 7) * 15;

  // Steep hills and drops — big amplitude but lower frequency to avoid reversals
  const y = Math.sin(a * 3) * 100 + Math.sin(a * 7) * 45 + Math.cos(a * 5) * 55;

  curvePoints.push(new THREE.Vector3(x, y, z));
}
const curve = new THREE.CatmullRomCurve3(curvePoints, true);

// Override Frenet frames for stable up-vector
curve.computeFrenetFrames = function(segments) {
  const tangents = [], normals = [], binormals = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const tan = this.getTangentAt(u).normalize();
    tangents.push(tan);
    const bi = new THREE.Vector3().crossVectors(tan, up).normalize();
    const no = new THREE.Vector3().crossVectors(bi, tan).normalize();
    binormals.push(bi);
    normals.push(no);
  }
  return { tangents, normals, binormals };
};

const tubeGeo = new THREE.TubeGeometry(curve, segs * 2, 14, 64, true);

// ═══════════════════════════════════════════════════
// MATRIX TEXTURE — procedural katakana canvas
// ═══════════════════════════════════════════════════
const mCnv = document.createElement('canvas');
mCnv.width = 1024; mCnv.height = 1024;
const mCtx = mCnv.getContext('2d');
mCtx.fillStyle = '#000';
mCtx.fillRect(0, 0, 1024, 1024);
mCtx.fillStyle = '#fff';
mCtx.font = 'bold 42px monospace';
mCtx.textAlign = 'center';
mCtx.textBaseline = 'middle';
for (let y = 22; y < 1024; y += 46) {
  for (let x = 22; x < 1024; x += 46) {
    const ch = String.fromCharCode(0xFF66 + Math.floor(Math.random() * 55));
    mCtx.globalAlpha = 0.4 + Math.random() * 0.6;
    mCtx.fillText(ch, x, y);
  }
}
const matrixTex = new THREE.CanvasTexture(mCnv);
matrixTex.wrapS = matrixTex.wrapT = THREE.RepeatWrapping;

// ═══════════════════════════════════════════════════
// CUSTOM SHADER — all effects in fragment shader
// ═══════════════════════════════════════════════════
const vertexShader = `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNorm;
  uniform float uPortalU;   // 0..1 along tube, <0 = off
  uniform float uOpen;      // 0..1 how much the mouth flares
  void main() {
    vUv = uv;
    // Flare tunnel walls outward near exit — reads as a widening mouth
    vec3 pos = position;
    if (uPortalU >= 0.0 && uOpen > 0.001) {
      float d = abs(uv.x - uPortalU);
      d = min(d, 1.0 - d);
      float flare = pow(smoothstep(0.14, 0.0, d), 0.4) * uOpen;
      pos += normal * flare * 48.0;
    }
    vWorldNorm = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = `
  uniform float uTime;
  uniform vec3 uBgTop;
  uniform vec3 uBgBot;
  uniform float uAngleOff;
  uniform float uIntensity;
  uniform float uDepthFade;
  uniform float uPortalU;
  uniform float uOpen;
  uniform vec3 uMouthSky;
  uniform vec3 uMouthRim;
  uniform float uReflect;
  uniform float uRingCount;
  uniform sampler2D uMatrix;
  uniform float uMatrixInt;
  uniform float uHue;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNorm;

  // Deterministic hash
  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  // Hue rotation (angle in radians)
  vec3 hueShift(vec3 c, float angle) {
    float s = sin(angle), co = cos(angle);
    vec3 w = vec3(0.299, 0.587, 0.114);
    return vec3(
      c.x*(co + (1.0-co)*w.x) + c.y*((1.0-co)*w.x - s*0.328) + c.z*((1.0-co)*w.x + s*0.948),
      c.x*((1.0-co)*w.y + s*0.328) + c.y*(co + (1.0-co)*w.y) + c.z*((1.0-co)*w.y - s*0.264),
      c.x*((1.0-co)*w.z - s*0.948) + c.y*((1.0-co)*w.z + s*0.264) + c.z*(co + (1.0-co)*w.z)
    );
  }

  // ── Neon streak line ──────────────────────────
  vec3 neonLine(vec3 col, float uPri, float target, float width, float uSec, float id, float t, float sMul) {
    // Random offset so lines aren't perfectly parallel
    float shifted = target + (hash(id * 8.2) - 0.5) * 0.1;
    // Vary thickness per-line
    float w = width * (0.15 + hash(id * 4.5) * 10.0);
    float weight = exp(-pow((uPri - shifted) * w, 2.0));

    float spd = (0.5 + hash(id) * 4.0) * sMul;
    float dir = hash(id * 2.1) > 0.5 ? 1.0 : -1.0;
    float scale = 0.08 + hash(id * 1.3) * 25.0;
    float phase = hash(id * 1.7) * 20.0;

    // Fast dash (bright head)
    float mc = uSec * scale + t * spd * dir + phase;
    float dp = fract(mc);
    float dLen = 0.01 + hash(id * 3.4) * 0.9;
    float dFade = 0.01 + hash(id * 7.1) * 0.07;
    float mask = smoothstep(0.0, dFade, dp) * smoothstep(dLen + dFade, dLen, dp);

    // Slow broken baseline
    float bs = scale * (0.02 + hash(id * 5.2) * 0.25);
    float bc = uSec * bs + t * spd * 0.1 * dir + phase * 2.0;
    float bp = fract(bc);
    float bLen = 0.1 + hash(id * 2.2) * 0.8;
    float bMask = smoothstep(0.0, 0.1, bp) * smoothstep(bLen + 0.1, bLen, bp);

    return col * weight * (0.25 * bMask + 0.85 * mask);
  }

  // ── Particle dot ──────────────────────────────
  vec3 particleDot(vec3 col, float uPri, float target, float width, float uSec, float id, float t, float sMul) {
    float w = width * (0.5 + hash(id * 6.1) * 3.0);
    float weight = exp(-pow((uPri - target) * w, 2.0));
    float spd = (2.0 + hash(id) * 4.0) * sMul;
    float dir = hash(id * 2.1) > 0.5 ? 1.0 : -1.0;
    float scale = 10.0 + hash(id * 1.3) * 80.0;
    float mc = uSec * scale + t * spd * dir + hash(id * 1.7) * 10.0;
    float dp = fract(mc);
    float dLen = 0.001 + hash(id * 3.4) * 0.012;
    float mask = smoothstep(0.0, 0.005, dp) * smoothstep(dLen + 0.005, dLen, dp);
    return col * weight * mask * 4.0;
  }

  // ── Ghost hologram panels ─────────────────────
  vec3 ghostLayer(float h, float uvX, float t, float seed) {
    float scroll = uvX * 12.0 + t * 0.3 * (hash(seed) > 0.5 ? 1.0 : -1.0);
    float idX = floor(scroll);
    float localX = fract(scroll);
    float hasPanel = step(0.68, hash(idX + seed));
    float idY = floor(h * 80.0);
    float hasBar = step(0.3, hash(idY * 15.0 + idX));
    float pulse = pow(sin(t * 1.2 + hash(idX) * 10.0) * 0.5 + 0.5, 2.0);
    float maskX = smoothstep(0.0, 0.2, localX) * smoothstep(1.0, 0.8, localX);
    vec3 tc = mix(vec3(0.2, 0.7, 1.0), vec3(1.0, 0.3, 0.7), hash(idX * 1.1));
    vec3 panel = tc * hasPanel * hasBar * maskX * pulse * 0.35;

    float wave = sin(uvX * 5.0 + t * 0.5 + seed) * sin(h * 10.0 - t * 0.4 + seed) * 0.5 + 0.5;
    wave = pow(wave, 5.0);
    vec3 wc = mix(vec3(0.1, 0.5, 1.0), vec3(0.8, 0.1, 0.5), hash(seed * 2.0));

    return panel + wc * wave * 0.03;
  }

  // ── Shared wall panel builder (blue neon cyber look) ──
  // h  = local height across the panel (-1..1-ish)
  // seed offsets keep each of the 4 walls unique
  vec3 wallPanel(float h, float uvX, float t, float seed) {
    vec3 c = vec3(0.0);
    float hw = h + sin(uvX * (90.0 + seed) + seed) * 0.003;
    float u = uvX * 100.0;
    float s = seed * 17.0;

    // Cool blue / cyan / magenta neon stack
    c += neonLine(vec3(0.15, 0.45, 1.0), hw, 0.35, 60.0,  u, s + 10.0, t, 2.0);
    c += neonLine(vec3(0.3,  0.85, 1.0), hw, 0.28, 280.0, u, s + 11.0, t, 2.0);
    c += neonLine(vec3(0.55, 0.25, 1.0), hw, 0.20, 130.0, u, s + 12.0, t, 2.0);
    c += neonLine(vec3(0.0,  0.9,  1.0), hw, 0.10, 45.0,  u, s + 13.0, t, 2.0);
    c += neonLine(vec3(0.7,  0.9,  1.0), hw, 0.02, 480.0, u, s + 14.0, t, 2.0);
    c += neonLine(vec3(0.2,  0.6,  1.0), hw,-0.08, 160.0, u, s + 15.0, t, 2.0);
    c += neonLine(vec3(0.9,  0.3,  0.85),hw,-0.18, 90.0,  u, s + 16.0, t, 2.0);
    c += neonLine(vec3(0.1,  0.35, 0.95),hw,-0.28, 380.0, u, s + 17.0, t, 2.0);

    // White cores
    c += neonLine(vec3(1.0), hw, 0.28, 450.0, u, s + 18.0, t, 2.5) * 0.45;
    c += neonLine(vec3(1.0), hw, 0.10, 800.0, u, s + 19.0, t, 2.5) * 0.45;

    // Particle dots
    c += particleDot(vec3(0.5, 0.85, 1.0), hw, 0.30, 400.0, u, s + 80.0, t, 1.5);
    c += particleDot(vec3(0.3, 1.0,  1.0), hw, 0.15, 350.0, u, s + 81.0, t, 2.5);
    c += particleDot(vec3(0.7, 0.5,  1.0), hw,-0.05, 450.0, u, s + 82.0, t, 2.0);
    c += particleDot(vec3(0.2, 0.6,  1.0), hw,-0.20, 300.0, u, s + 83.0, t, 3.0);

    c += ghostLayer(hw, uvX, t, 112.3 + seed * 33.7);
    return c;
  }

  vec3 rightSide(float h, float uvX, float t) { return wallPanel(h, uvX, t, 1.0); }
  vec3 leftSide (float h, float uvX, float t) { return wallPanel(h, uvX, t, 2.0); }
  vec3 topSide  (float h, float uvX, float t) { return wallPanel(h, uvX, t, 3.0); }
  vec3 botSide  (float h, float uvX, float t) { return wallPanel(h, uvX, t, 4.0); }

  // ── Colored rings around the tube ─────────────
  vec3 colorRings(float uvX, float uvY, float t) {
    vec3 c = vec3(0.0);
    float localX = fract(uvX * uRingCount);
    float cellId = floor(uvX * uRingCount);

    float rt = fract(hash(cellId) * 10.0);
    // Blue-family rings with occasional magenta accents
    vec3 rc = rt < 0.25 ? vec3(0.15, 0.55, 1.0) :
              rt < 0.45 ? vec3(0.0,  0.85, 1.0) :
              rt < 0.65 ? vec3(0.45, 0.35, 1.0) :
              rt < 0.85 ? vec3(0.25, 0.7,  1.0) :
                          vec3(0.85, 0.3,  0.95);

    c += neonLine(rc, localX, 0.5, 60.0 + hash(cellId) * 40.0, uvY, cellId, t, 1.0);
    float isActive = hash(cellId + 10.0) > 0.3 ? 1.0 : 0.0;
    return c * isActive;
  }

  // ── Main ──────────────────────────────────────
  void main() {
    float y = fract(vUv.y + uAngleOff);
    float cy = sin(y * 6.2831853);
    float cx = cos(y * 6.2831853);

    // Base color — deep blue tunnel body
    vec3 mintBase = hueShift(vec3(0.18, 0.42, 0.95), uHue) * 0.32;
    // Slight cool vignette around tube
    mintBase *= 0.78 + 0.22 * (0.5 + 0.5 * cy);

    // ── Four wall panels (Right / Left / Top / Bottom) ──
    // Wider soft lobes so each quadrant clearly shows its own graphics.
    // Local "height" across each panel uses the orthogonal axis so graphics stay upright.
    float rightW = pow(smoothstep(0.05, 0.62,  cx), 0.85);
    float leftW  = pow(smoothstep(0.05, 0.62, -cx), 0.85);
    float topW   = pow(smoothstep(0.05, 0.62,  cy), 0.85);
    float botW   = pow(smoothstep(0.05, 0.62, -cy), 0.85);
    float wSum   = rightW + leftW + topW + botW + 1e-4;

    vec3 streaks =
        (rightSide( cy, vUv.x, uTime) * rightW
       + leftSide ( cy, vUv.x, uTime) * leftW
       + topSide  ( cx, vUv.x, uTime) * topW
       + botSide  ( cx, vUv.x, uTime) * botW) / wSum;
    // Slightly boost panel graphics so all 4 walls read clearly
    streaks *= 1.15;

    // Neon accent lines all around the circumference
    float hw = cy + sin(vUv.x * 80.0) * 0.005;
    float u = vUv.x * 100.0;
    vec3 allLines = vec3(0.0);
    allLines += neonLine(vec3(0.25, 0.75, 1.0), hw, 0.70, 500.0, u, 30.0, uTime, 0.5) * 1.0;
    allLines += neonLine(vec3(0.45, 0.9,  1.0), hw, 0.82, 800.0, u, 31.0, uTime, 0.4) * 1.15;
    allLines += neonLine(vec3(0.55, 0.35, 1.0), hw, 0.55, 600.0, u, 32.0, uTime, 0.45) * 0.85;
    allLines += neonLine(vec3(0.2,  0.65, 1.0), hw, 0.38, 700.0, u, 33.0, uTime, 0.5) * 0.8;
    allLines += neonLine(vec3(0.7,  0.85, 1.0), hw, 0.15, 900.0, u, 34.0, uTime, 0.35) * 0.65;
    // Extra pair so top/bottom also get strong rails
    allLines += neonLine(vec3(0.3,  0.55, 1.0), hw,-0.55, 550.0, u, 35.0, uTime, 0.45) * 0.75;
    allLines += neonLine(vec3(0.5,  0.8,  1.0), hw,-0.72, 750.0, u, 36.0, uTime, 0.4) * 0.9;
    allLines += neonLine(vec3(0.25, 0.7, 1.0), hw, 0.20, 600.0, u, 40.0, uTime, 3.0) * 0.5;
    allLines += neonLine(vec3(0.4,  0.85,1.0), hw,-0.30, 700.0, u, 41.0, uTime, 2.5) * 0.45;
    allLines += neonLine(vec3(0.55, 0.4, 1.0), hw, 0.50, 400.0, u, 42.0, uTime, 2.0) * 0.35;

    vec3 finalCol = mintBase + (streaks * uIntensity * 0.5) + (allLines * uIntensity);

    // Rings
    vec3 rCol = colorRings(vUv.x, y, uTime);
    finalCol += rCol * uIntensity * 0.6;

    // Matrix characters — visible on all 4 wall panels
    if (uMatrixInt > 0.0) {
      vec2 texUv = vec2(vUv.x * 250.0, y * 14.0);
      float tv = texture2D(uMatrix, texUv).r;
      float sId = floor(texUv.y);
      float spd = 0.5 + hash(sId * 1.5) * 1.5;
      float phase = hash(sId * 7.1) * 10.0;
      float dir = hash(sId * 3.3) > 0.5 ? 1.0 : -1.0;
      float tc = vUv.x * 8.0 + uTime * spd * dir + phase;
      float tp = fract(tc);
      float trail = smoothstep(0.0, 0.8, tp) * smoothstep(1.0, 0.95, tp);
      float head = smoothstep(0.95, 1.0, tp);
      float cId = floor(texUv.x) + sId * 100.0;
      float flick = sin(uTime * 15.0 + hash(cId) * 20.0) * 0.5 + 0.5;
      float vis = (trail * 0.6 + head * 2.0) * (0.3 + 0.7 * flick);
      // Cool cyan/blue matrix rain instead of green
      vec3 mc = mix(vec3(0.15, 0.55, 1.0), vec3(0.7, 0.95, 1.0), head);
      // Stronger on the four panel centers, soft near seams
      float mSide = max(max(rightW, leftW), max(topW, botW));
      finalCol += mc * tv * vis * uMatrixInt * mSide * uIntensity;
    }

    // Wet floor reflection (bottom panel only)
    if (cy < -0.2 && uReflect > 0.0) {
      float rcy = abs(cy);
      float ripple = sin(vUv.x * 300.0 - uTime * 5.0) * 0.03 + sin(vUv.x * 1000.0) * 0.01;
      float rcx = cx + ripple;
      vec3 refl = rcx > 0.0 ? rightSide(rcy, vUv.x, uTime) : leftSide(rcy, vUv.x, uTime);
      // Also mix a bit of top panel reflection for depth
      refl = mix(refl, topSide(rcx, vUv.x, uTime), 0.35);
      float rMask = smoothstep(-0.2, -0.8, cy) * smoothstep(-1.0, -0.9, cy);
      finalCol += refl * uReflect * rMask;
    }

    // Depth fog & cavity shading
    float dist = length(cameraPosition - vWorldPos);
    float fog = exp(-dist * uDepthFade);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = max(0.0, dot(-vWorldNorm, viewDir));
    float cavity = mix(0.5, 1.0, smoothstep(0.0, 0.8, fresnel));

    finalCol = hueShift(finalCol, uHue);
    finalCol *= cavity;
    finalCol = mix(hueShift(uBgBot, uHue), finalCol, fog);

    // P3 — tunnel mouth: walls peel into soft daylight (mid-luma, bloom-safe)
    if (uPortalU >= 0.0 && uOpen > 0.001) {
      float d = abs(vUv.x - uPortalU);
      d = min(d, 1.0 - d);
      float mouth = pow(smoothstep(0.14, 0.0, d), 0.55) * uOpen;
      // Sky / rim colors driven from JS (rainbow cavalcade while opening)
      vec3 sky = uMouthSky;
      vec3 rim = uMouthRim;
      float rimAmt = smoothstep(0.06, 0.012, d) * (1.0 - smoothstep(0.012, 0.0, d)) * uOpen;
      finalCol = mix(finalCol, sky, mouth * 0.78);
      finalCol += rim * rimAmt * 0.4;
      // Soften neon near mouth so aperture reads clean
      finalCol *= (1.0 - mouth * 0.22);
    }

    gl_FragColor = vec4(finalCol, 1.0);
  }
`;

const tubeMat = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms: {
    uTime:       { value: 0 },
    uBgTop:      { value: new THREE.Color('#0e2a5c') },
    uBgBot:      { value: new THREE.Color('#061428') },
    uAngleOff:   { value: -0.25 },
    uIntensity:  { value: 1.75 },
    uDepthFade:  { value: 0.00045 },
    uReflect:    { value: 0.48 },
    uRingCount:  { value: 16.0 },
    uMatrix:     { value: matrixTex },
    uMatrixInt:  { value: 0.5 },
    uHue:        { value: 0.0 },
    uPortalU:    { value: -1.0 },
    uOpen:       { value: 0.0 },
    uMouthSky:   { value: new THREE.Color(0.25, 0.5, 0.95) },
    uMouthRim:   { value: new THREE.Color(0.45, 0.85, 1.0) },
  },
  side: THREE.BackSide,
});

scene.add(new THREE.Mesh(tubeGeo, tubeMat));

// ═══════════════════════════════════════════════════
// LIGHTING + ENVIRONMENT — neon cyberpunk punch
// ═══════════════════════════════════════════════════
const ambientLight = new THREE.AmbientLight(0xaaccff, 4.5);
scene.add(ambientLight);

// Headlight — attached to camera so it always illuminates the ship
const headLight = new THREE.DirectionalLight(0xe8f4ff, 10.0);
camera.add(headLight);
headLight.position.set(0, 2, -5); // shines forward from camera
headLight.target.position.set(0, 0, -10);
camera.add(headLight.target);
scene.add(camera); // camera must be in scene for children to render

const pointLight = new THREE.PointLight(0x00eeff, 28, 140);
scene.add(pointLight);

const pointLight2 = new THREE.PointLight(0xff22cc, 22, 120);
scene.add(pointLight2);

// Extra fill light that follows the ship from above
const fillLight = new THREE.PointLight(0xffffff, 18, 70);
scene.add(fillLight);

// Accent rim light — hot magenta from below/side for depth
const rimLight = new THREE.PointLight(0xff66aa, 14, 90);
scene.add(rimLight);

// Generate a bright studio-like environment map for metallic PBR materials
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.background = new THREE.Color(0xaabbcc); // bright neutral background
// Simulate studio lighting — bright, multi-directional
const envLights = [
  { color: 0xffffff, intensity: 500, pos: [5, 5, 5] },
  { color: 0xffffff, intensity: 500, pos: [-5, 5, -5] },
  { color: 0xffffff, intensity: 400, pos: [0, -5, 5] },
  { color: 0xffffff, intensity: 400, pos: [0, 5, -5] },
  { color: 0x88ccff, intensity: 300, pos: [5, 0, -5] },
  { color: 0xffaacc, intensity: 300, pos: [-5, 0, 5] },
];
envLights.forEach(({ color, intensity, pos }) => {
  const l = new THREE.PointLight(color, intensity, 0);
  l.position.set(...pos);
  envScene.add(l);
});
const envRT = pmremGenerator.fromScene(envScene).texture;
scene.environment = envRT;
pmremGenerator.dispose();

// ═══════════════════════════════════════════════════
// SETTINGS — tweakable from GUI
// ═══════════════════════════════════════════════════
const settings = {
  camOffX: 0,
  camOffY: 3,
  camOffZ: 0,
  shipOffX: 0,
  shipOffY: -11,
  shipOffZ: -16.9,
  shipScale: 2.4,
  shipRotX: 15,
  shipRotY: 0,
  shipRotZ: 0,
  speed: 0.18,
  bloomStrength: 0.3,
  bloomRadius: 0.1,
  bloomThreshold: 0.5,
  trailOffX: 0.15,
  trailOffY: 0.1,
  trailOffZ: 0.4,
  trailWidth: 0.08,
  trailLength: 200,
};

// ═══════════════════════════════════════════════════
// GAME STATE + COLORS + LEVELS
// ═══════════════════════════════════════════════════
const GAME_COLORS = [
  { name: 'CYAN',    hex: 0x00ccff, css: '#00ccff' },
  { name: 'MAGENTA', hex: 0xff00aa, css: '#ff00aa' },
  { name: 'YELLOW',  hex: 0xffcc00, css: '#ffcc00' },
  { name: 'GREEN',   hex: 0x00ff88, css: '#00ff88' },
];

let gameState = 'menu';
let score = 0;
// Points per unit of tunnel travelled. Tuned so level 1 pays ~18/sec, which
// is what the original per-frame formula was aiming for. Because it's driven
// by distance rather than time, later levels pay more simply for being faster.
const DISTANCE_SCORE = 1000;
let scoreCarry = 0; // fractional points not yet banked into `score`
let level = 1;
let shipColorIdx = 0;
const LEVEL_DURATION = 25; // seconds per level
let levelTimer = LEVEL_DURATION;
let lives = 3;
let hitFlash = 0;

// ── P1 juice / feel ──
let hitStopTimer = 0;       // brief slow-mo on hit
let camShake = 0;           // screen shake amplitude
let nearMissFlash = 0;      // white edge flash timer
let levelDamageTaken = false; // perfect-level tracking (reset each level)
let perfectLevelsThisRun = 0;

// ── Streak & multiplier ──
let streak = 0;          // consecutive obstacles dodged
let multiplier = 1;      // score multiplier (increases with streak)
let coinBoostTimer = 0;  // brief speed burst after coin pickup

// ═══════════════════════════════════════════════════
// P2 — SEED / PRACTICE / GHOST / AUDIO / AIM-ASSIST
// ═══════════════════════════════════════════════════
/** Mulberry32 — deterministic [0,1) from 32-bit seed */
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStringToSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function randomSeedStr() {
  // short shareable code e.g. "A7K2"
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return s;
}

let runSeedStr = randomSeedStr();   // human-readable seed shown in UI
let runSeedNum = hashStringToSeed(runSeedStr);
let rng = mulberry32(runSeedNum);   // layout RNG (obstacles / coins)
let practiceMode = false;          // same seed every restart until toggled
let aimAssist = false;             // mild pull toward nearest gap (default OFF)

// Ghost / best-run line (roll samples vs progress 0..1)
const LS_GHOST = 'tunnelrunner_ghost_v1';
const GHOST_SAMPLES = 256;
let ghostBest = null;              // { seed, score, rolls: Float32Array }
let ghostRecording = new Float32Array(GHOST_SAMPLES);
let ghostMesh = null;
const ghostPositions = new Float32Array(GHOST_SAMPLES * 3);

function loadGhostBest() {
  try {
    const raw = localStorage.getItem(LS_GHOST);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.rolls || o.rolls.length !== GHOST_SAMPLES) return null;
    return { seed: o.seed || '', score: o.score | 0, rolls: Float32Array.from(o.rolls) };
  } catch (_) { return null; }
}
function saveGhostBest(data) {
  try {
    localStorage.setItem(LS_GHOST, JSON.stringify({
      seed: data.seed,
      score: data.score,
      rolls: Array.from(data.rolls),
    }));
  } catch (_) { /* quota */ }
}
ghostBest = loadGhostBest();

function initGhostMesh() {
  if (ghostMesh) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(ghostPositions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x88ccff,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    fog: true,
  });
  ghostMesh = new THREE.Line(geo, mat);
  ghostMesh.frustumCulled = false;
  ghostMesh.visible = false;
  scene.add(ghostMesh);
}

function recordGhostSample() {
  // Map progress 0..1 → sample index; keep latest roll at that slot
  const idx = Math.min(GHOST_SAMPLES - 1, Math.max(0, (progress * GHOST_SAMPLES) | 0));
  ghostRecording[idx] = rollAngle;
}

function rebuildGhostLine() {
  if (!ghostMesh || !ghostBest) {
    if (ghostMesh) ghostMesh.visible = false;
    return;
  }
  // Only show ghost when practicing the same seed (fair comparison)
  const sameSeed = practiceMode && ghostBest.seed === runSeedStr;
  if (!sameSeed) {
    ghostMesh.visible = false;
    return;
  }
  const wallDist = TUBE_R - 1.2;
  for (let i = 0; i < GHOST_SAMPLES; i++) {
    const t = i / (GHOST_SAMPLES - 1);
    const pos = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(tan, worldUp).normalize();
    const up = new THREE.Vector3().crossVectors(right, tan).normalize();
    const ang = ghostBest.rolls[i] || 0;
    const floorDir = new THREE.Vector3()
      .addScaledVector(up, -Math.cos(ang))
      .addScaledVector(right, Math.sin(ang));
    const p = pos.clone().addScaledVector(floorDir, wallDist);
    ghostPositions[i * 3] = p.x;
    ghostPositions[i * 3 + 1] = p.y;
    ghostPositions[i * 3 + 2] = p.z;
  }
  ghostMesh.geometry.attributes.position.needsUpdate = true;
  ghostMesh.visible = true;
}

function maybeSaveGhost(finalScore) {
  if (practiceMode) return; // don't overwrite best with practice runs
  if (!ghostBest || finalScore > ghostBest.score) {
    ghostBest = {
      seed: runSeedStr,
      score: finalScore,
      rolls: Float32Array.from(ghostRecording),
    };
    saveGhostBest(ghostBest);
  }
}

// ── WebAudio SFX (no assets) ──
let audioCtx = null;
let masterGain = null;
let sfxEnabled = true;

function ensureAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.35;
  masterGain.connect(audioCtx.destination);
}
function resumeAudio() {
  ensureAudio();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function playTone({ freq = 440, dur = 0.08, type = 'square', gain = 0.15, slide = 0, delay = 0 }) {
  if (!sfxEnabled) return;
  ensureAudio();
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}
const SFX = {
  nearMiss() {
    playTone({ freq: 880, dur: 0.07, type: 'triangle', gain: 0.12, slide: 400 });
    playTone({ freq: 1320, dur: 0.05, type: 'sine', gain: 0.08, delay: 0.03 });
  },
  hit() {
    playTone({ freq: 120, dur: 0.18, type: 'sawtooth', gain: 0.2, slide: -80 });
    playTone({ freq: 60, dur: 0.25, type: 'square', gain: 0.12 });
  },
  coin() {
    playTone({ freq: 988, dur: 0.06, type: 'sine', gain: 0.1 });
    playTone({ freq: 1319, dur: 0.08, type: 'sine', gain: 0.08, delay: 0.05 });
  },
  levelUp() {
    playTone({ freq: 523, dur: 0.1, type: 'square', gain: 0.1 });
    playTone({ freq: 659, dur: 0.1, type: 'square', gain: 0.1, delay: 0.08 });
    playTone({ freq: 784, dur: 0.16, type: 'square', gain: 0.12, delay: 0.16 });
  },
  start() {
    playTone({ freq: 330, dur: 0.08, type: 'triangle', gain: 0.1 });
    playTone({ freq: 440, dur: 0.1, type: 'triangle', gain: 0.1, delay: 0.07 });
  },
  dodge() {
    playTone({ freq: 220, dur: 0.04, type: 'sine', gain: 0.04 });
  },
};

// ── High Score (localStorage) ──
const LS_KEY = 'tunnelrunner_highscore';
let highScore = parseInt(localStorage.getItem(LS_KEY)) || 0;

function saveHighScore() {
  if (score > highScore) {
    highScore = score;
    localStorage.setItem(LS_KEY, highScore);
    return true; // new record
  }
  return false;
}

// ═══════════════════════════════════════════════════
// PERSISTENT COIN WALLET
// ═══════════════════════════════════════════════════
const LS_WALLET = 'tunnelrunner_wallet';
let wallet = parseInt(localStorage.getItem(LS_WALLET)) || 0;
let sessionCoins = 0; // coins earned this run

function saveWallet() { localStorage.setItem(LS_WALLET, wallet); }

// ═══════════════════════════════════════════════════
// MISSION SYSTEM — 3 active missions at a time
// ═══════════════════════════════════════════════════
const LS_MISSIONS = 'tunnelrunner_missions';
const LS_MISSIONS_DONE = 'tunnelrunner_missions_done';

const MISSION_DEFS = [
  // ── Reach level X ──
  { id: 'reach_lv3',  desc: 'Reach Level 3',         type: 'level',  target: 3,  reward: 50 },
  { id: 'reach_lv5',  desc: 'Reach Level 5',         type: 'level',  target: 5,  reward: 100 },
  { id: 'reach_lv8',  desc: 'Reach Level 8',         type: 'level',  target: 8,  reward: 200 },
  { id: 'reach_lv12', desc: 'Reach Level 12',        type: 'level',  target: 12, reward: 400 },
  // ── Dodge X obstacles in a row ──
  { id: 'streak_10',  desc: '10 dodges in a row',    type: 'streak', target: 10,  reward: 50 },
  { id: 'streak_20',  desc: '20 dodges in a row',    type: 'streak', target: 20,  reward: 100 },
  { id: 'streak_35',  desc: '35 dodges in a row',    type: 'streak', target: 35,  reward: 200 },
  { id: 'streak_50',  desc: '50 dodges in a row',    type: 'streak', target: 50,  reward: 400 },
  // ── Collect X coins in one run ──
  { id: 'coins_20',   desc: 'Collect 20 coins',      type: 'coins',  target: 20,  reward: 75 },
  { id: 'coins_50',   desc: 'Collect 50 coins',      type: 'coins',  target: 50,  reward: 150 },
  { id: 'coins_100',  desc: 'Collect 100 coins',     type: 'coins',  target: 100, reward: 300 },
  // ── Score X points ──
  { id: 'score_5k',   desc: 'Score 5,000 points',    type: 'score',  target: 5000,  reward: 50 },
  { id: 'score_15k',  desc: 'Score 15,000 points',   type: 'score',  target: 15000, reward: 150 },
  { id: 'score_30k',  desc: 'Score 30,000 points',   type: 'score',  target: 30000, reward: 300 },
  // ── Near misses ──
  { id: 'close_5',    desc: '5 near misses',         type: 'close',  target: 5,  reward: 75 },
  { id: 'close_15',   desc: '15 near misses',        type: 'close',  target: 15, reward: 200 },
  // ── Perfect levels (P1) ──
  { id: 'perfect_1',  desc: 'Clear 1 level with no hits', type: 'perfect', target: 1, reward: 75 },
  { id: 'perfect_3',  desc: 'Clear 3 perfect levels',     type: 'perfect', target: 3, reward: 200 },
  // ── No damage ──
  { id: 'nodmg_lv3',  desc: 'Reach Level 3 no damage', type: 'nodmg_level', target: 3, reward: 200 },
  { id: 'nodmg_lv5',  desc: 'Reach Level 5 no damage', type: 'nodmg_level', target: 5, reward: 500 },
];

let completedMissionIds = JSON.parse(localStorage.getItem(LS_MISSIONS_DONE) || '[]');
let activeMissions = JSON.parse(localStorage.getItem(LS_MISSIONS) || 'null');

// Per-run tracking
let runCoinsCollected = 0;
let runNearMisses = 0;
let runMaxStreak = 0;
let runDamageTaken = false;
// perfectLevelsThisRun declared with P1 juice vars above

function getAvailableMissions() {
  return MISSION_DEFS.filter(m => !completedMissionIds.includes(m.id));
}

function pickNewMissions() {
  const available = getAvailableMissions();
  const activeIds = activeMissions ? activeMissions.map(m => m.id) : [];
  const pool = available.filter(m => !activeIds.includes(m.id));

  // Fill up to 3
  const needed = 3 - (activeMissions ? activeMissions.length : 0);
  const picked = [];
  const shuffled = pool.sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(needed, shuffled.length); i++) {
    picked.push({ id: shuffled[i].id, progress: 0 });
  }
  return picked;
}

function initMissions() {
  if (!activeMissions || activeMissions.length === 0) {
    activeMissions = [];
    const picks = pickNewMissions();
    activeMissions.push(...picks);
  }
  // Fill if less than 3
  while (activeMissions.length < 3) {
    const picks = pickNewMissions();
    if (picks.length === 0) break;
    activeMissions.push(...picks);
  }
  saveMissions();
}

function saveMissions() {
  localStorage.setItem(LS_MISSIONS, JSON.stringify(activeMissions));
  localStorage.setItem(LS_MISSIONS_DONE, JSON.stringify(completedMissionIds));
}

function getMissionDef(id) { return MISSION_DEFS.find(m => m.id === id); }

function checkMissions() {
  if (!activeMissions) return;
  const completed = [];

  for (const m of activeMissions) {
    const def = getMissionDef(m.id);
    if (!def) continue;

    let current = 0;
    switch (def.type) {
      case 'level': current = level; break;
      case 'streak': current = runMaxStreak; break;
      case 'coins': current = runCoinsCollected; break;
      case 'perfect': current = perfectLevelsThisRun; break;
      case 'nearmiss': current = runNearMisses; break;
      case 'score': current = score; break;
      case 'close': current = runNearMisses; break;
      case 'nodmg_level': current = runDamageTaken ? 0 : level; break;
    }
    m.progress = Math.min(current, def.target);

    if (current >= def.target) {
      completed.push(m);
    }
  }

  for (const m of completed) {
    const def = getMissionDef(m.id);
    completedMissionIds.push(m.id);
    wallet += def.reward;
    saveWallet();
    activeMissions = activeMissions.filter(a => a.id !== m.id);
    showMissionComplete(def);
  }

  if (completed.length > 0) {
    // Fill new missions
    const picks = pickNewMissions();
    activeMissions.push(...picks);
    saveMissions();
  }
}

function showMissionComplete(def) {
  audio.play('mission_complete');
  const el = document.getElementById('hud-mission-complete');
  el.querySelector('.mc-text').textContent = def.desc;
  el.querySelector('.mc-reward').textContent = `+${def.reward}`;
  el.style.display = 'block';
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'missionPop 2s forwards';
  setTimeout(() => { el.style.display = 'none'; }, 2000);
}

function resetRunTracking() {
  runCoinsCollected = 0;
  runNearMisses = 0;
  runMaxStreak = 0;
  runDamageTaken = false;
  sessionCoins = 0;
}

initMissions();

// ═══════════════════════════════════════════════════
// SHOP — unlockable ships and trails
// ═══════════════════════════════════════════════════
const LS_SHOP = 'tunnelrunner_shop';
const LS_EQUIPPED = 'tunnelrunner_equipped';

const SHOP_ITEMS = [
  // Ships
  { id: 'ship_default', name: 'Crystal',     type: 'ship', cost: 0,   color: 0x00ccff, desc: 'Default ship' },
  { id: 'ship_fire',    name: 'Inferno',     type: 'ship', cost: 200, color: 0xff4422, desc: 'Blazing red fighter' },
  { id: 'ship_toxic',   name: 'Venom',       type: 'ship', cost: 300, color: 0x44ff00, desc: 'Toxic green racer' },
  { id: 'ship_gold',    name: 'Gilded',      type: 'ship', cost: 500, color: 0xffcc00, desc: 'Pure gold luxury' },
  { id: 'ship_void',    name: 'Void',        type: 'ship', cost: 800, color: 0xaa44ff, desc: 'Dark energy vessel' },
  // Trails
  { id: 'trail_default', name: 'Neon',       type: 'trail', cost: 0,   colors: [0x00ccff, 0xff00aa], desc: 'Default trail' },
  { id: 'trail_fire',    name: 'Fire',       type: 'trail', cost: 150, colors: [0xff4400, 0xffaa00], desc: 'Flame trails' },
  { id: 'trail_ice',     name: 'Frost',      type: 'trail', cost: 250, colors: [0x88ddff, 0xffffff], desc: 'Icy cold trails' },
  { id: 'trail_toxic',   name: 'Acid',       type: 'trail', cost: 300, colors: [0x44ff00, 0x00ff88], desc: 'Toxic acid trails' },
  { id: 'trail_royal',   name: 'Royal',      type: 'trail', cost: 500, colors: [0xaa44ff, 0xff44aa], desc: 'Purple majesty' },
  { id: 'trail_gold',    name: 'Golden',     type: 'trail', cost: 700, colors: [0xffcc00, 0xffee88], desc: 'Liquid gold' },
];

let ownedItems = JSON.parse(localStorage.getItem(LS_SHOP) || '["ship_default","trail_default"]');
let equipped = JSON.parse(localStorage.getItem(LS_EQUIPPED) || '{"ship":"ship_default","trail":"trail_default"}');

function saveShop() {
  localStorage.setItem(LS_SHOP, JSON.stringify(ownedItems));
  localStorage.setItem(LS_EQUIPPED, JSON.stringify(equipped));
}

function buyItem(id) {
  const item = SHOP_ITEMS.find(i => i.id === id);
  if (!item || ownedItems.includes(id)) return false;
  if (wallet < item.cost) return false;
  wallet -= item.cost;
  ownedItems.push(id);
  saveWallet();
  saveShop();
  return true;
}

function equipItem(id) {
  const item = SHOP_ITEMS.find(i => i.id === id);
  if (!item || !ownedItems.includes(id)) return false;
  equipped[item.type] = id;
  saveShop();
  applyEquipped();
  return true;
}

function applyEquipped() {
  // Apply ship color
  const shipItem = SHOP_ITEMS.find(i => i.id === equipped.ship);
  if (shipItem && shipGroup) {
    shipGroup.userData.bodyMat.color.set(shipItem.color);
    shipGroup.userData.edgeMat.color.set(shipItem.color);
  }
  // Apply trail colors
  const trailItem = SHOP_ITEMS.find(i => i.id === equipped.trail);
  if (trailItem) {
    trail1.mesh.material.uniforms.uColor.value.set(trailItem.colors[0]);
    trail2.mesh.material.uniforms.uColor.value.set(trailItem.colors[1]);
  }
}

// ── HUD ──
const hudEl = document.createElement('div');
hudEl.innerHTML = `
<style>
  #hud-bar { position:fixed; top:0; left:0; width:100%; display:flex; justify-content:space-between; align-items:center; padding:18px 32px; font-family:'Courier New',monospace; font-size:22px; color:#e8ffff; z-index:10; pointer-events:none;
    background:linear-gradient(180deg, rgba(5,10,30,0.55) 0%, transparent 100%); }
  #hud-bar > div { text-shadow: 0 0 12px rgba(0,255,255,0.7), 0 0 28px rgba(0,200,255,0.35); }
  #hud-color-badge { padding:5px 16px; border:2px solid; border-radius:6px; font-weight:bold; letter-spacing:3px;
    box-shadow:0 0 16px currentColor, inset 0 0 12px rgba(255,255,255,0.08); backdrop-filter:blur(4px); }
  #hud-lives { font-size:26px; letter-spacing:5px; filter:drop-shadow(0 0 8px #ff4488); }
  #hud-flash { display:none; position:fixed; top:0; left:0; width:100%; height:100%; z-index:12; pointer-events:none; background:radial-gradient(transparent 30%, rgba(255,0,80,0.55)); border:5px solid #ff2266; box-sizing:border-box; box-shadow:inset 0 0 80px rgba(255,0,80,0.4); }
  @keyframes hudFlash { 0%{opacity:1} 100%{opacity:0} }
  #hud-hit { display:none; position:fixed; z-index:15; pointer-events:none; font-family:'Courier New',monospace; font-size:36px; font-weight:bold; color:#ff0044; text-shadow:0 0 20px #ff0044, 0 0 40px rgba(255,0,68,0.5); }
  @keyframes hudHitPop { 0%{opacity:1;transform:translate(-50%,-50%) scale(1.5)} 50%{opacity:1;transform:translate(-50%,-80%) scale(1)} 100%{opacity:0;transform:translate(-50%,-120%) scale(0.8)} }
  #hud-menu { position:fixed; top:0; left:0; width:100%; height:100%; z-index:25; display:flex; align-items:center; justify-content:center; flex-direction:column; font-family:'Courier New',monospace; color:#fff; background:rgba(0,0,0,0.6); }
  #hud-menu .title { font-size:64px; font-weight:bold; letter-spacing:6px; color:#00ccff; text-shadow:0 0 40px #00ccff, 0 0 80px rgba(0,204,255,0.3); margin-bottom:8px; }
  #hud-menu .subtitle { font-size:16px; letter-spacing:8px; opacity:0.5; margin-bottom:48px; text-transform:uppercase; }
  #hud-menu .prompt { font-size:20px; animation:hudBlink 1.2s infinite; opacity:0.9; }
  #hud-menu .menu-keys { font-size:12px; letter-spacing:2px; margin-top:20px; opacity:0.4; }
  #hud-menu .highscore { font-size:16px; margin-top:32px; opacity:0.6; }
  #hud-overlay { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:20; align-items:center; justify-content:center; flex-direction:column; font-family:'Courier New',monospace; color:#fff; }
  #hud-overlay h1 { font-size:60px; margin:0 0 16px; color:#ff0044; text-shadow:0 0 40px #ff0044; }
  #hud-overlay .stats { font-size:20px; margin:6px 0; opacity:0.9; }
  #hud-overlay .stats span { color:#00ccff; }
  #hud-overlay .new-record { font-size:24px; color:#ffcc00; text-shadow:0 0 20px #ffcc00; margin:16px 0; animation:hudBlink 0.8s infinite; }
  #hud-overlay .highscore-line { font-size:16px; opacity:0.5; margin:8px 0; }
  #hud-overlay .blink { animation:hudBlink 1s infinite; font-size:18px; margin-top:28px; opacity:0.8; }
  @keyframes hudBlink { 0%,100%{opacity:0.8} 50%{opacity:0.2} }
  #hud-lvlup { display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); font-family:'Courier New',monospace; font-size:52px; font-weight:bold; z-index:15; pointer-events:none; text-shadow:0 0 40px currentColor; }
  @keyframes hudLvlPop { 0%{opacity:0;transform:translate(-50%,-50%) scale(0.5)} 15%{opacity:1;transform:translate(-50%,-50%) scale(1.3)} 30%{transform:translate(-50%,-50%) scale(1)} 100%{opacity:0;transform:translate(-50%,-50%) translateY(-60px)} }
  #hud-boost { display:none; position:fixed; top:0; left:0; width:100%; height:100%; z-index:11; pointer-events:none; }
  #hud-boost .speed-line { position:absolute; background:linear-gradient(to bottom, transparent, currentColor, transparent); opacity:0; filter:blur(0.5px); }
  @keyframes boostLine { 0%{opacity:0;transform:translateY(-10vh) scaleY(0.5)} 15%{opacity:0.95} 100%{opacity:0;transform:translateY(110vh) scaleY(2.4)} }
  #hud-boost-flash { display:none; position:fixed; top:0; left:0; width:100%; height:100%; z-index:11; pointer-events:none; background:radial-gradient(ellipse at center, rgba(180,255,255,0.75) 0%, rgba(255,100,220,0.2) 40%, transparent 70%); }
  @keyframes boostFlash { 0%{opacity:1} 100%{opacity:0} }
  #hud-finish { display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); font-family:'Courier New',monospace; z-index:16; pointer-events:none; text-align:center; }
  #hud-finish .finish-text { font-size:48px; font-weight:bold; letter-spacing:8px; text-shadow:0 0 30px currentColor, 0 0 70px currentColor, 0 0 120px currentColor; }
  #hud-finish .finish-checker { font-size:19px; letter-spacing:3px; opacity:0.75; margin-top:6px; }
  @keyframes finishPop { 0%{opacity:0;transform:translate(-50%,-50%) scale(2.2)} 18%{opacity:1;transform:translate(-50%,-50%) scale(1)} 80%{opacity:1;transform:translate(-50%,-50%) scale(1)} 100%{opacity:0;transform:translate(-50%,-50%) scale(0.75)} }
  #hud-lvlstart { display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); font-family:'Courier New',monospace; z-index:16; pointer-events:none; text-align:center; }
  #hud-lvlstart .start-text { font-size:62px; font-weight:bold; letter-spacing:5px; text-shadow:0 0 40px currentColor, 0 0 90px currentColor; }
  #hud-lvlstart .start-sub { font-size:22px; opacity:0.75; margin-top:10px; letter-spacing:4px; }
  @keyframes lvlStartIn { 0%{opacity:0;transform:translate(-50%,-50%) scale(0.25)} 28%{opacity:1;transform:translate(-50%,-50%) scale(1.15)} 48%{transform:translate(-50%,-50%) scale(1)} 100%{opacity:0;transform:translate(-50%,-50%) translateY(-48px)} }
  #hud-finish-lines { display:none; position:fixed; top:0; left:0; width:100%; height:100%; z-index:11; pointer-events:none; overflow:hidden; }
  #hud-finish-lines .checker-bar { position:absolute; height:100%; background:repeating-linear-gradient(0deg, transparent 0px, transparent 20px, currentColor 20px, currentColor 40px); opacity:0; }
  @keyframes checkerSlide { 0%{opacity:0;transform:translateY(-100%)} 15%{opacity:0.7} 85%{opacity:0.7} 100%{opacity:0;transform:translateY(100%)} }
  #hud-coin-popup { display:none; position:fixed; z-index:15; pointer-events:none; font-family:'Courier New',monospace; font-size:28px; font-weight:bold; color:#ffcc00; text-shadow:0 0 12px rgba(255,204,0,0.5); }
  @keyframes coinPop { 0%{opacity:1;transform:translate(-50%,-50%) scale(1.3)} 50%{opacity:1;transform:translate(-50%,-80%) scale(1)} 100%{opacity:0;transform:translate(-50%,-120%) scale(0.8)} }
  #hud-streak { position:fixed; bottom:60px; left:50%; transform:translateX(-50%); font-family:'Courier New',monospace; font-size:32px; font-weight:bold; z-index:10; pointer-events:none; opacity:0; transition:opacity 0.3s; color:#fff; text-shadow:0 0 15px currentColor; }
  #hud-streak.active { opacity:1; }
  #hud-near-miss { display:none; position:fixed; z-index:15; pointer-events:none; font-family:'Courier New',monospace; font-size:22px; font-weight:bold; color:#00ffaa; text-shadow:0 0 10px rgba(0,255,170,0.5); }
  @keyframes nearMissPop { 0%{opacity:1;transform:translate(-50%,-50%) scale(1.5)} 40%{opacity:1;transform:translate(-50%,-70%) scale(1)} 100%{opacity:0;transform:translate(-50%,-100%) scale(0.8)} }
  #hud-mute { display:none; position:fixed; bottom:28px; left:50%; transform:translateX(-50%); z-index:30; pointer-events:none; font-family:'Courier New',monospace; font-size:16px; letter-spacing:2px; color:#fff; text-shadow:0 0 10px rgba(255,255,255,0.4); }
  @keyframes muteToast { 0%{opacity:0} 15%{opacity:0.9} 75%{opacity:0.9} 100%{opacity:0} }
  #hud-mission-complete { display:none; position:fixed; bottom:120px; left:50%; transform:translateX(-50%); z-index:20; pointer-events:none; font-family:'Courier New',monospace; text-align:center; background:rgba(0,0,0,0.7); border:1px solid #ffcc00; border-radius:8px; padding:12px 24px; }
  .mc-label { font-size:12px; letter-spacing:3px; color:#ffcc00; opacity:0.8; }
  .mc-text { font-size:18px; color:#fff; margin:4px 0; }
  .mc-reward { font-size:22px; font-weight:bold; color:#ffcc00; text-shadow:0 0 10px rgba(255,204,0,0.5); }
  @keyframes missionPop { 0%{opacity:0;transform:translateX(-50%) translateY(20px)} 10%{opacity:1;transform:translateX(-50%) translateY(0)} 80%{opacity:1;transform:translateX(-50%) translateY(0)} 100%{opacity:0;transform:translateX(-50%) translateY(-20px)} }
  #hud-wallet { position:fixed; top:50px; right:28px; font-family:'Courier New',monospace; font-size:16px; color:#ffcc00; z-index:10; pointer-events:none; text-shadow:0 0 8px rgba(255,204,0,0.3); }
  #hud-missions { position:fixed; top:50px; left:28px; font-family:'Courier New',monospace; font-size:13px; color:#aaa; z-index:10; pointer-events:none; line-height:1.8; }
  .mission-row { display:flex; align-items:center; gap:8px; }
  .mission-bar { width:60px; height:6px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden; }
  .mission-fill { height:100%; background:#ffcc00; border-radius:3px; transition:width 0.3s; }
  .mission-done { color:#ffcc00; }
  #hud-shop { display:none; position:fixed; top:0; left:0; width:100%; height:100%; z-index:30; background:rgba(0,0,0,0.92); font-family:'Courier New',monospace; color:#fff; overflow-y:auto; }
  .shop-inner { max-width:600px; margin:40px auto; padding:0 20px; }
  .shop-title { font-size:36px; text-align:center; color:#ffcc00; margin-bottom:8px; letter-spacing:4px; }
  .shop-wallet { text-align:center; font-size:18px; color:#ffcc00; margin-bottom:24px; }
  .shop-section { font-size:14px; letter-spacing:3px; color:#888; margin:20px 0 10px; border-bottom:1px solid #333; padding-bottom:4px; }
  .shop-item { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; margin:4px 0; border:1px solid #333; border-radius:6px; cursor:pointer; transition:border-color 0.2s; }
  .shop-item:hover { border-color:#888; }
  .shop-item.equipped { border-color:#ffcc00; }
  .shop-item.locked { opacity:0.5; }
  .shop-item-left { display:flex; align-items:center; gap:12px; }
  .shop-swatch { width:20px; height:20px; border-radius:50%; border:2px solid #555; }
  .shop-item-name { font-size:16px; font-weight:bold; }
  .shop-item-desc { font-size:12px; color:#888; }
  .shop-item-price { font-size:14px; color:#ffcc00; font-weight:bold; }
  .shop-item-owned { font-size:12px; color:#00ff88; }
  .shop-item-equip { font-size:12px; color:#ffcc00; }
  .shop-close { position:fixed; top:20px; right:30px; font-size:28px; cursor:pointer; color:#888; z-index:31; }
  .shop-close:hover { color:#fff; }
  .menu-opts { margin-top:18px; display:flex; flex-direction:column; align-items:center; gap:10px; pointer-events:auto; }
  .menu-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:center; }
  .menu-seed-input {
    width:110px; padding:6px 10px; font-family:'Courier New',monospace; font-size:14px; letter-spacing:2px;
    text-align:center; color:#88ccff; background:rgba(0,0,0,0.5); border:1px solid #446688; border-radius:4px;
    text-transform:uppercase;
  }
  .menu-seed-input:focus { outline:none; border-color:#88ccff; }
  .menu-toggle {
    cursor:pointer; font-size:12px; padding:6px 12px; border:1px solid #556677; color:#aaccdd;
    background:transparent; font-family:'Courier New',monospace; letter-spacing:1px; border-radius:4px;
  }
  .menu-toggle:hover { border-color:#88ccff; color:#fff; }
  .menu-toggle.on { border-color:#88ffaa; color:#88ffaa; background:rgba(0,255,136,0.08); }
  #hud-seed {
    position:fixed; top:14px; left:50%; transform:translateX(-50%); z-index:16;
    font-family:'Courier New',monospace; font-size:12px; letter-spacing:2px;
    color:#88ccff; opacity:0.85; pointer-events:none; text-shadow:0 0 8px rgba(0,0,0,0.8);
    display:none;
  }
  .menu-shop-btn { cursor:pointer; font-size:16px; margin-top:16px; padding:8px 24px; border:1px solid #ffcc00; color:#ffcc00; background:transparent; font-family:'Courier New',monospace; letter-spacing:2px; border-radius:4px; transition:background 0.2s; }
  .menu-shop-btn:hover { background:rgba(255,204,0,0.15); }
  #hud-float { display:none; position:fixed; top:38%; left:50%; transform:translate(-50%,-50%);
    font-family:'Courier New',monospace; font-size:42px; font-weight:bold; letter-spacing:4px;
    text-align:center; z-index:22; pointer-events:none; text-shadow:0 0 24px currentColor; }
  @keyframes floatPop { 0%{opacity:0;transform:translate(-50%,-40%) scale(0.6)}
    20%{opacity:1;transform:translate(-50%,-50%) scale(1.15)}
    100%{opacity:0;transform:translate(-50%,-70%) scale(1)} }
  #hud-nm-flash { display:none; position:fixed; inset:0; pointer-events:none; z-index:14;
    background:radial-gradient(ellipse at center, transparent 40%, rgba(255,255,255,0.35) 100%); }
</style>
<div id="hud-bar">
  <div id="hud-score">0</div>
  <div id="hud-lives"></div>
  <div id="hud-level">LEVEL 1</div>
  <div id="hud-color-badge">CYAN</div>
</div>
<div id="hud-flash"></div>
<div id="hud-nm-flash"></div>
<div id="hud-float"></div>
<div id="hud-hit">-1</div>
<div id="hud-coin-popup">+100</div>
<div id="hud-streak"></div>
<div id="hud-near-miss">CLOSE!</div>
<div id="hud-mute">🔊 SOUND ON</div>
<div id="hud-mission-complete"><div class="mc-label">MISSION COMPLETE</div><div class="mc-text"></div><div class="mc-reward"></div></div>
<div id="hud-wallet"></div>
<div id="hud-missions"></div>
<div id="hud-seed"></div>
<div id="hud-menu">
  <div class="title">TUNNEL RUNNER</div>
  <div class="subtitle">Dodge the light</div>
  <div class="prompt">PRESS SPACE TO START</div>
  <div class="menu-keys">A / D — STEER &nbsp;·&nbsp; P — PAUSE &nbsp;·&nbsp; M — MUTE</div>
  <div class="highscore" id="menu-highscore"></div>
  <div class="menu-opts">
    <div class="menu-row">
      <span style="color:#668899;font-size:12px;letter-spacing:1px">SEED</span>
      <input id="menu-seed-input" class="menu-seed-input" maxlength="12" spellcheck="false" autocomplete="off" />
      <button type="button" class="menu-toggle" id="menu-seed-rand">RAND</button>
    </div>
    <div class="menu-row">
      <button type="button" class="menu-toggle" id="menu-practice-btn">PRACTICE: OFF</button>
      <button type="button" class="menu-toggle" id="menu-aim-btn">AIM ASSIST: OFF</button>
      <button type="button" class="menu-toggle" id="menu-sfx-btn">SFX: ON</button>
    </div>
  </div>
  <button class="menu-shop-btn" id="menu-shop-btn">SHOP</button>
</div>
<div id="hud-overlay">
  <h1>GAME OVER</h1>
  <p class="stats">Score: <span id="hud-final-score">0</span></p>
  <p class="stats">Level: <span id="hud-final-level">1</span></p>
  <p class="stats">Coins: <span id="hud-final-coins">0</span></p>
  <div id="hud-new-record" class="new-record" style="display:none">NEW HIGH SCORE!</div>
  <div id="hud-old-record" class="highscore-line"></div>
  <p class="blink">PRESS SPACE TO RESTART</p>
  <button class="menu-shop-btn" id="gameover-shop-btn" style="margin-top:12px">SHOP</button>
</div>
<div id="hud-shop">
  <div class="shop-close" id="shop-close">&times;</div>
  <div class="shop-inner">
    <div class="shop-title">SHOP</div>
    <div class="shop-wallet" id="shop-wallet"></div>
    <div id="shop-items"></div>
  </div>
</div>
<div id="hud-lvlup"></div>
<div id="hud-boost"></div>
<div id="hud-boost-flash"></div>
<div id="hud-finish"><div class="finish-text">FINISH</div><div class="finish-checker">&#9632;&#9633;&#9632;&#9633;&#9632;&#9633;&#9632;&#9633;&#9632;&#9633;&#9632;&#9633;&#9632;&#9633;&#9632;&#9633;</div></div>
<div id="hud-finish-lines"></div>
<div id="hud-lvlstart"><div class="start-text"></div><div class="start-sub">GET READY</div></div>
`;
document.body.appendChild(hudEl);

function updateHUD() {
  document.getElementById('hud-score').textContent = score;
  document.getElementById('hud-level').textContent = `LEVEL ${level}`;
  document.getElementById('hud-lives').textContent = '\u2764'.repeat(lives);
  const badge = document.getElementById('hud-color-badge');
  const gc = GAME_COLORS[shipColorIdx];
  badge.textContent = gc.name;
  badge.style.color = gc.css;
  badge.style.borderColor = gc.css;

  // Streak display
  const streakEl = document.getElementById('hud-streak');
  if (streak >= 3) {
    streakEl.textContent = `${streak} STREAK  x${multiplier}`;
    streakEl.style.color = multiplier >= 5 ? '#ffcc00' : multiplier >= 3 ? '#00ffaa' : '#fff';
    streakEl.classList.add('active');
  } else {
    streakEl.classList.remove('active');
  }

  // Wallet
  document.getElementById('hud-wallet').textContent = `\u2B50 ${wallet}`;

  // Mission progress
  updateMissionHUD();
}

function updateMissionHUD() {
  const el = document.getElementById('hud-missions');
  if (!activeMissions || activeMissions.length === 0) {
    el.innerHTML = '';
    return;
  }
  let html = '';
  for (const m of activeMissions) {
    const def = getMissionDef(m.id);
    if (!def) continue;
    const pct = Math.min(100, (m.progress / def.target) * 100);
    html += `<div class="mission-row">
      <span>${def.desc}</span>
      <div class="mission-bar"><div class="mission-fill" style="width:${pct}%"></div></div>
      <span style="color:#ffcc00;font-size:11px">\u2B50${def.reward}</span>
    </div>`;
  }
  el.innerHTML = html;
}

function renderShop() {
  const container = document.getElementById('shop-items');
  document.getElementById('shop-wallet').textContent = `\u2B50 ${wallet}`;

  const ships = SHOP_ITEMS.filter(i => i.type === 'ship');
  const trails = SHOP_ITEMS.filter(i => i.type === 'trail');

  let html = '<div class="shop-section">SHIPS</div>';
  for (const item of ships) {
    const owned = ownedItems.includes(item.id);
    const isEquipped = equipped.ship === item.id;
    const canBuy = wallet >= item.cost;
    const cls = isEquipped ? 'shop-item equipped' : owned ? 'shop-item' : canBuy ? 'shop-item' : 'shop-item locked';
    const colorHex = '#' + item.color.toString(16).padStart(6, '0');

    html += `<div class="${cls}" data-id="${item.id}">
      <div class="shop-item-left">
        <div class="shop-swatch" style="background:${colorHex}"></div>
        <div>
          <div class="shop-item-name">${item.name}</div>
          <div class="shop-item-desc">${item.desc}</div>
        </div>
      </div>
      <div>
        ${isEquipped ? '<span class="shop-item-equip">EQUIPPED</span>' :
          owned ? '<span class="shop-item-owned">OWNED</span>' :
          `<span class="shop-item-price">\u2B50 ${item.cost}</span>`}
      </div>
    </div>`;
  }

  html += '<div class="shop-section">TRAILS</div>';
  for (const item of trails) {
    const owned = ownedItems.includes(item.id);
    const isEquipped = equipped.trail === item.id;
    const canBuy = wallet >= item.cost;
    const cls = isEquipped ? 'shop-item equipped' : owned ? 'shop-item' : canBuy ? 'shop-item' : 'shop-item locked';
    const c1 = '#' + item.colors[0].toString(16).padStart(6, '0');
    const c2 = '#' + item.colors[1].toString(16).padStart(6, '0');

    html += `<div class="${cls}" data-id="${item.id}">
      <div class="shop-item-left">
        <div class="shop-swatch" style="background:linear-gradient(135deg,${c1},${c2})"></div>
        <div>
          <div class="shop-item-name">${item.name}</div>
          <div class="shop-item-desc">${item.desc}</div>
        </div>
      </div>
      <div>
        ${isEquipped ? '<span class="shop-item-equip">EQUIPPED</span>' :
          owned ? '<span class="shop-item-owned">OWNED</span>' :
          `<span class="shop-item-price">\u2B50 ${item.cost}</span>`}
      </div>
    </div>`;
  }

  container.innerHTML = html;

  // Click handlers
  container.querySelectorAll('.shop-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (ownedItems.includes(id)) {
        equipItem(id);
        audio.play('ui_click');
      } else {
        if (buyItem(id)) {
          equipItem(id);
          audio.play('ui_buy');
        } else {
          // Can't afford it — flat blip rather than the reward chime.
          audio.play('ui_click', { rate: 0.7, gain: 0.7 });
        }
      }
      renderShop();
    });
  });
}

function openShop() {
  document.getElementById('hud-shop').style.display = 'block';
  renderShop();
}

function closeShop() {
  document.getElementById('hud-shop').style.display = 'none';
}

/** Center-screen float text (PERFECT / CLOSE / etc.) — P1 */
function showFloatText(label, color, bonus) {
  const el = document.getElementById('hud-float');
  if (!el) return;
  el.innerHTML = bonus != null
    ? `<span style="color:${color}">${label}</span><br><span style="font-size:18px;opacity:0.9">+${bonus}</span>`
    : `<span style="color:${color}">${label}</span>`;
  el.style.display = 'block';
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'floatPop 0.9s ease-out forwards';
  clearTimeout(showFloatText._t);
  showFloatText._t = setTimeout(() => { el.style.display = 'none'; }, 950);
}

function dodgedObstacle(wasClose) {
  streak++;
  multiplier = 1 + Math.floor(streak / 5);
  if (streak > runMaxStreak) runMaxStreak = streak;

  if (wasClose && shipGroup) {
    SFX.nearMiss();
    runNearMisses++;
    nearMissFlash = 0.22;
    camShake = Math.min(0.5, Math.max(camShake, 0.22) + 0.12);
    const bonus = 75 * multiplier; // P1: stronger near-miss reward
    score += bonus;
    // Whoosh rises with the streak so a long clean run keeps escalating.
    audio.play('near_miss', {
      rate: 0.95 + Math.min(streak, 30) * 0.012,
      gain: 0.9,
    });
    const screenPos = shipGroup.position.clone().project(camera);
    const el = document.getElementById('hud-near-miss');
    el.textContent = `CLOSE! +${bonus}`;
    el.style.left = ((screenPos.x * 0.5 + 0.5) * innerWidth) + 'px';
    el.style.top = ((1 - (screenPos.y * 0.5 + 0.5)) * innerHeight - 30) + 'px';
    el.style.display = 'block';
    el.style.animation = 'none';
    el.offsetHeight;
    el.style.animation = 'nearMissPop 0.5s forwards';
    setTimeout(() => { el.style.display = 'none'; }, 500);
  }
  checkMissions();
  updateHUD();
}

function hitObstacle() {
  streak = 0;
  multiplier = 1;
  runDamageTaken = true;
  levelDamageTaken = true;
  lives--;

  audio.play('impact');
  audio.duck(0.25, 0.2, 0.6);

  if (lives <= 0) {
    showGameOver();
  } else {
    // Last life — warning pulse under the impact tail.
    if (lives === 1) audio.play('low_life', { delay: 0.35 });

    // Red vignette flash
    const flash = document.getElementById('hud-flash');
    flash.style.display = 'block';
    flash.style.animation = 'none';
    flash.offsetHeight;
    flash.style.animation = 'hudFlash 0.6s forwards';
    setTimeout(() => { flash.style.display = 'none'; }, 600);

    // "-1" popup near the ship
    if (shipGroup) {
      const screenPos = shipGroup.position.clone().project(camera);
      const hit = document.getElementById('hud-hit');
      hit.style.left = ((screenPos.x * 0.5 + 0.5) * innerWidth) + 'px';
      hit.style.top = ((1 - (screenPos.y * 0.5 + 0.5)) * innerHeight) + 'px';
      hit.style.display = 'block';
      hit.style.animation = 'none';
      hit.offsetHeight;
      hit.style.animation = 'hudHitPop 0.8s forwards';
      setTimeout(() => { hit.style.display = 'none'; }, 800);
    }

    spawnSafe = 1.5;
    updateHUD();
  }
}

function showGameOver() {
  gameState = 'dead';
  audio.stopAllLoops(0.25);
  audio.play('game_over', { delay: 0.15 });
  checkMissions();
  maybeSaveGhost(score);
  const seedHud = document.getElementById('hud-seed');
  if (seedHud) seedHud.style.display = 'none';
  const isNewRecord = saveHighScore();
  document.getElementById('hud-final-score').textContent = score;
  document.getElementById('hud-final-level').textContent = level;
  document.getElementById('hud-final-coins').textContent = sessionCoins;
  document.getElementById('hud-new-record').style.display = isNewRecord ? 'block' : 'none';
  document.getElementById('hud-old-record').textContent = isNewRecord ? '' : `Best: ${highScore}`;
  document.getElementById('hud-overlay').style.display = 'flex';
}

function showLevelUp() {
  const gc = GAME_COLORS[shipColorIdx];

  // Perfect level bonus (no hits this level) — P1
  if (!levelDamageTaken) {
    perfectLevelsThisRun++;
    const perfectBonus = 500 + level * 100;
    score += perfectBonus;
    wallet += 15;
    saveWallet();
    showFloatText('PERFECT!', '#ffdd66', perfectBonus);
    checkMissions();
  }
  levelDamageTaken = false; // next level starts clean

  // ── Straight into BOOST ZONE ──
  transitionPhase = 'boost';
  transitionTimer = BOOST_DURATION;
  SFX.levelUp();

  audio.play('level_up');
  audio.play('boost_start', { delay: 0.25 });
  audio.duck(0.45, 0.3, 0.8);
  coinChain = 0; // fresh riff for the coin frenzy

  // White flash
  const flash = document.getElementById('hud-boost-flash');
  flash.style.display = 'block';
  flash.style.animation = 'none';
  flash.offsetHeight;
  flash.style.animation = 'boostFlash 0.8s forwards';
  setTimeout(() => { flash.style.display = 'none'; }, 800);

  // "LEVEL X" banner during boost
  const startEl = document.getElementById('hud-lvlstart');
  startEl.querySelector('.start-text').textContent = `LEVEL ${level}`;
  startEl.style.color = gc.css;
  startEl.style.display = 'block';
  startEl.style.animation = 'none';
  startEl.offsetHeight;
  startEl.style.animation = `lvlStartIn 2.0s forwards`;
  setTimeout(() => { startEl.style.display = 'none'; }, 2000);

  // Spawn coin frenzy
  spawnBoostCoins((progress + 0.02) % 1.0);

  // Speed lines overlay
  const boostEl = document.getElementById('hud-boost');
  boostEl.innerHTML = '';
  boostEl.style.display = 'block';
  const lineCount = 30;
  for (let i = 0; i < lineCount; i++) {
    const line = document.createElement('div');
    line.className = 'speed-line';
    line.style.left = (Math.random() * 100) + '%';
    line.style.width = (1 + Math.random() * 3) + 'px';
    line.style.height = (15 + Math.random() * 30) + 'vh';
    line.style.color = gc.css;
    line.style.animation = `boostLine ${0.4 + Math.random() * 0.6}s linear ${Math.random() * BOOST_DURATION}s infinite`;
    boostEl.appendChild(line);
  }
  setTimeout(() => { boostEl.style.display = 'none'; }, BOOST_DURATION * 1000);

  // ── End of boost → LEVEL START ──
  setTimeout(() => {
    if (transitionPhase !== 'boost') return;
    transitionPhase = 'start';
    transitionTimer = START_DURATION;

    audio.play('boost_end');

    // Place start-portal ahead of ship
    const startPortalT = (progress + 0.04) % 1.0;
    placePortal(startPortalT, gc.hex, { exit: false });

    setTimeout(() => {
      transitionPhase = 'none';
      transitionTimer = 0;
      spawnSafe = 1.5;
      hidePortal();
    }, START_DURATION * 1000);
  }, BOOST_DURATION * 1000);
}

let spawnSafe = 0; // grace period after restart (seconds)

// ── Level transition state ──
// Phases: 'none' → 'finish' (1.5s) → 'boost' (2.5s, no obstacles) → 'start' (1.5s) → 'none'
let transitionPhase = 'none';
let transitionTimer = 0;
const BOOST_DURATION = 5.0;
const START_DURATION = 1.0;
let boostSpeedMul = 1.0;
let boostFovTarget = 85;
let boostBloomTarget = 0.42;
let targetHue = 0;
let hueDrift = 0; // continuous rainbow sweep on top of per-level base hue

// ── Level portal (3D ring visible before level transition) ──
let portalMesh = null;
let portalT = -1;       // t-position on curve (-1 = inactive)
let portalPlaced = false;
let portalOpenDist = 0.09; // t-distance at which a sealed exit portal starts opening

function createPortal() {
  // Exit reads as an APERTURE: shutter contracts → soft sky revealed behind.
  const mesh = new THREE.Group();
  mesh.visible = false;
  scene.add(mesh);
  const R = TUBE_R; // ~14

  // Soft "outside" sky — sits behind the shutter (local +Z = past the mouth)
  // Mid luminance so bloom doesn't blow it to pure white
  const skyGeo = new THREE.CircleGeometry(R + 2, 48);
  const skyMat = new THREE.MeshBasicMaterial({
    color: 0x5aa0d8,
    fog: false,
    transparent: true,
    opacity: 0.0, // only on exit
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.position.z = 0.55;
  mesh.add(sky);

  // Shutter disc — covers sky, scales DOWN to open the mouth
  const discGeo = new THREE.CircleGeometry(R - 0.3, 48);
  const discMat = new THREE.MeshBasicMaterial({
    color: 0x05070c,
    transparent: true,
    opacity: 0.92,
    fog: false,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.position.z = 0.08;
  mesh.add(disc);

  // Outer neon rim (mouth lip)
  const ringGeo = new THREE.TorusGeometry(R - 0.8, 0.75, 16, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    fog: false,
    side: THREE.DoubleSide,
  });
  const outerRing = new THREE.Mesh(ringGeo, ringMat);
  outerRing.position.z = 0.02;
  mesh.add(outerRing);

  // Soft color wash around the lip (no additive)
  const glowGeo = new THREE.RingGeometry(R - 1.5, R + 4.5, 48);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0x3a7ab0,
    transparent: true,
    opacity: 0.0,
    fog: false,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.z = -0.2;
  mesh.add(glow);

  // Spinning inner accent ring (rides the shutter edge)
  const innerRingGeo = new THREE.TorusGeometry(R - 3.2, 0.28, 12, 48);
  const innerRingMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
    fog: false,
    side: THREE.DoubleSide,
  });
  const innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
  innerRing.position.z = 0.12;
  innerRing.userData.spinInner = true;
  mesh.add(innerRing);

  // Funnel ribs: walls peeling outward toward the mouth (approach = local -Z)
  const funnelGroup = new THREE.Group();
  const funnelLen = 30;
  const ringCount = 12;
  const funnelMats = [];
  for (let i = 0; i < ringCount; i++) {
    const u = i / (ringCount - 1); // 0 far → 1 at mouth
    const z = -funnelLen * (1 - u);
    const rad = (R - 0.4) + Math.pow(u, 1.6) * 32;
    const tGeo = new THREE.TorusGeometry(rad, 0.1 + u * 0.32, 8, 56);
    const tMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: false,
      transparent: true,
      opacity: 0.12 + u * 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    funnelMats.push(tMat);
    const tr = new THREE.Mesh(tGeo, tMat);
    tr.position.z = z;
    funnelGroup.add(tr);
  }
  const ribMats = [];
  for (let k = 0; k < 12; k++) {
    const ang = (k / 12) * Math.PI * 2;
    const pts = [];
    for (let i = 0; i < ringCount; i++) {
      const u = i / (ringCount - 1);
      const z = -funnelLen * (1 - u);
      const rad = (R - 0.4) + Math.pow(u, 1.6) * 32;
      pts.push(new THREE.Vector3(Math.cos(ang) * rad, Math.sin(ang) * rad, z));
    }
    const ribGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const ribMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      fog: false,
    });
    ribMats.push(ribMat);
    funnelGroup.add(new THREE.Line(ribGeo, ribMat));
  }
  funnelGroup.visible = false;
  mesh.add(funnelGroup);

  // Gentle rim light (low intensity — bloom-safe)
  const pLight = new THREE.PointLight(0x88bbff, 0, R * 3, 1.8);
  pLight.position.set(0, 0, 2);
  mesh.add(pLight);

  mesh.userData.ringMat = ringMat;
  mesh.userData.outerRing = outerRing;
  mesh.userData.disc = disc;
  mesh.userData.discMat = discMat;
  mesh.userData.sky = sky;
  mesh.userData.skyMat = skyMat;
  mesh.userData.glowMat = glowMat;
  mesh.userData.innerRing = innerRing;
  mesh.userData.innerRingMat = innerRingMat;
  mesh.userData.funnelGroup = funnelGroup;
  mesh.userData.funnelMats = funnelMats;
  mesh.userData.ribMats = ribMats;
  mesh.userData.pLight = pLight;
  mesh.userData.isExit = false;
  return mesh;
}

function placePortal(tPos, color, opts = {}) {
  if (!portalMesh) portalMesh = createPortal();
  portalT = ((tPos % 1) + 1) % 1;
  portalPlaced = true;
  portalMesh.userData.isExit = !!opts.exit;

  const pos = curve.getPointAt(portalT);
  const tan = curve.getTangentAt(portalT).normalize();
  portalMesh.position.copy(pos);
  // Object3D.lookAt aims local -Z at the target. Funnel is built along -Z,
  // so aim -Z toward the approaching player (opposite travel dir).
  portalMesh.lookAt(pos.clone().sub(tan));

  portalMesh.userData.ringMat.color.set(color);
  portalMesh.userData.innerRingMat.color.set(color);
  portalMesh.visible = true;
  portalMesh.scale.setScalar(1);

  // P3: aperture exit — shutter starts FULLY sealed; opens only when the
  // ship comes within portalOpenDist (see animate loop).
  if (opts.exit) {
    if (portalMesh.userData.disc) portalMesh.userData.disc.scale.setScalar(1.0);
    if (portalMesh.userData.discMat) {
      portalMesh.userData.discMat.color.set(0x05070c);
      portalMesh.userData.discMat.opacity = 0.92;
    }
    if (portalMesh.userData.skyMat) {
      portalMesh.userData.skyMat.color.set(0x5aa0d8);
      portalMesh.userData.skyMat.opacity = 0.0; // sealed — no sky until close
    }
    if (portalMesh.userData.glowMat) {
      portalMesh.userData.glowMat.color.set(color);
      portalMesh.userData.glowMat.opacity = 0.0;
    }
    if (portalMesh.userData.funnelGroup) {
      portalMesh.userData.funnelGroup.visible = true;
      portalMesh.userData.funnelGroup.scale.set(1, 1, 1);
      for (const m of portalMesh.userData.funnelMats || []) m.color.set(color);
      for (const m of portalMesh.userData.ribMats || []) m.color.set(color);
    }
    if (portalMesh.userData.pLight) {
      portalMesh.userData.pLight.color.set(color);
      portalMesh.userData.pLight.intensity = 0;
    }
    if (portalMesh.userData.innerRing) portalMesh.userData.innerRing.scale.setScalar(1);
    // Track portal position for the shader but keep the mouth sealed
    tubeMat.uniforms.uPortalU.value = portalT;
    tubeMat.uniforms.uOpen.value = 0.0;
    clearObstaclesBeyondPortal(portalT);
  } else {
    // Entry portal — dark seal, no funnel / sky
    if (portalMesh.userData.disc) portalMesh.userData.disc.scale.setScalar(1);
    if (portalMesh.userData.discMat) {
      portalMesh.userData.discMat.color.set(0x000000);
      portalMesh.userData.discMat.opacity = 0.9;
    }
    if (portalMesh.userData.skyMat) portalMesh.userData.skyMat.opacity = 0.0;
    if (portalMesh.userData.glowMat) portalMesh.userData.glowMat.opacity = 0.0;
    if (portalMesh.userData.funnelGroup) portalMesh.userData.funnelGroup.visible = false;
    if (portalMesh.userData.pLight) portalMesh.userData.pLight.intensity = 0;
    tubeMat.uniforms.uPortalU.value = -1.0;
    tubeMat.uniforms.uOpen.value = 0.0;
  }
}

/** Remove obstacles on/after the portal so the finish is a clean open stretch. */
function clearObstaclesBeyondPortal(pT) {
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    let forward = o.t - pT;
    if (forward < -0.5) forward += 1;
    if (forward > 0.5) forward -= 1;
    if (forward > -0.03) {
      if (o.mesh) scene.remove(o.mesh);
      obstacles.splice(i, 1);
    }
  }
}

function hidePortal() {
  if (portalMesh) {
    portalMesh.visible = false;
    portalMesh.userData.isExit = false;
    if (portalMesh.userData.funnelGroup) {
      portalMesh.userData.funnelGroup.visible = false;
      portalMesh.userData.funnelGroup.scale.set(1, 1, 1);
    }
    if (portalMesh.userData.disc) portalMesh.userData.disc.scale.setScalar(1);
    if (portalMesh.userData.innerRing) portalMesh.userData.innerRing.scale.setScalar(1);
    if (portalMesh.userData.outerRing) portalMesh.userData.outerRing.scale.setScalar(1);
    if (portalMesh.userData.skyMat) portalMesh.userData.skyMat.opacity = 0;
    if (portalMesh.userData.pLight) portalMesh.userData.pLight.intensity = 0;
    if (portalMesh.userData.glowMat) portalMesh.userData.glowMat.opacity = 0;
  }
  portalT = -1;
  portalPlaced = false;
  portalOpeningFired = false;
  tubeMat.uniforms.uPortalU.value = -1.0;
  tubeMat.uniforms.uOpen.value = 0.0;
  if (transitionPhase === 'none') {
    boostBloomTarget = 0.42;
    boostFovTarget = 85;
  }
}

// ── Portal celebration FX — color & effect cavalcade ──
// Confetti particles + shockwave rings rushing at the player.
const portalFx = [];
const _fxOct = new THREE.OctahedronGeometry(0.4);
const _fxBox = new THREE.BoxGeometry(0.32, 0.32, 0.32);
const _fxRingGeo = new THREE.TorusGeometry(11, 0.55, 8, 48);
let portalOpeningFired = false;

function spawnPortalParticle(pos, vel, hue, life = 1.4) {
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 1, fog: false,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  mat.color.setHSL(((hue % 1) + 1) % 1, 1.0, 0.62);
  const m = new THREE.Mesh(Math.random() > 0.5 ? _fxOct : _fxBox, mat);
  m.position.copy(pos);
  m.scale.setScalar(0.7 + Math.random() * 1.1);
  scene.add(m);
  portalFx.push({
    mesh: m, vel, life, maxLife: life,
    spin: new THREE.Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18),
  });
}

/** Burst fired the moment the sealed portal starts opening. */
function portalOpeningBurst() {
  if (!portalMesh || portalT < 0) return;
  const pos = portalMesh.position.clone();
  const tan = curve.getTangentAt(portalT).normalize();
  for (let i = 0; i < 110; i++) {
    const v = tan.clone().multiplyScalar(-(14 + Math.random() * 32)); // rush at player
    v.x += (Math.random() - 0.5) * 30;
    v.y += (Math.random() - 0.5) * 30;
    v.z += (Math.random() - 0.5) * 30;
    spawnPortalParticle(pos, v, i / 110, 1.2 + Math.random() * 1.0);
  }
  boostBloomTarget = Math.max(boostBloomTarget, 0.7);
  camShake = Math.max(camShake, 0.55);
}

/** Big cavalcade the instant the ship passes through. */
function portalPassExplosion() {
  if (!portalMesh || portalT < 0) return;
  const pos = portalMesh.position.clone();
  const tan = curve.getTangentAt(portalT).normalize();
  for (let i = 0; i < 240; i++) {
    const v = tan.clone().multiplyScalar(-(22 + Math.random() * 55));
    v.x += (Math.random() - 0.5) * 48;
    v.y += (Math.random() - 0.5) * 48;
    v.z += (Math.random() - 0.5) * 48;
    spawnPortalParticle(pos, v, Math.random(), 1.6 + Math.random() * 1.5);
  }
  // Rainbow shockwave rings racing at the player
  for (let k = 0; k < 5; k++) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 1.0, fog: false,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mat.color.setHSL(k / 5, 1, 0.65);
    const ring = new THREE.Mesh(_fxRingGeo, mat);
    ring.position.copy(pos);
    ring.lookAt(pos.clone().sub(tan));
    scene.add(ring);
    portalFx.push({
      mesh: ring, shock: true,
      vel: tan.clone().multiplyScalar(-(26 + k * 16)),
      life: 1.0 + k * 0.18, maxLife: 1.0 + k * 0.18,
    });
  }
  // Extra flat shock rings via shared system
  for (let k = 0; k < 3; k++) {
    const c = new THREE.Color().setHSL(k / 3, 1, 0.7);
    spawnShockwave(pos, tan, c, { inner: 0.5 + k * 0.4, outer: 2.5 + k, maxAge: 0.6 + k * 0.15, grow: 20 + k * 6, opacity: 0.9 });
  }
  camShake = Math.min(1.4, camShake + 0.7);
  nearMissFlash = Math.max(nearMissFlash, 0.45);
  boostBloomTarget = Math.max(boostBloomTarget, 1.05);
  rgbPass.uniforms['amount'].value = Math.max(rgbPass.uniforms['amount'].value, 0.018);
}

function updatePortalFx(dt) {
  for (let i = portalFx.length - 1; i >= 0; i--) {
    const p = portalFx[i];
    p.life -= dt;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      portalFx.splice(i, 1);
      continue;
    }
    const f = p.life / p.maxLife;
    p.mesh.position.addScaledVector(p.vel, dt);
    if (p.shock) {
      p.mesh.scale.setScalar(1 + (1 - f) * 8.5);
      p.mesh.material.opacity = f * f * 1.0;
    } else {
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
      p.mesh.material.opacity = f;
      p.mesh.scale.setScalar(0.6 + f * 1.4);
    }
  }
}

function resetGameState() {
  score = 0;
  scoreCarry = 0;
  level = 1;
  levelTimer = LEVEL_DURATION;
  lives = 3;
  shipColorIdx = 0;
  progress = 0.0;
  rollAngle = 0;
  rollVel = 0;
  camRoll = 0;
  spawnSafe = 3.0;
  streak = 0;
  levelDamageTaken = false;
  perfectLevelsThisRun = 0;
  hitStopTimer = 0;
  camShake = 0;
  nearMissFlash = 0;
  multiplier = 1;
  coinBoostTimer = 0;
  resetRunTracking();
  applyEquipped();
  transitionPhase = 'none';
  transitionTimer = 0;
  boostSpeedMul = 1.0;
  boostFovTarget = 85;
  boostBloomTarget = 0.42;
  targetHue = 0;
  hueDrift = 0;
  tubeMat.uniforms.uHue.value = 0;
  hidePortal();
  clearBoostCoins();
  document.getElementById('hud-boost').style.display = 'none';
  document.getElementById('hud-finish').style.display = 'none';
  document.getElementById('hud-finish-lines').style.display = 'none';
  document.getElementById('hud-lvlstart').style.display = 'none';
  document.getElementById('hud-overlay').style.display = 'none';
  generateObstacles();
  generateCoins();
  obstacles.forEach(o => { o.lastTd = tDist(0.0, o.t); });
  trail1.points.length = 0;
  trail2.points.length = 0;
  updateHUD();
}

async function startAmbience() {
  // First call also creates the AudioContext and decodes the assets, so it
  // has to be awaited before the loops can find their buffers.
  await audio.unlock();
  if (gameState !== 'playing') return;
  audio.stopAllLoops(0.15);
  audio.startLoop('engine_loop', { filter: true, fade: 0.5 });
  audio.startLoop('wind_loop', { filter: true, fade: 0.8 });
  audio.startLoop('music_loop', { bus: 'music', fade: 1.2 });
  audio.setSpeed(1);
}

function startGame() {
  document.getElementById('hud-menu').style.display = 'none';
  document.getElementById('hud-overlay').style.display = 'none';
  document.getElementById('hud-bar').style.display = 'flex';
  const seedHud = document.getElementById('hud-seed');
  if (seedHud) seedHud.style.display = 'block';
  resetGameState();
  initGhostMesh();
  rebuildGhostLine();
  updateSeedHUD();
  SFX.start();
  gameState = 'playing';
  startAmbience();
}

function updateSeedHUD() {
  const el = document.getElementById('hud-seed');
  if (el) {
    el.textContent = practiceMode
      ? `PRACTICE · SEED ${runSeedStr}`
      : `SEED ${runSeedStr}`;
    el.style.color = practiceMode ? '#88ffaa' : '#88ccff';
  }
  const menuSeed = document.getElementById('menu-seed-input');
  if (menuSeed && document.activeElement !== menuSeed) menuSeed.value = runSeedStr;
  const pracBtn = document.getElementById('menu-practice-btn');
  if (pracBtn) {
    pracBtn.textContent = practiceMode ? 'PRACTICE: ON' : 'PRACTICE: OFF';
    pracBtn.classList.toggle('on', practiceMode);
  }
  const aimBtn = document.getElementById('menu-aim-btn');
  if (aimBtn) {
    aimBtn.textContent = aimAssist ? 'AIM ASSIST: ON' : 'AIM ASSIST: OFF';
    aimBtn.classList.toggle('on', aimAssist);
  }
  const sfxBtn = document.getElementById('menu-sfx-btn');
  if (sfxBtn) {
    sfxBtn.textContent = sfxEnabled ? 'SFX: ON' : 'SFX: OFF';
    sfxBtn.classList.toggle('on', sfxEnabled);
  }
}

function restartGame() {
  resetGameState();
  gameState = 'playing';
  startAmbience();
}

// ── Initial menu state ──
document.getElementById('hud-bar').style.display = 'none';
const menuHs = document.getElementById('menu-highscore');
if (highScore > 0) menuHs.textContent = `Best: ${highScore}`;
// Seed field default
{
  const inp = document.getElementById('menu-seed-input');
  if (inp) inp.value = runSeedStr;
}
updateSeedHUD();
updateHUD();

// Shop button events
document.getElementById('menu-shop-btn').addEventListener('click', e => { e.stopPropagation(); audio.unlock(); audio.play('ui_click'); openShop(); });
document.getElementById('gameover-shop-btn').addEventListener('click', e => { e.stopPropagation(); audio.play('ui_click'); openShop(); });
document.getElementById('shop-close').addEventListener('click', () => { audio.play('ui_click'); closeShop(); });
document.addEventListener('keydown', e => { if (e.code === 'Escape' && document.getElementById('hud-shop').style.display === 'block') { closeShop(); e.stopPropagation(); } }, true);

// P2 menu controls
document.getElementById('menu-practice-btn')?.addEventListener('click', e => {
  e.stopPropagation();
  practiceMode = !practiceMode;
  updateSeedHUD();
});
document.getElementById('menu-aim-btn')?.addEventListener('click', e => {
  e.stopPropagation();
  aimAssist = !aimAssist;
  updateSeedHUD();
});
document.getElementById('menu-sfx-btn')?.addEventListener('click', e => {
  e.stopPropagation();
  sfxEnabled = !sfxEnabled;
  if (sfxEnabled) resumeAudio();
  updateSeedHUD();
});
document.getElementById('menu-seed-rand')?.addEventListener('click', e => {
  e.stopPropagation();
  applyRunSeed(randomSeedStr());
  updateSeedHUD();
});
document.getElementById('menu-seed-input')?.addEventListener('change', e => {
  applyRunSeed(e.target.value);
  updateSeedHUD();
});
document.getElementById('menu-seed-input')?.addEventListener('keydown', e => {
  e.stopPropagation(); // don't start game while typing seed
  if (e.code === 'Enter') {
    applyRunSeed(e.target.value);
    updateSeedHUD();
    e.target.blur();
  }
});

// ═══════════════════════════════════════════════════
// SPACESHIP PLAYER — code-generated crystal ship
// ═══════════════════════════════════════════════════
function createCrystalShip() {
  const group = new THREE.Group();

  // ── Main fuselage — sleek pointed body ──
  const bodyGeo = new THREE.BufferGeometry();
  const v = [
    // 0: Nose (sharp front)
     0,     0,    -2.2,
    // 1: Upper ridge
     0,     0.35,  0,
    // 2: Right body
     0.4,   0,     0,
    // 3: Lower ridge
     0,    -0.2,   0,
    // 4: Left body
    -0.4,   0,     0,
    // 5: Tail center
     0,     0.05,  0.9,
    // 6: Right wing tip (swept back)
     1.4,  -0.08,  0.7,
    // 7: Left wing tip (swept back)
    -1.4,  -0.08,  0.7,
    // 8: Right wing root
     0.4,  -0.05,  0.3,
    // 9: Left wing root
    -0.4,  -0.05,  0.3,
    // 10: Right fin tip
     0.5,   0.35,  0.8,
    // 11: Left fin tip
    -0.5,   0.35,  0.8,
  ];
  const idx = [
    // Nose cone (4 faces)
    0,1,2,  0,2,3,  0,3,4,  0,4,1,
    // Body to tail (4 faces)
    5,2,1,  5,3,2,  5,4,3,  5,1,4,
    // Right wing (2 triangles)
    8,6,5,  8,3,6,
    // Left wing (2 triangles)
    9,5,7,  9,7,3,
    // Right dorsal fin
    1,10,5,  10,2,5,
    // Left dorsal fin
    1,5,11,  11,5,4,
  ];
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  bodyGeo.setIndex(idx);
  bodyGeo.computeVertexNormals();

  // Solid metallic body — minimal emissive
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xe8ffff,
    emissive: 0x114466,
    emissiveIntensity: 0.35,
    metalness: 0.92,
    roughness: 0.12,
    transparent: false,
    side: THREE.DoubleSide,
    fog: false,
    envMap: envRT,
    envMapIntensity: 1.8,
  });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  group.add(bodyMesh);

  // Neon edge wireframe
  const edgeGeo = new THREE.EdgesGeometry(bodyGeo, 20);
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0x66ffff,
    fog: false,
    linewidth: 2,
    transparent: true,
    opacity: 0.85,
  });
  group.add(new THREE.LineSegments(edgeGeo, edgeMat));

  // Engine core
  const glowGeo = new THREE.SphereGeometry(0.12, 12, 12);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0x00ffcc,
    transparent: true,
    opacity: 0.95,
    fog: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.set(0, 0, 0.9);
  group.add(glow);

  // Outer engine halo (blooms hard)
  const haloGeo = new THREE.SphereGeometry(0.28, 12, 12);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x44ffee,
    transparent: true,
    opacity: 0.35,
    fog: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.set(0, 0, 0.95);
  group.add(halo);

  // Wing tip neon dots
  const tipGeo = new THREE.SphereGeometry(0.06, 8, 8);
  const tipMat = new THREE.MeshBasicMaterial({
    color: 0xff44cc,
    transparent: true,
    opacity: 0.9,
    fog: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const tipL = new THREE.Mesh(tipGeo, tipMat);
  tipL.position.set(-0.55, 0.05, 0.55);
  const tipR = new THREE.Mesh(tipGeo, tipMat.clone());
  tipR.position.set(0.55, 0.05, 0.55);
  group.add(tipL, tipR);

  // Store references for color changes
  group.userData.bodyMat = bodyMat;
  group.userData.edgeMat = edgeMat;
  group.userData.glowMat = glowMat;
  group.userData.haloMat = haloMat;
  group.userData.tipMats = [tipMat, tipR.material];

  return group;
}

let shipGroup = createCrystalShip();
let shipModel = shipGroup; // for compatibility
shipGroup.userData.baseScale = 1;
scene.add(shipGroup);

// ═══════════════════════════════════════════════════
// OBSTACLES — thick wall segments on the tunnel wall (Tunnel Rush style)
// ═══════════════════════════════════════════════════
const obstacles = [];
const TUBE_R = 14;

// ── P0 fair-play constants (see PLAN.md) ──
// progress/sec ≈ settings.speed * levelSpeed * coinBoost * 0.1
const FAIR_SKILL_MARGIN = 0.75;       // leave room for imperfect input
const FAIR_MIN_REACT_TIME = 0.60;     // seconds gap must be readable before hit
const FAIR_MAX_LEVEL_FOR_SPAWN = 12;  // design layout fair up to this level
const FAIR_LEVEL_SPEED_STEP = 0.05;   // must match runtime levelSpeed step
const FAIR_COIN_BOOST_MUL = 1.3;      // layout fair even during coin boost
// Hitbox pad expands safe cone beyond visual gap half-angle (radians).
// gap entry: dot > cos(halfAngle + pad) → more forgiving than pure geometry.
const FAIR_HIT_PAD = 0.06;            // ~3.4° past visual edge
const FAIR_NEAR_MISS_OUTER = 0.14;    // rad outside safe cone still "close"
const FAIR_NEAR_MISS_INNER = 0.10;    // rad inside safe cone (edge, not center)
const FAIR_SPIN_CHANCE = 0.10;        // was 0.20 — spinners are harder to read
const FAIR_SPIN_MAX = 0.55;           // rad/s cap during approach
// Max sustained roll (rad/s) AFTER accel — used by fair gap spacing.
// Keep in sync with rollSpeed / ship feel below.
const FAIR_ROLL_SPEED = 2.55;

// Obstacle patterns — each type has a unique color identity
// innerR: how far the block reaches inward (lower = thicker wall, harder)
// The ship flies at radius ~12.8
// maxGapAngle: largest angular gap (used for spacing — bigger gap = less rotation needed)
// GREEN (0x00ff88) is reserved for the safe-lane gap band — never use on walls
const SAFE_LANE_COLOR = 0x00ff88;
const OBS_PATTERNS = [
  { slices: 2, gaps: 1, innerR: 5,  name: 'half-wall',    color: 0xff4466, css: '#ff4466' },  // red — 180° wall
  { slices: 3, gaps: 1, innerR: 6,  name: '3-wall-1gap',  color: 0x44aaff, css: '#44aaff' },  // blue
  { slices: 4, gaps: 1, innerR: 5,  name: '4-wall-1gap',  color: 0xffaa22, css: '#ffaa22' },  // orange
  { slices: 4, gaps: 2, innerR: 6,  name: '4-wall-2gap',  color: 0xaa66ff, css: '#aa66ff' },  // purple (was green)
  { slices: 2, gaps: 1, innerR: 3,  name: 'half-thick',   color: 0xff66ff, css: '#ff66ff' },  // pink
  { slices: 3, gaps: 1, innerR: 4,  name: '3-wall-thick', color: 0xffdd44, css: '#ffdd44' },  // yellow
];

/** Smallest signed turn from a → b into [-PI, PI]. */
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Max progress/sec the layout must remain fair under (boost + high level). */
function fairMaxProgressPerSec() {
  const levelSpeed = 1.0 + (FAIR_MAX_LEVEL_FOR_SPAWN - 1) * FAIR_LEVEL_SPEED_STEP;
  return settings.speed * levelSpeed * FAIR_COIN_BOOST_MUL * 0.1;
}

function generateObstacles() {
  obstacles.forEach(o => { if (o.mesh) scene.remove(o.mesh); });
  obstacles.length = 0;

  // P2/P3: deterministic per (seed, level) — practice still matches, levels differ
  rng = mulberry32((runSeedNum ^ Math.imul(level | 0, 0x9e3779b9)) >>> 0);

  // Build obstacle list with fair spacing + fair gap rotation (P0)
  const baseCount = 40;
  const obsDefs = []; // { t, patIdx, randAngle, gapStart, gapAngle }
  let prevGapAngle = 0;

  const maxProgPerSec = fairMaxProgressPerSec();
  const minSpacingT = maxProgPerSec * FAIR_MIN_REACT_TIME;

  // P1 difficulty waves: safe → build → peak → breather → peak → outro
  // phase drives pattern bucket + spacing multiplier (still fair-checked)
  function wavePhase(frac) {
    // frac 0..1 along the run
    if (frac < 0.12) return 'safe';
    if (frac < 0.35) return 'build';
    if (frac < 0.50) return 'peak';
    if (frac < 0.62) return 'breather';
    if (frac < 0.85) return 'peak';
    return 'outro';
  }

  function pickPattern(phase) {
    // buckets: easy 1-gap, medium, hard (thick / multi)
    const easy = [0, 1];           // half-wall, 3-wall-1gap
    const medium = [1, 2, 3];      // + 4-wall, 2-gap
    const hard = [2, 3, 4, 5];     // thick + multi
    let pool = medium;
    if (phase === 'safe' || phase === 'breather') pool = easy;
    else if (phase === 'build' || phase === 'outro') pool = rng() < 0.65 ? medium : easy;
    else if (phase === 'peak') pool = rng() < 0.55 ? hard : medium;
    return pool[Math.floor(rng() * pool.length)];
  }

  for (let i = 0; i < baseCount; i++) {
    // provisional t for wave phase (refined below)
    const approxT = i === 0 ? 0.08 : (obsDefs.length ? obsDefs[obsDefs.length - 1].t : 0.08) + minSpacingT;
    const phase = wavePhase(Math.min(1, (approxT - 0.08) / 0.84));
    const patIdx = pickPattern(phase);
    const pat = OBS_PATTERNS[patIdx];
    const sliceAngle = (Math.PI * 2) / pat.slices;
    const gapStart = Math.floor(rng() * pat.slices);

    // Desired random orientation — pressure keeps similar gap, twist allows more
    let randAngle = rng() * Math.PI * 2;
    if (phase === 'safe' || phase === 'breather') {
      // small offset from previous so player can settle
      randAngle = prevGapAngle - (gapStart + 0.5) * sliceAngle + (rng() - 0.5) * 0.9;
    } else if (phase === 'peak' && rng() < 0.35) {
      // pressure: nearly same gap angle (tight but fair)
      randAngle = prevGapAngle - (gapStart + 0.5) * sliceAngle + (rng() - 0.5) * 0.5;
    }
    let gapAngle = randAngle + (gapStart + 0.5) * sliceAngle;

    // Spacing: breathers get more air, peaks stay at min fair spacing
    let spaceMul = 1.0;
    if (phase === 'safe') spaceMul = 1.35;
    else if (phase === 'build') spaceMul = 1.15;
    else if (phase === 'peak') spaceMul = 1.0;
    else if (phase === 'breather') spaceMul = 1.45;
    else if (phase === 'outro') spaceMul = 1.2;

    const baseT = Math.max(0.87 / baseCount, minSpacingT) * spaceMul;
    let t = i === 0 ? 0.08 : obsDefs[obsDefs.length - 1].t + baseT;

    if (i > 0) {
      // How much can the player rotate before arriving at this obstacle?
      const spacingT = t - obsDefs[obsDefs.length - 1].t;
      const travelTime = spacingT / maxProgPerSec;
      const availableTurn = FAIR_ROLL_SPEED * travelTime * FAIR_SKILL_MARGIN;

      const delta = angleDelta(prevGapAngle, gapAngle);
      const absDelta = Math.abs(delta);

      if (absDelta > availableTurn) {
        // Clamp gap rotation so the line stays fair.
        // Very tight windows: keep nearly aligned + add spacing.
        if (availableTurn < 0.35) {
          const sign = delta === 0 ? (rng() < 0.5 ? 1 : -1) : Math.sign(delta);
          const clamped = sign * Math.min(absDelta, Math.max(availableTurn, 0.25));
          gapAngle = prevGapAngle + clamped;
          randAngle = gapAngle - (gapStart + 0.5) * sliceAngle;
          t += minSpacingT * 0.35;
        } else {
          const clamped = Math.sign(delta) * availableTurn;
          gapAngle = prevGapAngle + clamped;
          randAngle = gapAngle - (gapStart + 0.5) * sliceAngle;
        }
      } else if (absDelta > Math.PI * 0.55) {
        // Large but fair turn — give a breath of extra spacing
        t += baseT * 0.35;
      }
    }

    if (t > 0.92) break; // stop generating — don't wrap around
    obsDefs.push({ t, patIdx, randAngle, gapStart, gapAngle, phase });
    prevGapAngle = gapAngle;
  }

  for (let i = 0; i < obsDefs.length; i++) {
    const def = obsDefs[i];
    const t = def.t;
    const patIdx = def.patIdx;
    const pat = OBS_PATTERNS[patIdx];

    const sliceAngle = (Math.PI * 2) / pat.slices;
    const padding = 0.10;
    const segLength = 3.0;

    // Use pre-computed gap and rotation
    const gapStart = def.gapStart;
    const gapIndices = new Set();
    for (let g = 0; g < pat.gaps; g++) {
      gapIndices.add((gapStart + g * Math.floor(pat.slices / pat.gaps)) % pat.slices);
    }

    const randAngle = def.randAngle;

    // Build all wall segments as one geometry
    const shapes = [];
    const steps = 32;
    for (let s = 0; s < pat.slices; s++) {
      if (gapIndices.has(s)) continue;

      const a0 = s * sliceAngle + padding / 2;
      const a1 = (s + 1) * sliceAngle - padding / 2;

      const shape = new THREE.Shape();
      // Outer arc
      shape.moveTo(Math.cos(a0) * TUBE_R, Math.sin(a0) * TUBE_R);
      for (let j = 1; j <= steps; j++) {
        const a = a0 + (j / steps) * (a1 - a0);
        shape.lineTo(Math.cos(a) * TUBE_R, Math.sin(a) * TUBE_R);
      }
      // Inner arc back
      for (let j = steps; j >= 0; j--) {
        const a = a0 + (j / steps) * (a1 - a0);
        shape.lineTo(Math.cos(a) * pat.innerR, Math.sin(a) * pat.innerR);
      }
      shape.closePath();
      shapes.push(shape);
    }

    const geo = new THREE.ExtrudeGeometry(shapes, { depth: segLength, bevelEnabled: false });
    geo.translate(0, 0, -segLength / 2);

    // Tunnel frame
    const pos = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(tan, up).normalize();
    const normal = new THREE.Vector3().crossVectors(right, tan).normalize();

    // Brighter emissive + edge glow for gap readability (P1)
    const mat = new THREE.MeshStandardMaterial({
      color: pat.color,
      emissive: pat.color,
      emissiveIntensity: 0.35,
      metalness: 0.15,
      roughness: 0.55,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      fog: true,
      envMapIntensity: 0.0,
    });

    const mesh = new THREE.Mesh(geo, mat);

    // Edge outline
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, fog: false });
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), edgeMat));

    // Orient using lookAt — guaranteed correct right-handed rotation
    // lookAt points -Z at target, so look BACKWARD to make +Z (extrusion) go forward
    mesh.position.copy(pos);
    mesh.up.copy(normal);
    mesh.lookAt(pos.clone().sub(tan));
    // Random rotation around tunnel axis
    mesh.rotateZ(randAngle);

    // Green SAFE LANE bands in each gap — "fly through the green strip"
    // (green is reserved; walls never use SAFE_LANE_COLOR)
    const gapGlows = [];
    const laneMat = new THREE.MeshBasicMaterial({
      color: SAFE_LANE_COLOR,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: true,
    });
    const laneEdgeMat = new THREE.MeshBasicMaterial({
      color: 0xaaffcc,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    });
    for (const gi of gapIndices) {
      const a0 = gi * sliceAngle + padding / 2;
      const a1 = (gi + 1) * sliceAngle - padding / 2;
      // Thin arc on the tunnel wall through the gap
      const laneShape = new THREE.Shape();
      const outerR = TUBE_R - 0.15;
      const innerBand = TUBE_R - 1.35; // narrow green strip on the wall
      const steps = 16;
      laneShape.moveTo(Math.cos(a0) * outerR, Math.sin(a0) * outerR);
      for (let j = 1; j <= steps; j++) {
        const a = a0 + (a1 - a0) * (j / steps);
        laneShape.lineTo(Math.cos(a) * outerR, Math.sin(a) * outerR);
      }
      for (let j = steps; j >= 0; j--) {
        const a = a0 + (a1 - a0) * (j / steps);
        laneShape.lineTo(Math.cos(a) * innerBand, Math.sin(a) * innerBand);
      }
      const laneGeo = new THREE.ExtrudeGeometry(laneShape, {
        depth: segLength * 0.55,
        bevelEnabled: false,
      });
      laneGeo.translate(0, 0, -segLength * 0.275);
      const lane = new THREE.Mesh(laneGeo, laneMat.clone());
      mesh.add(lane);
      gapGlows.push(lane);

      // Bright center line for long-distance read
      const mid = (a0 + a1) * 0.5;
      const lineR = TUBE_R - 0.7;
      const lineW = 0.22;
      const lineShape = new THREE.Shape();
      const la0 = mid - 0.06;
      const la1 = mid + 0.06;
      lineShape.moveTo(Math.cos(la0) * (lineR + lineW), Math.sin(la0) * (lineR + lineW));
      lineShape.lineTo(Math.cos(la1) * (lineR + lineW), Math.sin(la1) * (lineR + lineW));
      lineShape.lineTo(Math.cos(la1) * (lineR - lineW), Math.sin(la1) * (lineR - lineW));
      lineShape.lineTo(Math.cos(la0) * (lineR - lineW), Math.sin(la0) * (lineR - lineW));
      const lineGeo = new THREE.ExtrudeGeometry(lineShape, {
        depth: segLength * 0.7,
        bevelEnabled: false,
      });
      lineGeo.translate(0, 0, -segLength * 0.35);
      const line = new THREE.Mesh(lineGeo, laneEdgeMat.clone());
      mesh.add(line);
      gapGlows.push(line);
    }

    mesh.visible = false;
    mesh.scale.setScalar(0.01); // pop-in starts tiny
    scene.add(mesh);

    // Store gap directions as world-space vectors (robust, no angle math needed)
    mesh.updateMatrixWorld(true);
    const gapDirs = [];
    for (const gi of gapIndices) {
      const gapCenterAngle = (gi + 0.5) * sliceAngle;
      const gapDir = new THREE.Vector3(
        Math.cos(gapCenterAngle),
        Math.sin(gapCenterAngle),
        0
      ).transformDirection(mesh.matrixWorld).normalize();
      gapDirs.push(gapDir);
    }

    // Spinners are harder to read — rarer + capped speed (P0)
    const spinning = rng() < FAIR_SPIN_CHANCE;
    const spinSpeed = spinning
      ? (0.25 + rng() * (FAIR_SPIN_MAX - 0.25)) * (rng() > 0.5 ? 1 : -1)
      : 0;

    obstacles.push({
      t, mesh,
      gapDirs,
      gapGlows,
      popIn: 0, // 0..1 scale pop-in progress
      sliceAngle,
      // Safe cone slightly wider than visual gap (forgiving hitbox)
      gapHalfCos: Math.cos(sliceAngle / 2 + FAIR_HIT_PAD),
      // Near-miss band: scraped outer edge → just inside safe cone (not deep center)
      nearMissCos: Math.cos(sliceAngle / 2 + FAIR_HIT_PAD + FAIR_NEAR_MISS_OUTER),
      nearMissInnerCos: Math.cos(sliceAngle / 2 + FAIR_HIT_PAD - FAIR_NEAR_MISS_INNER),
      innerR: pat.innerR,
      pattern: pat.name,
      spinning,
      spinSpeed,          // radians per second
      gapIndices: [...gapIndices],
    });
  }
}

generateObstacles();

// ═══════════════════════════════════════════════════
// COINS — collectible pickups placed in obstacle gaps
// ═══════════════════════════════════════════════════
const coins = [];
const COIN_RADIUS = 0.9;
const COIN_VALUE = 100;
const COIN_COLLECT_DIST = 6.0;  // world-space distance for pickup
const COIN_MAGNET_DIST = 10.0;  // start pulling coin toward ship

// Shared coin geometry and material
const coinGeo = new THREE.TorusGeometry(COIN_RADIUS, 0.2, 8, 20);
const coinMat = new THREE.MeshStandardMaterial({
  color: 0xffcc00,
  emissive: 0x332200,
  emissiveIntensity: 0.1,
  metalness: 0.9,
  roughness: 0.2,
  fog: false,
});

function generateCoins() {
  coins.forEach(c => { if (c.mesh) scene.remove(c.mesh); });
  coins.length = 0;
  // Coins are only spawned during boost zones now
}

// ── Boost zone bonus coins (spawned in patterns during speed zone) ──
const boostCoins = [];

function clearBoostCoins() {
  boostCoins.forEach(c => { if (c.mesh) scene.remove(c.mesh); });
  boostCoins.length = 0;
}

function spawnBoostCoins(startT) {
  clearBoostCoins();

  // Deterministic boost layout from run seed + level
  const boostRng = mulberry32((runSeedNum ^ Math.imul(level + 1, 0x9e3779b9)) >>> 0);
  const patterns = ['spiral', 'rings', 'zigzag'];
  const pattern = patterns[Math.floor(boostRng() * patterns.length)];
  const count = 60;
  const span = 0.25;

  for (let i = 0; i < count; i++) {
    const frac = i / count;
    const coinT = (startT + frac * span) % 1.0;
    const center = curve.getPointAt(coinT);
    const tan = curve.getTangentAt(coinT).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(tan, up).normalize();
    const normal = new THREE.Vector3().crossVectors(right, tan).normalize();

    let angle;
    if (pattern === 'spiral') {
      angle = frac * Math.PI * 6;
    } else if (pattern === 'rings') {
      const ring = Math.floor(i / 5);
      const slot = i % 5;
      angle = slot * (Math.PI * 2 / 5) + ring * 0.4;
    } else {
      angle = (i % 2 === 0 ? 0.3 : -0.3) * Math.PI + Math.floor(i / 2) * 0.15;
    }

    const radius = TUBE_R - 1.5;
    const dir = new THREE.Vector3()
      .addScaledVector(normal, -Math.cos(angle))
      .addScaledVector(right, Math.sin(angle));

    const coinPos = center.clone().addScaledVector(dir, radius);

    const mesh = new THREE.Mesh(coinGeo, coinMat.clone());
    mesh.position.copy(coinPos);
    mesh.lookAt(coinPos.clone().add(tan));
    mesh.visible = false;
    scene.add(mesh);

    boostCoins.push({ t: coinT, mesh, collected: false });
  }
}

// Coin pickup animation particles
const coinFx = []; // { mesh, vel, life, maxLife }

// Coin pickups climb a pentatonic ladder while you keep collecting, and
// reset once you drop the chain — turns a coin run into a little riff.
const COIN_LADDER = [1.0, 1.122, 1.26, 1.498, 1.682, 2.0];
let coinChain = 0;
let lastCoinAt = -99;

function collectCoin(coin) {
  coin.collected = true;
  const value = COIN_VALUE * multiplier;
  score += value;
  coinBoostTimer = 0.5;

  const now = clock.getElapsedTime();
  coinChain = (now - lastCoinAt < 0.7) ? Math.min(coinChain + 1, COIN_LADDER.length - 1) : 0;
  lastCoinAt = now;
  audio.play('coin', { rate: COIN_LADDER[coinChain] });

  runCoinsCollected++;
  sessionCoins++;
  wallet++;
  saveWallet();
  checkMissions();
  SFX.coin();

  // Spawn sparkle particles at coin position — juicy gold burst
  const pos = coin.mesh.position.clone();
  boostBloomTarget = Math.max(boostBloomTarget, 0.55);
  camShake = Math.max(camShake, 0.14);
  for (let i = 0; i < 18; i++) {
    const geo = new THREE.OctahedronGeometry(0.12 + Math.random() * 0.22);
    const mat = new THREE.MeshBasicMaterial({
      color: Math.random() > 0.35 ? 0xffdd44 : 0xffffff,
      transparent: true,
      opacity: 1,
      fog: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    scene.add(m);

    // Random velocity biased toward camera
    const toCamera = camera.position.clone().sub(pos).normalize();
    const vel = toCamera.multiplyScalar(5 + Math.random() * 8);
    vel.x += (Math.random() - 0.5) * 12;
    vel.y += (Math.random() - 0.5) * 12;
    vel.z += (Math.random() - 0.5) * 12;

    coinFx.push({ mesh: m, vel, life: 0.55 + Math.random() * 0.3, maxLife: 0.7 });
  }

  // Hide the coin mesh
  coin.mesh.visible = false;

  // "+X" popup
  if (shipGroup) {
    const screenPos = shipGroup.position.clone().project(camera);
    const popup = document.getElementById('hud-coin-popup');
    popup.textContent = `+${value}`;
    popup.style.left = ((screenPos.x * 0.5 + 0.5) * innerWidth) + 'px';
    popup.style.top = ((1 - (screenPos.y * 0.5 + 0.5)) * innerHeight) + 'px';
    popup.style.display = 'block';
    popup.style.animation = 'none';
    popup.offsetHeight;
    popup.style.animation = 'coinPop 0.6s forwards';
    setTimeout(() => { popup.style.display = 'none'; }, 600);
  }
  updateHUD();
}

function updateCoinFx(dt) {
  for (let i = coinFx.length - 1; i >= 0; i--) {
    const p = coinFx[i];
    p.life -= dt;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      coinFx.splice(i, 1);
      continue;
    }
    const t = p.life / p.maxLife;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.material.opacity = t;
    p.mesh.scale.setScalar(t);
    p.mesh.rotation.x += dt * 8;
    p.mesh.rotation.y += dt * 6;
  }
}

// ═══════════════════════════════════════════════════
// OBSTACLE DESTRUCTION ANIMATION
// ═══════════════════════════════════════════════════
const debris = []; // active debris pieces
const shockwaves = []; // expanding neon rings

function spawnShockwave(pos, tan, color, opts = {}) {
  const geo = new THREE.RingGeometry(opts.inner ?? 0.3, opts.outer ?? 1.8, 48);
  const mat = new THREE.MeshBasicMaterial({
    color: color.clone ? color.clone() : new THREE.Color(color),
    transparent: true,
    opacity: opts.opacity ?? 1.0,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.position.copy(pos);
  ring.lookAt(pos.clone().add(tan));
  scene.add(ring);
  shockwaves.push({
    mesh: ring,
    age: 0,
    maxAge: opts.maxAge ?? 0.55,
    grow: opts.grow ?? 18,
  });
}

function updateShockwaves(dt) {
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const s = shockwaves[i];
    s.age += dt;
    const t = s.age / s.maxAge;
    if (t >= 1) {
      scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
      shockwaves.splice(i, 1);
      continue;
    }
    s.mesh.scale.setScalar(1 + t * s.grow);
    s.mesh.material.opacity = (1 - t) * (1 - t);
  }
}

function explodeObstacle(obs) {
  const mesh = obs.mesh;
  if (!mesh) return;

  // Slightly after the impact, so hull-hit then shrapnel reads in order.
  audio.play('debris', { delay: 0.08, rate: 0.9 + Math.random() * 0.25 });

  // Get obstacle world position, tangent, and color
  const obsPos = mesh.position.clone();
  const obsTan = curve.getTangentAt(obs.t).normalize();
  const color = mesh.material.color ? mesh.material.color.clone() : new THREE.Color(0x00ffaa);
  const emissive = mesh.material.emissive ? mesh.material.emissive.clone() : color.clone();
  const hotColor = color.clone().offsetHSL(0, 0.25, 0.35);

  // Get the obstacle's world rotation to orient debris properly
  mesh.updateMatrixWorld(true);
  const obsMatrix = mesh.matrixWorld.clone();

  // Create debris fragments
  const fragCount = 22 + Math.floor(Math.random() * 14);
  const fragGroup = new THREE.Group();
  fragGroup.position.copy(obsPos);
  scene.add(fragGroup);

  const pieces = [];

  // Bright core flash (blooms hard)
  {
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 14, 14),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    fragGroup.add(core);
    pieces.push({
      mesh: core,
      vel: new THREE.Vector3(),
      rotVel: new THREE.Vector3(),
      isCore: true,
      maxAge: 0.28,
    });
  }

  for (let i = 0; i < fragCount; i++) {
    // Random small shard geometry
    const size = 0.25 + Math.random() * 1.25;
    const roll = Math.random();
    const geo = roll > 0.66
      ? new THREE.BoxGeometry(size, size * 0.45, size * 0.28)
      : roll > 0.33
        ? new THREE.TetrahedronGeometry(size * 0.65)
        : new THREE.OctahedronGeometry(size * 0.45);

    const mat = new THREE.MeshStandardMaterial({
      color: color.clone().offsetHSL((Math.random() - 0.5) * 0.12, 0.2, (Math.random() - 0.5) * 0.2),
      emissive: hotColor,
      emissiveIntensity: 1.2 + Math.random() * 1.8,
      metalness: 0.55,
      roughness: 0.25,
      transparent: true,
      opacity: 1.0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.4,
      fog: false,
    });

    const frag = new THREE.Mesh(geo, mat);

    // Start near center, fly outward
    const angle = Math.random() * Math.PI * 2;
    const radius = 1.5 + Math.random() * 9;
    const localDir = new THREE.Vector3(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      (Math.random() - 0.5) * 2.5
    );
    frag.position.copy(localDir.clone().multiplyScalar(0.1));

    // Random rotation
    frag.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );

    fragGroup.add(frag);

    // Velocity: hard outward burst in world space
    const worldVel = localDir.clone().normalize()
      .transformDirection(obsMatrix)
      .multiplyScalar(12 + Math.random() * 18);
    // Also add forward velocity so debris flies ahead with the camera
    worldVel.addScaledVector(obsTan, 5 + Math.random() * 10);

    pieces.push({
      mesh: frag,
      vel: worldVel,
      rotVel: new THREE.Vector3(
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18
      ),
    });
  }

  // Additive sparkle spray
  for (let i = 0; i < 30; i++) {
    const spark = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.08 + Math.random() * 0.18),
      new THREE.MeshBasicMaterial({
        color: Math.random() > 0.4 ? hotColor : new THREE.Color(0xffffff),
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    const a = Math.random() * Math.PI * 2;
    const localDir = new THREE.Vector3(Math.cos(a), Math.sin(a), (Math.random() - 0.5) * 0.8);
    const worldVel = localDir.clone().normalize()
      .transformDirection(obsMatrix)
      .multiplyScalar(18 + Math.random() * 28);
    worldVel.addScaledVector(obsTan, 4 + Math.random() * 12);
    spark.position.set(0, 0, 0);
    fragGroup.add(spark);
    pieces.push({
      mesh: spark,
      vel: worldVel,
      rotVel: new THREE.Vector3((Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24),
      isSpark: true,
      maxAge: 0.45 + Math.random() * 0.4,
    });
  }

  debris.push({
    group: fragGroup,
    pieces,
    obsTan: obsTan.clone(), // tunnel direction at this obstacle
    age: 0,
    maxAge: 1.8,
  });

  // Multi-layer neon shockwaves
  spawnShockwave(obsPos, obsTan, color, { inner: 0.4, outer: 2.4, maxAge: 0.5, grow: 24, opacity: 1 });
  spawnShockwave(obsPos, obsTan, hotColor, { inner: 1.0, outer: 3.5, maxAge: 0.75, grow: 16, opacity: 0.75 });
  spawnShockwave(obsPos, obsTan, new THREE.Color(0xffffff), { inner: 0.15, outer: 1.0, maxAge: 0.3, grow: 30, opacity: 0.95 });

  // Bloom punch + camera kick + chromatic pop
  boostBloomTarget = Math.max(boostBloomTarget, 0.95);
  camShake = Math.max(camShake, 0.95);
  rgbPass.uniforms['amount'].value = Math.max(rgbPass.uniforms['amount'].value, 0.015);

  // Hide the original obstacle
  mesh.visible = false;
}

function updateDebris(dt, cameraSpeed) {
  updateShockwaves(dt);
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.age += dt;

    if (d.age >= d.maxAge) {
      // Remove all debris
      scene.remove(d.group);
      d.group.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      debris.splice(i, 1);
      continue;
    }

    // Move entire debris group forward along tunnel so it stays in view
    d.group.position.addScaledVector(d.obsTan, cameraSpeed * dt);

    const fade = 1 - (d.age / d.maxAge);
    for (const p of d.pieces) {
      const pieceFade = p.maxAge != null
        ? Math.max(0, 1 - (d.age / p.maxAge))
        : fade;
      if (pieceFade <= 0) {
        p.mesh.visible = false;
        continue;
      }
      // Move fragment in world space (velocity already in world coords)
      p.mesh.position.addScaledVector(p.vel, dt);
      // Slow down (sparks die faster)
      p.vel.multiplyScalar(p.isSpark || p.isCore ? 0.94 : 0.965);
      // Rotate
      p.mesh.rotation.x += p.rotVel.x * dt;
      p.mesh.rotation.y += p.rotVel.y * dt;
      p.mesh.rotation.z += p.rotVel.z * dt;
      // Fade & shrink
      p.mesh.material.opacity = pieceFade;
      if (p.isCore) {
        p.mesh.scale.setScalar(1 + (1 - pieceFade) * 4);
        p.mesh.material.opacity = pieceFade * pieceFade;
      } else if (p.isSpark) {
        p.mesh.scale.setScalar(Math.max(0.05, pieceFade * 1.4));
      } else {
        p.mesh.scale.setScalar(Math.max(0.08, pieceFade));
        // Increase emissive as it fades (glow effect)
        if (p.mesh.material.emissiveIntensity != null) {
          p.mesh.material.emissiveIntensity = 1.0 + (1 - pieceFade) * 3.5;
        }
      }
    }
  }
}

function tDist(playerT, obsT) {
  let d = playerT - obsT;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

// ═══════════════════════════════════════════════════
// TRON TRAIL — fat ribbon trails
// ═══════════════════════════════════════════════════
const MAX_TRAIL = 400;

function createTrailMesh(color) {
  // Ribbon: two vertices per point (left/right of center line) = triangle strip
  const positions = new Float32Array(MAX_TRAIL * 2 * 3);
  const alphas = new Float32Array(MAX_TRAIL * 2);
  const indices = [];
  for (let i = 0; i < MAX_TRAIL - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
  geo.setIndex(indices);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: `
      attribute float alpha;
      varying float vAlpha;
      void main() {
        vAlpha = alpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        // Hot neon core + soft outer glow falloff
        float a = vAlpha * vAlpha;
        vec3 col = uColor * (1.2 + vAlpha * 1.8);
        gl_FragColor = vec4(col, a * 0.95);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  return { geo, positions, alphas, points: [], mesh };
}

const trail1 = createTrailMesh(0x00ccff);
const trail2 = createTrailMesh(0xff00aa);

// ═══════════════════════════════════════════════════
// AMBIENT CONFETTI — rainbow sparkle field filling the whole tunnel
// ═══════════════════════════════════════════════════
const AMBIENT_COUNT = 680;
const ambientGeo = new THREE.BufferGeometry();
const ambientPos = new Float32Array(AMBIENT_COUNT * 3);
const ambientCol = new Float32Array(AMBIENT_COUNT * 3);
const ambientSeeds = [];
{
  const c = new THREE.Color();
  for (let i = 0; i < AMBIENT_COUNT; i++) {
    ambientSeeds.push({
      ahead: 0.003 + Math.random() * 0.34,   // t-offset ahead of the camera
      ang: Math.random() * Math.PI * 2,
      rad: 1.5 + Math.random() * (TUBE_R - 2.5),
      drift: (Math.random() - 0.5) * 0.9,    // slow swirl speed
      wob: Math.random() * Math.PI * 2,
      hueSpeed: 0.04 + Math.random() * 0.12,
      baseHue: Math.random(),
    });
    c.setHSL(Math.random(), 1.0, 0.68);
    ambientCol[i * 3] = c.r;
    ambientCol[i * 3 + 1] = c.g;
    ambientCol[i * 3 + 2] = c.b;
  }
}
ambientGeo.setAttribute('position', new THREE.BufferAttribute(ambientPos, 3));
ambientGeo.setAttribute('color', new THREE.BufferAttribute(ambientCol, 3));
const ambientPts = new THREE.Points(ambientGeo, new THREE.PointsMaterial({
  size: 0.95,
  vertexColors: true,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  fog: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
}));
ambientPts.frustumCulled = false;
scene.add(ambientPts);

function updateAmbientConfetti(t) {
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  for (let i = 0; i < AMBIENT_COUNT; i++) {
    const s = ambientSeeds[i];
    const pt = (progress + s.ahead) % 1;
    const pos = curve.getPointAt(pt);
    const tan = curve.getTangentAt(pt).normalize();
    const right = new THREE.Vector3().crossVectors(tan, up).normalize();
    const norm = new THREE.Vector3().crossVectors(right, tan).normalize();
    const ang = s.ang + t * s.drift + progress * 48;
    const r = s.rad + Math.sin(t * 2.1 + s.wob) * 0.85;
    ambientPos[i * 3]     = pos.x + (Math.cos(ang) * norm.x + Math.sin(ang) * right.x) * r;
    ambientPos[i * 3 + 1] = pos.y + (Math.cos(ang) * norm.y + Math.sin(ang) * right.y) * r;
    ambientPos[i * 3 + 2] = pos.z + (Math.cos(ang) * norm.z + Math.sin(ang) * right.z) * r;
    // Slow rainbow shimmer through the field
    c.setHSL((s.baseHue + t * s.hueSpeed) % 1, 1.0, 0.7);
    ambientCol[i * 3] = c.r;
    ambientCol[i * 3 + 1] = c.g;
    ambientCol[i * 3 + 2] = c.b;
  }
  ambientGeo.attributes.position.needsUpdate = true;
  ambientGeo.attributes.color.needsUpdate = true;
}

function updateRibbonTrail(trail, newPos, camPos) {
  trail.points.unshift(newPos.clone());
  if (trail.points.length > MAX_TRAIL) trail.points.pop();

  const w = settings.trailWidth;
  const len = trail.points.length;
  const _tangent = new THREE.Vector3();
  const _toCamera = new THREE.Vector3();
  const _side = new THREE.Vector3();

  for (let i = 0; i < len; i++) {
    const p = trail.points[i];
    const fade = 1.0 - i / MAX_TRAIL;
    const alpha = fade * fade;
    const halfW = w * fade;

    // Compute tangent from neighboring points for smooth bending
    if (i === 0 && len > 1) {
      _tangent.subVectors(trail.points[0], trail.points[1]);
    } else if (i === len - 1 && len > 1) {
      _tangent.subVectors(trail.points[i - 1], trail.points[i]);
    } else if (len > 2) {
      _tangent.subVectors(trail.points[i - 1], trail.points[i + 1]);
    } else {
      _tangent.set(0, 0, 1);
    }
    _tangent.normalize();

    // Side vector = cross(tangent, toCamera) — ribbon faces camera AND bends with path
    _toCamera.subVectors(camPos, p).normalize();
    _side.crossVectors(_tangent, _toCamera).normalize().multiplyScalar(halfW);

    const idx = i * 2;
    trail.positions[idx * 3]     = p.x + _side.x;
    trail.positions[idx * 3 + 1] = p.y + _side.y;
    trail.positions[idx * 3 + 2] = p.z + _side.z;
    trail.positions[(idx + 1) * 3]     = p.x - _side.x;
    trail.positions[(idx + 1) * 3 + 1] = p.y - _side.y;
    trail.positions[(idx + 1) * 3 + 2] = p.z - _side.z;

    trail.alphas[idx] = alpha;
    trail.alphas[idx + 1] = alpha;
  }

  trail.geo.attributes.position.needsUpdate = true;
  trail.geo.attributes.alpha.needsUpdate = true;
  trail.geo.setDrawRange(0, Math.max(0, (len - 1)) * 6);
}

// ═══════════════════════════════════════════════════
// INPUT — keyboard rotation (Tunnel Rush style)
// ═══════════════════════════════════════════════════
const keys = {};

// Browsers only allow audio to start from a user gesture — warm the
// AudioContext up on the very first interaction so the assets are decoded
// and ready by the time the run actually begins.
['keydown', 'pointerdown'].forEach(ev =>
  document.addEventListener(ev, () => audio.unlock(), { once: true })
);

document.addEventListener('keydown', e => {
  keys[e.code] = true;
  const shopOpen = document.getElementById('hud-shop').style.display === 'block';
  if (e.code === 'Space' && gameState === 'menu' && !shopOpen) startGame({ fromMenu: true });
  if (e.code === 'Space' && gameState === 'dead' && !shopOpen) restartGame();
  if (e.code === 'Backquote' && DEBUG) gui.show(gui._hidden);
  if (e.code === 'KeyM') {
    const muted = audio.toggleMute();
    const el = document.getElementById('hud-mute');
    el.textContent = muted ? '🔇 MUTED' : '🔊 SOUND ON';
    el.style.display = 'block';
    el.style.animation = 'none';
    el.offsetHeight;
    el.style.animation = 'muteToast 1.2s forwards';
    setTimeout(() => { el.style.display = 'none'; }, 1200);
  }
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (gameState === 'playing') { gameState = 'paused'; audio.suspend(); }
    else if (gameState === 'paused') { gameState = 'playing'; audio.resume(); clock.getDelta(); }
  }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// Ship bank around tunnel axis — fly the ship, don't spin the world
let rollAngle = 0;       // ship / collision authority
let rollVel = 0;         // angular velocity (rad/s) — inertia
let camRoll = 0;         // camera lag behind the ship
const rollSpeed = FAIR_ROLL_SPEED; // max roll rate (rad/s)
const ROLL_ACCEL = 9.0;  // how fast we reach max speed (higher = snappier)
const ROLL_DAMP = 6.5;   // coast/brake when no input (higher = less slide)
const CAM_ROLL_LAG = 5.0; // camera catch-up (lower = heavier lag)

// ═══════════════════════════════════════════════════
// DEBUG GUI — hidden unless the page is opened with ?debug
//
// It exposes speed, ship position and bloom, so leaving it on screen let
// players tune the difficulty away. It's still built either way, so the
// panel is one URL parameter (or the ` key) away during development.
// ═══════════════════════════════════════════════════
const DEBUG = new URLSearchParams(location.search).has('debug');

const gui = new GUI({ title: 'Tunnel Runner' });

const camFolder = gui.addFolder('Camera Offset');
camFolder.add(settings, 'camOffX', -10, 10, 0.1).name('X');
camFolder.add(settings, 'camOffY', -10, 10, 0.1).name('Y');
camFolder.add(settings, 'camOffZ', -10, 10, 0.1).name('Z');

const shipFolder = gui.addFolder('Ship Offset');
shipFolder.add(settings, 'shipOffX', -15, 15, 0.1).name('X');
shipFolder.add(settings, 'shipOffY', -20, 5, 0.1).name('Y');
shipFolder.add(settings, 'shipOffZ', -40, -2, 0.1).name('Z (forward)');
shipFolder.add(settings, 'shipScale', 0.05, 5, 0.05).name('Scale').onChange(v => {
  if (shipModel) shipModel.scale.setScalar((shipGroup.userData.baseScale || 1) * v);
});

const rotFolder = gui.addFolder('Ship Rotation');
const updateShipRot = () => {
  if (shipModel) shipModel.rotation.set(
    THREE.MathUtils.degToRad(settings.shipRotX),
    THREE.MathUtils.degToRad(settings.shipRotY),
    THREE.MathUtils.degToRad(settings.shipRotZ)
  );
};
rotFolder.add(settings, 'shipRotX', -180, 180, 1).name('X°').onChange(updateShipRot);
rotFolder.add(settings, 'shipRotY', -180, 180, 1).name('Y°').onChange(updateShipRot);
rotFolder.add(settings, 'shipRotZ', -180, 180, 1).name('Z°').onChange(updateShipRot);

gui.add(settings, 'speed', 0.01, 1.0, 0.01).name('Speed');

const trailFolder = gui.addFolder('Trail');
trailFolder.add(settings, 'trailOffX', 0, 3, 0.05).name('Offset X');
trailFolder.add(settings, 'trailOffY', -3, 3, 0.05).name('Offset Y');
trailFolder.add(settings, 'trailOffZ', -3, 3, 0.05).name('Offset Z');
trailFolder.add(settings, 'trailWidth', 0.01, 1.0, 0.01).name('Width');

const bloomFolder = gui.addFolder('Bloom');
bloomFolder.add(settings, 'bloomStrength', 0, 3, 0.05).name('Strength').onChange(v => { bloomPass.strength = v; });
bloomFolder.add(settings, 'bloomRadius', 0, 1, 0.01).name('Radius').onChange(v => { bloomPass.radius = v; });
bloomFolder.add(settings, 'bloomThreshold', 0, 1, 0.01).name('Threshold').onChange(v => { bloomPass.threshold = v; });

gui.add({
  copySettings() {
    const json = JSON.stringify(settings, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      console.log('Settings copied to clipboard:\n' + json);
    });
  }
}, 'copySettings').name('📋 Copy Settings');

if (!DEBUG) gui.hide();

// ═══════════════════════════════════════════════════
// ANIMATE — camera follows curve, ship steered by player
// ═══════════════════════════════════════════════════
const clock = new THREE.Clock();
let progress = 0;
let audioSpeedTimer = 0;

function getOffsetPos(t, offX, offY) {
  const pos = curve.getPointAt(t).clone();
  const tan = curve.getTangentAt(t).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(tan, up).normalize();
  const normal = new THREE.Vector3().crossVectors(right, tan).normalize();
  pos.add(normal.multiplyScalar(offY));
  pos.add(right.multiplyScalar(offX));
  return pos;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.getElapsedTime();

  tubeMat.uniforms.uTime.value = t;

  // ── Level transition update ──
  if (transitionPhase === 'boost') {
    transitionTimer -= dt;
    const p = Math.max(0, transitionTimer / BOOST_DURATION);
    boostSpeedMul = 1.0 + 1.5 * p;
    boostFovTarget = 85 + 25 * p;
    boostBloomTarget = 0.42 + 0.55 * p;
  } else if (transitionPhase === 'start') {
    boostSpeedMul = 1.0;
    boostFovTarget = 85;
    boostBloomTarget = 0.4;
  } else {
    boostSpeedMul = 1.0;
    boostFovTarget = 85;
    boostBloomTarget = 0.42;
  }
  // Smoothly interpolate FOV and bloom
  camera.fov += (boostFovTarget - camera.fov) * Math.min(1, dt * 5);
  camera.updateProjectionMatrix();
  bloomPass.strength += (boostBloomTarget - bloomPass.strength) * Math.min(1, dt * 5);

  // Continuous rainbow sweep on top of the per-level base hue
  hueDrift += dt * 0.22;
  const currentHue = tubeMat.uniforms.uHue.value;
  const hueGoal = targetHue + hueDrift;
  tubeMat.uniforms.uHue.value += (hueGoal - currentHue) * Math.min(1, dt * 2);

  const inTransition = transitionPhase !== 'none';

  // ── Hit-stop scales simulation (declared early so progress can use it) ──
  let playDt = dt;
  if (hitStopTimer > 0 && gameState === 'playing') {
    hitStopTimer -= dt;
    playDt = dt * 0.25;
  }

  // ── Input + progress only when playing ──
  if (gameState === 'playing') {
    let inputR = 0;
    if (keys['ArrowLeft']  || keys['KeyA']) inputR -= 1;
    if (keys['ArrowRight'] || keys['KeyD']) inputR += 1;

    // P2 mild aim-assist (default OFF): gentle pull toward nearest upcoming gap
    if (aimAssist && inputR === 0) {
      let bestObs = null;
      let bestTd = 1;
      for (const obs of obstacles) {
        if (obs.hit) continue;
        const td = tDist(progress, obs.t);
        if (td > 0.002 && td < 0.06 && td < bestTd) {
          bestTd = td;
          bestObs = obs;
        }
      }
      if (bestObs && bestObs.gapDirs && bestObs.gapDirs.length) {
        // Ship floor direction in world → desired bank toward closest gap
        const shipT = (progress + 0.006) % 1.0;
        const shipPt = curve.getPointAt(shipT);
        const shipTan = curve.getTangentAt(shipT).normalize();
        const wUp = new THREE.Vector3(0, 1, 0);
        const sRight = new THREE.Vector3().crossVectors(shipTan, wUp).normalize();
        const sUp = new THREE.Vector3().crossVectors(sRight, shipTan).normalize();
        const floorDir = new THREE.Vector3()
          .addScaledVector(sUp, -Math.cos(rollAngle))
          .addScaledVector(sRight, Math.sin(rollAngle));
        let bestDot = -2;
        let bestGap = null;
        for (const gd of bestObs.gapDirs) {
          const d = floorDir.dot(gd);
          if (d > bestDot) { bestDot = d; bestGap = gd; }
        }
        if (bestGap && bestDot < 0.92) {
          // Signed error around tunnel axis (project gap onto ship right)
          const err = floorDir.clone().cross(bestGap).dot(shipTan);
          // Mild only — never stronger than ~35% of max roll
          const pull = Math.max(-0.35, Math.min(0.35, err * 1.8));
          inputR += pull;
        }
      }
    }

    // Heavy ship feel: accelerate toward max rate, damp when released
    // (still responsive during hit-stop — use full dt for control)
    const targetVel = inputR * rollSpeed;
    if (Math.abs(inputR) > 0.01) {
      const k = 1 - Math.exp(-ROLL_ACCEL * dt);
      rollVel += (targetVel - rollVel) * k;
    } else {
      // coast / brake
      rollVel *= Math.exp(-ROLL_DAMP * dt);
      if (Math.abs(rollVel) < 0.02) rollVel = 0;
    }
    rollAngle += rollVel * dt;

    // Speed increases per level + brief boost from coin pickups
    const levelSpeed = 1.0 + (level - 1) * 0.08;
    if (coinBoostTimer > 0) coinBoostTimer -= dt;
    const coinBoost = coinBoostTimer > 0 ? 1.3 : 1.0;
    const travelled = settings.speed * boostSpeedMul * levelSpeed * coinBoost * dt * 0.1;
    progress += travelled;
    progress %= 1.0;

    // Distance score. This has to carry a fraction between frames: the old
    // version rounded per frame, and at 60fps each frame was worth 0.3 points,
    // so Math.round() returned 0 every time and distance scored nothing at all
    // (while a slow machine with big dt did score). Accumulate, then bank whole
    // points, so the rate is identical at any framerate.
    scoreCarry += travelled * DISTANCE_SCORE;
    if (scoreCarry >= 1) {
      const whole = Math.floor(scoreCarry);
      score += whole;
      scoreCarry -= whole;
    }

    // Drive the engine/wind beds from the real tunnel speed. Throttled —
    // the ramps smooth themselves, so per-frame automation is wasted work.
    audioSpeedTimer -= dt;
    if (audioSpeedTimer <= 0) {
      audioSpeedTimer = 0.1;
      audio.setSpeed(boostSpeedMul * levelSpeed * coinBoost);
    }
  }

  // ── Tunnel cross-section frame (always runs) ──
  const curvePt = curve.getPointAt(progress);
  const curveTan = curve.getTangentAt(progress).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const curveRight = new THREE.Vector3().crossVectors(curveTan, worldUp).normalize();
  const curveUp = new THREE.Vector3().crossVectors(curveRight, curveTan).normalize();

  // Camera roll lags the ship → weight in the turns
  {
    const k = 1 - Math.exp(-CAM_ROLL_LAG * dt);
    camRoll += (rollAngle - camRoll) * k;
  }

  // ── Camera (always runs — so GUI tweaks show during pause) ──
  camera.position.copy(curvePt);
  const lookAt = curvePt.clone().add(curveTan);
  camera.up.copy(curveUp);
  camera.lookAt(lookAt);
  camera.rotateZ(camRoll); // lag behind ship
  if (settings.camOffZ !== 0) camera.translateZ(settings.camOffZ);

  // ── Ship positioning — on the tunnel wall in world space ──
  if (shipGroup) {
    shipGroup.scale.setScalar(settings.shipScale);

    // Ship sits ahead of camera on the tunnel floor.
    // Use a t-value slightly ahead of progress so the ship is visible.
    const shipT = (progress + 0.006) % 1.0;
    const shipPt = curve.getPointAt(shipT);
    const shipTan = curve.getTangentAt(shipT).normalize();
    const shipRight = new THREE.Vector3().crossVectors(shipTan, worldUp).normalize();
    const shipUp = new THREE.Vector3().crossVectors(shipRight, shipTan).normalize();

    // Place ship on tunnel floor: center - up * (radius - offset)
    // rollAngle rotates where "down" is on the cross-section
    const wallDist = TUBE_R - 1.2; // slightly above the wall so it doesn't clip
    const floorDir = new THREE.Vector3()
      .addScaledVector(shipUp, -Math.cos(rollAngle))
      .addScaledVector(shipRight, Math.sin(rollAngle));

    shipGroup.position.copy(shipPt).addScaledVector(floorDir, wallDist);

    // Orient ship: nose along tunnel tangent, "up" pointing away from wall
    const shipNormal = floorDir.clone().negate(); // points inward (away from wall)
    const m = new THREE.Matrix4();
    // Build rotation matrix: X=right, Y=normal(up from wall), Z=-tangent(forward)
    const shipSide = new THREE.Vector3().crossVectors(shipTan, shipNormal).normalize();
    m.makeBasis(shipSide, shipNormal, shipTan.clone().negate());
    shipGroup.quaternion.setFromRotationMatrix(m);

    pointLight.position.copy(shipGroup.position).addScaledVector(shipNormal, 2);
    pointLight2.position.copy(shipGroup.position).addScaledVector(shipNormal, 3);
    fillLight.position.copy(shipGroup.position).addScaledVector(shipNormal, 5);
    if (typeof rimLight !== 'undefined') {
      rimLight.position.copy(shipGroup.position)
        .addScaledVector(shipNormal, -2.5)
        .addScaledVector(shipRight, 3);
      // Subtle color pulse on accent lights
      pointLight.color.setHSL((t * 0.08) % 1, 0.85, 0.6);
      pointLight2.color.setHSL((t * 0.08 + 0.55) % 1, 0.9, 0.58);
      rimLight.color.setHSL((t * 0.12 + 0.85) % 1, 1.0, 0.6);
    }

    // Rainbow cavalcade: trails + engine glow sweep the spectrum
    trail1.mesh.material.uniforms.uColor.value.setHSL((t * 0.35) % 1, 1, 0.6);
    trail2.mesh.material.uniforms.uColor.value.setHSL((t * 0.35 + 0.5) % 1, 1, 0.6);
    if (shipGroup.userData.glowMat) {
      shipGroup.userData.glowMat.color.setHSL((t * 0.5) % 1, 1, 0.6);
      const pulse = 0.55 + 0.4 * Math.sin(t * 8);
      shipGroup.userData.glowMat.opacity = pulse;
      if (shipGroup.userData.haloMat) {
        shipGroup.userData.haloMat.opacity = 0.22 + 0.2 * Math.sin(t * 10);
        shipGroup.userData.haloMat.color.setHSL((t * 0.5) % 1, 1, 0.65);
      }
      if (shipGroup.userData.tipMats) {
        for (const tm of shipGroup.userData.tipMats) {
          tm.color.setHSL((t * 0.5 + 0.35) % 1, 1, 0.6);
          tm.opacity = 0.7 + 0.3 * Math.sin(t * 12);
        }
      }
    }

    // Trails only when playing
    if (gameState === 'playing') {
      shipGroup.updateMatrixWorld();
      const trailLocal1 = new THREE.Vector3(settings.trailOffX, settings.trailOffY, settings.trailOffZ);
      const trailLocal2 = new THREE.Vector3(-settings.trailOffX, settings.trailOffY, settings.trailOffZ);
      const trailWorld1 = trailLocal1.applyMatrix4(shipGroup.matrixWorld);
      const trailWorld2 = trailLocal2.applyMatrix4(shipGroup.matrixWorld);
      updateRibbonTrail(trail1, trailWorld1, camera.position);
      updateRibbonTrail(trail2, trailWorld2, camera.position);
    }
  }

  // Grace period countdown (once per frame, not per obstacle!)
  if (gameState === 'playing' && spawnSafe > 0) spawnSafe -= dt;

  // ── P1/P2 juice: cam shake (damped noise) + near-miss flash ──
  if (camShake > 0) {
    // Smooth-ish shake: two-phase noise, stronger on hit, soft on near-miss
    const shakeAmp = camShake * 0.32;
    const nx = Math.sin(t * 47.1) * 0.6 + (Math.random() - 0.5) * 0.4;
    const ny = Math.cos(t * 53.7) * 0.6 + (Math.random() - 0.5) * 0.4;
    camera.position.x += nx * shakeAmp;
    camera.position.y += ny * shakeAmp;
    camera.rotateZ(nx * camShake * 0.04);
    camShake = Math.max(0, camShake - dt * 4.2);
  }
  if (nearMissFlash > 0) {
    nearMissFlash -= dt;
    const nmEl = document.getElementById('hud-nm-flash');
    if (nmEl) {
      nmEl.style.display = 'block';
      nmEl.style.opacity = String(Math.min(1, nearMissFlash * 5));
    }
  } else {
    const nmEl = document.getElementById('hud-nm-flash');
    if (nmEl) nmEl.style.display = 'none';
  }

  // ── Obstacles visibility + collision ──
  for (const obs of obstacles) {
    const td = tDist(progress, obs.t);
    const absTd = Math.abs(td);
    // Hide / ignore obstacles past the exit portal (full half-loop, not just 0.08)
    let pastExit = false;
    if (portalPlaced && portalT >= 0 && portalMesh?.userData?.isExit) {
      let fwd = obs.t - portalT;
      if (fwd < -0.5) fwd += 1;
      if (fwd > 0.5) fwd -= 1;
      pastExit = fwd > -0.02; // on portal lip or beyond
    }
    const vis = absTd < 0.08 && !inTransition && !pastExit;

    // Show/hide obstacle mesh (hidden during level transitions)
    obs.mesh.visible = vis;
    if (vis) {
      // P1 pop-in: scale from tiny → 1 so the eye catches the obstacle
      if (obs.popIn < 1) {
        obs.popIn = Math.min(1, obs.popIn + dt * 4.5);
        const s = obs.popIn * obs.popIn * (3 - 2 * obs.popIn); // smoothstep
        obs.mesh.scale.setScalar(0.15 + 0.85 * s);
      } else {
        obs.mesh.scale.setScalar(1);
      }
      // Pulse green safe-lane bands (bright = fly here)
      if (obs.gapGlows) {
        const pulse = 0.7 + 0.3 * Math.sin(t * 5 + obs.t * 30);
        for (let gi = 0; gi < obs.gapGlows.length; gi++) {
          const g = obs.gapGlows[gi];
          if (!g.material) continue;
          // even = band, odd = center line
          g.material.opacity = (gi % 2 === 0 ? 0.5 : 0.85) * pulse;
        }
      }

      // Spin rotating obstacles and recalculate gap directions
      if (obs.spinning && gameState === 'playing') {
        obs.mesh.rotateZ(obs.spinSpeed * dt);
        obs.mesh.updateMatrixWorld(true);
        obs.gapDirs.length = 0;
        const sa = obs.sliceAngle || ((Math.PI * 2) / Math.max(1, (obs.gapIndices?.length || 1) + 1));
        for (const gi of obs.gapIndices) {
          const gapCenterAngle = (gi + 0.5) * sa;
          const gapDir = new THREE.Vector3(
            Math.cos(gapCenterAngle),
            Math.sin(gapCenterAngle),
            0
          ).transformDirection(obs.mesh.matrixWorld).normalize();
          obs.gapDirs.push(gapDir);
        }
      }
    }

    // Collision: check EVERY frame while ship is near obstacle
    // Skip anything past the exit portal (runway is open)
    if (gameState === 'playing' && !inTransition && !pastExit) {
      // td < 0 = approaching, td > 0 = passed; generous before, tight after
      const inRange = td > -0.004 && td < 0.0005;
      if (spawnSafe <= 0 && inRange && !obs.hit && shipGroup) {
        const obsCenter = curve.getPointAt(obs.t);
        const obsTan = curve.getTangentAt(obs.t).normalize();

        // Ship direction from tunnel center (projected onto cross-section)
        const rel = shipGroup.position.clone().sub(obsCenter);
        const alongTunnel = obsTan.clone().multiplyScalar(rel.dot(obsTan));
        const shipDir = rel.clone().sub(alongTunnel).normalize();
        const shipDist = rel.clone().sub(alongTunnel).length();

        // Check if ship direction aligns with ANY gap direction
        let inGap = false;
        let bestGapDot = -1;
        for (const gapDir of obs.gapDirs) {
          const d = shipDir.dot(gapDir);
          if (d > obs.gapHalfCos) {
            inGap = true;
          }
          if (d > bestGapDot) bestGapDot = d;
        }

        // Also safe if inside the inner hole
        const inCenter = shipDist < obs.innerR + 1.0;

        if (!inGap && !inCenter) {
          explodeObstacle(obs);
          hitObstacle();
          obs.hit = true;
        } else {
          // Worst alignment while still safe (min dot) = how close we scraped the wall
          if (obs._bestGapDot === undefined || bestGapDot < obs._bestGapDot) {
            obs._bestGapDot = bestGapDot;
          }
        }
      }

      // Dodge detection: ship has passed the obstacle without being hit
      if (td > 0.003 && !obs.hit && !obs.dodged) {
        // Near-miss = scraped safe-cone edge (barely in), not flying deep center
        const d = obs._bestGapDot;
        const wasClose = d !== undefined && d <= obs.nearMissInnerCos;
        dodgedObstacle(wasClose);
        obs.dodged = true;
      }

      // Reset flags once ship is far away
      if (absTd > 0.02) { obs.hit = false; obs.dodged = false; obs._bestGapDot = undefined; }
      obs.lastTd = td;
    }
  }

  // ── Boost zone coins ──
  if (transitionPhase === 'boost') {
    for (const coin of boostCoins) {
      if (coin.collected) continue;
      const td = tDist(progress, coin.t);
      const absTd = Math.abs(td);
      coin.mesh.visible = td > -0.15 && td < 0.005; // visible ahead, hide once passed
      if (coin.mesh.visible) {
        coin.mesh.rotation.z += dt * 5.0; // spin faster in boost
      }
      if (gameState === 'playing' && absTd < 0.015 && shipGroup) {
        const dist = shipGroup.position.distanceTo(coin.mesh.position);
        if (dist < COIN_MAGNET_DIST * 1.5 && dist > COIN_COLLECT_DIST) {
          const pullDir = shipGroup.position.clone().sub(coin.mesh.position).normalize();
          coin.mesh.position.addScaledVector(pullDir, dt * 25);
        }
        if (dist < COIN_COLLECT_DIST) {
          collectCoin(coin);
        }
      }
    }
  } else if (transitionPhase === 'start') {
    // Keep coins visible through start phase, still collectible
    for (const coin of boostCoins) {
      if (coin.collected) continue;
      const td = tDist(progress, coin.t);
      coin.mesh.visible = td > -0.15 && td < 0.005;
      if (coin.mesh.visible) coin.mesh.rotation.z += dt * 5.0;
      if (gameState === 'playing' && Math.abs(td) < 0.015 && shipGroup) {
        const dist = shipGroup.position.distanceTo(coin.mesh.position);
        if (dist < 8.0) collectCoin(coin);
      }
    }
  } else if (boostCoins.length > 0 && transitionPhase === 'none') {
    clearBoostCoins();
  }

  // ── Scoring + Level progression (only when playing) ──
  if (gameState === 'playing') {
    // Timer-based level progression (only count down outside transitions)
    if (transitionPhase === 'none') {
      levelTimer -= dt;

      // Place end-portal (SEALED) with ~7 seconds left — it opens on approach
      if (!portalPlaced && levelTimer < 7 && levelTimer > 0) {
        const levelSpeed = 1.0 + (level - 1) * FAIR_LEVEL_SPEED_STEP;
        const progPerSec = settings.speed * levelSpeed * 0.1;
        // ~3.5–4.5s of travel so funnel + flare are obvious
        const lookAhead = Math.min(0.20, Math.max(0.12, progPerSec * 4.0));
        const portalAhead = (progress + lookAhead) % 1.0;
        const nextGc = GAME_COLORS[level % GAME_COLORS.length];
        // Sealed until the ship is ~3s of travel away, then opens fully
        portalOpenDist = Math.min(lookAhead, Math.max(0.05, progPerSec * 3.0));
        placePortal(portalAhead, nextGc.hex, { exit: true });
      }

      // Animate portal + open the tunnel mouth as you approach
      if (portalMesh && portalMesh.visible && portalT >= 0) {
        const ptd = tDist(progress, portalT); // neg while approaching, + after pass
        const pulse = 0.5 + 0.5 * Math.sin(t * 6);

        // Keep portal facing the player approach — NEVER set group.rotation.z
        // (that destroyed lookAt; funnel pointed the wrong way)
        const pPos = curve.getPointAt(portalT);
        const pTan = curve.getTangentAt(portalT).normalize();
        portalMesh.position.copy(pPos);
        portalMesh.lookAt(pPos.clone().sub(pTan)); // -Z toward player

        // Spin only the inner ring (local Z)
        if (portalMesh.userData.innerRingMat) {
          portalMesh.userData.innerRingMat.opacity = 0.45 + 0.4 * pulse;
        }
        portalMesh.traverse(c => {
          if (c.userData && c.userData.spinInner) c.rotation.z = t * 2.2;
        });

        const dist = Math.max(0, -ptd); // 0 at portal, >0 while approaching
        // Sealed until within portalOpenDist, then ease-in so the last
        // stretch really "opens" (approach 0 → 1 across the open distance)
        const approachLin = THREE.MathUtils.clamp(1 - dist / Math.max(0.02, portalOpenDist), 0, 1);
        const approach = approachLin * approachLin; // smooth accelerate open
        portalMesh.scale.setScalar(1.0); // keep group stable; animate parts

        // P3 aperture: shutter contracts → sky revealed + funnel flares
        if (portalMesh.userData.isExit) {
          tubeMat.uniforms.uPortalU.value = portalT;
          tubeMat.uniforms.uOpen.value = approach; // 0 = fully sealed

          // ── COLOR & EFFECT CAVALCADE while opening ──
          if (approach > 0) {
            // Opening burst — fired once when the seal breaks
            if (!portalOpeningFired) {
              portalOpeningFired = true;
              portalOpeningBurst();
            }
            // Rainbow hue sweeps everything: sky, rings, glow, light, shader mouth
            const hue = (t * 0.9) % 1;
            portalMesh.userData.ringMat.color.setHSL(hue, 1, 0.6);
            portalMesh.userData.innerRingMat.color.setHSL((hue + 0.33) % 1, 1, 0.65);
            portalMesh.userData.glowMat.color.setHSL((hue + 0.66) % 1, 1, 0.6);
            portalMesh.userData.skyMat.color.setHSL(hue, 0.85, 0.62);
            portalMesh.userData.pLight.color.setHSL(hue, 1, 0.6);
            tubeMat.uniforms.uMouthSky.value.setHSL(hue, 0.8, 0.5);
            tubeMat.uniforms.uMouthRim.value.setHSL((hue + 0.15) % 1, 1, 0.72);
            // Bloom swells as the mouth opens
            boostBloomTarget = Math.max(boostBloomTarget, 0.42 + approach * 0.7);
            // Continuous sparkle fountain toward the player
            if (Math.random() < approach * 0.6) {
              const sp = portalMesh.position.clone();
              const sv = pTan.clone().multiplyScalar(-(8 + Math.random() * 20));
              sv.x += (Math.random() - 0.5) * 16;
              sv.y += (Math.random() - 0.5) * 16;
              sv.z += (Math.random() - 0.5) * 16;
              spawnPortalParticle(sp, sv, Math.random(), 0.9 + Math.random() * 0.5);
            }
          }

          // THE OPENING: shutter scale 1 → ~0.08 (contracts to a point)
          if (portalMesh.userData.disc) {
            const shut = THREE.MathUtils.lerp(1.0, 0.06, approach);
            portalMesh.userData.disc.scale.setScalar(shut);
          }
          // Inner ring rides the shrinking shutter edge
          if (portalMesh.userData.innerRing) {
            portalMesh.userData.innerRing.scale.setScalar(
              THREE.MathUtils.lerp(1.0, 0.12, approach)
            );
          }
          // Sky fades in from sealed (mid-luma, bloom-safe)
          if (portalMesh.userData.skyMat) {
            portalMesh.userData.skyMat.opacity = approach * 0.9;
          }
          if (portalMesh.userData.glowMat) {
            portalMesh.userData.glowMat.opacity = approach * 0.53;
          }
          if (portalMesh.userData.pLight) {
            portalMesh.userData.pLight.intensity = approach * 3.5;
          }
          // Funnel flares wide — walls peel open toward the mouth
          if (portalMesh.userData.funnelGroup) {
            const f = 1 + approach * 1.15;
            portalMesh.userData.funnelGroup.scale.set(f, f, 1 + approach * 0.2);
          }
          // Outer rim grows slightly so the mouth feels bigger
          if (portalMesh.userData.outerRing) {
            portalMesh.userData.outerRing.scale.setScalar(1 + approach * 0.35);
          }
          // Mild FOV only — no bloom punch
          boostFovTarget = 85 + approach * 8;
        }

        // Ship passed through portal → trigger level up
        if (ptd > 0.003) {
          audio.play('portal');
          level++;
          shipColorIdx = (level - 1) % GAME_COLORS.length;
          targetHue = (level - 1) * 1.2;
          levelTimer = LEVEL_DURATION;
          // clear leftover obstacles immediately so boost zone is clean
          obstacles.forEach(o => { if (o.mesh) scene.remove(o.mesh); });
          obstacles.length = 0;
          hidePortal();
          checkMissions();
          showLevelUp();
        }
      }

      // Failsafe: if timer runs out without hitting portal
      if (levelTimer <= -2) {
        level++;
        shipColorIdx = (level - 1) % GAME_COLORS.length;
        targetHue = (level - 1) * 1.2;
        levelTimer = LEVEL_DURATION;
        obstacles.forEach(o => { if (o.mesh) scene.remove(o.mesh); });
        obstacles.length = 0;
        hidePortal();
        showLevelUp();
      }
    }

    updateHUD();
  }

  // Update debris explosion particles — pass tunnel speed (world units/sec) so debris follows camera
  const camWorldSpeed = settings.speed * 0.1 * curve.getLength();
  updateDebris(dt, camWorldSpeed);
  updateCoinFx(dt);
  updatePortalFx(dt);
  updateAmbientConfetti(t);

  composer.render();
}

animate();

// ═══════════════════════════════════════════════════
// DEBUG HOOK — read-only state + levelTimer skip (used by automated playtest)
// ═══════════════════════════════════════════════════
window.__trDebug = {
  state: () => ({
    gameState, level, levelTimer, lives, progress,
    portalPlaced, portalT, portalOpenDist,
    portalIsExit: !!(portalMesh && portalMesh.userData.isExit),
    portalVisible: !!(portalMesh && portalMesh.visible),
    uOpen: tubeMat.uniforms.uOpen.value,
    skyOpacity: portalMesh ? portalMesh.userData.skyMat.opacity : 0,
    transitionPhase,
  }),
  skipTo: s => { levelTimer = s; },
  god: on => { spawnSafe = on ? 1e9 : 0; }, // playtest: disable collision damage
};

// ═══════════════════════════════════════════════════
// RESIZE
// ═══════════════════════════════════════════════════
// Don't keep the engine droning in a background tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.suspend();
  else if (gameState === 'playing') audio.resume();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
