import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioPlayer } from "../src/audio.ts";

function playerFixture() {
  const player = new AudioPlayer();
  const messages = [];
  const requests = [];
  player.init = async () => {};
  player.context = { sampleRate: 48000 };
  player.worker = { postMessage: (message) => messages.push(message) };
  player.loaded = true;
  player.call = (message) =>
    new Promise((resolve, reject) =>
      requests.push({ message, resolve, reject }),
    );
  return { player, messages, requests };
}

test("superseded acceptance discards only its own request", async () => {
  const { player, messages, requests } = playerFixture();
  const first = player.accept({}, () => true);
  await Promise.resolve();
  const second = player.accept({}, () => true);
  await Promise.resolve();
  requests[0].resolve({});
  assert.equal(await first, null);
  assert.deepEqual(messages, [{ type: "discard", request: 1 }]);
  requests[1].resolve({});
  await Promise.resolve();
  assert.equal(requests[2].message.type, "apply");
  requests[2].resolve({ revision: 2, endBeat: 16 });
  assert.equal((await second).revision, 2);
});

test("commit boundary begins before apply and clears after rejection", async () => {
  const { player, requests } = playerFixture();
  let entered = false;
  const accepted = player.accept(
    {},
    () => true,
    [],
    () => {
      entered = true;
      assert.equal(player.committing, true);
      assert.equal(
        requests.length,
        1,
        "apply has not been sent before the guard",
      );
    },
  );
  await Promise.resolve();
  requests[0].resolve({});
  await Promise.resolve();
  assert.equal(entered, true);
  requests[1].reject(new Error("stale transport"));
  await assert.rejects(accepted, /stale transport/);
  assert.equal(player.committing, false);
  assert.equal(player.revision, 0);
});

test("cancellation before preparation returns cannot submit apply", async () => {
  const { player, requests } = playerFixture();
  const accepted = player.accept({}, () => true);
  await Promise.resolve();
  player.cancelPending();
  requests[0].resolve({});
  assert.equal(await accepted, null);
  assert.equal(requests.length, 1);
});

test("source authorization rejects before apply and discards the prepared candidate", async () => {
  const { player, messages, requests } = playerFixture();
  const accepted = player.accept({}, () => true, [], undefined, async () => {
    throw new Error("source conflict");
  });
  await Promise.resolve();
  requests[0].resolve({});
  await assert.rejects(accepted, /source conflict/);
  assert.equal(requests.length, 1);
  assert.deepEqual(messages, [{ type: "discard", request: 1 }]);
  assert.equal(player.revision, 0);
});

test("seek resolves only with acknowledged transport position", async () => {
  const { player, requests } = playerFixture();
  const pending = player.seek(4);
  assert.equal(player.beat, 0);
  assert.equal(requests[0].message.type, "seek");
  requests[0].resolve({ beat: 3, generation: 2 });
  assert.equal((await pending).beat, 3);
  assert.equal(player.beat, 3);
});

test("an abort after apply begins cannot turn accepted audio into a cancellation", async () => {
  const { player, requests } = playerFixture();
  let current = true;
  const pending = player.accept({}, () => current, [], () => { current = false; });
  await Promise.resolve();
  requests[0].resolve({});
  await Promise.resolve();
  assert.equal(requests[1].message.type, "apply");
  requests[1].resolve({ revision: 1, endBeat: 8 });
  assert.equal((await pending).revision, 1);
});

function analysisFixture(rate = 48000) {
  const player = new AudioPlayer();
  const analysers = [], messages = [], reads = [];
  const destination = {};
  const silent = {
    connected: false,
    connect(target) { assert.equal(target, destination); this.connected = true; return target; },
    disconnect() { this.connected = false; },
  };
  const context = {
    sampleRate: rate, currentTime: 0, state: "running", destination,
    resume: async () => {},
    createAnalyser() {
      const analyser = {
        connected: false, waveform: 0, decibels: -Infinity, bins: new Map(),
        connect(target) { this.connected = true; return target; },
        disconnect() { this.connected = false; },
        getFloatTimeDomainData(target) { reads.push(target); target.fill(this.waveform); },
        getFloatFrequencyData(target) {
          reads.push(target);
          target.fill(this.decibels);
          for (const [bin, value] of this.bins) target[bin] = value;
        },
      };
      analysers.push(analyser);
      return analyser;
    },
  };
  const links = new Set();
  player.context = context;
  player.silent = silent;
  player.worker = { postMessage: message => messages.push(message) };
  player.node = {
    port: { postMessage: message => messages.push(message) },
    connect(target, output) { if (output === 1) links.add(target); },
    disconnect(target, output) { if (output === 1) links.delete(target); },
  };
  player.playing = true;
  player.analysisGeneration = "0";
  player.setAnalysisEnabled(true);
  return {
    player, context, analysers, links, silent, messages, reads,
    confirm(ready = true, overrides = {}) {
      player.receivePosition({
        type: "analysisReady", captureId: player.analysisCapture.toString(),
        source: player.analysisSource, epoch: player.epoch, revision: player.revision,
        generation: Number(player.analysisGeneration ?? player.epoch), ready, ...overrides,
      });
    },
    warm() {
      context.currentTime += 2048 / rate + 0.001;
      this.confirm();
    },
  };
}

test("browser unsmoothed Blackman amplitudes have calibrated DC/interior scale at every rate", () => {
  for (const rate of [44100, 48000, 96000]) {
    const fixture = analysisFixture(rate);
    const { player, analysers, reads } = fixture;
    assert.equal(player.readAnalysis(), null, "startup zero padding is not a full window");
    const analyser = analysers.at(-1);
    assert.equal(analyser.fftSize, 2048);
    assert.equal(analyser.smoothingTimeConstant, 0);
    assert.equal(analyser.channelCount, 1);
    assert.equal(analyser.channelCountMode, "explicit");
    analyser.bins.set(0, 20 * Math.log10(0.25 * 0.42));
    analyser.bins.set(137, 20 * Math.log10(0.75 * 0.42 / 2));
    analyser.bins.set(1023, 20 * Math.log10(0.5 * 0.42 / 2));
    analyser.waveform = 0.25;
    fixture.warm();
    const first = player.readAnalysis();
    assert.ok(Math.abs(first.spectrum[0] - 0.25) < 1e-6);
    assert.ok(Math.abs(first.spectrum[137] - 0.75) < 1e-6);
    assert.ok(Math.abs(first.spectrum[1023] - 0.5) < 1e-6);
    assert.equal(first.peak, 0.25); assert.equal(first.rms, 0.25);
    assert.equal(first.spectrum.length, 1024, "Web Audio does not expose Nyquist");
    assert.equal(first.sampleCount, 2048);
    assert.equal(first.sampleRate, rate);
    assert.equal(first.windowEndSample, null, "no invented exact analyser clock");
    assert.equal(first.window, "blackman");
    assert.equal(first.smoothing, 0);
    analyser.bins.clear();
    analyser.waveform = 0;
    const second = player.readAnalysis();
    assert.ok(second.spectrum.every(value => value === 0));
    assert.equal(second.peak, 0); assert.equal(second.rms, 0);
    assert.ok(BigInt(second.sequence) > BigInt(first.sequence));
    assert.equal(reads[0], reads[2], "reuse time-domain compute storage");
    assert.equal(reads[1], reads[3], "reuse frequency compute storage");
    assert.notEqual(first.spectrum, second.spectrum, "published snapshots remain immutable");
    assert.ok(Math.abs(first.spectrum[137] - 0.75) < 1e-6);
  }
});

test("nonfinite browser data is finite silence at the analysis boundary", () => {
  const fixture = analysisFixture();
  const analyser = fixture.analysers.at(-1);
  analyser.waveform = NaN;
  analyser.bins.set(0, Infinity);
  analyser.bins.set(1, NaN);
  fixture.warm();
  const frame = fixture.player.readAnalysis();
  assert.ok(frame.waveform.every(value => value === 0));
  assert.ok(frame.spectrum.every(value => value === 0));
  assert.equal(frame.peak, 0); assert.equal(frame.rms, 0);
});

test("hidden detail disconnects the entire analyser graph without pausing audio or meters", () => {
  const fixture = analysisFixture();
  fixture.warm();
  const before = fixture.player.readAnalysis();
  fixture.player.setAnalysisEnabled(false);
  assert.equal(fixture.links.size, 0);
  assert.equal(fixture.silent.connected, false);
  assert.equal(fixture.player.analyser, undefined);
  assert.equal(fixture.player.playing, true);
  assert.equal(fixture.player.readAnalysis(), null);
  assert.ok(fixture.messages.some(message => message.type === "analysis" && message.enabled === false));
  fixture.player.setAnalysisEnabled(true);
  assert.equal(fixture.links.size, 1);
  assert.equal(fixture.player.readAnalysis(), null);
  fixture.warm();
  assert.ok(BigInt(fixture.player.readAnalysis().captureId) > BigInt(before.captureId));
});

test("selection, pause/resume, acknowledged seek and acceptance replace browser history", async () => {
  const fixture = analysisFixture();
  const { player } = fixture;
  fixture.warm();
  const initial = player.readAnalysis();
  player.selectAnalysis("track");
  assert.equal(player.readAnalysis(), null);
  fixture.warm();
  const selected = player.readAnalysis();
  assert.ok(BigInt(selected.captureId) > BigInt(initial.captureId));
  player.pause();
  assert.equal(player.readAnalysis(), null);
  await player.play();
  assert.equal(player.readAnalysis(), null);
  fixture.warm();
  let acknowledge;
  player.call = () => new Promise(resolve => { acknowledge = resolve; });
  const seeking = player.seek(4);
  assert.equal(player.readAnalysis(), null, "pending seek cannot relabel old analysis");
  acknowledge({ beat: 4, generation: 2 });
  await seeking;
  assert.equal(player.readAnalysis(), null);
  fixture.warm();
  const sought = player.readAnalysis();
  assert.ok(BigInt(sought.captureId) > BigInt(selected.captureId));
  player.committing = true;
  assert.equal(player.readAnalysis(), null, "apply barrier blocks previous accepted analyser data");
  player.committing = false;
  player.init = async () => {};
  player.loaded = true;
  player.call = async message => message.type === "apply" ? { revision: 2, endBeat: 16 } : {};
  await player.accept({}, () => true);
  assert.equal(player.readAnalysis(), null);
  fixture.warm();
  assert.ok(BigInt(player.readAnalysis().captureId) > BigInt(sought.captureId));
});

test("meter capture control is independent of detailed analyser visibility", () => {
  const fixture = analysisFixture();
  const { player, messages } = fixture;
  player.setMetersEnabled(true, 20);
  player.setAnalysisEnabled(false);
  assert.equal(player.playing, true);
  assert.equal(player.readAnalysis(), null);
  assert.deepEqual(messages.filter(message => message.type === "meters" && "hz" in message), [
    { type: "meters", enabled: true, hz: 20 },
  ]);
  player.setAnalysisEnabled(true);
  player.setMetersEnabled(false, 0);
  assert.equal(player.playing, true);
  assert.equal(fixture.links.size, 1, "disabling meters does not disconnect detail");
  assert.deepEqual(messages.filter(message => message.type === "meters" && "hz" in message), [
    { type: "meters", enabled: true, hz: 20 }, { type: "meters", enabled: false, hz: 0 },
  ]);
  assert.ok(messages.some(message => message.type === "meters" && !("hz" in message) && !message.enabled),
    "disable immediately clears worklet retained meters");
});

test("meter cadence changes are finite and bounded independently of detail", () => {
  const { player, messages } = analysisFixture();
  for (const hz of [NaN, Infinity, -1, 21, 0.5, 0])
    assert.throws(() => player.setMetersEnabled(true, hz), RangeError);
  player.setMetersEnabled(true, 20);
  player.setMetersEnabled(true, 10);
  player.setMetersEnabled(true, 10);
  assert.deepEqual(messages.filter(message => message.type === "meters" && "hz" in message), [
    { type: "meters", enabled: true, hz: 20 }, { type: "meters", enabled: true, hz: 10 },
  ]);
});

test("elapsed graph time cannot warm rejected queued-source prefixes or stale capture identities", () => {
  const fixture = analysisFixture();
  const { player, context } = fixture;
  const invalidated=[];
  player.onAnalysisInvalidated=captureId=>invalidated.push(captureId);
  context.currentTime = 60;
  assert.equal(player.readAnalysis(), null, "old-source queue drainage is not matching capture");
  const capture = player.analysisCapture.toString();
  fixture.confirm(true, { captureId: "0" });
  fixture.confirm(true, { source: "old-track" });
  fixture.confirm(true, { revision: player.revision + 1 });
  fixture.confirm(true, { epoch: player.epoch + 1 });
  assert.equal(player.readAnalysis(), null, "all capture authorities must match");
  fixture.confirm();
  assert.ok(player.readAnalysis(), "only worklet's full matching contiguous window enables reads");
  fixture.confirm(false);
  assert.equal(player.readAnalysis(), null, "starved or mismatched capture retires readiness");
  assert.deepEqual(invalidated,[capture],"readiness loss invalidates published detail immediately");
  fixture.confirm(false);
  assert.deepEqual(invalidated,[capture],"repeated false readiness does not queue invalidation work");
  fixture.confirm();
  player.selectAnalysis("new-track");
  assert.equal(invalidated.at(-1),player.analysisCapture.toString(),"source reset invalidates the prior presented capture");
  context.currentTime += 60;
  fixture.confirm(true, { captureId: capture, source: null });
  assert.equal(player.readAnalysis(), null, "selection reset rejects old ready signal regardless of age");
  fixture.confirm();
  assert.ok(player.readAnalysis());
  player.analysisGeneration = "4";
  fixture.confirm(true, { generation: 3 });
  assert.equal(player.readAnalysis(), null, "loop/discontinuity generation cannot revive prior capture");
});

test("readiness before a new generation's position cannot relabel analyser data as the old generation", () => {
  const fixture = analysisFixture();
  const { player } = fixture;
  fixture.warm();
  assert.ok(player.readAnalysis());
  fixture.confirm(false, { generation: 1 });
  assert.equal(player.readAnalysis(), null, "new-generation false retires old readiness immediately");
  fixture.confirm(true, { generation: 1 });
  assert.equal(player.readAnalysis(), null, "readiness cannot advance the transport identity on its own");
  player.receivePosition({ type: "position", epoch: player.epoch, generation: 1, beat: 0 });
  assert.equal(player.readAnalysis(), null, "position establishes generation and resets capture token");
  fixture.confirm();
  assert.ok(player.readAnalysis());
});
