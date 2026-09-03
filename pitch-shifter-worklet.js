const FFT_SIZE = 2048;
const HOP_SIZE = 512;
const HALF_FFT = FFT_SIZE >> 1;
const OUTPUT_RING_SIZE = FFT_SIZE * 4;
const TWO_PI = Math.PI * 2;
const WINDOW_NORMALIZATION = 1.5;

const HANN_WINDOW = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN_WINDOW[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / FFT_SIZE);
}

function fft(real, imag, inverse = false) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let width = 2; width <= size; width <<= 1) {
    const angle = (inverse ? TWO_PI : -TWO_PI) / width;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    const half = width >> 1;
    for (let offset = 0; offset < size; offset += width) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      for (let k = 0; k < half; k++) {
        const even = offset + k;
        const odd = even + half;
        const oddReal = real[odd] * twiddleReal - imag[odd] * twiddleImag;
        const oddImag = real[odd] * twiddleImag + imag[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imag[odd] = imag[even] - oddImag;
        real[even] += oddReal;
        imag[even] += oddImag;
        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < size; i++) {
      real[i] /= size;
      imag[i] /= size;
    }
  }
}

class PhaseVocoderChannel {
  constructor() {
    this.inputRing = new Float32Array(FFT_SIZE);
    this.outputRing = new Float32Array(OUTPUT_RING_SIZE);
    this.real = new Float64Array(FFT_SIZE);
    this.imag = new Float64Array(FFT_SIZE);
    this.lastPhase = new Float64Array(HALF_FFT + 1);
    this.sumPhase = new Float64Array(HALF_FFT + 1);
    this.analysisMagnitude = new Float64Array(HALF_FFT + 1);
    this.analysisBin = new Float64Array(HALF_FFT + 1);
    this.synthesisMagnitude = new Float64Array(HALF_FFT + 1);
    this.synthesisFrequencyTotal = new Float64Array(HALF_FFT + 1);
    this.sampleIndex = 0;
  }

  processFrame(factor, frameStart) {
    const { real, imag } = this;
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = this.inputRing[(frameStart + i) % FFT_SIZE];
      real[i] = sample * HANN_WINDOW[i];
      imag[i] = 0;
    }
    fft(real, imag);

    const expectedAdvance = TWO_PI * HOP_SIZE / FFT_SIZE;
    for (let bin = 0; bin <= HALF_FFT; bin++) {
      const magnitude = Math.hypot(real[bin], imag[bin]);
      const phase = Math.atan2(imag[bin], real[bin]);
      let deviation = phase - this.lastPhase[bin] - bin * expectedAdvance;
      this.lastPhase[bin] = phase;
      deviation -= TWO_PI * Math.round(deviation / TWO_PI);
      this.analysisMagnitude[bin] = magnitude;
      this.analysisBin[bin] = bin + deviation / expectedAdvance;
    }

    this.synthesisMagnitude.fill(0);
    this.synthesisFrequencyTotal.fill(0);
    for (let bin = 0; bin <= HALF_FFT; bin++) {
      const magnitude = this.analysisMagnitude[bin];
      const targetPosition = bin * factor;
      const targetLow = Math.floor(targetPosition);
      const fraction = targetPosition - targetLow;
      const trueTargetBin = this.analysisBin[bin] * factor;
      for (const [target, weight] of [[targetLow, 1 - fraction], [targetLow + 1, fraction]]) {
        if (target > HALF_FFT || weight <= 0) continue;
        const weightedMagnitude = magnitude * weight;
        this.synthesisMagnitude[target] += weightedMagnitude;
        this.synthesisFrequencyTotal[target] += weightedMagnitude * trueTargetBin;
      }
    }

    real.fill(0);
    imag.fill(0);
    for (let bin = 0; bin <= HALF_FFT; bin++) {
      const magnitude = this.synthesisMagnitude[bin];
      const trueBin = magnitude > 1e-12
        ? this.synthesisFrequencyTotal[bin] / magnitude
        : bin;
      this.sumPhase[bin] += trueBin * expectedAdvance;
      real[bin] = magnitude * Math.cos(this.sumPhase[bin]);
      imag[bin] = magnitude * Math.sin(this.sumPhase[bin]);
      if (bin > 0 && bin < HALF_FFT) {
        real[FFT_SIZE - bin] = real[bin];
        imag[FFT_SIZE - bin] = -imag[bin];
      }
    }
    fft(real, imag, true);

    const outputStart = frameStart + FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const position = (outputStart + i) % OUTPUT_RING_SIZE;
      this.outputRing[position] += real[i] * HANN_WINDOW[i] / WINDOW_NORMALIZATION;
    }
  }

  processSample(sample, factor) {
    const index = this.sampleIndex;
    this.inputRing[index % FFT_SIZE] = sample;
    if (index >= FFT_SIZE - 1 && (index - (FFT_SIZE - 1)) % HOP_SIZE === 0) {
      this.processFrame(factor, index - FFT_SIZE + 1);
    }
    const outputPosition = index % OUTPUT_RING_SIZE;
    const output = this.outputRing[outputPosition];
    this.outputRing[outputPosition] = 0;
    this.sampleIndex++;
    return output;
  }
}

class PracticePitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: "semitones",
      defaultValue: 0,
      minValue: -3,
      maxValue: 3,
      automationRate: "k-rate"
    }];
  }

  constructor() {
    super();
    this.channels = [];
  }

  ensureChannels(count) {
    while (this.channels.length < count) this.channels.push(new PhaseVocoderChannel());
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output.length) return true;
    if (!input.length) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    this.ensureChannels(output.length);
    const semitones = parameters.semitones[0] || 0;
    const factor = Math.pow(2, semitones / 12);
    for (let frame = 0; frame < output[0].length; frame++) {
      for (let channel = 0; channel < output.length; channel++) {
        const source = input[Math.min(channel, input.length - 1)];
        output[channel][frame] = this.channels[channel].processSample(source ? source[frame] || 0 : 0, factor);
      }
    }
    return true;
  }
}

registerProcessor("practice-pitch-shifter", PracticePitchShifter);
