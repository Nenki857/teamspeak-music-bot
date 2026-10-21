<script setup>
import { computed, ref } from 'vue';
const props = defineProps({ loggedIn: Boolean, running: Boolean, canRestart: Boolean, busy: Boolean, run: { type: Function, required: true } });
const emit = defineEmits(['done']);
const pending = ref(''); const working = ref(false); const error = ref('');
const locked = computed(() => props.busy || working.value);
const actions = computed(() => [
  { id: 'owner', name: '退出管理端登录', detail: '结束当前浏览器的管理登录，机器人继续运行。' },
  { id: 'music', name: '退出网易云登录', detail: props.loggedIn ? '退出服务器上的音乐账号，其他管理员也会受影响。' : '网易云账号尚未登录。', disabled: !props.loggedIn },
  { id: 'stop', name: '关闭机器人', detail: '停止播放并退出 TS，管理网页继续运行。', disabled: !props.running },
  { id: 'restart', name: '重启机器人', detail: '重新连接当前 TS 预设，管理网页继续运行。', disabled: !props.canRestart }
]);
const selected = computed(() => actions.value.find(item => item.id === pending.value));
function choose(item) { if (locked.value || item.disabled) return; error.value = ''; if (item.id === 'owner') execute(item.id); else pending.value = item.id; }
async function execute(id) {
  if (locked.value) return;
  working.value = true; error.value = '';
  try { await props.run(id); emit('done'); }
  catch (failure) { error.value = failure.message || '操作失败，请稍后重试'; }
  finally { working.value = false; }
}
</script>
<template>
  <section class="admin-actions-panel" aria-labelledby="admin-actions-heading">
    <span class="eyebrow">ADMIN CONTROLS</span><h2 id="admin-actions-heading">管理操作</h2>
    <template v-if="!selected">
      <p class="admin-actions-intro">分别管理网页登录、音乐账号与 TS 机器人。</p>
      <div class="admin-actions-list"><button v-for="item in actions" :key="item.id" type="button" :disabled="locked || item.disabled" @click="choose(item)"><span><strong>{{ item.name }}</strong><small>{{ item.detail }}</small></span><span aria-hidden="true">›</span></button></div>
    </template>
    <template v-else>
      <h3>{{ selected.name }}？</h3><p>{{ selected.detail }}</p>
      <p v-if="selected.id === 'stop' || selected.id === 'restart'" class="admin-actions-warning">当前播放会中断，朋友控制会话需要重新连接。建议先保存播放队列；重连后可能需要重新选歌。</p>
      <p v-if="selected.id === 'music'" class="admin-actions-warning">之后播放需要账号授权的歌曲时，可能需要重新扫码登录。</p>
      <div class="modal-actions"><button class="secondary" type="button" :disabled="locked" @click="pending = ''; error = ''">返回</button><button :class="selected.id === 'restart' ? 'primary' : 'danger-button'" type="button" :disabled="locked || selected.disabled" @click="execute(selected.id)">{{ working ? '正在处理…' : '确认' + selected.name }}</button></div>
    </template>
    <p v-if="error" class="admin-actions-error" role="alert">{{ error }}</p>
  </section>
</template>
