import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('async function ensurePracticePitchPipeline'), html.indexOf('function cancelPracticeCountIn'));

function environment({ failure = false, delayed = false } = {}) {
  const media = {}, track = { pitchSemitones: 2 };
  const state = { media, track, mediaPipelines: new Map(), pitchPipelinePromises: new Map(), pitchWorkletPromise: null };
  const nodes = [], sources = [], statuses = [], key = {};
  let resumes = 0, saves = 0, loads = 0;
  class Node {
    connections = [];
    connect(other) { this.connections.push(other); return other; }
    disconnect() { this.connections = []; }
  }
  const ctx = {
    currentTime: 12, destination: new Node(),
    audioWorklet: { addModule: async () => { loads++; } },
    createMediaElementSource: () => { const source = new Node(); sources.push(source); return source; }
  };
  class Worklet extends Node {
    constructor() {
      super();
      this.messages = [];
      this.port = { postMessage: message => this.messages.push(message), close() {} };
      this.values = [];
      this.parameters = new Map([['semitones', { setValueAtTime: value => this.values.push(value) }]]);
      nodes.push(this);
      if (!delayed) queueMicrotask(() => this.port.onmessage({ data: { type: failure ? 'error' : 'ready' } }));
    }
  }
  const api = new Function('practicePlayer', 'audioCtx', 'getAudioCtx', 'AudioWorkletNode', 'document', 'setPracticeStatus', 'saveCurrentPracticeTrack', code + ';return {applyPracticePitch, ensurePracticePitchPipeline, resetPracticePitch};')(
    state, ctx, async () => { resumes++; return ctx; }, Worklet,
    { getElementById: () => key }, message => statuses.push(message), () => saves++
  );
  return { ...api, state, media, track, ctx, nodes, sources, statuses, key, counts: () => ({ resumes, saves, loads }) };
}

test('concurrent initialization uses one source and the latest key', async () => {
  const e = environment();
  const first = e.applyPracticePitch();
  e.track.pitchSemitones = -3;
  await Promise.all([first, e.applyPracticePitch(), e.applyPracticePitch()]);
  assert.equal(e.sources.length, 1);
  assert.equal(e.nodes.length, 1);
  assert.deepEqual(e.nodes[0].values, [-3, -3, -3]);
  assert.deepEqual(e.sources[0].connections, [e.nodes[0]]);
  assert.deepEqual(e.nodes[0].connections, [e.ctx.destination]);
  assert.equal(e.counts().loads, 1);
});

test('zero key uses a real bypass and existing pipelines resume the context', async () => {
  const e = environment();
  e.track.pitchSemitones = 0;
  await e.applyPracticePitch();
  assert.equal(e.sources.length, 0, 'untouched native output');
  e.track.pitchSemitones = 1;
  await e.applyPracticePitch();
  const before = e.counts().resumes;
  e.track.pitchSemitones = 0;
  await e.applyPracticePitch();
  assert.equal(e.counts().resumes, before + 1);
  assert.deepEqual(e.sources[0].connections, [e.ctx.destination]);
  assert.deepEqual(e.nodes[0].connections, []);
  e.track.pitchSemitones = -1;
  await e.applyPracticePitch();
  assert.deepEqual(e.sources[0].connections, [e.nodes[0]]);
  assert.equal(e.sources.length, 1);
});

test('initialization failure leaves native output intact and allows retry', async () => {
  const e = environment({ failure: true });
  await assert.rejects(e.applyPracticePitch());
  assert.equal(e.sources.length, 0);
  assert.equal(e.state.pitchPipelinePromises.size, 0);
  await assert.rejects(e.applyPracticePitch());
  assert.equal(e.nodes.length, 2);
});

test('processor error routes to original audio and clears the selected key', async () => {
  const e = environment();
  await e.applyPracticePitch();
  e.nodes[0].onprocessorerror();
  assert.deepEqual(e.sources[0].connections, [e.ctx.destination]);
  assert.equal(e.track.pitchSemitones, 0);
  assert.equal(e.key.value, '0');
  assert.equal(e.counts().saves, 1);
  await e.applyPracticePitch();
  assert.equal(e.statuses.length, 1);
});

test('changing tracks during initialization cannot apply a stale key', async () => {
  const e = environment({ delayed: true });
  const pending = e.applyPracticePitch();
  while (!e.nodes.length) await new Promise(resolve => setImmediate(resolve));
  e.state.track = { pitchSemitones: -1 };
  e.nodes[0].port.onmessage({ data: { type: 'ready' } });
  await pending;
  assert.deepEqual(e.nodes[0].values, []);
  assert.deepEqual(e.sources[0].connections, [e.ctx.destination]);
  await e.applyPracticePitch();
  assert.deepEqual(e.nodes[0].values, [-1]);
});

test('seek and source lifecycle events reset the processor history', async () => {
  const e = environment();
  await e.applyPracticePitch();
  const before = e.nodes[0].messages.length;
  e.resetPracticePitch(e.media);
  assert.equal(e.nodes[0].messages.length, before + 1);
  assert.equal(e.nodes[0].messages.at(-1).type, 'reset');
  assert.match(html, /for \(const event of \["seeking", "emptied", "pause", "playing"\]\)/);
});
