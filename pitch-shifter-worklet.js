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
    this.ringLength = 16384;
    // 長めの窓と等パワー寄りのクロスフェードで、粒の切替周期に出る
    // ビブラート状のピッチ揺れを抑える。
    this.windowSamples = Math.min(8192, Math.max(2048, Math.round(sampleRate * 0.09)));
    this.buffers = [];
    this.writeIndex = 0;
    this.phaseA = 0;
    this.phaseB = 0.5;
  }

  ensureChannels(count) {
    while (this.buffers.length < count) this.buffers.push(new Float32Array(this.ringLength));
  }

  read(buffer, position) {
    let index = position;
    while (index < 0) index += this.ringLength;
    const lower = Math.floor(index) % this.ringLength;
    const upper = (lower + 1) % this.ringLength;
    const fraction = index - Math.floor(index);
    return buffer[lower] + (buffer[upper] - buffer[lower]) * fraction;
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
    const bypass = Math.abs(semitones) < 0.001;
    const phaseStep = bypass ? 0 : Math.abs(factor - 1) / this.windowSamples;

    for (let frame = 0; frame < output[0].length; frame++) {
      for (let channel = 0; channel < output.length; channel++) {
        const source = input[Math.min(channel, input.length - 1)];
        const sample = source ? source[frame] || 0 : 0;
        const buffer = this.buffers[channel];
        buffer[this.writeIndex] = sample;

        if (bypass) {
          output[channel][frame] = sample;
          continue;
        }

        const delayA = factor > 1
          ? (1 - this.phaseA) * this.windowSamples
          : this.phaseA * this.windowSamples;
        const delayB = factor > 1
          ? (1 - this.phaseB) * this.windowSamples
          : this.phaseB * this.windowSamples;
        const weightA = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * this.phaseA));
        const weightB = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * this.phaseB));
        const weightSum = Math.max(0.0001, weightA + weightB);
        const shiftedA = this.read(buffer, this.writeIndex - delayA);
        const shiftedB = this.read(buffer, this.writeIndex - delayB);
        output[channel][frame] = (shiftedA * weightA + shiftedB * weightB) / weightSum;
      }

      this.writeIndex = (this.writeIndex + 1) % this.ringLength;
      if (!bypass) {
        this.phaseA = (this.phaseA + phaseStep) % 1;
        this.phaseB = (this.phaseB + phaseStep) % 1;
      }
    }
    return true;
  }
}

registerProcessor("practice-pitch-shifter", PracticePitchShifter);
