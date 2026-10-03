/** Grab a scrollable graph, including its nodes, without turning drags into clicks. */
export function enableGraphPanning(
  viewport: HTMLElement,
  onPan: () => void = () => {},
) {
  let gesture:
    | {
        pointer: number;
        x: number;
        y: number;
        left: number;
        top: number;
        dragging: boolean;
      }
    | undefined;
  let suppressClick = false;
  let frame = 0;
  let pending: { left: number; top: number } | undefined;
  const applyScroll = () => {
    frame = 0;
    if (!pending) return;
    const { left, top } = pending;
    pending = undefined;
    if (viewport.scrollLeft !== left) viewport.scrollLeft = left;
    if (viewport.scrollTop !== top) viewport.scrollTop = top;
  };

  viewport.addEventListener("pointerdown", (event) => {
    suppressClick = false;
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      (event.target instanceof Element &&
        !!event.target.closest("button, input, select, a")) ||
      !viewport.classList.contains("pannable")
    )
      return;
    const rect = viewport.getBoundingClientRect();
    // Leave the native scrollbars available too.
    if (
      event.clientX >= rect.left + viewport.clientWidth ||
      event.clientY >= rect.top + viewport.clientHeight
    )
      return;
    gesture = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      dragging: false,
    };
  });

  window.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const dx = event.clientX - gesture.x,
      dy = event.clientY - gesture.y;
    if (!gesture.dragging && Math.hypot(dx, dy) < 4) return;
    if (!gesture.dragging) {
      gesture.dragging = true;
      onPan();
      // Delaying capture preserves the original node target on ordinary clicks.
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add("panning");
    }
    event.preventDefault();
    pending = {
      left: Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, gesture.left - dx)),
      top: Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, gesture.top - dy)),
    };
    if (!frame) frame = requestAnimationFrame(applyScroll);
  });

  const finish = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    cancelAnimationFrame(frame);
    applyScroll();
    suppressClick = gesture.dragging;
    gesture = undefined;
    viewport.classList.remove("panning");
    if (viewport.hasPointerCapture(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
  };
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  viewport.addEventListener("lostpointercapture", finish);
  viewport.addEventListener(
    "click",
    (event) => {
      if (!suppressClick || event.detail === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = false;
    },
    true,
  );
}
