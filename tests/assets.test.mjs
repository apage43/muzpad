import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_LIMITS,
  assertSourceOnlyShareable,
  assetTransfers,
  createAsset,
  importArchiveEntries,
  normalizeProjectPath,
  projectArchiveEntries,
  verifiedAssetTransfers,
} from "../src/assets.js";

test("asset records are immutable, JSON-safe, content-versioned transfers", async () => {
  const input = Uint8Array.of(0, 1, 127, 255);
  const asset = await createAsset("assets/beat.MID", input);
  input[0] = 99;
  assert.equal(asset.format, "midi");
  assert.match(asset.version, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(asset), true);

  const restored = JSON.parse(JSON.stringify({ "assets/beat.MID": asset }));
  const [transfer] = await verifiedAssetTransfers(restored);
  assert.deepEqual([...transfer.bytes], [0, 1, 127, 255]);
  transfer.bytes[0] = 42;
  assert.deepEqual([...assetTransfers(restored)[0].bytes], [0, 1, 127, 255]);
});

test("archive entries round-trip text separately from MIDI, WAV and FLAC", async () => {
  const files = { "song.muz": "song({ tracks: [] })", "notes.md": "hi" };
  const assets = {
    "assets/a.mid": await createAsset("assets/a.mid", Uint8Array.of(1, 2)),
    "samples/a.wav": await createAsset("samples/a.wav", Uint8Array.of(3, 4)),
    "samples/a.flac": await createAsset("samples/a.flac", Uint8Array.of(5, 6)),
  };
  const entries = projectArchiveEntries(files, assets);
  const imported = await importArchiveEntries(entries);
  assert.deepEqual(imported.files, files);
  assert.deepEqual(
    Object.fromEntries(
      assetTransfers(imported.assets).map(({ path, bytes }) => [
        path,
        [...bytes],
      ]),
    ),
    {
      "assets/a.mid": [1, 2],
      "samples/a.wav": [3, 4],
      "samples/a.flac": [5, 6],
    },
  );
});

test("asset boundaries reject escapes, oversized collections and tampering", async () => {
  for (const path of ["../escape.wav", "/escape.wav", "a\\b.wav", "a//b.wav"])
    assert.throws(() => normalizeProjectPath(path), /project|escapes/);

  const asset = await createAsset("a.wav", Uint8Array.of(1));
  assert.throws(
    () =>
      assetTransfers(
        { "a.wav": asset, "b.wav": { ...asset } },
        { ...ASSET_LIMITS, maxFiles: 1 },
      ),
    /more than 1/,
  );
  await assert.rejects(
    verifiedAssetTransfers({ "a.wav": { ...asset, base64: "Ag==" } }),
    /version does not match/,
  );
  assert.throws(
    () => assertSourceOnlyShareable({ "a.wav": asset }),
    /Source-only sharing.*Export the project ZIP/,
  );
});
