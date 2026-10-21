import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const defaults = { width: 1320, height: 880 };
const minimum = { width: 1040, height: 700 };
const validRectangle = bounds => bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]) && Math.abs(bounds[key]) < 1e7) && bounds.width > 0 && bounds.height > 0;
const rectangle = bounds => Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(bounds[key])]));
const intersection = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Electron window bounds and display work areas both use device-independent pixels.
export function fitWindowState(saved, workAreas, primaryArea) {
  const areas = workAreas.filter(validRectangle).map(rectangle);
  const primary = validRectangle(primaryArea) ? rectangle(primaryArea) : areas[0] || { x: 0, y: 0, width: 1920, height: 1080 };
  if (!areas.length) areas.push(primary);
  const previous = saved?.version === 1 && validRectangle(saved.bounds) ? rectangle(saved.bounds) : null;
  const matching = previous ? areas.reduce((best, area) => intersection(previous, area) > intersection(previous, best) ? area : best, areas[0]) : primary;
  const visible = previous && intersection(previous, matching) > 0;
  const area = visible ? matching : primary;
  const minWidth = Math.min(minimum.width, area.width); const minHeight = Math.min(minimum.height, area.height);
  const width = clamp(previous?.width || defaults.width, minWidth, area.width);
  const height = clamp(previous?.height || defaults.height, minHeight, area.height);
  return {
    bounds: {
      x: visible ? clamp(previous.x, area.x, area.x + area.width - width) : area.x + Math.floor((area.width - width) / 2),
      y: visible ? clamp(previous.y, area.y, area.y + area.height - height) : area.y + Math.floor((area.height - height) / 2),
      width, height
    },
    minWidth, minHeight, maximized: !!previous && saved.maximized === true
  };
}

export function loadWindowState(file, workAreas, primaryArea) {
  let saved; try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  return fitWindowState(saved, workAreas, primaryArea);
}

export function rememberWindowState(window, file, initial, onError = () => {}) {
  let current = { version: 1, bounds: { ...initial.bounds }, maximized: initial.maximized === true };
  let timer; let lastSaved; let disposed = false;
  function capture() {
    if (disposed || window.isDestroyed() || window.isMinimized()) return;
    const bounds = window.getNormalBounds();
    if (validRectangle(bounds)) current = { version: 1, bounds: rectangle(bounds), maximized: window.isMaximized() };
  }
  function save() {
    clearTimeout(timer); timer = undefined;
    if (disposed || window.isDestroyed()) return false;
    capture(); const serialized = JSON.stringify(current);
    if (serialized === lastSaved) return true;
    const temporary = file + '.tmp';
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temporary, serialized, 'utf8'); renameSync(temporary, file);
      lastSaved = serialized; return true;
    } catch {
      try { unlinkSync(temporary); } catch {}
      onError(); return false;
    }
  }
  function schedule() {
    if (disposed || window.isDestroyed()) return;
    capture(); clearTimeout(timer); timer = setTimeout(save, 250); timer.unref?.();
  }
  const changes = ['resize', 'move', 'maximize', 'unmaximize', 'restore'];
  const flushes = ['close', 'query-session-end', 'session-end'];
  function dispose() {
    disposed = true; clearTimeout(timer);
    for (const event of changes) window.removeListener(event, schedule);
    for (const event of flushes) window.removeListener(event, save);
    window.removeListener('closed', dispose);
  }
  for (const event of changes) window.on(event, schedule);
  for (const event of flushes) window.on(event, save);
  window.once('closed', dispose);
  return { save, dispose };
}
