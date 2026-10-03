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
