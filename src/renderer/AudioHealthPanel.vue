<script setup>
import { ref, computed } from 'vue';
const props = defineProps({ health: { type: Object, default: () => ({}) } });
const copyMessage = ref('');
const number = value => Number.isFinite(value) ? value : null;
const buffer = value => Number.isFinite(value) ? (value / 1000).toFixed(2) + ' 秒' : '—';
const gap = value => Number.isFinite(value) ? Math.round(value) + ' ms' : '—';
const summary = computed(() => {
  const value = props.health;
  if (value.officialClient) return value.bridgeStatus === 'unavailable' ? '官方客户端音频桥暂未响应，请检查服务器音频服务。' : '当前使用官方 TS3 客户端传输；原内核的帧计数与缓冲诊断不适用。';
  if (!value.supported) return '连接机器人并播放歌曲后开始记录。';
  if (value.transport?.sendErrors) return '发现本机 UDP 发送错误，请复制诊断查看发送端计数；成功提交也不代表听众已收到。';
  if (value.underruns || value.starving) return value.lateTicks ? '发现音频缓冲耗尽和本机调度停顿，请结合下面的时间记录排查。' : '发现音频缓冲耗尽，先检查音乐源下载或转码供给。';
  if (value.lateTicks) return '发现本机音频调度停顿；平均 CPU 很低也可能出现短时停顿。';
  if (!value.frames) return '等待歌曲产生音频帧。';
  return '最近一分钟未发现缓冲耗尽或明显调度停顿；仍不能排除 TS 传输与收听端的问题。';
});
async function copyReport() {
  const value = props.health;
  // Keep the clipboard report explicit, so future state fields cannot leak account data.
  const report = { kind: 'TS Music Desk audio diagnostics', capturedAt: new Date().toISOString(), windowSeconds: 60,
    state: value.state || 'unknown', supported: Boolean(value.supported), backend: value.officialClient ? 'official-client-sinusbot' : 'custom-ts3', officialClient: value.officialClient === true,
    bufferMs: number(value.bufferMs), minBufferMs: number(value.minBufferMs), frames: number(value.frames), underruns: number(value.underruns),
    lateTicks: number(value.lateTicks), maxFrameGapMs: number(value.maxFrameGapMs), maxTickGapMs: number(value.maxTickGapMs),
    starving: Boolean(value.starving), isolatedCore: value.isolatedCore === true, directCatalog: value.directCatalog === true,
    audioWork: { maxFrameWorkMs: number(value.audioWork?.maxFrameWorkMs), maxEncodeMs: number(value.audioWork?.maxEncodeMs), maxVoiceSubmitMs: number(value.audioWork?.maxVoiceSubmitMs), slowFrameCalls: number(value.audioWork?.slowFrameCalls) },
    encoding: value.encoding ? { codec: value.encoding.codec === 'opus-music' ? 'opus-music' : 'unknown', sampleRate: number(value.encoding.sampleRate), channels: number(value.encoding.channels), frameDurationMs: number(value.encoding.frameDurationMs), bitrate: number(value.encoding.bitrate), variableBitrate: typeof value.encoding.variableBitrate === 'boolean' ? value.encoding.variableBitrate : null } : null,
    transport: { supported: value.transport?.supported === true, windowSeconds: 60,
      voicePackets: number(value.transport?.voicePackets), voiceBytes: number(value.transport?.voiceBytes), sendCallbacks: number(value.transport?.sendCallbacks), sendErrors: number(value.transport?.sendErrors),
      voiceEndPackets: number(value.transport?.voiceEndPackets),
      minVoicePacketBytes: number(value.transport?.minVoicePacketBytes), maxVoicePacketBytes: number(value.transport?.maxVoicePacketBytes),
      maxSendCallbackMs: number(value.transport?.maxSendCallbackMs), pendingVoiceSends: number(value.transport?.pendingVoiceSends), sendQueueBytes: number(value.transport?.sendQueueBytes), sendQueuePackets: number(value.transport?.sendQueuePackets),
      rttMs: number(value.transport?.rttMs), maxRttMs: number(value.transport?.maxRttMs), pingReplies: number(value.transport?.pingReplies),
      lastErrorCode: /^(ENOBUFS|EMSGSIZE|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EACCES|EBADF|ERR_SOCKET_DGRAM_NOT_RUNNING|OTHER)$/.test(value.transport?.lastErrorCode) ? value.transport.lastErrorCode : null,
      deliveryVerified: false },
    tsConnectionStatistics: 'unsupported', deliveryVerified: false,
    recent: (value.recent || []).slice(-8).map(item => ({ time: number(item.time), type: item.type === 'buffer-empty' ? 'buffer-empty' : 'scheduler-gap', gapMs: number(item.gapMs), bufferMs: number(item.bufferMs) })) };
  try { if (!await window.musicDesk.copy(JSON.stringify(report, null, 2))) throw new Error('Copy unavailable'); copyMessage.value = '诊断已复制'; }
  catch { copyMessage.value = '复制失败，请重试'; }
}
</script>

<template>
  <section class="panel settings-panel audio-health-panel" aria-label="播放链路诊断">
    <div class="audio-health-heading"><div><h2>播放链路诊断</h2><p>{{ health.officialClient ? '官方客户端模式 · 音频由独立进程处理' : '最近一分钟 · 正常音频帧间隔约 20 ms' }}</p></div><button class="secondary" @click="copyReport" :disabled="!health.supported && !health.frames && !health.officialClient">复制诊断</button></div>
    <p class="audio-health-result" :class="{ warning: health.underruns || health.lateTicks || health.starving || health.transport?.sendErrors }">{{ summary }}</p>
    <div class="audio-health-grid" v-if="!health.officialClient">
      <div><span>当前音频缓冲</span><strong>{{ buffer(health.bufferMs) }}</strong></div>
      <div><span>最长出帧间隔</span><strong>{{ gap(health.maxFrameGapMs) }}</strong></div>
      <div><span>缓冲耗尽次数</span><strong>{{ health.underruns ?? '—' }}</strong></div>
      <div><span>调度停顿次数</span><strong>{{ health.lateTicks ?? '—' }}</strong></div>
    </div>
    <p class="audio-health-limit" v-if="health.audioWork">单帧处理最长 {{ gap(health.audioWork.maxFrameWorkMs) }} · 编码最长 {{ gap(health.audioWork.maxEncodeMs) }} · 提交语音最长 {{ gap(health.audioWork.maxVoiceSubmitMs) }}。这些是本机同步处理耗时，不是网络延迟。</p>
    <p class="audio-health-limit" v-if="health.encoding">TS 发送编码：Opus 音乐 · {{ health.encoding.bitrate / 1000 }} kbps · {{ health.encoding.variableBitrate ? '可变码率' : '固定码率' }} · {{ health.encoding.sampleRate / 1000 }} kHz / {{ health.encoding.channels }} 声道 / {{ health.encoding.frameDurationMs }} ms。这是机器人发送编码，与网易云下载音质分别设置。</p>
    <template v-if="health.transport?.supported">
      <p class="audio-health-limit">UDP 语音包 {{ health.transport.voicePackets ?? '—' }} · 发送错误 {{ health.transport.sendErrors ?? '—' }} · 最长提交回调 {{ gap(health.transport.maxSendCallbackMs) }} · 当前待回调 {{ health.transport.pendingVoiceSends ?? '—' }}</p>
      <p class="audio-health-limit">最近保活往返 {{ gap(health.transport.rttMs) }} · 一分钟最长 {{ gap(health.transport.maxRttMs) }} · 当前发送队列 {{ health.transport.sendQueueBytes ?? '—' }} Bytes。回调仅表示本机提交；保活沿用现有数据包，不额外测速，不能当作语音丢包率。</p>
    </template>
    <p v-if="health.officialClient" class="audio-health-limit">音乐交由独立音频服务和官方 TS3 客户端处理。工具没有读取听众收到的音频数据，不能据此判断失真已经解决。</p>
    <p v-else class="audio-health-limit">当前内核仍未向 TS 连接信息窗口上报统计，其中的全 0 不能当作网络正常的依据。上述保活往返由本机独立观测；音频生成、UDP 提交和保活回复均不代表每个语音包已被听众收到。</p>
    <div class="audio-health-events" v-if="health.recent?.length"><p v-for="(item, index) in health.recent.slice().reverse()" :key="index"><time>{{ new Date(item.time).toLocaleTimeString() }}</time><span>{{ item.type === 'buffer-empty' ? '音频缓冲不足一帧' : '本机调度间隔 ' + gap(item.gapMs) }}</span><small>缓冲 {{ buffer(item.bufferMs) }}</small></p></div>
    <span class="audio-health-copy" role="status" v-if="copyMessage">{{ copyMessage }}</span>
  </section>
</template>
