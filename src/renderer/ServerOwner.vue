<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import App from './App.vue';
import { createServerBridge } from './server-bridge.mjs';
const ready = ref(false); const checking = ref(true); const password = ref(''); const busy = ref(false); const error = ref('');
const remember = ref(false); const showPassword = ref(false);
let bridge;
function expired() { ready.value = false; bridge?.dispose(); delete window.musicDesk; password.value = ''; showPassword.value = false; }
function authorize(csrf) { bridge = createServerBridge(csrf, expired); window.musicDesk = bridge; ready.value = true; error.value = ''; }
onMounted(async () => {
  try { const response = await fetch('/api/admin/session'); const data = await response.json(); if (data.ok) authorize(data.csrf); }
  catch { error.value = '暂时无法连接服务器，请稍后刷新'; }
  finally { checking.value = false; }
});
async function login() {
  if (busy.value) return; busy.value = true; error.value = '';
  try {
    const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value, remember: remember.value }) });
    const data = await response.json(); if (!data.ok) throw new Error(data.error); password.value = ''; showPassword.value = false; authorize(data.csrf);
  } catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
onUnmounted(() => { bridge?.dispose(); delete window.musicDesk; });
</script>
<template>
  <App v-if="ready" />
  <main v-else class="server-login-screen">
    <form class="server-login-card" @submit.prevent="login">
      <img src="/logo.png" alt="Music Desk"><span class="eyebrow">TS MUSIC DESK · SERVER</span>
      <h1>主人控制台</h1><p>管理音乐账号、服务器和共享权限。关闭网页后，机器人继续运行。</p>
      <p v-if="checking" role="status">正在检查登录状态…</p>
      <template v-else>
        <label for="owner-password">主人密码</label>
        <div class="owner-login-password"><input id="owner-password" name="password" v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" required maxlength="128" autofocus><button type="button" class="owner-password-visibility" :aria-label="showPassword ? '隐藏密码' : '显示密码'" :aria-pressed="showPassword" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div>
        <div class="owner-login-options"><label><input v-model="remember" type="checkbox">记住密码</label><span>在此浏览器保持登录 30 天</span></div>
        <p v-if="error" class="server-login-error" role="alert">{{ error }}</p><button class="primary" :disabled="busy">{{ busy ? '正在登录…' : '登录控制台' }}</button>
      </template>
      <small>密码由服务器初始化命令生成。朋友请使用完整的分享链接。</small>
    </form>
  </main>
</template>
