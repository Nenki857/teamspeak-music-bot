// Timed lyrics use seconds, matching player.elapsed. Render all text as text, never HTML.
export function normalizeLyrics(input) {
  if (!Array.isArray(input)) throw new Error('歌词响应格式无效');
  const result=[]; let remaining=32000;
  for(const line of input.slice(0,1000)) {
    if(!line || !Number.isFinite(line.time) || line.time<0 || line.time>86400 || typeof line.text!=='string')continue;
    const text=line.text.trim().slice(0,500);if(!text || text.length>remaining)continue;remaining-=text.length;
    const translation=typeof line.translation==='string'?line.translation.trim().slice(0,Math.min(500,remaining)):'';remaining-=translation.length;
    result.push({time:Math.round(line.time*1000)/1000,text,...(translation?{translation}:{})});
    if(result.length>=500 || remaining<=0)break;
  }
  return result.sort((a,b)=>a.time-b.time);
}
export function activeLyricIndex(lines,elapsed) {
  if(!Number.isFinite(elapsed))return -1;
  let low=0,high=lines.length;
  while(low<high){const mid=(low+high)>>>1;if(lines[mid].time<=elapsed)low=mid+1;else high=mid;}
  return low-1;
}
