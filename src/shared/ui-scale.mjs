export const uiScaleOptions = [100, 125, 150, 175];
export const uiScaleKey = 'tsmd_ui_scale_v1';
export function readUiScale(view = window) { try { const value=Number(view.localStorage.getItem(uiScaleKey)); return uiScaleOptions.includes(value)?value:100; } catch { return 100; } }
export function currentUiScale(view = window) { const value=Number(view.document.documentElement.dataset.uiScale);return uiScaleOptions.includes(value)?value/100:1; }
export function applyUiScale(value, view = window) { const percent=uiScaleOptions.includes(Number(value))?Number(value):100;const root=view.document.documentElement;root.dataset.uiScale=String(percent);root.style.zoom=String(percent/100);root.style.setProperty('--ui-scale',String(percent/100));view.dispatchEvent(new view.Event('resize'));return percent; }
export function saveUiScale(value, view = window) { const percent=applyUiScale(value,view);try{view.localStorage.setItem(uiScaleKey,String(percent));}catch{}return percent; }
