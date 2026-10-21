<script setup>
import { computed, ref } from 'vue';
const props = defineProps({ server: Boolean, friendOnly: Boolean, tunnel: Object, grants: Array, changePassword: Function, busy: Boolean });
const emit = defineEmits(['notice', 'sharing']);
const expanded = ref(false); const saving = ref(false); const error = ref(''); const form = ref(null);
const currentPassword = ref(''); const newPassword = ref(''); const confirmation = ref('');
const currentAddress = computed(() => props.server ? `${window.location.origin}/admin` : '本地桌面控制台');
const publicAddress = computed(() => props.server && !props.friendOnly && props.tunnel?.status === 'online' && props.tunnel.url ? `${props.tunnel.url}/admin` : '');
const friendAddress = computed(() => [...(props.grants || [])].reverse().find(item => item.url)?.url || '');
async function copy(value) {
  try { if (window.musicBot?.copy) await window.musicBot.copy(value); else await navigator.clipboard.writeText(value); emit('notice', '地址已复制'); }
  catch { error.value = '复制失败，请选中地址手动复制'; }
}
function clear() { currentPassword.value = ''; newPassword.value = ''; confirmation.value = ''; error.value = ''; }
function toggle() { if (saving.value) return; clear(); expanded.value = !expanded.value; }
async function submit() {
  if (saving.value || props.busy || !form.value?.reportValidity()) return;
  error.value = '';
  if (newPassword.value !== confirmation.value) { error.value = '两次输入的新密码不一致'; return; }
  if (!props.changePassword) { error.value = '请先更新服务器后台，再修改主人密码'; return; }
  saving.value = true;
  try {
    await props.changePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value });
    clear(); expanded.value = false; emit('notice', '主人密码已修改，其他主人会话已退出；朋友授权保持有效');
  } catch (failure) { error.value = failure.message; currentPassword.value = ''; }
  finally { saving.value = false; }
}
</script>
<template>
  <section class="panel owner-console-panel" aria-labelledby="owner-console-heading">
    <div class="section-title compact"><div><h2 id="owner-console-heading">控制台与登录</h2><p>{{ server ? '管理地址与主人登录密码' : '当前桌面控制台无需主人网页登录密码' }}</p></div><button v-if="server" class="secondary" type="button" @click="toggle" :aria-expanded="expanded" :disabled="saving || busy">{{ expanded ? '收起修改' : '修改主人密码' }}</button></div>
    <div class="console-address"><label for="current-console-address">{{ server ? '当前主人控制台地址' : '当前控制台' }}</label><div><input id="current-console-address" :value="currentAddress" readonly spellcheck="false"><button v-if="server" type="button" class="secondary" @click="copy(currentAddress)">复制地址</button></div></div>
    <div v-if="publicAddress && publicAddress !== currentAddress" class="console-address"><label for="public-console-address">公网主人控制台地址</label><div><input id="public-console-address" :value="publicAddress" readonly spellcheck="false"><button type="button" class="secondary" @click="copy(publicAddress)">复制地址</button></div><p>仍需主人密码登录；给朋友点歌请使用下方授权链接。</p></div>
    <div class="console-address"><label for="friend-console-address">朋友控制地址</label><div><input id="friend-console-address" :value="friendAddress || '尚未创建可用的公网授权链接'" readonly spellcheck="false"><button v-if="friendAddress" class="secondary" type="button" @click="copy(friendAddress)">复制链接</button><button v-else class="secondary" type="button" @click="emit('sharing')">分享控制</button></div></div>
    <form v-if="server && expanded" ref="form" class="owner-password-form" @submit.prevent="submit">
      <label class="field-label">当前主人密码<input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label>
      <label class="field-label">新主人密码<input v-model="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>
      <label class="field-label">确认新密码<input v-model="confirmation" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>
      <p class="owner-password-hint">新密码 12–128 个字符。修改后当前页面保持登录，其他主人会话退出，音乐和朋友授权不受影响。</p>
      <div class="owner-password-actions"><button class="secondary" type="button" @click="toggle" :disabled="saving">取消</button><button class="primary" type="submit" :disabled="saving || busy">{{ saving ? '正在修改…' : '保存新密码' }}</button></div>
    </form>
    <p v-if="error" class="owner-console-error" role="alert">{{ error }}</p>
  </section>
</template>
