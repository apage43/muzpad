const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createEngine(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports;
  return {
    call(message) {
      const input = encoder.encode(JSON.stringify(message));
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
}
