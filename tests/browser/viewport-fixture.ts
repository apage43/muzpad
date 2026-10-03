/** Isolated, built-in-only producer/delivery/layout profiling fixture; never user music. */
export function viewportProfileSource({ tracks = 140, buses = 150, repeats = 64, kitLanes = 32 } = {}) {
  const melodic = Array.from({ length: tracks }, (_, i) =>
    `track("lane${i}",stack([note(${i % 2 ? 0 : 127},${repeats * 4}b),phrase("C4:q E4:q G4:q B4:q").repeat(${repeats})]),synth("init"))`);
  if (kitLanes) {
    const lanes = Array.from({ length: kitLanes }, (_, i) =>
      `phrase("C4:q").map_notes(fn(n)=>{voice:"hit${i}",velocity:0.5})`);
    const voices = Array.from({ length: kitLanes }, (_, i) => `"hit${i}":synth("init")`);
    melodic.push(`track("profilekit",stack([${lanes.join(",")}]).repeat(${repeats}),kit("profile",{${voices.join(",")}}))`);
  }
  const routing = Array.from({ length: buses }, (_, i) => `bus("route${i}",[])`);
  return `song({tempo:120,tracks:[${melodic.join(",")}],buses:[${routing.join(",")}],tail:0})`;
}
