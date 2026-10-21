import koffi from 'koffi';

function loadWindowsTimerApi() {
  const library = koffi.load('winmm.dll');
  return {
    begin: library.func('uint32_t __stdcall timeBeginPeriod(uint32_t)'),
    end: library.func('uint32_t __stdcall timeEndPeriod(uint32_t)')
  };
}

// Keep the finer Windows timer resolution scoped to active audio playback.
export function createAudioClock({ platform = process.platform, loadApi = loadWindowsTimerApi, onError = () => {} } = {}) {
  let api; let active = false; let unavailable = false;
  return {
    get active() { return active; },
    setActive(playing) {
      if (platform !== 'win32' || playing === active || (playing && unavailable)) return;
      try {
        if (playing) {
          api ||= loadApi();
          if (api.begin(1) !== 0) throw new Error('Windows audio timer unavailable');
          active = true;
        } else {
          api.end(1); active = false;
        }
      } catch {
        if (!unavailable) onError();
        unavailable = true;
      }
    },
    close() { this.setActive(false); }
  };
}
