import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const worklet = (await readFile(new URL('../pitch-shifter-worklet.js', import.meta.url), 'utf8'));

async function processor(sampleRate) {
  let resolve, reject;
  const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  const Base = class {
    port = { postMessage: message => message.type === 'ready' ? resolve(message) : reject(new Error('Processor initialization failed')) };
  };
  const Processor = new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', `${worklet}; return PracticePitchShifter;`)(sampleRate, Base, () => {});
  const instance = new Processor();
  const info = await ready;
  assert.ok(info.latency > 0 && info.latency < 0.21);
  return instance;
}

function render(p, sampleRate, seconds, semitones, signal, inputChannels = 1, quantum = 128) {
  const samples = Math.ceil(sampleRate * seconds / quantum) * quantum;
  const result = [new Float32Array(samples), new Float32Array(samples)];
  const inputs = [Array.from({ length: inputChannels }, () => new Float32Array(quantum))];
  const outputs = [[new Float32Array(quantum), new Float32Array(quantum)]];
  const parameters = { semitones: new Float32Array([semitones]) };
  for (let offset = 0; offset < samples; offset += quantum) {
    for (let c = 0; c < inputChannels; c++) {
      for (let i = 0; i < quantum; i++) inputs[0][c][i] = signal((offset + i) / sampleRate, c);
    }
    assert.equal(p.process(inputs, outputs, parameters), true);
    for (let c = 0; c < 2; c++) result[c].set(outputs[0][c], offset);
  }
  for (const channel of result) for (const value of channel) assert.ok(Number.isFinite(value));
  return result;
}

// Short overlapping windows catch temporary deviations; a whole-file FFT or
// average pitch would miss the reported failure. Interpolate zero crossings on
// sine probes only (not polyphonic music, where that estimator is invalid).
function maxPitchError(data, sampleRate, frequency) {
  let maximum = 0;
  const window = Math.round(sampleRate * 0.1);
  for (let start = sampleRate; start + window < data.length; start += Math.round(sampleRate * 0.01)) {
    let first, last, count = 0;
    for (let i = start + 1; i < start + window; i++) {
      if (data[i - 1] <= 0 && data[i] > 0) {
        const crossing = i - 1 - data[i - 1] / (data[i] - data[i - 1]);
        if (!count) first = crossing;
        last = crossing;
        count++;
      }
    }
    assert.ok(count >= 3, 'audible output must contain the requested tone');
    maximum = Math.max(maximum, Math.abs(1200 * Math.log2(sampleRate * (count - 1) / (last - first) / frequency)));
  }
  return maximum;
}

for (const sampleRate of [44100, 48000]) {
  test(`short-window pitch stability, all keys, ${sampleRate}Hz`, async t => {
    let worst = 0;
    for (const frequency of [82.4069, 110, 220, 440]) {
      for (const semitones of [-3, -2, -1, 0, 1, 2, 3]) {
        const p = await processor(sampleRate);
        const output = render(p, sampleRate, 5, semitones, time =>
          0.6 * (0.55 + 0.45 * Math.cos(2 * Math.PI * 1.7 * time)) * Math.sin(2 * Math.PI * frequency * time));
        const error = maxPitchError(output[0], sampleRate, frequency * 2 ** (semitones / 12));
        worst = Math.max(worst, error);
        assert.ok(error < 6, `${frequency}Hz, ${semitones} semitones: ${error.toFixed(2)} cents`);
        let stereoError = 0, energy = 0;
        for (let i = sampleRate; i < output[0].length; i++) {
          stereoError += (output[0][i] - output[1][i]) ** 2;
          energy += output[0][i] ** 2;
        }
        assert.ok(stereoError / energy < 1e-6, 'mono channel difference below -60dB');
      }
    }
    t.diagnostic(`worst 100ms-window deviation: ${worst.toFixed(2)} cents`);
  });
}

test('stereo phase is preserved for a chord with changing note strengths', async () => {
  const p = await processor(48000);
  const chord = time => [110, 138.5913, 164.8138, 220, 277.1826, 329.6276]
    .reduce((sum, hz, i) => sum + (0.07 + 0.04 * Math.cos((i + 1) * time)) * Math.sin(2 * Math.PI * hz * time), 0);
  const output = render(p, 48000, 5, -3, (time, c) => chord(time) * (c ? -1 : 1), 2);
  let energy = 0, difference = 0;
  for (let i = 48000; i < output[0].length; i++) {
    energy += output[0][i] ** 2;
    difference += (output[0][i] + output[1][i]) ** 2;
  }
  assert.ok(energy > 100, 'chord is audible');
  assert.ok(difference / energy < 1e-8, 'opposite-phase channels must not collapse to identical phases');
});

test('seek/reset clears old notes and matches a fresh engine', async () => {
  const used = await processor(48000);
  render(used, 48000, 1, 2, t => 0.6 * Math.sin(2 * Math.PI * 110 * t));
  used.port.onmessage({ data: { type: 'reset' } });
  const afterSeek = render(used, 48000, 1, 2, t => 0.6 * Math.sin(2 * Math.PI * 330 * t));
  const fresh = await processor(48000);
  const expected = render(fresh, 48000, 1, 2, t => 0.6 * Math.sin(2 * Math.PI * 330 * t));
  for (let c = 0; c < 2; c++) for (let i = 0; i < expected[c].length; i++) {
    assert.ok(Math.abs(afterSeek[c][i] - expected[c][i]) < 1e-5, `residual history at ${i}`);
  }
});

test('disconnected input drains to silence without replaying stale audio', async () => {
  const p = await processor(48000);
  render(p, 48000, 1, -2, t => 0.6 * Math.sin(2 * Math.PI * 220 * t));
  const silence = render(p, 48000, 1, -2, () => 0, 0);
  for (const channel of silence) {
    assert.ok(channel.some(value => value !== 0), 'drains buffered tail');
    assert.ok(channel.slice(24000).every(value => Math.abs(value) < 1e-7));
  }
});

test('continuous pitch change converges and supports different render quanta', async () => {
  for (const quantum of [64, 128, 256]) {
    const p = await processor(48000);
    render(p, 48000, 1, -3, t => 0.6 * Math.sin(2 * Math.PI * 220 * t), 1, quantum);
    const shifted = render(p, 48000, 3, 3, t => 0.6 * Math.sin(2 * Math.PI * 220 * t), 1, quantum);
    assert.ok(maxPitchError(shifted[0], 48000, 220 * 2 ** (3 / 12)) < 6);
  }
});

// Resolve each note separately. Changing their strengths must not pull either
// note toward the other (the old synthesis-bin frequency averaging did that).
function spectralPeak(data, sampleRate, startSeconds, expected) {
  const start = Math.round(startSeconds * sampleRate), count = Math.round(0.8 * sampleRate);
  let bestFrequency = 0, bestPower = -1;
  for (let frequency = expected - 4; frequency <= expected + 4; frequency += 0.05) {
    const angle = 2 * Math.PI * frequency / sampleRate;
    const stepReal = Math.cos(angle), stepImag = Math.sin(angle);
    let real = 0, imag = 0, phaseReal = 1, phaseImag = 0;
    for (let i = 0; i < count; i++) {
      const value = data[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / count));
      real += value * phaseReal;
      imag += value * phaseImag;
      const next = phaseReal * stepReal - phaseImag * stepImag;
      phaseImag = phaseReal * stepImag + phaseImag * stepReal;
      phaseReal = next;
    }
    const power = real * real + imag * imag;
    if (power > bestPower) { bestPower = power; bestFrequency = frequency; }
  }
  return bestFrequency;
}

test('nearby simultaneous notes keep their pitches as their strengths change', async t => {
  const p = await processor(48000);
  const output = render(p, 48000, 7, -3, time =>
    (0.25 + 0.12 * Math.cos(time * 1.3)) * Math.sin(2 * Math.PI * 220 * time)
    + (0.25 - 0.12 * Math.cos(time * 1.3)) * Math.sin(2 * Math.PI * 246.9417 * time));
  let worst = 0;
  for (const time of [1, 3, 5]) for (const frequency of [220, 246.9417]) {
    const expected = frequency * 2 ** (-3 / 12);
    const measured = spectralPeak(output[0], 48000, time, expected);
    const cents = Math.abs(1200 * Math.log2(measured / expected));
    worst = Math.max(worst, cents);
    assert.ok(cents < 6, `${frequency}Hz at ${time}s: ${cents.toFixed(2)} cents`);
  }
  t.diagnostic(`worst simultaneous-note deviation: ${worst.toFixed(2)} cents`);
});

test('six minutes at fixed keys never revert pitch or drift with elapsed time', async t => {
  for (const semitones of [-3, 3]) {
    const p = await processor(48000);
    const out = render(p, 48000, 180, semitones, time =>
      (0.4 + 0.15 * Math.sin(time * 0.47)) * Math.sin(2 * Math.PI * 110 * time));
    const error = maxPitchError(out[0], 48000, 110 * 2 ** (semitones / 12));
    assert.ok(error < 6, `${semitones}: ${error} cents during continuous playback`);
    assert.ok(p.phase.every(value => Math.abs(value) <= Math.PI));
    t.diagnostic(`${semitones} semitones, 180 seconds, worst deviation ${error.toFixed(2)} cents`);
  }
});

test('zero transposition reconstructs the original waveform at the reported latency', async () => {
  const p = await processor(48000);
  const signal = t => 0.3 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * Math.cos(2 * Math.PI * 521 * t);
  const out = render(p, 48000, 2, 0, signal);
  let error = 0;
  for (let i = 48000; i < out[0].length; i++) error = Math.max(error, Math.abs(out[0][i] - signal((i - 8704) / 48000)));
  assert.ok(error < 1e-6, `reconstruction/overlap error: ${error}`);
});
