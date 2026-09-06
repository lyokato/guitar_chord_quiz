// Peak-region frequency shifting with phase locking (Laroche/Dolson): move each
// resolved peak and its surrounding complex spectrum together. Never average
// unrelated input frequencies into an output bin. See tests/README.md.
const FFT_SIZE = 8192;
const HOP_SIZE = 512;
const STAGE_SIZE = HOP_SIZE / 4;
const HALF_FFT = FFT_SIZE / 2;
const OUTPUT_RING_SIZE = FFT_SIZE * 2;
const LATENCY = FFT_SIZE + HOP_SIZE;
const TWO_PI = 2 * Math.PI;
const PHASE_ADVANCE = TWO_PI * HOP_SIZE / FFT_SIZE;
const WINDOW_NORMALIZATION = 3 * FFT_SIZE / (8 * HOP_SIZE);

// Tables are constructed once at module load, outside audio rendering.
const HANN_WINDOW = new Float64Array(FFT_SIZE);
const BIT_REVERSE = new Uint16Array(FFT_SIZE);
const TWIDDLE_REAL = new Float64Array(HALF_FFT);
const TWIDDLE_IMAG = new Float64Array(HALF_FFT);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN_WINDOW[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / FFT_SIZE);
  let value = i, reversed = 0;
  for (let bit = 1; bit < FFT_SIZE; bit *= 2) {
    reversed = reversed * 2 + (value & 1);
    value >>>= 1;
  }
  BIT_REVERSE[i] = reversed;
  if (i < HALF_FFT) {
    TWIDDLE_REAL[i] = Math.cos(TWO_PI * i / FFT_SIZE);
    TWIDDLE_IMAG[i] = Math.sin(TWO_PI * i / FFT_SIZE);
  }
}

function fft(real, imag, inverse = false) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = BIT_REVERSE[i];
    if (i >= j) continue;
    const re = real[i], im = imag[i];
    real[i] = real[j]; imag[i] = imag[j];
    real[j] = re; imag[j] = im;
  }
  for (let width = 2; width <= FFT_SIZE; width *= 2) {
    const half = width / 2, stride = FFT_SIZE / width;
    for (let offset = 0; offset < FFT_SIZE; offset += width) {
      for (let k = 0; k < half; k++) {
        const even = offset + k, odd = even + half;
        const wr = TWIDDLE_REAL[k * stride];
        const wi = inverse ? TWIDDLE_IMAG[k * stride] : -TWIDDLE_IMAG[k * stride];
        const re = real[odd] * wr - imag[odd] * wi;
        const im = real[odd] * wi + imag[odd] * wr;
        real[odd] = real[even] - re; imag[odd] = imag[even] - im;
        real[even] += re; imag[even] += im;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < FFT_SIZE; i++) { real[i] /= FFT_SIZE; imag[i] /= FFT_SIZE; }
  }
}

function createChannel() {
  return {
    input: new Float32Array(FFT_SIZE), output: new Float32Array(OUTPUT_RING_SIZE),
    real: new Float64Array(FFT_SIZE), imag: new Float64Array(FFT_SIZE),
    synthesisReal: new Float64Array(FFT_SIZE), synthesisImag: new Float64Array(FFT_SIZE),
    lastPhase: new Float64Array(HALF_FFT + 1), trueBin: new Float64Array(HALF_FFT + 1)
  };
}

class PracticePitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "semitones", defaultValue: 0, minValue: -3, maxValue: 3, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.channels = [createChannel(), createChannel()];
    this.energy = new Float64Array(HALF_FFT + 1);
    this.phase = new Float64Array(HALF_FFT + 1);
    this.nextPhase = new Float64Array(HALF_FFT + 1);
    this.peaks = new Int32Array(HALF_FFT + 1);
    this.reset();
    this.port.onmessage = event => {
      if (event.data.type === "reset") this.reset();
    };
    this.port.postMessage({ type: "ready", latency: LATENCY / sampleRate });
  }

  reset() {
    this.sampleIndex = 0;
    this.nextStageAt = -1;
    this.phaseReady = false;
    this.phase.fill(0);
    for (let c = 0; c < 2; c++) {
      this.channels[c].input.fill(0);
      this.channels[c].output.fill(0);
      this.channels[c].lastPhase.fill(0);
    }
  }

  beginFrame(factor, start) {
    this.frameFactor = factor;
    this.frameStart = start;
    // Snapshot both channels together before the ring receives more samples.
    for (let c = 0; c < 2; c++) {
      const channel = this.channels[c];
      for (let i = 0; i < FFT_SIZE; i++) {
        channel.real[i] = channel.input[(start + i) & (FFT_SIZE - 1)] * HANN_WINDOW[i];
        channel.imag[i] = 0;
      }
    }
    fft(this.channels[0].real, this.channels[0].imag);
    this.stage = 1;
  }

  shiftSpectrum() {
    this.energy.fill(0);
    for (let c = 0; c < 2; c++) {
      const channel = this.channels[c];
      for (let bin = 0; bin <= HALF_FFT; bin++) {
        const phase = Math.atan2(channel.imag[bin], channel.real[bin]);
        let deviation = phase - channel.lastPhase[bin] - bin * PHASE_ADVANCE;
        deviation -= TWO_PI * Math.round(deviation / TWO_PI);
        channel.lastPhase[bin] = phase;
        channel.trueBin[bin] = bin + deviation / PHASE_ADVANCE;
        this.energy[bin] += channel.real[bin] ** 2 + channel.imag[bin] ** 2;
      }
      channel.synthesisReal.fill(0);
      channel.synthesisImag.fill(0);
    }

    let peakCount = 0, maximumEnergy = 0;
    for (let bin = 1; bin < HALF_FFT; bin++) {
      maximumEnergy = Math.max(maximumEnergy, this.energy[bin]);
      if (this.energy[bin] > this.energy[bin - 1] && this.energy[bin] >= this.energy[bin + 1]) {
        this.peaks[peakCount++] = bin;
      }
    }
    if (maximumEnergy < 1e-16) {
      this.phase.fill(0);
      this.phaseReady = false;
      return;
    }
    if (!peakCount) this.peaks[peakCount++] = 1;

    for (let p = 0; p < peakCount; p++) {
      const peak = this.peaks[p];
      const from = p ? Math.floor((this.peaks[p - 1] + peak) / 2) + 1 : 0;
      const to = p + 1 < peakCount ? Math.floor((peak + this.peaks[p + 1]) / 2) : HALF_FFT;
      // Use the dominant channel's estimate at this single resolved peak. Both
      // channels receive the SAME shift and phase rotation, preserving stereo.
      const left = this.channels[0], right = this.channels[1];
      const reference = left.real[peak] ** 2 + left.imag[peak] ** 2 >= right.real[peak] ** 2 + right.imag[peak] ** 2 ? left : right;
      const frequency = this.phaseReady ? reference.trueBin[peak] : peak;
      const shift = (this.frameFactor - 1) * frequency;
      // Carry phase by input region, including when a peak crosses a bin. Bound
      // it each frame so long playback never accumulates large phase arguments.
      let phase = this.frameFactor === 1 ? 0 : this.phase[peak] + shift * PHASE_ADVANCE;
      phase -= TWO_PI * Math.round(phase / TWO_PI);
      const cos = Math.cos(phase), sin = Math.sin(phase);
      for (let bin = from; bin <= to; bin++) {
        this.nextPhase[bin] = phase;
        const target = bin + shift, low = Math.floor(target), fraction = target - low;
        for (let c = 0; c < 2; c++) {
          const channel = this.channels[c];
          const real = channel.real[bin] * cos - channel.imag[bin] * sin;
          const imag = channel.real[bin] * sin + channel.imag[bin] * cos;
          // Interpolate the centred complex spectrum, not magnitudes or
          // frequencies. The alternating signs account for the window centre.
          if (low >= 0 && low <= HALF_FFT) {
            const weight = ((low - bin) & 1) ? fraction - 1 : 1 - fraction;
            channel.synthesisReal[low] += real * weight;
            channel.synthesisImag[low] += imag * weight;
          }
          if (low + 1 >= 0 && low + 1 <= HALF_FFT) {
            const weight = ((low + 1 - bin) & 1) ? -fraction : fraction;
            channel.synthesisReal[low + 1] += real * weight;
            channel.synthesisImag[low + 1] += imag * weight;
          }
        }
      }
    }
    this.phase.set(this.nextPhase);
    this.phaseReady = true;
  }

  synthesize(channel) {
    const real = channel.synthesisReal, imag = channel.synthesisImag;
    imag[0] = imag[HALF_FFT] = 0;
    for (let bin = 1; bin < HALF_FFT; bin++) {
      real[FFT_SIZE - bin] = real[bin];
      imag[FFT_SIZE - bin] = -imag[bin];
    }
    fft(real, imag, true);
    for (let i = 0; i < FFT_SIZE; i++) {
      channel.output[(this.frameStart + LATENCY + i) & (OUTPUT_RING_SIZE - 1)] += real[i] * HANN_WINDOW[i] / WINDOW_NORMALIZATION;
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!output.length) return true;
    const factor = 2 ** ((parameters.semitones[0] || 0) / 12);
    for (let frame = 0; frame < output[0].length; frame++) {
      const index = this.sampleIndex;
      for (let c = 0; c < 2; c++) {
        const source = input && input[Math.min(c, input.length - 1)];
        this.channels[c].input[index & (FFT_SIZE - 1)] = source ? source[frame] : 0;
      }
      // Four stages per hop: avoid four FFTs in a single render callback. The
      // extra hop of latency ensures every output is ready before it is read.
      if (index >= FFT_SIZE - 1 && (index - FFT_SIZE + 1) % HOP_SIZE === 0) {
        this.beginFrame(factor, index - FFT_SIZE + 1);
        this.nextStageAt = index + STAGE_SIZE;
      } else if (index === this.nextStageAt) {
        if (this.stage === 1) {
          fft(this.channels[1].real, this.channels[1].imag);
          this.shiftSpectrum();
        } else {
          this.synthesize(this.channels[this.stage - 2]);
        }
        this.stage++;
        this.nextStageAt = this.stage < 4 ? index + STAGE_SIZE : -1;
      }
      for (let c = 0; c < 2; c++) {
        const position = index & (OUTPUT_RING_SIZE - 1);
        if (c < output.length) output[c][frame] = this.channels[c].output[position];
        this.channels[c].output[position] = 0;
      }
      this.sampleIndex++;
    }
    return true;
  }
}

registerProcessor("practice-pitch-shifter", PracticePitchShifter);
