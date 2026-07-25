const fs = require('fs');
const path = require('path');

const sampleRate = 16_000;
const seconds = 6;
const sampleCount = sampleRate * seconds;
const tau = Math.PI * 2;

function randomSource(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function addPeriodicNoise(samples, random, count, minCycles, maxCycles, amplitude, slope = 0.5) {
  for (let harmonic = 0; harmonic < count; harmonic += 1) {
    const cycles = Math.round(minCycles + random() * (maxCycles - minCycles));
    const phase = random() * tau;
    const gain = amplitude * (0.35 + random() * 0.65) / Math.pow(harmonic + 1, slope);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] += Math.sin(tau * cycles * index / samples.length + phase) * gain;
    }
  }
}

function addCircularPulses(samples, random, count, minWidth, maxWidth, minCycles, maxCycles, amplitude) {
  for (let pulse = 0; pulse < count; pulse += 1) {
    const center = Math.floor(random() * samples.length);
    const width = Math.round(minWidth + random() * (maxWidth - minWidth));
    const cycles = Math.round(minCycles + random() * (maxCycles - minCycles));
    const phase = random() * tau;
    const gain = amplitude * (0.35 + random() * 0.65);
    for (let offset = -width; offset <= width; offset += 1) {
      const index = (center + offset + samples.length) % samples.length;
      const normalized = offset / width;
      const envelope = Math.pow(Math.cos(normalized * Math.PI / 2), 4);
      samples[index] += (
        Math.sin(tau * cycles * index / samples.length + phase)
        * envelope
        * gain
      );
    }
  }
}

function normalize(samples, peakTarget) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const scale = peak ? peakTarget / peak : 0;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.tanh(samples[index] * scale * 1.15) / Math.tanh(1.15);
  }
}

function createSamples(kind) {
  const random = randomSource({ rain: 0x5241494e, fire: 0x46495245, library: 0x4c494252 }[kind]);
  const samples = new Float64Array(sampleCount);
  if (kind === 'rain') {
    addPeriodicNoise(samples, random, 72, 90, 46_000, 0.42, 0.26);
    addCircularPulses(samples, random, 42, 18, 110, 5_500, 44_000, 0.48);
    normalize(samples, 0.58);
  } else if (kind === 'fire') {
    addPeriodicNoise(samples, random, 52, 4, 3_200, 0.5, 0.62);
    addCircularPulses(samples, random, 34, 8, 62, 1_000, 38_000, 0.85);
    normalize(samples, 0.55);
  } else {
    const humCycles = [288, 576, 1_152];
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] += (
        Math.sin(tau * humCycles[0] * index / samples.length) * 0.08
        + Math.sin(tau * humCycles[1] * index / samples.length + 0.7) * 0.035
        + Math.sin(tau * humCycles[2] * index / samples.length + 1.4) * 0.018
      );
    }
    addPeriodicNoise(samples, random, 38, 12, 8_000, 0.19, 0.72);
    addCircularPulses(samples, random, 8, 90, 520, 90, 9_000, 0.18);
    normalize(samples, 0.42);
  }
  return samples;
}

function encodeWave(samples) {
  const dataBytes = samples.length * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0);
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVE', 8);
  output.write('fmt ', 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    output.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return output;
}

const outputDirectory = __dirname;
for (const kind of ['rain', 'fire', 'library']) {
  fs.writeFileSync(
    path.join(outputDirectory, `focus-${kind}.wav`),
    encodeWave(createSamples(kind)),
  );
}
