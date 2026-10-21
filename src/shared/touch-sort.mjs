// Pointer capture on the grip leaves normal list scrolling available elsewhere.
export function touchSort({ selector, begin, over, drop, end }) {
  let active = null;
  function cancel() {
    if (!active) return;
    const previous = active; active = null;
    try { previous.handle.releasePointerCapture(previous.id); } catch {}
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); end();
  }
  function target(event) { return document.elementFromPoint(event.clientX, event.clientY)?.closest(selector)?.dataset.sortId; }
  function move(event) { if (!active || event.pointerId !== active.id) return; event.preventDefault(); const id = target(event); if (id) { active.target = id; over(event, id); } }
  function finish(event) { if (!active || event.pointerId !== active.id) return; const id = target(event) || active.target; if (id) drop(event, id); cancel(); }
  function start(event, id) {
    if (active || event.pointerType === 'mouse' || event.isPrimary === false || !begin(event, id)) return;
    event.preventDefault(); active = { id: event.pointerId, target: id, handle: event.currentTarget };
    try { active.handle.setPointerCapture(event.pointerId); } catch {}
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel);
  }
  return { start, cancel };
}
