#!/usr/bin/env node
/**
 * Generates every sound effect in the game by prompting the ElevenLabs
 * Text-to-Sound-Effects API directly.
 *
 *   POST https://api.elevenlabs.io/v1/sound-generation
 *
 * Usage:
 *   ELEVENLABS_API_KEY=xi_... node tools/generate-sfx.mjs
 *   node tools/generate-sfx.mjs --key xi_...          # key on the command line
 *   node tools/generate-sfx.mjs --force               # re-generate existing files
 *   node tools/generate-sfx.mjs --only coin,impact    # regenerate a subset
 *
 * Output lands in assets/audio/ as mp3, plus a manifest.json recording the
 * exact prompt used for each file so a sound can be re-rolled on its own.
 */

import { writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'audio');

const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation';
const MODEL = 'eleven_text_to_sound_v2';
const FORMAT = 'mp3_44100_128';

// ─────────────────────────────────────────────────────────────
// The prompts. This is the actual sound design — tweak here and
// re-run with --only <name> to re-roll a single sound.
//
// prompt_influence: higher = sticks closer to the words, lower =
// more room for the model to make something musical. Loops need a
// high influence or they drift and the seam becomes audible.
// ─────────────────────────────────────────────────────────────
const SOUNDS = [
  // ── Continuous beds ────────────────────────────────────────
  {
    name: 'engine_loop',
    loop: true,
    duration: 4,
    influence: 0.6,
    prompt:
      'Continuous low sci-fi spacecraft thruster drone, smooth steady hum with a ' +
      'subtle metallic harmonic shimmer on top, constant volume, no rhythm, no ' +
      'impacts, no melody, clean seamless loop.',
  },
  {
    name: 'wind_loop',
    loop: true,
    duration: 4,
    influence: 0.6,
    prompt:
      'Steady rushing air inside a narrow tunnel, smooth airy high-speed whoosh bed, ' +
      'constant intensity, no gusts, no impacts, no music, clean seamless loop.',
  },
  {
    name: 'music_loop',
    loop: true,
    duration: 22,
    influence: 0.35,
    prompt:
      'Driving dark synthwave loop at 130 BPM, pulsing analog bassline, tight ' +
      'arpeggiated neon synth, punchy electronic drums, retro cyberpunk racing ' +
      'energy, instrumental, no vocals, seamless loop.',
  },

  // ── Pickups and rewards ────────────────────────────────────
  {
    name: 'coin',
    duration: 0.8,
    influence: 0.55,
    prompt:
      'Bright metallic coin pickup, short crystalline ping with a quick sparkling ' +
      'tail, clean arcade video game collectible, no reverb wash.',
  },
  {
    name: 'mission_complete',
    duration: 1.6,
    influence: 0.45,
    prompt:
      'Rewarding achievement unlocked chime, warm bright bell arpeggio rising to a ' +
      'confident resolve, positive confirmation, polished game UI.',
  },
  {
    name: 'level_up',
    duration: 2.2,
    influence: 0.45,
    prompt:
      'Triumphant sci-fi level complete sting, bright ascending synth riser landing ' +
      'on a wide satisfying chord, energetic arcade fanfare.',
  },

  // ── Danger and failure ─────────────────────────────────────
  {
    name: 'near_miss',
    duration: 0.9,
    influence: 0.6,
    prompt:
      'Fast doppler whoosh passing extremely close, sharp air displacement swish ' +
      'sweeping past the listener from front to back, dry and brief.',
  },
  {
    name: 'impact',
    duration: 1.3,
    influence: 0.6,
    prompt:
      'Heavy metallic crash, spacecraft hull slamming hard into a steel barrier, ' +
      'deep punchy thud layered with a bright metal clang and a short ringing tail.',
  },
  {
    name: 'debris',
    duration: 1.6,
    influence: 0.6,
    prompt:
      'Shattered metal and glass debris scattering outward, sharp shards clattering ' +
      'and tumbling away, dense fragmented rubble, dry.',
  },
  {
    name: 'low_life',
    duration: 1.3,
    influence: 0.55,
    prompt:
      'Tense warning alarm pulse, low ominous electronic beep with a dark reverb ' +
      'tail, critical danger alert in a spacecraft cockpit.',
  },
  {
    name: 'game_over',
    duration: 2.6,
    influence: 0.5,
    prompt:
      'Sci-fi power-down failure, descending detuned synth collapsing into a dark ' +
      'bass drop, machine losing power and shutting off, bleak.',
  },

  // ── Speed and transitions ──────────────────────────────────
  {
    name: 'boost_start',
    duration: 2.2,
    influence: 0.55,
    prompt:
      'Turbine spooling up into a powerful accelerating whoosh, rising pitch sci-fi ' +
      'speed boost, building pressure and forward thrust.',
  },
  {
    name: 'boost_end',
    duration: 1.4,
    influence: 0.55,
    prompt:
      'Powering down from extreme speed, descending airy whoosh settling into calm, ' +
      'pressure releasing, smooth deceleration.',
  },
  {
    name: 'portal',
    duration: 1.6,
    influence: 0.5,
    prompt:
      'Passing through a shimmering energy portal, glassy warp shimmer sweeping past ' +
      'with a soft deep bass swell underneath, magical sci-fi transition.',
  },

  // ── Interface ──────────────────────────────────────────────
  {
    name: 'ui_click',
    duration: 0.5,
    influence: 0.6,
    prompt:
      'Short clean digital interface blip, soft holographic menu tap, crisp and dry, ' +
      'no reverb.',
  },
  {
    name: 'ui_buy',
    duration: 1.2,
    influence: 0.5,
    prompt:
      'Satisfying purchase confirmation, digital cash register chime with a bright ' +
      'sparkle flourish, rewarding shop transaction.',
  },
];

// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { force: false, only: null, key: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--only') out.only = argv[++i]?.split(',').map(s => s.trim());
    else if (argv[i] === '--key') out.key = argv[++i];
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function generate(sound, apiKey) {
  const body = {
    text: sound.prompt,
    model_id: MODEL,
    duration_seconds: sound.duration,
    prompt_influence: sound.influence ?? 0.3,
  };
  if (sound.loop) body.loop = true;

  // Retry on rate limits and transient server errors.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${ENDPOINT}?output_format=${FORMAT}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return Buffer.from(await res.arrayBuffer());

    const retryable = res.status === 429 || res.status >= 500;
    const detail = await res.text().catch(() => '');
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new Error(`${res.status} ${res.statusText} — ${detail.slice(0, 300)}`);
    }
    const wait = 2000 * 2 ** (attempt - 1);
    console.log(`   ${res.status}, retrying in ${wait / 1000}s (${attempt}/${MAX_ATTEMPTS - 1})`);
    await sleep(wait);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = args.key || process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    console.error(
      'Missing API key.\n\n' +
      '  ELEVENLABS_API_KEY=xi_... node tools/generate-sfx.mjs\n' +
      '  node tools/generate-sfx.mjs --key xi_...\n'
    );
    process.exit(1);
  }

  const queue = args.only
    ? SOUNDS.filter(s => args.only.includes(s.name))
    : SOUNDS;

  if (args.only) {
    const unknown = args.only.filter(n => !SOUNDS.some(s => s.name === n));
    if (unknown.length) {
      console.error(`Unknown sound(s): ${unknown.join(', ')}`);
      console.error(`Available: ${SOUNDS.map(s => s.name).join(', ')}`);
      process.exit(1);
    }
  }

  await mkdir(OUT_DIR, { recursive: true });

  let made = 0, skipped = 0, failed = 0;
  const manifest = [];

  for (const sound of queue) {
    const file = join(OUT_DIR, `${sound.name}.mp3`);

    if (!args.force && await exists(file)) {
      console.log(`·  ${sound.name} — exists, skipping (use --force to re-roll)`);
      skipped++;
      manifest.push({ ...sound, file: `assets/audio/${sound.name}.mp3` });
      continue;
    }

    process.stdout.write(`→  ${sound.name} (${sound.duration}s${sound.loop ? ', loop' : ''}) ... `);
    try {
      const audio = await generate(sound, apiKey);
      await writeFile(file, audio);
      console.log(`${(audio.length / 1024).toFixed(0)} KB`);
      made++;
      manifest.push({ ...sound, file: `assets/audio/${sound.name}.mp3` });
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      failed++;
    }

    // Be polite to the API between generations.
    await sleep(600);
  }

  // Merge into any existing manifest so --only doesn't wipe the others.
  const manifestPath = join(OUT_DIR, 'manifest.json');
  let previous = [];
  if (await exists(manifestPath)) {
    const { readFile } = await import('node:fs/promises');
    previous = JSON.parse(await readFile(manifestPath, 'utf8')).sounds ?? [];
  }
  const byName = new Map(previous.map(s => [s.name, s]));
  for (const s of manifest) byName.set(s.name, s);

  await writeFile(manifestPath, JSON.stringify({
    model: MODEL,
    format: FORMAT,
    sounds: [...byName.values()],
  }, null, 2) + '\n');

  console.log(`\n${made} generated, ${skipped} skipped, ${failed} failed → assets/audio/`);
  if (failed) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
