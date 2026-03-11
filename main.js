import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RGBShiftShader } from 'three/addons/shaders/RGBShiftShader.js';

import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

// ═══════════════════════════════════════════════════
// SCENE SETUP
// ═══════════════════════════════════════════════════
const scene = new THREE.Scene();
const bgColor = '#0a1a15';
scene.fog = new THREE.FogExp2(bgColor, 0.004);

const camera = new THREE.PerspectiveCamera(85, innerWidth / innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 3.5;
document.body.appendChild(renderer.domElement);

// ═══════════════════════════════════════════════════
// POST PROCESSING — real bloom + chromatic aberration
// ═══════════════════════════════════════════════════
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.25,  // strength — matches settings
  0.19,  // radius
  0.35   // threshold
);
composer.addPass(bloomPass);

const rgbPass = new ShaderPass(RGBShiftShader);
rgbPass.uniforms['amount'].value = 0.0018;
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
  void main() {
    vUv = uv;
    vWorldNorm = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
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
  uniform float uReflect;
  uniform float uRingCount;
  uniform sampler2D uMatrix;
  uniform float uMatrixInt;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNorm;

  // Deterministic hash
  float hash(float n) { return fract(sin(n) * 43758.5453123); }

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

  // ── Right wall color ──────────────────────────
  vec3 rightSide(float h, float uvX, float t) {
    vec3 c = vec3(0.0);
    float hw = h + sin(uvX * 100.0) * 0.003;
    float u = uvX * 100.0;

    c += neonLine(vec3(0.2, 0.4, 1.0), hw, 0.35, 60.0,  u, 10.0, t, 2.0);
    c += neonLine(vec3(1.0, 0.2, 0.7), hw, 0.28, 300.0, u, 11.0, t, 2.0);
    c += neonLine(vec3(1.0, 0.6, 0.1), hw, 0.20, 120.0, u, 12.0, t, 2.0);
    c += neonLine(vec3(0.0, 0.8, 1.0), hw, 0.10, 40.0,  u, 13.0, t, 2.0);
    c += neonLine(vec3(1.0, 0.9, 0.2), hw, 0.02, 500.0, u, 14.0, t, 2.0);
    c += neonLine(vec3(0.1, 0.9, 0.3), hw,-0.08, 150.0, u, 15.0, t, 2.0);
    c += neonLine(vec3(1.0, 0.4, 0.0), hw,-0.18, 80.0,  u, 16.0, t, 2.0);
    c += neonLine(vec3(1.0, 0.1, 0.1), hw,-0.28, 400.0, u, 17.0, t, 2.0);

    // White cores on some lines
    c += neonLine(vec3(1.0), hw, 0.28, 450.0, u, 18.0, t, 2.5) * 0.5;
    c += neonLine(vec3(1.0), hw, 0.10, 800.0, u, 19.0, t, 2.5) * 0.5;

    // Particle dots
    c += particleDot(vec3(1.0, 0.5, 1.0), hw, 0.30, 400.0, u, 80.0, t, 1.5);
    c += particleDot(vec3(0.5, 1.0, 1.0), hw, 0.15, 350.0, u, 81.0, t, 2.5);
    c += particleDot(vec3(1.0, 1.0, 0.5), hw,-0.05, 450.0, u, 82.0, t, 2.0);
    c += particleDot(vec3(1.0, 0.2, 0.2), hw,-0.20, 300.0, u, 83.0, t, 3.0);

    c += ghostLayer(hw, uvX, t, 112.3);
    return c;
  }

  // ── Left wall color ───────────────────────────
  vec3 leftSide(float h, float uvX, float t) {
    vec3 c = vec3(0.0);
    float hw = h + sin(uvX * 120.0 + 1.0) * 0.003;
    float u = uvX * 100.0;

    c += neonLine(vec3(1.0, 0.4, 0.0), hw, 0.32, 70.0,  u, 20.0, t, 2.0);
    c += neonLine(vec3(1.0, 0.1, 0.5), hw, 0.25, 350.0, u, 21.0, t, 2.0);
    c += neonLine(vec3(0.1, 0.6, 1.0), hw, 0.15, 120.0, u, 22.0, t, 2.0);
    c += neonLine(vec3(0.2, 0.9, 0.4), hw, 0.05, 50.0,  u, 23.0, t, 2.0);
    c += neonLine(vec3(1.0, 0.8, 0.0), hw,-0.05, 450.0, u, 24.0, t, 2.0);
    c += neonLine(vec3(1.0, 0.2, 0.1), hw,-0.15, 150.0, u, 25.0, t, 2.0);
    c += neonLine(vec3(0.6, 0.1, 1.0), hw,-0.25, 60.0,  u, 26.0, t, 2.0);

    c += neonLine(vec3(1.0), hw, 0.15, 600.0, u, 27.0, t, 2.5) * 0.5;
    c += neonLine(vec3(1.0), hw,-0.05, 900.0, u, 28.0, t, 2.5) * 0.5;

    c += particleDot(vec3(1.0, 0.8, 0.2), hw, 0.28, 350.0, u, 90.0, t, 1.8);
    c += particleDot(vec3(0.2, 0.8, 1.0), hw, 0.10, 400.0, u, 91.0, t, 2.2);
    c += particleDot(vec3(0.5, 1.0, 0.5), hw,-0.10, 300.0, u, 92.0, t, 1.5);
    c += particleDot(vec3(1.0, 0.4, 0.8), hw,-0.20, 450.0, u, 93.0, t, 2.7);

    c += ghostLayer(hw, uvX, t, 442.1);
    return c;
  }

  // ── Colored rings around the tube ─────────────
  vec3 colorRings(float uvX, float uvY, float t) {
    vec3 c = vec3(0.0);
    float localX = fract(uvX * uRingCount);
    float cellId = floor(uvX * uRingCount);

    float rt = fract(hash(cellId) * 10.0);
    vec3 rc = rt < 0.2 ? vec3(1.0, 0.2, 0.7) :
              rt < 0.4 ? vec3(0.0, 0.8, 1.0) :
              rt < 0.6 ? vec3(1.0, 0.6, 0.1) :
              rt < 0.8 ? vec3(0.1, 0.9, 0.3) :
                         vec3(1.0, 0.9, 0.2);

    c += neonLine(rc, localX, 0.5, 60.0 + hash(cellId) * 40.0, uvY, cellId, t, 1.0);
    float isActive = hash(cellId + 10.0) > 0.3 ? 1.0 : 0.0;
    return c * isActive;
  }

  // ── Main ──────────────────────────────────────
  void main() {
    float y = fract(vUv.y + uAngleOff);
    float cy = sin(y * 6.2831853);
    float cx = cos(y * 6.2831853);

    // Mint green base that lights the whole tunnel evenly
    vec3 mintBase = vec3(0.35, 0.85, 0.65) * 0.4;
    // Subtle variation around the circumference
    mintBase *= 0.8 + 0.2 * (0.5 + 0.5 * cy);

    vec3 streaks = cx > 0.0 ? rightSide(cy, vUv.x, uTime) : leftSide(cy, vUv.x, uTime);

    // Neon lines all around (not just ceiling)
    float hw = cy + sin(vUv.x * 80.0) * 0.005;
    float u = vUv.x * 100.0;
    vec3 allLines = vec3(0.0);
    allLines += neonLine(vec3(0.4, 1.0, 0.7), hw, 0.70, 500.0, u, 30.0, uTime, 0.5) * 0.5;
    allLines += neonLine(vec3(0.6, 1.0, 0.9), hw, 0.82, 800.0, u, 31.0, uTime, 0.4) * 0.7;
    allLines += neonLine(vec3(0.3, 0.9, 0.6), hw, 0.20, 600.0, u, 40.0, uTime, 3.0) * 0.5;
    allLines += neonLine(vec3(0.5, 1.0, 0.8), hw,-0.30, 700.0, u, 41.0, uTime, 2.5) * 0.4;
    allLines += neonLine(vec3(1.0, 0.8, 0.5), hw, 0.50, 400.0, u, 42.0, uTime, 2.0) * 0.3;

    vec3 finalCol = mintBase + (streaks * uIntensity * 0.5) + (allLines * uIntensity);

    // Rings
    vec3 rCol = colorRings(vUv.x, y, uTime);
    finalCol += rCol * uIntensity * 0.6;

    // Matrix characters
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
      vec3 mc = mix(vec3(0.0, 0.9, 0.3), vec3(0.6, 1.0, 0.8), head);
      float mSide = smoothstep(0.8, 0.2, abs(cy));
      finalCol += mc * tv * vis * uMatrixInt * mSide * uIntensity;
    }

    // Wet floor reflection
    if (cy < -0.2 && uReflect > 0.0) {
      float rcy = abs(cy);
      float ripple = sin(vUv.x * 300.0 - uTime * 5.0) * 0.03 + sin(vUv.x * 1000.0) * 0.01;
      float rcx = cx + ripple;
      vec3 refl = rcx > 0.0 ? rightSide(rcy, vUv.x, uTime) : leftSide(rcy, vUv.x, uTime);
      float rMask = smoothstep(-0.2, -0.8, cy) * smoothstep(-1.0, -0.9, cy);
      finalCol += refl * uReflect * rMask;
    }

    // Depth fog & cavity shading
    float dist = length(cameraPosition - vWorldPos);
    float fog = exp(-dist * uDepthFade);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = max(0.0, dot(-vWorldNorm, viewDir));
    float cavity = mix(0.5, 1.0, smoothstep(0.0, 0.8, fresnel));

    finalCol *= cavity;
    finalCol = mix(uBgBot, finalCol, fog);

    gl_FragColor = vec4(finalCol, 1.0);
  }
`;

const tubeMat = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms: {
    uTime:       { value: 0 },
    uBgTop:      { value: new THREE.Color('#1a4a3a') },
    uBgBot:      { value: new THREE.Color('#0d2a20') },
    uAngleOff:   { value: -0.25 },
    uIntensity:  { value: 2.0 },
    uDepthFade:  { value: 0.0006 },
    uReflect:    { value: 0.35 },
    uRingCount:  { value: 12.0 },
    uMatrix:     { value: matrixTex },
    uMatrixInt:  { value: 0.25 },
  },
  side: THREE.BackSide,
});

scene.add(new THREE.Mesh(tubeGeo, tubeMat));

// ═══════════════════════════════════════════════════
// LIGHTING + ENVIRONMENT — needed for Meshy PBR models
// ═══════════════════════════════════════════════════
const ambientLight = new THREE.AmbientLight(0xffffff, 6.0);
scene.add(ambientLight);

// Headlight — attached to camera so it always illuminates the ship
const headLight = new THREE.DirectionalLight(0xffffff, 8.0);
camera.add(headLight);
headLight.position.set(0, 2, -5); // shines forward from camera
headLight.target.position.set(0, 0, -10);
camera.add(headLight.target);
scene.add(camera); // camera must be in scene for children to render

const pointLight = new THREE.PointLight(0x00ccff, 12, 100);
scene.add(pointLight);

const pointLight2 = new THREE.PointLight(0xff00aa, 10, 100);
scene.add(pointLight2);

// Extra fill light that follows the ship from above
const fillLight = new THREE.PointLight(0xffffff, 15, 60);
scene.add(fillLight);

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
  bloomStrength: 0.25,
  bloomRadius: 0.19,
  bloomThreshold: 0.35,
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

let gameState = 'playing';
let score = 0;
let level = 1;
let shipColorIdx = 0;
const LEVEL_THRESHOLD = 3000;
let lives = 3;
let hitFlash = 0; // countdown timer for screen flash on hit

// ── HUD ──
const hudEl = document.createElement('div');
hudEl.innerHTML = `
<style>
  #hud-bar { position:fixed; top:0; left:0; width:100%; display:flex; justify-content:space-between; align-items:center; padding:16px 28px; font-family:'Courier New',monospace; font-size:20px; color:#fff; z-index:10; pointer-events:none; }
  #hud-bar > div { text-shadow: 0 0 10px rgba(255,255,255,0.5); }
  #hud-color-badge { padding:4px 14px; border:2px solid; border-radius:4px; font-weight:bold; letter-spacing:2px; }
  #hud-lives { font-size:24px; letter-spacing:4px; }
  #hud-flash { display:none; position:fixed; top:0; left:0; width:100%; height:100%; z-index:12; pointer-events:none; background:radial-gradient(transparent 40%, rgba(255,0,68,0.4)); border:4px solid #ff0044; box-sizing:border-box; }
  @keyframes hudFlash { 0%{opacity:1} 100%{opacity:0} }
  #hud-hit { display:none; position:fixed; z-index:15; pointer-events:none; font-family:'Courier New',monospace; font-size:36px; font-weight:bold; color:#ff0044; text-shadow:0 0 20px #ff0044, 0 0 40px rgba(255,0,68,0.5); }
  @keyframes hudHitPop { 0%{opacity:1;transform:translate(-50%,-50%) scale(1.5)} 50%{opacity:1;transform:translate(-50%,-80%) scale(1)} 100%{opacity:0;transform:translate(-50%,-120%) scale(0.8)} }
  #hud-overlay { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.75); z-index:20; align-items:center; justify-content:center; flex-direction:column; font-family:'Courier New',monospace; color:#fff; }
  #hud-overlay h1 { font-size:60px; margin:0 0 8px; color:#ff0044; text-shadow:0 0 40px #ff0044; }
  #hud-overlay .sub { font-size:22px; margin:6px 0; }
  #hud-overlay .blink { animation:hudBlink 1s infinite; font-size:18px; margin-top:24px; opacity:0.8; }
  @keyframes hudBlink { 0%,100%{opacity:0.8} 50%{opacity:0.2} }
  #hud-lvlup { display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); font-family:'Courier New',monospace; font-size:52px; font-weight:bold; z-index:15; pointer-events:none; text-shadow:0 0 40px currentColor; }
  @keyframes hudLvlPop { 0%{opacity:0;transform:translate(-50%,-50%) scale(0.5)} 15%{opacity:1;transform:translate(-50%,-50%) scale(1.3)} 30%{transform:translate(-50%,-50%) scale(1)} 100%{opacity:0;transform:translate(-50%,-50%) translateY(-60px)} }
</style>
<div id="hud-bar">
  <div id="hud-score">0</div>
  <div id="hud-lives"></div>
  <div id="hud-level">LEVEL 1</div>
  <div id="hud-color-badge">CYAN</div>
</div>
<div id="hud-flash"></div>
<div id="hud-hit">-1</div>
<div id="hud-overlay">
  <h1>GAME OVER</h1>
  <p class="sub" id="hud-final">Score: 0 — Level 1</p>
  <p class="blink">PRESS SPACE TO RESTART</p>
</div>
<div id="hud-lvlup"></div>
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
}

function hitObstacle() {
  lives--;
  if (lives <= 0) {
    showGameOver();
  } else {
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
  document.getElementById('hud-final').textContent = `Score: ${score} — Level ${level}`;
  document.getElementById('hud-overlay').style.display = 'flex';
}

function showLevelUp() {
  const el = document.getElementById('hud-lvlup');
  const gc = GAME_COLORS[shipColorIdx];
  el.textContent = `LEVEL ${level}`;
  el.style.color = gc.css;
  el.style.display = 'block';
  el.style.animation = 'none';
  el.offsetHeight; // reflow
  el.style.animation = 'hudLvlPop 2s forwards';
  setTimeout(() => { el.style.display = 'none'; }, 2000);
}

let spawnSafe = 0; // grace period after restart (seconds)

function restartGame() {
  gameState = 'playing';
  score = 0;
  level = 1;
  lives = 3;
  shipColorIdx = 0;
  progress = 0.0;
  rollAngle = 0;
  spawnSafe = 3.0; // 3 seconds of invincibility after restart
  document.getElementById('hud-overlay').style.display = 'none';
  // Regenerate obstacles so spawn area is always clear
  generateObstacles();
  obstacles.forEach(o => { o.lastTd = tDist(0.0, o.t); });
  trail1.points.length = 0;
  trail2.points.length = 0;
  updateHUD();
}

updateHUD();

// ═══════════════════════════════════════════════════
// SPACESHIP PLAYER — code-generated crystal ship
// ═══════════════════════════════════════════════════
function createCrystalShip() {
  const group = new THREE.Group();

  // Main body — elongated octahedron (diamond shape)
  const bodyGeo = new THREE.BufferGeometry();
  const v = [
    // Tip front (nose)
     0,    0,   -1.8,
    // Top
     0,    0.45, 0,
    // Right
     0.55, 0,    0,
    // Bottom
     0,   -0.3,  0,
    // Left
    -0.55, 0,    0,
    // Tail
     0,    0,    1.0,
    // Wing tips
     1.2, -0.05, 0.6,
    -1.2, -0.05, 0.6,
  ];
  const idx = [
    // Nose to body
    0,1,2,  0,2,3,  0,3,4,  0,4,1,
    // Body to tail
    5,2,1,  5,3,2,  5,4,3,  5,1,4,
    // Right wing: body-right, wing-tip, tail
    2,6,5,  2,3,6,  3,5,6,
    // Left wing: body-left, wing-tip, tail
    4,5,7,  4,7,3,  3,7,5,
  ];
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  bodyGeo.setIndex(idx);
  bodyGeo.computeVertexNormals();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x88ffcc,
    emissive: 0x88ffcc,
    emissiveIntensity: 0.6,
    metalness: 0.8,
    roughness: 0.2,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    fog: false,
    envMap: envRT,
    envMapIntensity: 2.0,
  });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  group.add(bodyMesh);

  // Neon edge wireframe
  const edgeGeo = new THREE.EdgesGeometry(bodyGeo, 15);
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0xaaffee,
    fog: false,
    linewidth: 1,
  });
  group.add(new THREE.LineSegments(edgeGeo, edgeMat));

  // Small engine glow at tail
  const glowGeo = new THREE.SphereGeometry(0.15, 8, 8);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0x00ffaa,
    transparent: true,
    opacity: 0.9,
    fog: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.set(0, 0, 0.9);
  group.add(glow);

  // Store references for color changes
  group.userData.bodyMat = bodyMat;
  group.userData.edgeMat = edgeMat;
  group.userData.glowMat = glowMat;

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

// Obstacle patterns — Tunnel Rush style
// innerR: how far the block reaches inward (lower = thicker wall, harder)
// The ship flies at radius ~12.8
const OBS_PATTERNS = [
  { slices: 2, gaps: 1, innerR: 5,  name: 'half-wall' },      // thick half-wall
  { slices: 3, gaps: 1, innerR: 6,  name: '3-wall-1gap' },    // 3 thick segments
  { slices: 4, gaps: 1, innerR: 5,  name: '4-wall-1gap' },    // 4 segments, 1 gap
  { slices: 4, gaps: 2, innerR: 6,  name: '4-wall-2gap' },    // 4 segments, 2 gaps (easier)
  { slices: 2, gaps: 1, innerR: 3,  name: 'half-thick' },     // very thick half
  { slices: 3, gaps: 1, innerR: 4,  name: '3-wall-thick' },   // 3 thick segments
];

function generateObstacles() {
  obstacles.forEach(o => { if (o.mesh) scene.remove(o.mesh); });
  obstacles.length = 0;

  const count = 40;
  for (let i = 0; i < count; i++) {
    const t = 0.08 + (i / count) * 0.87;
    const patIdx = Math.floor(Math.random() * OBS_PATTERNS.length);
    const colIdx = Math.floor(Math.random() * GAME_COLORS.length);
    const gc = GAME_COLORS[colIdx];
    const pat = OBS_PATTERNS[patIdx];

    const sliceAngle = (Math.PI * 2) / pat.slices;
    const padding = 0.10; // gap between segments
    const segLength = 3.0; // depth along tunnel

    // Pick which segment(s) to skip (the gap to fly through)
    const gapStart = Math.floor(Math.random() * pat.slices);
    const gapIndices = new Set();
    for (let g = 0; g < pat.gaps; g++) {
      gapIndices.add((gapStart + g * Math.floor(pat.slices / pat.gaps)) % pat.slices);
    }

    // Random rotation
    const randAngle = Math.random() * Math.PI * 2;

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

    const mat = new THREE.MeshStandardMaterial({
      color: gc.hex,
      emissive: gc.hex,
      emissiveIntensity: 0.6,
      metalness: 0.4,
      roughness: 0.3,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      fog: true,
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

    mesh.visible = false;
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

    obstacles.push({
      t, colIdx, mesh,
      gapDirs,                          // world-space direction of each gap center
      gapHalfCos: Math.cos(sliceAngle / 2 - 0.05), // cos of half-gap angle (with tolerance)
      innerR: pat.innerR,
      pattern: pat.name,
    });
  }
}

generateObstacles();

// ═══════════════════════════════════════════════════
// OBSTACLE DESTRUCTION ANIMATION
// ═══════════════════════════════════════════════════
const debris = []; // active debris pieces

function explodeObstacle(obs) {
  const mesh = obs.mesh;
  if (!mesh) return;

  // Get obstacle world position, tangent, and color
  const obsPos = mesh.position.clone();
  const obsTan = curve.getTangentAt(obs.t).normalize();
  const color = mesh.material.color.clone();
  const emissive = mesh.material.emissive.clone();

  // Get the obstacle's world rotation to orient debris properly
  mesh.updateMatrixWorld(true);
  const obsMatrix = mesh.matrixWorld.clone();

  // Create debris fragments
  const fragCount = 12 + Math.floor(Math.random() * 8);
  const fragGroup = new THREE.Group();
  fragGroup.position.copy(obsPos);
  scene.add(fragGroup);

  const pieces = [];
  for (let i = 0; i < fragCount; i++) {
    // Random small shard geometry
    const size = 0.3 + Math.random() * 1.2;
    const geo = Math.random() > 0.5
      ? new THREE.BoxGeometry(size, size * 0.5, size * 0.3)
      : new THREE.TetrahedronGeometry(size * 0.6);

    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity: 1.0,
      metalness: 0.4,
      roughness: 0.3,
      transparent: true,
      opacity: 1.0,
      side: THREE.DoubleSide,
    });

    const frag = new THREE.Mesh(geo, mat);

    // Start near the obstacle surface, spread radially in the obstacle's local frame
    const angle = Math.random() * Math.PI * 2;
    const radius = 2 + Math.random() * 8;
    const localDir = new THREE.Vector3(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      (Math.random() - 0.5) * 2
    );
    frag.position.copy(localDir);

    // Random rotation
    frag.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );

    fragGroup.add(frag);

    // Velocity: outward radially in world space using obstacle's orientation
    const worldVel = localDir.clone().normalize()
      .transformDirection(obsMatrix)
      .multiplyScalar(5 + Math.random() * 10);
    // Also add forward velocity so debris flies ahead with the camera
    worldVel.addScaledVector(obsTan, 3 + Math.random() * 5);

    pieces.push({
      mesh: frag,
      vel: worldVel,
      rotVel: new THREE.Vector3(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10
      ),
    });
  }

  debris.push({
    group: fragGroup,
    pieces,
    obsTan: obsTan.clone(), // tunnel direction at this obstacle
    age: 0,
    maxAge: 1.5,
  });

  // Hide the original obstacle
  mesh.visible = false;
}

function updateDebris(dt, cameraSpeed) {
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
      // Move fragment in world space (velocity already in world coords)
      p.mesh.position.addScaledVector(p.vel, dt);
      // Slow down
      p.vel.multiplyScalar(0.97);
      // Rotate
      p.mesh.rotation.x += p.rotVel.x * dt;
      p.mesh.rotation.y += p.rotVel.y * dt;
      p.mesh.rotation.z += p.rotVel.z * dt;
      // Fade & shrink
      p.mesh.material.opacity = fade;
      p.mesh.scale.setScalar(Math.max(0.1, fade));
      // Increase emissive as it fades (glow effect)
      p.mesh.material.emissiveIntensity = 0.6 + (1 - fade) * 2;
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
        // Bright core + glow
        gl_FragColor = vec4(uColor * (1.0 + vAlpha), vAlpha);
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

document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space' && gameState === 'dead') restartGame();
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (gameState === 'playing') { gameState = 'paused'; }
    else if (gameState === 'paused') { gameState = 'playing'; clock.getDelta(); }
  }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// Tunnel rotation angle (radians) — player rolls the view to dodge obstacles
let rollAngle = 0;
const rollSpeed = 4.0; // radians per second

// ═══════════════════════════════════════════════════
// DEBUG GUI
// ═══════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════
// ANIMATE — camera follows curve, ship steered by player
// ═══════════════════════════════════════════════════
const clock = new THREE.Clock();
let progress = 0;

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

  // ── Input + progress only when playing ──
  if (gameState === 'playing') {
    let inputR = 0;
    if (keys['ArrowLeft']  || keys['KeyA']) inputR -= 1;
    if (keys['ArrowRight'] || keys['KeyD']) inputR += 1;
    rollAngle += inputR * rollSpeed * dt;

    progress += settings.speed * dt * 0.1;
    progress %= 1.0;
  }

  // ── Tunnel cross-section frame (always runs) ──
  const curvePt = curve.getPointAt(progress);
  const curveTan = curve.getTangentAt(progress).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const curveRight = new THREE.Vector3().crossVectors(curveTan, worldUp).normalize();
  const curveUp = new THREE.Vector3().crossVectors(curveRight, curveTan).normalize();

  // ── Camera (always runs — so GUI tweaks show during pause) ──
  camera.position.copy(curvePt);
  const lookAt = curvePt.clone().add(curveTan);
  camera.up.copy(curveUp);
  camera.lookAt(lookAt);
  camera.rotateZ(rollAngle);
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

  // ── Obstacles visibility + collision ──
  for (const obs of obstacles) {
    const td = tDist(progress, obs.t);
    const absTd = Math.abs(td);
    const vis = absTd < 0.08;

    // Show/hide obstacle mesh
    const isMatch = obs.colIdx === shipColorIdx;
    obs.mesh.visible = vis;
    if (vis) {
      obs.mesh.material.opacity = isMatch ? 0.1 : 0.85;
      obs.mesh.material.emissiveIntensity = isMatch ? 0.1 : 0.6;
    }

    // Collision: when ship crosses obstacle plane, check if it's in a gap
    if (gameState === 'playing') {
      const crossed = obs.lastTd !== undefined && obs.lastTd <= 0 && td > 0;
      const inRange = absTd < 0.003;
      if (spawnSafe <= 0 && (crossed || (inRange && !obs.checked))) {
        if (!isMatch && shipGroup) {
          const obsCenter = curve.getPointAt(obs.t);
          const obsTan = curve.getTangentAt(obs.t).normalize();

          // Ship direction from tunnel center (projected onto cross-section)
          const rel = shipGroup.position.clone().sub(obsCenter);
          const alongTunnel = obsTan.clone().multiplyScalar(rel.dot(obsTan));
          const shipDir = rel.clone().sub(alongTunnel).normalize();
          const shipDist = rel.clone().sub(alongTunnel).length();

          // Check if ship direction aligns with ANY gap direction
          let inGap = false;
          for (const gapDir of obs.gapDirs) {
            if (shipDir.dot(gapDir) > obs.gapHalfCos) {
              inGap = true;
              break;
            }
          }

          // Also safe if inside the inner hole
          const inCenter = shipDist < obs.innerR + 1.0;

          if (!inGap && !inCenter) {
            explodeObstacle(obs);
            hitObstacle();
          }
          obs.checked = true;
        }
      }
      if (absTd > 0.01) obs.checked = false;
      obs.lastTd = td;
    }
  }

  // ── Scoring + Level progression (only when playing) ──
  if (gameState === 'playing') {
    score += Math.round(dt * settings.speed * 500);
    const newLevel = Math.floor(score / LEVEL_THRESHOLD) + 1;
    if (newLevel > level) {
      level = newLevel;
      shipColorIdx = (level - 1) % GAME_COLORS.length;
      showLevelUp();
    }
    updateHUD();
  }

  // Update debris explosion particles — pass tunnel speed (world units/sec) so debris follows camera
  const camWorldSpeed = settings.speed * 0.1 * curve.getLength();
  updateDebris(dt, camWorldSpeed);

  composer.render();
}

animate();

// ═══════════════════════════════════════════════════
// RESIZE
// ═══════════════════════════════════════════════════
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
