<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
const props = defineProps({ request: { type: Function, required: true }, available: Boolean });
const emit = defineEmits(['logged-in']);
const frame = ref(null), error = ref(''), frameError = ref(''), busy = ref(false), input = ref('');
const viewport = ref(null), viewportSize = ref({ width: 0, height: 0 }), viewMode = ref('fit'), extraOpen = ref(false);
const keyboard = ref(null), keyboardFocused = ref(false);
const diagnosticCopied = ref(false);
let timer, inputTimer, alive = true, polling = false, refreshAgain = false, dragging = false, lastMove = 0, lastWheel = 0, sizeObserver;
let pendingInputs = [], sending = false, composing = false, activity = 0;
watch(viewport, element => {
  sizeObserver?.disconnect();
  if (!element) return;
  viewportSize.value = { width: element.clientWidth, height: element.clientHeight };
  sizeObserver = new ResizeObserver(entries => { const bounds = entries[0].contentRect; viewportSize.value = { width: bounds.width, height: bounds.height }; });
  sizeObserver.observe(element);
}, { flush: 'post' });
const screenStyle = computed(() => {
  if (!frame.value) return {};
  const scale = viewMode.value === 'actual' ? 1 : Math.max(0.01, Math.min(viewportSize.value.width / frame.value.width, viewportSize.value.height / frame.value.height));
  return { width: frame.value.width * scale + 'px', height: frame.value.height * scale + 'px' };
});
const loginHint = computed(() => ({
  confirmed: '官网已确认账号，可以保存登录会话。',
  'session-present': '官网已写入会话，账号页面尚未更新；点击“保存登录会话”会返回官网重新确认。',
  redirecting: '官网仍停在登录跳转，尚未写入登录会话。可点击“返回官网”检查登录结果。',
  waiting: '尚未检测到官网登录会话，请在网页中完成登录。',
  unknown: '官网正在切换页面，登录状态将自动重新检查。'
}[frame.value?.login?.state] || ''));
function update(value) { if (alive && value?.image?.startsWith('data:image/jpeg;base64,')) { frame.value = value; frameError.value = ''; } }
async function copyLoginDiagnostic() {
  const diagnostic = { kind: 'TS Music Desk official login diagnostics', capturedAt: new Date().toISOString(), login: frame.value?.login || { state: 'unknown' } };
  try { await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2)); diagnosticCopied.value = true; }
  catch { error.value = '诊断复制失败，请允许控制台访问剪贴板后重试'; }
}
async function operation(method, args = {}) {
  busy.value = true; error.value = '';
  try { const value = await props.request('auth.browser.' + method, args); update(value); return value; }
  catch (failure) { if (alive) error.value = failure.message || '官网浏览器操作失败，请重试'; }
  finally { if (alive) busy.value = false; }
}
function schedule() { clearTimeout(timer); if (alive && frame.value) timer = setTimeout(poll, 4000); }
async function poll() {
  if (!alive || !frame.value) return;
  if (polling) { refreshAgain = true; return; }
  if (busy.value || sending || pendingInputs.length) { refreshSoon(); return; }
  const nonce = frame.value.nonce, revision = activity;
  polling = true;
  try { const value = await props.request('auth.browser.frame'); if (frame.value?.nonce === nonce && revision === activity) update(value); else refreshAgain = true; }
  catch (failure) { if (alive && frame.value?.nonce === nonce) frameError.value = failure.message || '截图暂未更新，将自动重试'; }
  finally { polling = false; if (refreshAgain) { refreshAgain = false; refreshSoon(); } else schedule(); }
}
function refreshSoon() { clearTimeout(timer); if (alive && frame.value) timer = setTimeout(poll, 150); }
async function start() { const result = await operation('start'); if (result) schedule(); }
async function home() { await drain(); await operation('home'); schedule(); }
function send(args) {
  const nonce = frame.value?.nonce;
  if (!alive || !nonce) return Promise.resolve(false);
  if (pendingInputs.length >= 128) { error.value = '输入等待发送过多，请等画面更新后再输入'; return Promise.resolve(false); }
  activity++;
  return new Promise(resolve => {
    const previous = pendingInputs.at(-1);
    if (args.type === 'pointer' && args.event === 'mouseMoved' && previous?.args.event === 'mouseMoved') { previous.resolve(false); pendingInputs.pop(); }
    pendingInputs.push({ args, nonce, resolve });
    if (!sending && !inputTimer) inputTimer = setTimeout(flush, 50);
  });
}
async function flush() {
  clearTimeout(inputTimer); inputTimer = null;
  if (sending || !alive) return;
  sending = true;
  try {
    while (alive && pendingInputs.length) {
      const batch = pendingInputs.splice(0, 32);
      try {
        await props.request('auth.browser.input', { type: 'batch', events: batch.map(item => item.args), nonce: batch[0].nonce });
        batch.forEach(item => item.resolve(true));
      } catch (failure) {
        batch.forEach(item => item.resolve(false));
        pendingInputs.splice(0).forEach(item => item.resolve(false));
        if (alive) error.value = failure.message || '输入未发送，请重试';
        break;
      }
    }
  } finally { sending = false; refreshSoon(); }
}
async function drain() {
  // Enqueue a harmless empty insertion as an ordering barrier.
  if (frame.value) await send({ type: 'text', text: '' });
}
function focusKeyboard() { keyboard.value?.focus({ preventScroll: true }); }
function committedText(value) {
  const characters = [...value.replace(/\r\n?/g, '\n')].slice(0, 4096);
  for (let offset = 0; offset < characters.length; offset += 256) send({ type: 'text', text: characters.slice(offset, offset + 256).join('') });
}
function typing(event) {
  if (composing || event.isComposing) return;
  const value = event.target.value; event.target.value = '';
  if (value) committedText(value);
}
function compositionEnd(event) { composing = false; typing(event); }
function paste(event) { if (composing) return; event.preventDefault(); committedText(event.clipboardData?.getData('text/plain') || ''); }
function keydown(event) {
  event.stopPropagation();
  if (composing || event.isComposing || event.keyCode === 229) return;
  const shortcut = event.ctrlKey || event.metaKey;
  if (shortcut && event.key.toLowerCase() === 'v') return;
  if (shortcut && event.key.toLowerCase() === 'a') { event.preventDefault(); send({ type: 'key', key: 'a', modifiers: 2 }); return; }
  if (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault(); send({ type: 'key', key: event.key, modifiers: (event.shiftKey ? 8 : 0) | (shortcut ? 2 : 0) });
  } else if (shortcut || event.altKey) event.preventDefault();
}
function beforeInput(event) {
  // Mobile keyboards may send editing input without a keydown event.
  const key = { deleteContentBackward: 'Backspace', deleteContentForward: 'Delete', insertLineBreak: 'Enter', insertParagraph: 'Enter' }[event.inputType];
  if (!composing && key) { event.preventDefault(); send({ type: 'key', key }); }
}
function pointer(event, kind) {
  if (!frame.value || busy.value) return;
  if (kind === 'mouseMoved' && (!dragging || Date.now() - lastMove < 100)) return;
  if (kind === 'mousePressed') { focusKeyboard(); dragging = true; event.currentTarget.setPointerCapture(event.pointerId); }
  if (kind === 'mouseReleased') dragging = false;
  if (kind === 'mouseMoved') lastMove = Date.now();
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = Math.max(0, Math.min(frame.value.width, (event.clientX - bounds.left) / bounds.width * frame.value.width));
  const y = Math.max(0, Math.min(frame.value.height, (event.clientY - bounds.top) / bounds.height * frame.value.height));
  send({ type: 'pointer', event: kind, x, y });
}
async function text() { const value = input.value; input.value = ''; await send({ type: 'text', text: value }); await poll(); }
async function key(value) { await send({ type: 'key', key: value }); await poll(); }
async function scroll(delta) { await send({ type: 'scroll', delta }); await poll(); }
function wheel(event) {
  if (viewMode.value !== 'fit' || event.ctrlKey || !frame.value) return;
  event.preventDefault();
  if (Date.now() - lastWheel < 180) return; lastWheel = Date.now();
  send({ type: 'scroll', delta: Math.max(-800, Math.min(800, event.deltaY)) }).then(() => { clearTimeout(timer); timer = setTimeout(poll, 200); });
}
async function finish() { await drain(); const result = await operation('finish'); if (result?.loggedIn) emit('logged-in', result); }
function clearInput() { clearTimeout(inputTimer); inputTimer = null; pendingInputs.splice(0).forEach(item => item.resolve(false)); if (keyboard.value) keyboard.value.value = ''; input.value = ''; }
async function stop() { clearTimeout(timer); clearInput(); await operation('close'); frame.value = null; extraOpen.value = false; }
onBeforeUnmount(() => { alive = false; clearTimeout(timer); clearInput(); sizeObserver?.disconnect(); props.request('auth.browser.close').catch(() => {}); });
</script>

<template>
  <section class="official-browser-login" aria-label="服务器网易云官网登录">
    <div class="browser-guide"><span class="browser-guide-dot" aria-hidden="true"></span><p>点击官网输入框后，可直接打字、粘贴；支持中文输入法。</p><span class="browser-private">仅主人可见</span></div>
    <p v-if="error || frameError" class="browser-error" role="alert">{{ error || frameError }}</p>
    <template v-if="frame">
      <div class="browser-toolbar"><span class="browser-address" :title="frame.address">{{ frame.address }}</span><div class="browser-view-mode" role="group" aria-label="官网画面显示方式"><button :class="{ selected: viewMode === 'fit' }" :aria-pressed="viewMode === 'fit'" @click="viewMode = 'fit'">适应窗口</button><button :class="{ selected: viewMode === 'actual' }" :aria-pressed="viewMode === 'actual'" @click="viewMode = 'actual'">原始大小</button></div><button class="secondary" :disabled="busy" @click="poll">刷新画面</button><button class="secondary" :disabled="busy" @click="home">返回官网</button><button class="browser-close" :disabled="busy" @click="stop">关闭浏览器</button></div>
      <div v-if="loginHint" class="browser-login-state" :class="{ confirmed: frame.login?.state === 'confirmed' }"><p role="status">{{ loginHint }}</p><button class="secondary" @click="copyLoginDiagnostic">{{ diagnosticCopied ? '诊断已复制' : '复制登录诊断' }}</button></div>
      <div ref="viewport" class="browser-viewport" :class="{ 'actual-size': viewMode === 'actual' }" @wheel="wheel"><img class="browser-screen" :style="screenStyle" :src="frame.image" alt="服务器网易云官网的实时截图，点击输入框后可直接使用键盘" draggable="false" @pointerdown.prevent="pointer($event, 'mousePressed')" @pointermove.prevent="pointer($event, 'mouseMoved')" @pointerup.prevent="pointer($event, 'mouseReleased')" @pointercancel.prevent="pointer($event, 'mouseReleased')"><textarea ref="keyboard" class="browser-keyboard-capture" aria-label="官网键盘输入" autocomplete="off" autocapitalize="off" :spellcheck="false" @focus="keyboardFocused = true" @blur="keyboardFocused = false" @keydown="keydown" @beforeinput="beforeInput" @input="typing" @paste="paste" @compositionstart="composing = true" @compositionend="compositionEnd"></textarea></div>
      <div v-if="extraOpen" id="official-browser-tools" class="browser-extra"><div class="browser-keyboard"><button class="secondary" @click="scroll(-500)">网页上移</button><button class="secondary" @click="scroll(500)">网页下移</button><span></span><button class="secondary" @click="key('Tab')">Tab</button><button class="secondary" @click="key('Backspace')">退格</button><button class="secondary" @click="key('Enter')">回车</button><button class="secondary" @click="key('Escape')">Esc</button></div><form class="browser-text" @submit.prevent="text"><label>先点击官网输入框，再发送内容<input v-model="input" type="password" autocomplete="off" maxlength="256" placeholder="输入到官网当前光标处" aria-label="发送到官网输入框的内容"></label><button class="secondary" :disabled="!input || busy">发送输入</button></form></div>
      <footer class="browser-footer"><button class="secondary" :aria-expanded="extraOpen" aria-controls="official-browser-tools" @click="extraOpen = !extraOpen">{{ extraOpen ? '收起辅助操作' : '输入与网页滚动' }}</button><p>{{ keyboardFocused ? '键盘已连接官网，可直接输入' : '点击官网输入框即可使用键盘' }}<br><span>支持 Ctrl+V 粘贴、Tab 切换、回车确认。</span></p><button class="primary" :disabled="busy" @click="finish">{{ busy ? '正在保存…' : '保存登录会话' }}</button></footer>
    </template>
    <div v-else class="browser-empty"><span class="browser-empty-icon" aria-hidden="true">↗</span><h3>在服务器上打开网易云</h3><p>直接显示官网的真实页面，由你扫码或完成验证。</p><button class="primary" :disabled="busy || !available" @click="start">{{ busy ? '正在打开官网…' : '打开服务器官网登录页' }}</button><p v-if="!available" class="browser-hint">请先运行“安装官网登录组件.cmd”，完成后刷新控制台。</p><p v-else class="browser-hint">登录会话保存在服务器，电脑无需一直开机。</p></div>
  </section>
</template>

<style scoped>
.browser-login-state{display:flex;align-items:center;gap:12px;flex:none;font-size:12px;color:#bdc9d9;padding:8px 12px;background:#111925;border:1px solid #303c4c;border-radius:8px}.browser-login-state p{flex:1}.browser-login-state button{flex:none;font-size:11px;padding:6px 8px;white-space:nowrap}.browser-login-state.confirmed{color:#b4f777;border-color:#475f36}
.browser-viewport{position:relative}.browser-keyboard-capture{position:absolute;left:12px;top:12px;width:1px;height:1px;min-height:0;padding:0;border:0;opacity:0;pointer-events:none;font-size:16px;resize:none}
.official-browser-login{display:flex;flex-direction:column;gap:12px;min-height:0;min-width:0;flex:1}.official-browser-login p{margin:0;line-height:1.6}.browser-guide{display:flex;align-items:center;gap:9px;flex:none;font-size:12px;color:#aab7c8}.browser-guide-dot{width:6px;height:6px;background:#b4f777;border-radius:50%;flex:none}.browser-private{margin-left:auto;font-size:11px;white-space:nowrap;color:#80938c}.browser-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:none;padding:9px 12px;border:1px solid #303c4c;border-radius:10px;background:#111925}.browser-toolbar button,.browser-keyboard button{font-size:12px;padding:7px 10px;white-space:nowrap}.browser-address{min-width:90px;flex:1;color:#93a5b9;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.browser-view-mode{display:flex;padding:3px;border:1px solid #354153;border-radius:7px;gap:2px}.browser-view-mode button{background:transparent;color:#93a5b9;border:0;padding:5px 9px;border-radius:4px;font-size:11px}.browser-view-mode .selected{background:#2d3e2a;color:#c4f69a}.browser-close{color:#a0adbd;background:transparent;border:0}.browser-viewport{display:flex;align-items:center;justify-content:center;flex:1;min-height:0;min-width:0;overflow:hidden;background:#090e16;border:1px solid #303c4c;border-radius:10px}.browser-screen{display:block;flex:none;touch-action:none;user-select:none;cursor:default;background:#fff}.browser-viewport.actual-size{display:block;overflow:auto;scrollbar-width:thin}.actual-size .browser-screen{margin:0 auto}.browser-error{color:#ffb2a5;flex:none;max-height:64px;overflow:auto;font-size:12px;background:#2a1c22;border:1px solid #654047;border-radius:8px;padding:9px 12px}.browser-extra{flex:none;border:1px solid #303c4c;border-radius:10px;padding:12px;background:#111925;display:grid;gap:12px}.browser-keyboard{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.browser-keyboard>span{flex:1}.browser-text{display:flex;gap:12px;align-items:end}.browser-text label{display:grid;gap:6px;flex:1;font-size:11px;color:#a5b4c7;min-width:0}.browser-text input{width:100%;box-sizing:border-box;font-size:12px;padding:10px 12px}.browser-text button{font-size:12px;white-space:nowrap}.browser-footer{display:flex;align-items:center;gap:16px;flex:none;padding-top:12px;border-top:1px solid #303c4c}.browser-footer p{font-size:12px;flex:1;color:#c3cfdd}.browser-footer p span{font-size:11px;color:#8493a7}.browser-footer button{white-space:nowrap;font-size:12px}.browser-empty{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;border:1px dashed #344254;border-radius:12px;background:#111822;padding:24px;overflow:auto}.browser-empty-icon{display:grid;place-items:center;width:52px;height:52px;border-radius:14px;background:#253325;color:#b4f777;font-size:28px}.browser-empty h3{font-size:20px;margin:0}.browser-empty p{color:#8f9fb4;font-size:12px;max-width:430px}.browser-empty button{margin:5px 0}.browser-empty .browser-hint{font-size:11px}.browser-hint{color:#8f9fb4;font-size:11px}@media(max-width:700px){.official-browser-login{gap:8px}.browser-guide p{font-size:11px}.browser-private{display:none}.browser-toolbar{padding:7px;gap:6px}.browser-address{flex-basis:100%}.browser-toolbar button{padding:5px 7px;font-size:11px}.browser-footer{gap:8px;flex-wrap:wrap}.browser-footer p{display:none}.browser-footer>.primary{margin-left:auto}.browser-extra{padding:8px}.browser-text{gap:8px}.browser-keyboard>span{display:none}.browser-text button{padding:9px;font-size:11px}.browser-empty{padding:18px}}
</style>
