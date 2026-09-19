import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const script = await readFile(
  new URL("../public/player-worklet.js", import.meta.url),
  "utf8",
);
test("audio output drains exact PCM order, freezes on pause, and discards an old seek epoch", () => {
  let Player;
  const messages = [];
  const context = vm.createContext({
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { postMessage: (x) => messages.push(x) };
    },
    registerProcessor: (_, p) => {
      Player = p;
    },
  });
  vm.runInContext(script, context);
  const player = new Player();
  player.source = { postMessage() {} };
  const packet = (epoch, value, done = false) => ({
    type: "audio",
    epoch,
    audio: new Float32Array(256).fill(value),
    meta: {
      frames: 128,
      startBeat: 0,
      startSeconds: 0,
      meters: [],
      status: { beat: 0.01, bpm: 120, done },
    },
  });
  player.receive({ type: "reset", epoch: 2, status: { beat: 0 } });
  player.receive(packet(1, 0.9));
  for (let i = 0; i < 8; i++) player.receive(packet(2, 0.25));
  let left = new Float32Array(128),
    right = new Float32Array(128);
  player.process([], [[left, right]]);
  assert.ok(left.every((v) => v === 0));
  player.playing = true;
  player.process([], [[left, right]]);
  assert.ok(left.every((v) => v >= 0 && v <= 0.25));
  assert.deepEqual(left, right);
  player.process([], [[left, right]]);
  player.process([], [[left, right]]);
  assert.ok(left.every((v) => v === 0.25));
  player.receive({ type: "reset", epoch: 3, status: { beat: 4 } });
  player.receive(packet(2, 0.9));
  player.receive(packet(3, 0.1, true));
  player.process([], [[left, right]]);
  assert.ok(left.every((v) => v <= 0.1));
  assert.equal(player.playing, false);
  assert.equal(messages.at(-1).type, "ended");
});

test("selected analysis PCM is synchronized and never mixed into audible output", () => {
  let Player;
  vm.runInNewContext(script, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { postMessage() {} };
    },
    registerProcessor: (_, p) => {
      Player = p;
    },
  });
  const p = new Player();
  p.source = { postMessage() {} };
  p.playing = p.primed = true;
  p.gain = 1;
  p.analysis = "lead";
  const audio = new Float32Array(512);
  audio.fill(0.25, 0, 256);
  audio.fill(0.75, 256);
  p.receive({
    type: "audio",
    epoch: 0,
    analysis: "lead",
    audio,
    meta: { frames: 128, startBeat: 0, startSeconds: 0, status: { beat: 1 } },
  });
  const master = [new Float32Array(128), new Float32Array(128)],
    monitor = [new Float32Array(128), new Float32Array(128)];
  p.process([], [master, monitor]);
  assert.ok(master[0].every((v) => v === 0.25));
  assert.ok(monitor[0].every((v) => v === 0.75));
  p.analysis = "bass";
  monitor.forEach((v) => v.fill(0));
  p.receive({
    type: "audio",
    epoch: 0,
    analysis: "lead",
    audio,
    meta: { frames: 128, startBeat: 1, startSeconds: 0, status: { beat: 2 } },
  });
  p.process([], [master, monitor]);
  assert.ok(
    monitor[0].every((v) => v === 0),
    "stale selection is silent until matching buffers arrive",
  );
  assert.ok(master[0].every((v) => v === 0.25));
});

test("an old queued done block cannot stop a newer accepted revision", () => {
  let Player;
  const messages = [];
  vm.runInNewContext(script, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { postMessage: (x) => messages.push(x) };
    },
    registerProcessor: (_, p) => {
      Player = p;
    },
  });
  const p = new Player();
  p.source = { postMessage() {} };
  p.playing = p.primed = true;
  p.gain = 1;
  p.receive({ type: "revision", epoch: 0, revision: 2 });
  const packet = (revision, done, value) => ({
    type: "audio",
    epoch: 0,
    audio: new Float32Array(256).fill(value),
    meta: {
      frames: 128,
      startBeat: 0,
      startSeconds: 0,
      meters: [],
      status: { revision, beat: revision, bpm: 120, done },
    },
  });
  p.receive(packet(1, true, 0.1));
  p.receive(packet(2, false, 0.2));
  const output = [new Float32Array(128), new Float32Array(128)];
  p.process([], [output]);
  assert.equal(p.playing, true);
  assert.equal(
    messages.some((x) => x.type === "ended"),
    false,
  );
  p.process([], [output]);
  assert.equal(p.status.revision, 2);
  assert.ok(output[0].every((v) => Math.abs(v - 0.2) < 1e-6));
});

test("queued structural fade tapers the old tail and new head without dropping blocks", () => {
  let Player;
  vm.runInNewContext(script, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { postMessage() {} };
    },
    registerProcessor: (_, p) => {
      Player = p;
    },
  });
  const p = new Player();
  p.source = { postMessage() {} };
  p.playing = p.primed = true;
  p.gain = 1;
  const packet = (revision, value) => ({
    type: "audio",
    epoch: 0,
    audio: new Float32Array(256).fill(value),
    meta: {
      frames: 128,
      startBeat: 0,
      startSeconds: 0,
      meters: [],
      status: { revision, beat: revision, bpm: 120, done: false },
    },
  });
  const old = packet(1, 0.5),
    next = packet(2, 0.5);
  p.receive(old);
  p.receive({ type: "revision", epoch: 0, revision: 2, queuedFade: true });
  p.receive(next);
  assert.equal(p.queue.length, 2);
  assert.equal(old.fadeOut, true);
  assert.equal(next.fadeIn, true);
  const output = [new Float32Array(128), new Float32Array(128)];
  p.process([], [output]);
  assert.ok(output[0][0] > 0.49);
  assert.equal(output[0][127], 0);
  p.process([], [output]);
  assert.equal(output[0][0], 0);
  assert.ok(output[0][127] > 0.49);
  assert.equal(p.queue.length, 0);
});
