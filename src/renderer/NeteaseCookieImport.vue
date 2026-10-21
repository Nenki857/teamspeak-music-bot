<script setup>
import { ref, onBeforeUnmount } from 'vue';
defineProps({ busy: Boolean });
const emit = defineEmits(['submit']);
const cookie = ref('');
function submit() { const value = cookie.value; cookie.value = ''; emit('submit', value); }
onBeforeUnmount(() => { cookie.value = ''; });
</script>

<template>
  <form class="cookie-import" @submit.prevent="submit">
    <div class="cookie-import-intro"><h3>使用你已经登录的账号</h3><p>在自己的浏览器完成登录，复制会话后粘贴到这里。</p></div>
    <ol class="cookie-import-steps">
      <li><span class="cookie-step-number" aria-hidden="true">01</span><div><strong>登录网易云网页版</strong><p>打开 <a href="https://music.163.com/" target="_blank" rel="noreferrer noopener">music.163.com ↗</a><br>登录你自己的账号。</p></div></li>
      <li><span class="cookie-step-number" aria-hidden="true">02</span><div><strong>找到登录会话</strong><p>按 <kbd>F12</kbd>，进入“应用”<br>在 Cookie 中找到 <code>MUSIC_U</code>。</p></div></li>
      <li><span class="cookie-step-number" aria-hidden="true">03</span><div><strong>复制并粘贴</strong><p>复制 <code>MUSIC_U</code> 的值，<br>粘贴到下方输入框。</p></div></li>
    </ol>
    <section class="cookie-import-field">
      <label class="field-label">登录会话<input v-model="cookie" type="password" autocomplete="off" spellcheck="false" maxlength="16384" placeholder="粘贴复制的 MUSIC_U 值" aria-label="网易云登录 Cookie" required :disabled="busy"></label>
      <details><summary>还支持哪些格式？</summary><p>也可以粘贴 <code>MUSIC_U=值</code> 或完整的 Cookie 请求头。</p></details>
    </section>
    <div class="cookie-import-actions"><div><strong>验证通过后，加密保存到服务器</strong><p>仅主人可导入；平台限制仍可能影响验证。</p></div><button class="primary" type="submit" :disabled="busy || !cookie.trim()">{{ busy ? '正在验证…' : '验证并导入' }}</button></div>
  </form>
</template>

<style scoped>
.cookie-import{display:grid;gap:24px;min-width:0}.cookie-import p{margin:0;line-height:1.8;color:var(--muted,#929faf)}.cookie-import-intro h3{font-size:18px;margin:0 0 7px}.cookie-import .cookie-import-steps{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.cookie-import-steps li{min-width:0;padding:17px 14px;background:#101722;border:1px solid #2b3646;border-radius:12px}.cookie-step-number{display:inline-flex;align-items:center;justify-content:center;font-size:11px;letter-spacing:1px;color:var(--accent,#b4f777);background:#243326;border-radius:6px;padding:5px 8px;margin-bottom:14px}.cookie-import-steps strong{display:block;font-size:13px;margin-bottom:7px}.cookie-import-steps p{font-size:12px}.cookie-import a{color:var(--accent,#b4f777);text-decoration:none;white-space:nowrap}.cookie-import code,.cookie-import kbd{font:inherit;font-size:.92em;color:#d9e3ef;white-space:nowrap}.cookie-import kbd{border:1px solid #445164;border-radius:4px;padding:1px 4px}.cookie-import-field{padding:18px;border:1px solid #334151;border-radius:12px;background:#111823;min-width:0}.cookie-import .field-label{display:grid;gap:10px;font-size:13px}.cookie-import input{width:100%;box-sizing:border-box;font-size:14px;padding:13px 14px;min-width:0}.cookie-import details{margin-top:12px;color:var(--muted,#929faf);font-size:12px;line-height:1.8}.cookie-import summary{cursor:pointer;list-style-position:inside}.cookie-import details p{margin-top:8px}.cookie-import-actions{display:flex;align-items:center;justify-content:space-between;gap:20px;border-top:1px solid #2c3747;padding-top:20px}.cookie-import-actions strong{font-size:12px;font-weight:500;color:#c3cfde}.cookie-import-actions p{font-size:11px;margin-top:5px}.cookie-import-actions button{flex:none;white-space:nowrap}@media(max-width:600px){.cookie-import{gap:18px}.cookie-import .cookie-import-steps{grid-template-columns:1fr;gap:8px}.cookie-import-steps li{display:flex;align-items:flex-start;gap:13px;padding:13px}.cookie-step-number{margin:0;flex:none}.cookie-import-steps p br{display:none}.cookie-import-actions{align-items:stretch;flex-direction:column;gap:14px}.cookie-import-actions button{align-self:stretch}}
</style>
