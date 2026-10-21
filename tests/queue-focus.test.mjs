import test from 'node:test';
import assert from 'node:assert/strict';
import {locateCurrentQueueRow} from '../src/shared/queue-focus.mjs';
function fixture({documentScroll=false,mobile=false,reduced=false}={}){
 const calls=[];const body={scrollHeight:10000};const html={scrollHeight:10000};const host={parentElement:body,scrollHeight:10000,clientHeight:600,scrollTop:100,getBoundingClientRect:()=>({top:64}),scrollTo:options=>calls.push({host:'workspace',...options})};
 const row={dataset:{sortId:'entry-49'},getBoundingClientRect:()=>({top:documentScroll?1000:3000,height:72})};const header={getBoundingClientRect:()=>({height:60})};const card={getBoundingClientRect:()=>({height:100})};
 const view={document:{body,documentElement:html,querySelector:()=>({getBoundingClientRect:()=>({height:120})})},innerWidth:mobile?390:1300,innerHeight:720,scrollY:2000,getComputedStyle:()=>({overflowY:'auto'}),matchMedia:()=>({matches:reduced}),scrollTo:options=>calls.push({host:'window',...options})};
 const panel={parentElement:documentScroll?body:host,querySelector:selector=>selector==='.queue-item.current'?row:selector==='.queue-heading'?header:card};return{calls,panel,view,row};
}
test('queue focus centers the current row inside the desktop workspace without moving the document',()=>{
 const f=fixture();assert.equal(locateCurrentQueueRow(f.panel,{view:f.view,currentEntryId:'entry-49'}),true);assert.deepEqual(f.calls,[{host:'workspace',top:2738,behavior:'auto'}]);
});
test('mobile document focus reserves room for the sticky song card and player bar',()=>{
 const f=fixture({documentScroll:true,mobile:true});assert.equal(locateCurrentQueueRow(f.panel,{view:f.view,currentEntryId:'entry-49',smooth:true}),true);assert.deepEqual(f.calls,[{host:'window',top:2652,behavior:'smooth'}]);
});
test('manual focus respects reduced motion and empty, stale or unmeasured rows do not scroll',()=>{
 const f=fixture({reduced:true});locateCurrentQueueRow(f.panel,{view:f.view,smooth:true});assert.equal(f.calls[0].behavior,'auto');f.calls.length=0;assert.equal(locateCurrentQueueRow(f.panel,{view:f.view,currentEntryId:'old-entry'}),false);f.row.getBoundingClientRect=()=>({height:0});assert.equal(locateCurrentQueueRow(f.panel,{view:f.view}),false);assert.equal(locateCurrentQueueRow(null,{view:f.view}),false);assert.equal(f.calls.length,0);
});

test('a bounded queue list scrolls itself without subtracting the header or moving the page',()=>{
 const f=fixture({mobile:true});const list=f.panel.parentElement;f.row.parentElement=list;f.panel.contains=node=>node===list;
 assert.equal(locateCurrentQueueRow(f.panel,{view:f.view,currentEntryId:'entry-49',smooth:true}),true);
 assert.deepEqual(f.calls,[{host:'workspace',top:2774,behavior:'smooth'}]);
});

test('zoomed queue focus converts screen coordinates to scroll offsets',()=>{
 const f=fixture();f.view.document.documentElement.dataset={uiScale:'175'};const host=f.panel.parentElement;const rowBox=f.row.getBoundingClientRect;f.row.getBoundingClientRect=()=>{const r=rowBox();return{top:r.top*1.75,height:r.height*1.75};};host.getBoundingClientRect=()=>({top:64*1.75});const query=f.panel.querySelector;f.panel.querySelector=selector=>{if(selector==='.queue-item.current')return f.row;const el=query(selector);return {getBoundingClientRect:()=>({height:el.getBoundingClientRect().height*1.75})};};locateCurrentQueueRow(f.panel,{view:f.view,currentEntryId:'entry-49'});assert.equal(f.calls[0].top,2738);
});
