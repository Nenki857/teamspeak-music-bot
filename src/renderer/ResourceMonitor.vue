<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
const props=defineProps({server:Boolean,loadSample:Function});
const server = Boolean(props.server || window.musicBot?.server);
const frequency=server?2000:1000;
const memoryDetail=computed(()=>server && !missing(sample.value?.memory?.totalBytes) ? bytes(sample.value.memory.totalBytes)+' 总计 · '+(missing(sample.value.memory.percent)?'—':sample.value.memory.percent.toFixed(0)+'%') : '');
const loadValue=value=>missing(value)?'—':value.toFixed(2);

const sample = ref(null); const failed = ref(false); const suspended = ref(false);
let timer; let disposed = false; let generation = 0;
const missing = value => value === null || value === undefined || !Number.isFinite(value);
const cpu = computed(() => missing(sample.value?.cpu?.percent) ? '—' : sample.value.cpu.percent.toFixed(1) + '%');
function bytes(value, rate = false) {
  if (missing(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB']; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index && value < 100 ? 1 : 0)} ${units[index]}${rate ? '/s' : ''}`;
}
const partial = computed(() => sample.value?.cpu?.status === 'partial' || sample.value?.memory?.status === 'partial');
const status = computed(() => {
  if (suspended.value) return '已暂停';
  if (failed.value || sample.value?.cpu?.status === 'unavailable') return '读取受限';
  if (!sample.value || sample.value.cpu.status === 'warming') return '采样中';
  return partial.value ? '部分可用' : '实时';
});
const networkTitle = computed(() => {
  if (sample.value?.network?.status === 'unavailable') return '暂时无法读取网卡计数；不表示网络流量为零。';
  if (sample.value?.network?.status === 'disconnected') return '没有已连接的物理网卡。';
  return server ? '服务器网卡总收发，包含 TS 服务和其他程序；不代表机器人单独占用。不进行测速下载。' : '整台电脑已连接物理网卡的收发，包含其他软件；不代表机器人单独占用。不进行测速下载。';
});
async function poll() {
  clearTimeout(timer);
  if (disposed || document.hidden) return;
  const current = ++generation;
  try {
    const load=props.loadSample || window.musicBot?.resources;if(!load)throw new Error('Resource counters unavailable');
    const next = await load();
    if (disposed || current !== generation) return;
    suspended.value = Boolean(next.paused); failed.value = false;
    if (!next.paused) sample.value = next;
  } catch {
    if (disposed || current !== generation) return;
    sample.value = null; failed.value = true;
  }
  if (!disposed && !document.hidden && current === generation) timer = setTimeout(poll, frequency);
}
function visibility() {
  clearTimeout(timer); generation++;
  suspended.value = document.hidden;
  // A new baseline avoids displaying an average covering time spent hidden.
  if (!document.hidden) { sample.value = null; poll(); }
}
onMounted(() => { document.addEventListener('visibilitychange', visibility); poll(); });
onUnmounted(() => { disposed = true; generation++; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); });
</script>

<template>
  <section class="resource-panel" :aria-label="server ? '服务器负载' : '实时资源占用'" :aria-busy="status === '采样中'">
    <div class="resource-heading"><span>{{ server ? '服务器负载' : '实时占用' }}</span><small class="resource-live" :class="{ active: status === '实时' }" :title="status === '实时' ? (server ? '每 2 秒更新；窗口隐藏时暂停读取' : '每秒更新；窗口隐藏时暂停采样') : status"><i></i>{{ status }}</small></div>
    <div class="resource-compute">
      <div :title="server ? '整台服务器的 CPU 使用率，含机器人、TS 和其他服务；整机合计 100%' : '工具主程序、界面、机器人、转码器和公网组件合计；按整机 CPU 100% 计算'"><span>CPU</span><strong data-metric="cpu">{{ cpu }}</strong></div>
      <div :title="server ? '服务器总内存减可用内存，已考虑可回收缓存' : '工具全部进程的内存工作集合计，含共享页；统计口径可能与任务管理器的专用内存不同'"><span>内存</span><strong data-metric="memory">{{ bytes(sample?.memory?.bytes) }}</strong><small v-if="memoryDetail" class="resource-memory-detail">{{ memoryDetail }}</small></div>
    </div>
    <div v-if="server" class="resource-load" :title="'最近 1 / 5 / 15 分钟平均运行或等待资源的任务数；CPU 核心数 ' + (sample?.cpu?.cores || '未知') + '，这些数值不是百分比'"><span>系统负载 <small v-if="sample?.cpu?.cores">{{ sample.cpu.cores }} 核</small></span><strong data-metric="load">{{ loadValue(sample?.load?.one) }} / {{ loadValue(sample?.load?.five) }} / {{ loadValue(sample?.load?.fifteen) }}</strong><small>1 / 5 / 15 分钟</small></div>
    <div class="resource-network" :title="networkTitle"><div class="resource-network-heading"><span>网络</span><small>{{ server ? '服务器总流量' : '本机总流量' }}</small></div><div class="resource-rates"><span><i aria-hidden="true">↓</i><strong data-metric="receive" :aria-label="(server ? '服务器接收 ' : '本机接收 ') + bytes(sample?.network?.receivedPerSecond, true)">{{ bytes(sample?.network?.receivedPerSecond, true) }}</strong></span><span><i aria-hidden="true">↑</i><strong data-metric="send" :aria-label="(server ? '服务器发送 ' : '本机发送 ') + bytes(sample?.network?.sentPerSecond, true)">{{ bytes(sample?.network?.sentPerSecond, true) }}</strong></span></div></div>
    <p class="resource-scope">{{ server ? '服务器整体 · 每 2 秒更新' : 'CPU / 内存含工具全部组件' }}</p>
  </section>
</template>
