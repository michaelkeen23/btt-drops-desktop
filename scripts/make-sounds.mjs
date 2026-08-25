// Generates the bundled alert sounds into assets/sounds/*.wav.
//
// Why synthesise rather than ship samples: these have to be DISTINCT from every stock Windows sound (the
// whole point is that you hear "that's a drop" without looking), royalty-free, and small enough that a
// dozen of them don't bloat the installer. Pure 16-bit mono PCM, 44.1 kHz, written by hand — no deps.
//
//   node scripts/make-sounds.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "sounds");
const SR = 44100;

// ── tiny synth ──────────────────────────────────────────────────────────────────────────────────────
const clamp = (v) => Math.max(-1, Math.min(1, v));
const TAU = Math.PI * 2;

/** ADSR-ish envelope: attack + exponential decay, optionally held flat for `hold` seconds. */
function env(t, dur, { attack = 0.005, hold = 0, curve = 4 } = {}) {
  if (t < attack) return t / attack;
  const after = t - attack - hold;
  if (after <= 0) return 1;
  const rest = Math.max(0.0001, dur - attack - hold);
  return Math.exp((-curve * after) / rest);
}

const sine = (ph) => Math.sin(ph);
const square = (ph) => (Math.sin(ph) >= 0 ? 1 : -1);
const saw = (ph) => (((ph / TAU) % 1) * 2) - 1;
const tri = (ph) => (2 / Math.PI) * Math.asin(Math.sin(ph));

/**
 * Render one voice into a float buffer.
 *   freq  — number | (t, dur) => number    (a function sweeps the pitch)
 *   wave  — sine | square | saw | tri | "noise"
 */
function voice(buf, { start = 0, dur, freq, wave = sine, gain = 0.4, attack, hold, curve, detune = 0, vibrato = 0, vibratoHz = 0 }) {
  const i0 = Math.floor(start * SR);
  const n = Math.floor(dur * SR);
  let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const idx = i0 + i;
    if (idx >= buf.length) break;
    let f = typeof freq === "function" ? freq(t, dur) : freq;
    if (vibrato && vibratoHz) f *= 1 + vibrato * Math.sin(TAU * vibratoHz * t);
    const e = env(t, dur, { attack, hold, curve }) * gain;
    if (wave === "noise") {
      buf[idx] += (Math.random() * 2 - 1) * e;
    } else {
      ph += (TAU * f) / SR;
      buf[idx] += wave(ph) * e;
      if (detune) { ph2 += (TAU * f * (1 + detune)) / SR; buf[idx] += wave(ph2) * e * 0.6; }
    }
  }
}

function render(seconds, build) {
  const buf = new Float32Array(Math.ceil(seconds * SR));
  build(buf);
  return buf;
}

function writeWav(file, samples) {
  // Normalise to -1.5 dBFS so every sound lands at a comparable loudness — nothing should be startlingly
  // louder than the one next to it in the picker.
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0 ? 0.84 / peak : 1;
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(clamp(samples[i] * scale) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return buf.length;
}

// ── the sounds ──────────────────────────────────────────────────────────────────────────────────────
const SOUNDS = {
  // The default. Three rising blips landing on a soft thump — reads as "something just arrived".
  "drop-alert": () => render(1.1, (b) => {
    [880, 1174, 1568].forEach((f, i) => voice(b, { start: i * 0.09, dur: 0.3, freq: f, wave: sine, gain: 0.4, curve: 6 }));
    voice(b, { start: 0.27, dur: 0.7, freq: (t) => 220 - 80 * t, wave: sine, gain: 0.5, curve: 3 });
    voice(b, { start: 0.27, dur: 0.5, freq: 1568, wave: tri, gain: 0.12, curve: 5 });
  }),

  // Ka-ching. Money noise, for when the drop is the good kind.
  "cash-register": () => render(1.2, (b) => {
    voice(b, { start: 0, dur: 0.06, freq: 3000, wave: "noise", gain: 0.5, curve: 9 });
    [1568, 2093, 2637].forEach((f) => voice(b, { start: 0.02, dur: 0.5, freq: f, wave: sine, gain: 0.28, curve: 5 }));
    [1318, 1760, 2637].forEach((f) => voice(b, { start: 0.16, dur: 0.85, freq: f, wave: sine, gain: 0.3, curve: 3.5 }));
    voice(b, { start: 0.18, dur: 0.25, freq: 5200, wave: "noise", gain: 0.1, curve: 8 });
  }),

  // Unmissable. Sawtooth blast with a slow vibrato — this is the one for priority events.
  "air-horn": () => render(1.4, (b) => {
    voice(b, { start: 0, dur: 1.25, freq: 233, wave: saw, gain: 0.34, attack: 0.03, hold: 0.75, curve: 5, detune: 0.006, vibrato: 0.012, vibratoHz: 5.5 });
    voice(b, { start: 0, dur: 1.25, freq: 349, wave: saw, gain: 0.22, attack: 0.03, hold: 0.75, curve: 5, detune: 0.008, vibrato: 0.012, vibratoHz: 5.5 });
    voice(b, { start: 0, dur: 1.25, freq: 466, wave: saw, gain: 0.14, attack: 0.04, hold: 0.7, curve: 5 });
  }),

  // Two-tone alternating alarm. Industrial, impossible to sleep through.
  "klaxon": () => render(1.6, (b) => {
    for (let i = 0; i < 4; i++) {
      voice(b, { start: i * 0.38, dur: 0.34, freq: i % 2 ? 494 : 659, wave: square, gain: 0.24, attack: 0.012, hold: 0.24, curve: 8 });
      voice(b, { start: i * 0.38, dur: 0.34, freq: i % 2 ? 247 : 330, wave: square, gain: 0.14, attack: 0.012, hold: 0.24, curve: 8 });
    }
  }),

  // Sonar. Long tail, low-key, good if you sit near other people.
  "radar-ping": () => render(1.8, (b) => {
    voice(b, { start: 0, dur: 1.6, freq: (t) => 1400 - 150 * t, wave: sine, gain: 0.5, attack: 0.004, curve: 5 });
    voice(b, { start: 0.35, dur: 1.2, freq: (t) => 1380 - 140 * t, wave: sine, gain: 0.18, attack: 0.004, curve: 5 });
  }),

  // 8-bit coin. Short, cheerful, cuts through a noisy room.
  "arcade-coin": () => render(0.75, (b) => {
    voice(b, { start: 0, dur: 0.09, freq: 988, wave: square, gain: 0.3, attack: 0.002, hold: 0.07, curve: 9 });
    voice(b, { start: 0.09, dur: 0.55, freq: 1319, wave: square, gain: 0.3, attack: 0.002, hold: 0.3, curve: 6 });
  }),

  // Struck bell with real harmonics. Warm, and it carries.
  "bell-tower": () => render(2.4, (b) => {
    const f0 = 523.25;
    [[1, 0.5, 2.2], [2, 0.26, 1.6], [2.76, 0.18, 1.2], [4.07, 0.1, 0.85], [5.43, 0.06, 0.6]].forEach(([mult, g, d]) =>
      voice(b, { start: 0, dur: d, freq: f0 * mult, wave: sine, gain: g, attack: 0.003, curve: 4 }));
    voice(b, { start: 0, dur: 0.04, freq: 6000, wave: "noise", gain: 0.14, curve: 10 });
  }),

  // Two soft pulses. The quiet option — noticeable, never rude.
  "pulse": () => render(0.9, (b) => {
    [0, 0.22].forEach((s) => {
      voice(b, { start: s, dur: 0.3, freq: 660, wave: sine, gain: 0.42, attack: 0.02, curve: 5 });
      voice(b, { start: s, dur: 0.3, freq: 990, wave: sine, gain: 0.14, attack: 0.02, curve: 5 });
    });
  }),

  // Rising/falling sweep. Emergency-adjacent; pairs well with "repeat until acknowledged".
  "siren": () => render(2.0, (b) => {
    voice(b, { start: 0, dur: 1.9, freq: (t) => 520 + 340 * Math.sin(TAU * 0.85 * t), wave: tri, gain: 0.4, attack: 0.03, hold: 1.2, curve: 5, detune: 0.004 });
  }),

  // Four descending chimes. The "pleasant but definitely a notification" one.
  "chime-cascade": () => render(1.7, (b) => {
    [1568, 1319, 1047, 784].forEach((f, i) => {
      voice(b, { start: i * 0.13, dur: 1.0 + i * 0.12, freq: f, wave: sine, gain: 0.34, attack: 0.004, curve: 4 });
      voice(b, { start: i * 0.13, dur: 0.5, freq: f * 2, wave: sine, gain: 0.07, attack: 0.004, curve: 6 });
    });
  }),

  // Descending zap. Very short, very distinct.
  "laser": () => render(0.6, (b) => {
    voice(b, { start: 0, dur: 0.42, freq: (t, d) => 2400 * Math.pow(0.12, t / d), wave: saw, gain: 0.34, attack: 0.002, curve: 4 });
    voice(b, { start: 0, dur: 0.42, freq: (t, d) => 1200 * Math.pow(0.12, t / d), wave: square, gain: 0.16, attack: 0.002, curve: 4 });
  }),

  // Two low thumps. Felt more than heard — good with headphones on.
  "heartbeat": () => render(1.2, (b) => {
    [0, 0.3].forEach((s, i) => {
      voice(b, { start: s, dur: 0.4, freq: (t) => 92 - 34 * t, wave: sine, gain: i ? 0.42 : 0.55, attack: 0.006, curve: 4 });
      voice(b, { start: s, dur: 0.09, freq: 400, wave: "noise", gain: 0.05, curve: 9 });
    });
  }),

  // Short triad fanfare. The celebratory one.
  "fanfare": () => render(1.5, (b) => {
    const notes = [[523.25, 0], [659.25, 0.1], [783.99, 0.2], [1046.5, 0.3]];
    for (const [f, s] of notes) {
      voice(b, { start: s, dur: 1.0, freq: f, wave: saw, gain: 0.2, attack: 0.012, hold: 0.2, curve: 4, detune: 0.005 });
      voice(b, { start: s, dur: 1.0, freq: f / 2, wave: tri, gain: 0.1, attack: 0.012, hold: 0.2, curve: 4 });
    }
  }),

  // Barely-there tick. For when you want the pop-up but not the noise.
  "subtle-tick": () => render(0.28, (b) => {
    voice(b, { start: 0, dur: 0.05, freq: 2400, wave: sine, gain: 0.4, attack: 0.001, curve: 10 });
    voice(b, { start: 0.06, dur: 0.16, freq: 1600, wave: sine, gain: 0.24, attack: 0.002, curve: 7 });
  }),
};

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [id, build] of Object.entries(SOUNDS)) {
  const bytes = writeWav(path.join(OUT, `${id}.wav`), build());
  total += bytes;
  console.log(`  ${id}.wav`.padEnd(26), (bytes / 1024).toFixed(0) + " KB");
}
console.log(`\nwrote ${Object.keys(SOUNDS).length} sounds (${(total / 1048576).toFixed(1)} MB) to assets/sounds`);
