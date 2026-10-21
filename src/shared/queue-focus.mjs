// Queue focus is local DOM work. It never reads fresh state or sends RPCs.
export function locateCurrentQueueRow(panel,{view=globalThis.window,currentEntryId='',smooth=false}={}) {
  if(!panel || !view)return false;
  const row=panel.querySelector('.queue-item.current');
  if(!row || (currentEntryId && row.dataset.sortId!==String(currentEntryId)))return false;
  const scale=Number(view.document.documentElement.dataset?.uiScale || 100)/100;
  const box=element=>{const r=element.getBoundingClientRect();return {top:r.top/scale,height:r.height/scale};};
  const rect=box(row);if(!(rect.height>0))return false;
  let host=row.parentElement || panel.parentElement;
  while(host && host!==view.document.body && host!==view.document.documentElement) {
    const style=view.getComputedStyle(host);
    if(/auto|scroll|overlay/.test(style.overflowY || style.overflow) && host.scrollHeight>host.clientHeight+1)break;
    host=host.parentElement;
  }
  const documentScroll=!host || host===view.document.body || host===view.document.documentElement;
  const viewportHeight=documentScroll?view.innerHeight/scale:host.clientHeight;if(!(viewportHeight>0))return false;
  const insideList=!documentScroll && Boolean(panel.contains?.(host));
  const headerHeight=insideList?0:(panel.querySelector('.queue-heading')?.getBoundingClientRect().height || 0)/scale;
  const cardHeight=!insideList&&view.innerWidth/scale<=650?((panel.querySelector('.now-card')?.getBoundingClientRect().height || 0)/scale):0;
  const footerHeight=documentScroll?((view.document.querySelector('.player-bar')?.getBoundingClientRect().height || 0)/scale):0;
  const inset=insideList?12:headerHeight+cardHeight+24;const available=Math.max(rect.height,viewportHeight-inset-footerHeight-16);
  const scrollTop=documentScroll?(view.scrollY || view.document.scrollingElement?.scrollTop || 0):host.scrollTop;
  const viewportTop=documentScroll?0:box(host).top;
  let top=Math.max(0,Math.round(scrollTop+rect.top-viewportTop-inset-(available-rect.height)/2));
  const scrollHeight=documentScroll?Math.max(view.document.documentElement.scrollHeight,view.document.body?.scrollHeight||0):host.scrollHeight;
  if(scrollHeight>viewportHeight)top=Math.min(top,scrollHeight-viewportHeight);
  const reduced=view.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const target=documentScroll?view:host;
  if(typeof target.scrollTo==='function')target.scrollTo({top,behavior:smooth&&!reduced?'smooth':'auto'});
  else target.scrollTop=top;
  return true;
}
