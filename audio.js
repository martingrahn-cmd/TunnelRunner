// ═══════════════════════════════════════════════════
// AUDIO — playback layer for the ElevenLabs-generated assets
//
// Every sound in assets/audio/ comes from the ElevenLabs
// Text-to-Sound-Effects API (see tools/generate-sfx.mjs).
// Nothing here synthesises audio; Web Audio is used purely as the
// mixer: pitch, filtering, ducking and voice management.
//
// The whole module degrades to silent no-ops if the mp3s are missing,
// so the game still runs before the assets have been generated.
// ═══════════════════════════════════════════════════

const AUDIO_DIR = './assets/audio';

const FILES = [
  'engine_loop', 'wind_loop', 'music_loop',
  'coin', 'mission_complete', 'level_up',
  'near_miss', 'impact', 'debris', 'low_life', 'game_over',
  'boost_start', 'boost_end', 'portal',
  'ui_click', 'ui_buy',
];

const LS_MUTED = 'tunnelrunner_muted';
const LS_VOLUME = 'tunnelrunner_volume';

// Per-sound mix trim. The generated files come back at very different
// levels — coin lands around 0.017 RMS while game_over is 0.41 — so these
// are derived from the measured RMS of each file against a target level for
// its role, not guessed. Values above 1 are safe: those files have low peaks.
// Re-derive after any --force re-roll.
const TRIM = {
  // Beds — sit well under the action.
  engine_loop: 0.13,
  wind_loop: 0.33,
  music_loop: 0.21,
  // Foreground events.
  impact: 3.00,   // quiet source, and it's the most important hit in the game
  game_over: 0.39,
  level_up: 0.68,
  boost_start: 0.51,
  boost_end: 0.37,
  portal: 0.66,
  low_life: 0.80,
  mission_complete: 1.00,
  debris: 0.63,   // supporting layer under impact, deliberately lower
  near_miss: 0.90,
  // Frequent — kept below the one-shots so they don't fatigue.
  coin: 3.50,
  ui_click: 1.00,
  ui_buy: 1.40,
};

class GameAudio {
  constructor() {
    this.ctx = null;
    this.raw = new Map();      // name -> ArrayBuffer (fetched immediately)
    this.buffers = new Map();  // name -> AudioBuffer (decoded on unlock)
    this.loops = new Map();    // name -> { source, gain, filter }
    this.unlocked = false;
    this.muted = localStorage.getItem(LS_MUTED) === '1';
    this.volume = parseFloat(localStorage.getItem(LS_VOLUME) ?? '0.8');
    this._duckUntil = 0;

    // Start pulling the files down straight away — this overlaps with
    // the title screen, so audio is usually ready by the first keypress.
    this._prefetch();
  }

  _prefetch() {
    this.loading = Promise.all(FILES.map(async name => {
      try {
        const res = await fetch(`${AUDIO_DIR}/${name}.mp3`);
        if (!res.ok) return;
        this.raw.set(name, await res.arrayBuffer());
      } catch {
        // Asset not generated yet — that sound stays silent.
      }
    }));
  }

  // Must be called from a user gesture (browsers block audio otherwise).
  // Callers race — the first gesture listener and startAmbience() both fire on
  // the same keypress — so everyone awaits one shared promise. Returning early
  // on a second call would hand back a context whose buffers aren't decoded yet.
  unlock() {
    if (!this._unlocking) {
      this._unlocking = this._doUnlock();
    } else if (this.ctx?.state === 'suspended') {
      this.ctx.resume();
    }
    return this._unlocking;
  }

  async _doUnlock() {
    this.unlocked = true;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // ── Bus layout: source → bus → master → out ──
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 1;
    this.musicBus.connect(this.master);

    this.loopBus = this.ctx.createGain();
    this.loopBus.gain.value = 1;
    this.loopBus.connect(this.master);

    await this.loading;
    await Promise.all([...this.raw.entries()].map(async ([name, buf]) => {
      try {
        // decodeAudioData detaches the buffer, so hand it a copy.
        this.buffers.set(name, await this.ctx.decodeAudioData(buf.slice(0)));
      } catch {
        // Corrupt or unsupported file — skip it.
      }
    }));
    this.raw.clear();
  }

  get available() { return !!this.ctx && this.buffers.size > 0; }

  // ── One-shots ──────────────────────────────────────────────
  play(name, { rate = 1, gain = 1, delay = 0, pan = 0 } = {}) {
    if (!this.ctx) return null;
    const buffer = this.buffers.get(name);
    if (!buffer) return null;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;

    const g = this.ctx.createGain();
    g.gain.value = (TRIM[name] ?? 1) * gain;

    let tail = g;
    if (pan !== 0 && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      tail = p;
    }

    src.connect(g);
    tail.connect(this.sfxBus);
    src.start(this.ctx.currentTime + delay);
    return src;
  }

  // ── Loops (engine, wind, music) ────────────────────────────
  startLoop(name, { rate = 1, gain = 1, bus = 'loop', fade = 0.4, filter = false } = {}) {
    if (!this.ctx || this.loops.has(name)) return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;

    const g = this.ctx.createGain();
    const target = (TRIM[name] ?? 1) * gain;
    g.gain.value = 0;
    g.gain.setTargetAtTime(target, this.ctx.currentTime, fade);

    let node = g;
    let lp = null;
    if (filter) {
      lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      g.connect(lp);
      node = lp;
    }

    src.connect(g);
    node.connect(bus === 'music' ? this.musicBus : this.loopBus);
    src.start();

    this.loops.set(name, { source: src, gain: g, filter: lp, target });
  }

  stopLoop(name, fade = 0.3) {
    const loop = this.loops.get(name);
    if (!loop || !this.ctx) return;
    this.loops.delete(name);
    loop.gain.gain.setTargetAtTime(0, this.ctx.currentTime, fade);
    // Stop well after the fade has settled (setTargetAtTime is asymptotic).
    const stopAt = this.ctx.currentTime + fade * 6;
    try { loop.source.stop(stopAt); } catch { /* already stopped */ }
  }

  stopAllLoops(fade = 0.3) {
    for (const name of [...this.loops.keys()]) this.stopLoop(name, fade);
  }

  // Ties the engine/wind beds to how fast the tunnel is actually moving.
  // `mul` is the combined speed multiplier (1.0 at level 1, ~2.5 in boost).
  setSpeed(mul) {
    if (!this.ctx) return;
    const k = Math.max(0, mul - 1);
    const now = this.ctx.currentTime;

    const engine = this.loops.get('engine_loop');
    if (engine) {
      engine.source.playbackRate.setTargetAtTime(0.85 + k * 0.42, now, 0.15);
      if (engine.filter) {
        engine.filter.frequency.setTargetAtTime(700 + k * 4200, now, 0.15);
      }
      engine.gain.gain.setTargetAtTime(engine.target * (1 + k * 0.35), now, 0.2);
    }

    const wind = this.loops.get('wind_loop');
    if (wind) {
      wind.source.playbackRate.setTargetAtTime(0.9 + k * 0.30, now, 0.15);
      if (wind.filter) {
        wind.filter.frequency.setTargetAtTime(1200 + k * 6000, now, 0.15);
      }
      // Wind is barely there at rest and dominates at high speed.
      wind.gain.gain.setTargetAtTime(wind.target * (0.35 + k * 1.1), now, 0.25);
    }
  }

  // Briefly pull the beds down so a big hit reads clearly.
  duck(amount = 0.35, hold = 0.25, release = 0.5) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const bus of [this.musicBus, this.loopBus]) {
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.linearRampToValueAtTime(amount, now + 0.03);
      bus.gain.setValueAtTime(amount, now + hold);
      bus.gain.linearRampToValueAtTime(1, now + hold + release);
    }
  }

  // ── Master controls ────────────────────────────────────────
  setMuted(muted) {
    this.muted = muted;
    localStorage.setItem(LS_MUTED, muted ? '1' : '0');
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    localStorage.setItem(LS_VOLUME, this.volume);
    if (this.master && this.ctx && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  suspend() { if (this.ctx?.state === 'running') this.ctx.suspend(); }
  resume()  { if (this.ctx?.state === 'suspended') this.ctx.resume(); }
}

export const audio = new GameAudio();
