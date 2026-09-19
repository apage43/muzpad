const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createEngine(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports;
  const assets = new Map();
  const engine = {
    call(message) {
      if (message.command === "assets") {
        const entries = message.entries ?? [];
        if (entries.length > 256) throw new Error("Too many assets");
        const manifest = entries.map(({ path, version }) => ({
          path,
          version,
        }));
        engine.call({ command: "asset_prune", entries: manifest });
        // Pruning may remove cached versions even if a subsequent upload fails.
        for (const [path, version] of assets) {
          if (
            !manifest.some(
              (entry) => entry.path === path && entry.version === version,
            )
          )
            assets.delete(path);
        }
        for (const entry of entries) {
          if (assets.get(entry.path) === entry.version) continue;
          const bytes =
            entry.bytes instanceof Uint8Array
              ? entry.bytes
              : new Uint8Array(entry.bytes);
          if (bytes.length > 16_000_000) throw new Error("Asset exceeds 16 MB");
          const ptr = wasm.alloc(bytes.length);
          try {
            new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
            if (!wasm.asset_bytes(ptr, bytes.length))
              throw new Error("Asset upload rejected");
            engine.call({
              command: "asset_put",
              path: entry.path,
              version: entry.version,
            });
          } finally {
            wasm.dealloc(ptr, bytes.length);
          }
        }
        message = { command: "asset_manifest", entries: manifest };
      }
      const input = encoder.encode(JSON.stringify(message));
      if (input.length > 256 * 1024 * 1024)
        throw new Error("Browser request exceeds byte limit");
      const ptr = wasm.alloc(input.length);
      let response;
      try {
        new Uint8Array(wasm.memory.buffer, ptr, input.length).set(input);
        const len = wasm.request(ptr, input.length);
        response = JSON.parse(
          decoder.decode(
            new Uint8Array(wasm.memory.buffer, wasm.response_ptr(), len),
          ),
        );
      } finally {
        wasm.dealloc(ptr, input.length);
      }
      if (!response.ok) {
        const error = new Error(response.error.message);
        error.diagnostic = response.error;
        throw error;
      }
      if (message.command === "asset_manifest") {
        assets.clear();
        for (const entry of message.entries)
          assets.set(entry.path, entry.version);
      }
      return response.value;
    },
    audio(frames, target, analysis = false) {
      const samples = new Float32Array(
        wasm.memory.buffer,
        analysis ? wasm.analysis_ptr() : wasm.pcm_ptr(),
        frames * 2,
      );
      if (target) {
        target.set(samples);
        return target;
      }
      return samples.slice();
    },
    memoryBytes() {
      return wasm.memory.buffer.byteLength;
    },
  };
  return engine;
}
