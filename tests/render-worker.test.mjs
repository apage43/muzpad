import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { readFile } from "node:fs/promises";

const source = stripTypeScriptTypes(
  (await readFile(new URL("../src/render.worker.ts", import.meta.url), "utf8"))
    .replace(
      'import { createEngine } from "./engine.js";',
      "const createEngine = globalThis.__createEngine;",
    )
    .replace('new URL("../public/muz.wasm", import.meta.url)', '"wasm"'),
  { mode: "strip" },
);

async function harness({ renderError } = {}) {
  const calls = [],
    workerMessages = [],
    portMessages = [],
    timers = [];
  let revision = 0,
    generation = 0,
    pending,
    render = 0;
  const engine = {
    call(message) {
      calls.push(structuredClone(message));
      switch (message.command) {
        case "assets":
          return {};
        case "prepare":
          if (message.snapshot?.fail) throw new Error("prepare failed");
          pending = {
            request: message.request,
            generation,
            needs_fade: !!message.snapshot?.structural,
          };
          return { ...pending, base_revision: revision };
        case "discard":
          pending = undefined;
          return { discarded: true };
        case "apply":
          if (!pending || pending.request !== message.request)
            throw new Error("stale apply");
          revision++;
          pending = undefined;
          return { revision };
        case "status":
          return { revision, generation };
        case "seek":
          generation++;
          return { revision, generation };
        case "loop":
          return { revision, generation };
        case "render":
          if (renderError) throw renderError;
          return {
            frames: 1024,
            startBeat: render,
            startSeconds: render++,
            status: {
              revision,
              generation,
              done: false,
              beat: render,
              bpm: 120,
            },
            meters: [],
          };
      }
    },
    audio(_frames, target) {
      target.fill(revision + 0.25);
    },
  };
  const self = { postMessage: (x) => workerMessages.push(x), onmessage: null };
  let createCount = 0;
  const context = vm.createContext({
    __createEngine: async () => {
      createCount++;
      return engine;
    },
    self,
    structuredClone,
    Float32Array,
    ArrayBuffer,
    WebAssembly,
    performance: { now: () => 0 },
    fetch: async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
    URL,
    setTimeout: (fn) => {
      timers.push(fn);
    },
    console,
  });
  vm.runInContext(source, context);
  const port = { postMessage: (x) => portMessages.push(x), onmessage: null };
  self.onmessage({ data: { type: "connect", port } });
  const send = async (data) => {
    self.onmessage({ data });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const runTimers = async () => {
    while (timers.length) {
      timers.shift()();
      await Promise.resolve();
    }
  };
  return {
    calls,
    workerMessages,
    portMessages,
    port,
    send,
    runTimers,
    engine,
    get createCount() {
      return createCount;
    },
  };
}

test("worker retains one engine through prepare, discard, apply, and ordered revisions", async () => {
  const h = await harness();
  await h.send({
    type: "prepare",
    id: 1,
    request: 1,
    snapshot: {},
    base_revision: 0,
    rate: 48000,
  });
  await h.send({ type: "discard", id: 2 });
  await h.send({
    type: "prepare",
    id: 3,
    request: 2,
    snapshot: {},
    base_revision: 0,
    rate: 48000,
  });
  await h.send({ type: "apply", id: 4, request: 2 });
  await h.send({
    type: "prepare",
    id: 5,
    request: 3,
    snapshot: {},
    base_revision: 1,
    rate: 48000,
  });
  await h.send({ type: "apply", id: 6, request: 3 });
  assert.deepEqual(
    h.portMessages.filter((x) => x.type === "revision").map((x) => x.revision),
    [1, 2],
  );
  assert.ok(h.calls.some((x) => x.command === "discard"));
  assert.equal(h.createCount, 1);
  assert.equal(h.calls.filter((x) => x.command === "seek").length, 0);
});

test("a stale scoped discard cannot clear a newer prepared request", async () => {
  const h = await harness();
  await h.send({
    type: "prepare",
    request: 1,
    snapshot: {},
    base_revision: 0,
    rate: 48000,
  });
  await h.send({
    type: "prepare",
    request: 2,
    snapshot: {},
    base_revision: 0,
    rate: 48000,
  });
  await h.send({ type: "discard", request: 1 });
  await h.send({ type: "apply", id: 20, request: 2 });
  assert.equal(h.workerMessages.find((x) => x.id === 20).value.revision, 1);
  assert.deepEqual(
    h.portMessages.filter((x) => x.type === "revision").map((x) => x.revision),
    [1],
  );
});

test("transport races reject apply and old epoch credits cannot render", async () => {
  const h = await harness();
  await h.send({
    type: "prepare",
    request: 1,
    snapshot: {},
    base_revision: 0,
    rate: 48000,
  });
  await h.send({ type: "apply", request: 1 });
  await h.send({
    type: "prepare",
    id: 7,
    request: 2,
    snapshot: {},
    base_revision: 1,
    rate: 48000,
  });
  await h.send({ type: "seek", epoch: 4, beat: 2, range: null });
  await h.send({ type: "apply", id: 8, request: 2 });
  assert.match(
    h.workerMessages.find((x) => x.id === 8).error.message,
    /Transport changed/,
  );
  await h.runTimers();
  const before = h.portMessages.filter((x) => x.type === "audio").length;
  h.port.onmessage({ data: { type: "credit", epoch: 3 } });
  await h.runTimers();
  assert.equal(h.portMessages.filter((x) => x.type === "audio").length, before);
});

test("structural apply emits fade-out audio before revision and failed prepare recovers", async () => {
  const h = await harness();
  await h.send({
    type: "prepare",
    id: 1,
    request: 1,
    snapshot: { fail: true },
    base_revision: 0,
    rate: 48000,
  });
  assert.match(
    h.workerMessages.find((x) => x.id === 1).error.message,
    /prepare failed/,
  );
  await h.send({
    type: "prepare",
    request: 2,
    snapshot: {},
    base_revision: 0,
    rate: 48000,
  });
  await h.send({ type: "apply", request: 2 });
  h.port.onmessage({ data: { type: "credit", epoch: 0 } });
  await h.send({
    type: "prepare",
    request: 3,
    snapshot: { structural: true },
    base_revision: 1,
    rate: 48000,
  });
  await h.send({ type: "apply", request: 3 });
  const fadeCall = h.calls.findIndex(
    (x) => x.command === "render" && x.fade_out === true,
  );
  const applyCall = h.calls.findLastIndex((x) => x.command === "apply");
  assert.ok(fadeCall >= 0 && fadeCall < applyCall);
  const audioIndex = h.portMessages.findIndex((x) => x.type === "audio");
  const revisionIndex = h.portMessages.findLastIndex(
    (x) => x.type === "revision",
  );
  assert.ok(audioIndex >= 0 && audioIndex < revisionIndex);
  h.port.onmessage({ data: { type: "credit", epoch: 0 } });
  await h.runTimers();
  assert.ok(
    h.portMessages.slice(revisionIndex + 1).some((x) => x.type === "audio"),
  );
});

test("repeated structural applies at zero credits do not synthesize or consume PCM", async () => {
  const h = await harness();
  await h.send({
    type: "prepare",
    request: 1,
    snapshot: {},
    base_revision: 0,
    rate: 48000,
  });
  await h.send({ type: "apply", request: 1 });
  for (let request = 2; request <= 4; request++) {
    await h.send({
      type: "prepare",
      request,
      snapshot: { structural: true },
      base_revision: request - 1,
      rate: 48000,
    });
    await h.send({ type: "apply", request });
  }
  assert.equal(h.calls.filter((x) => x.command === "render").length, 0);
  assert.equal(h.portMessages.filter((x) => x.type === "audio").length, 0);
  assert.deepEqual(
    h.portMessages
      .filter((x) => x.type === "revision")
      .map((x) => !!x.queuedFade),
    [false, true, true, true],
  );
  assert.equal(h.createCount, 1);
  h.port.onmessage({ data: { type: "credit", epoch: 0 } });
  await h.runTimers();
  assert.equal(h.portMessages.filter((x) => x.type === "audio").length, 1);
});

test("a render-time WASM trap is fatal because continuity is lost", async () => {
  const h = await harness({
    renderError: new WebAssembly.RuntimeError("trap"),
  });
  await h.send({
    type: "prepare",
    request: 1,
    snapshot: {},
    base_revision: 0,
    rate: 48000,
  });
  await h.send({ type: "apply", request: 1 });
  h.port.onmessage({ data: { type: "credit", epoch: 0 } });
  await h.runTimers();
  const fatal = h.workerMessages.find((x) => x.type === "fatal");
  assert.match(fatal.error.message, /continuity was lost.*trap/);
});
