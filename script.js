"use strict";
/* ============================================================
   STATE
============================================================ */
const COLS=['products','vendors','locations','channels','orders','pos','returns','history','scenarios'];
const S={db:null,user:null,dl:null,uid:null,isOwner:false,mode:'loading',ws:null,wsDoc:undefined,col:{},loaded:{},workspaces:{},unsubs:[],ro:false,ui:{sel:{},soStatus:'open',poStatus:'active'},names:{}};
COLS.forEach(c=>{S.col[c]={};});
const DEF_CFG={serviceLevel:95,safetyDays:14,reviewDays:30,overstockDays:120,defaultLeadTime:30,carryPct:20,defaultLocation:''};
const NAV=[
 ['',[['dashboard','Dashboard']]],
 ['Master data',[['products','Product master'],['vendors','Vendor master'],['locations','Locations'],['channels','Sales channels']]],
 ['Planning',[['demand','Demand planning'],['inventory','Inventory planning'],['mrp','MRP & production'],['landed','Landed cost scenarios']]],
 ['Execution',[['orders','Sales orders'],['purchasing','Purchasing'],['pos','Purchase orders'],['inbound','Inbound shipments'],['receiving','Receiving'],['returns','RMA & returns']]],
 ['Performance',[['health','Inventory health'],['cash','Cash requirements'],['risk','Revenue at risk'],['suppliers','Supplier performance'],['reports','Reports']]],
 ['System',[['integrations','Integrations & import'],['workspace','Workspace settings']]]
];
const PAGES=NAV.flatMap(g=>g[1].map(x=>x[0]));
let page=(()=>{const h=(location.hash||'').slice(1);return PAGES.includes(h)?h:'dashboard'})();

/* ============================================================
   UTIL
============================================================ */
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad=n=>String(n).padStart(2,'0');
const isoD=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const today=()=>isoD(new Date());
const addDays=(s,n)=>{const d=s?new Date(s+'T00:00:00'):new Date();d.setDate(d.getDate()+n);return isoD(d)};
const daysBetween=(a,b)=>Math.round((new Date(b+'T00:00:00')-new Date(a+'T00:00:00'))/864e5);
const monthKey=off=>{const d=new Date();d.setDate(1);d.setMonth(d.getMonth()+off);return d.getFullYear()+'-'+pad(d.getMonth()+1)};
const monthLabel=k=>{const [y,m]=k.split('-');return new Date(+y,+m-1,1).toLocaleString('en',{month:'short'})+(String(y).slice(2)!==String(new Date().getFullYear()).slice(2)?" '"+String(y).slice(2):'')};
const lastMonths=n=>{const a=[];for(let i=n;i>=1;i--)a.push(monthKey(-i));return a};
const nid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const num=(v,dp=0)=>Number.isFinite(+v)?(+v).toLocaleString('en',{minimumFractionDigits:dp,maximumFractionDigits:dp}):'—';
const cfg=()=>Object.assign({},DEF_CFG,(S.wsDoc&&S.wsDoc.cfg)||{});
const cur=()=>(S.wsDoc&&S.wsDoc.currency)||'PHP';
function money(v,dp){if(!Number.isFinite(+v))return '—';const a=Math.abs(+v);if(dp==null)dp=a<100&&a!==0&&a%1?2:0;try{return new Intl.NumberFormat('en',{style:'currency',currency:cur(),minimumFractionDigits:dp,maximumFractionDigits:dp}).format(v)}catch(e){return cur()+' '+num(v,dp)}}
const list=c=>Object.values(S.col[c]);
const P=id=>S.col.products[id]; const V=id=>S.col.vendors[id]; const L=id=>S.col.locations[id]; const CH=id=>S.col.channels[id];
const pName=id=>P(id)?P(id).name:'(deleted product)';
const vName=id=>V(id)?V(id).name:'—';
const sortBy=(a,f)=>a.slice().sort((x,y)=>{const A=f(x),B=f(y);return A<B?-1:A>B?1:0});
const defLoc=()=>{const c=cfg();if(c.defaultLocation&&L(c.defaultLocation))return c.defaultLocation;const l=sortBy(list('locations'),x=>x.name)[0];return l?l.id:null};
const onHand=p=>Object.values(p.stock||{}).reduce((a,b)=>a+(+b||0),0);
function toast(msg){const t=document.createElement('div');t.className='toast';t.setAttribute('role','status');t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3800)}
function pill(status){const m={'Stockout':'crit','Order now':'warn','Healthy':'ok','Overstock':'info','No demand':'mute','Below safety':'crit','draft':'mute','placed':'acc','in_transit':'info','partial':'warn','received':'ok','cancelled':'mute','open':'acc','shipped':'ok','Late':'crit','On time':'ok'};const lab={in_transit:'In transit',partial:'Partly received',draft:'Draft',placed:'Placed',received:'Received',cancelled:'Cancelled',open:'Open',shipped:'Shipped'}[status]||status;return `<span class="pill ${m[status]||'mute'}">${esc(lab)}</span>`}
function csvEsc(v){v=String(v??'');return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}
function parseCSV(t){const rows=[];let r=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){f+='"';i++}else q=false}else f+=c}else{if(c=='"')q=true;else if(c==','){r.push(f);f=''}else if(c=='\n'||c=='\r'){if(c=='\r'&&t[i+1]=='\n')i++;r.push(f);rows.push(r);r=[];f=''}else f+=c}}if(f!==''||r.length){r.push(f);rows.push(r)}return rows.filter(x=>x.some(v=>String(v).trim()!==''))}

/* ============================================================
   DATA LAYER
============================================================ */
const chains={};
function serial(key,fn){const p=(chains[key]||Promise.resolve()).then(fn);chains[key]=p.catch(()=>{});return p}
function dbErr(e){
  const code=e&&e.code;
  if(code==='invalid_argument'){S.ro=true;toast('This change was not saved. Your access to this workspace is view-only. Ask SCaaS Global for edit access.');scheduleRender()}
  else if(code==='quota_exceeded')toast('Storage is full for this workspace. Remove old sales orders or history to free space.');
  else toast('Could not save: '+((e&&e.message)||'connection problem')+'. Try again.');
}
async function retry(fn){try{return await fn()}catch(e){if(e&&e.code==='unavailable'){await new Promise(r=>setTimeout(r,400+Math.random()*600));return fn()}throw e}}
const dref=(c,id)=>S.db.doc(`workspaces/${S.ws}/${c}/${id}`);
const clean=o=>{const x=Object.assign({},o);delete x.id;return x};
function save(c,id,data){return serial(c+'/'+id,()=>retry(()=>dref(c,id).set(clean(data)))).catch(e=>{dbErr(e);throw e})}
function upd(c,id,data){return serial(c+'/'+id,()=>retry(()=>dref(c,id).update(clean(data)))).catch(e=>{dbErr(e);throw e})}
function del(c,id){return serial(c+'/'+id,()=>retry(()=>dref(c,id).delete())).catch(e=>{dbErr(e);throw e})}
function saveWs(data,full){const r=S.db.doc('workspaces/'+S.ws);return serial('ws',()=>retry(()=>full?r.set(data):r.update(data))).catch(e=>{dbErr(e);throw e})}

let rTimer=null;
let ver=0;
function scheduleRender(){ver++;if(rTimer)return;rTimer=requestAnimationFrame(()=>{rTimer=null;render()})}

function openWorkspace(id){
  S.unsubs.forEach(u=>{try{u()}catch(e){}});S.unsubs=[];
  S.ws=id;S.wsDoc=undefined;S.ui.sel={};COLS.forEach(c=>{S.col[c]={};S.loaded[c]=false});
  try{if(S.isOwner)localStorage.setItem('sv.ws',id)}catch(e){}
  S.unsubs.push(S.db.doc('workspaces/'+id).onSnapshot(s=>{S.wsDoc=s.exists?Object.assign({id:s.id},s.data()):null;scheduleRender()},e=>{if(e.code==='revoked'){S.mode='revoked';scheduleRender()}}));
  COLS.forEach(c=>{
    S.unsubs.push(S.db.collection(`workspaces/${id}/${c}`).onSnapshot(snap=>{
      const o={};snap.docs.forEach(d=>{o[d.id]=Object.assign({},d.data(),{id:d.id})});S.col[c]=o;S.loaded[c]=true;scheduleRender();
    },e=>{if(e.code==='revoked'){S.mode='revoked';scheduleRender()}}));
  });
  scheduleRender();
}

/* ============================================================
   PLANNING ENGINE
============================================================ */
const Z={90:1.2816,95:1.6449,97.5:1.96,98:2.0537,99:2.3263};
let memo={key:null,val:null};
function compute(){
  const key=S.ws+':'+ver+':'+stamp+':'+today();
  if(memo.key===key)return memo.val;
  const C=cfg(), M6=lastMonths(6), curM=monthKey(0), z=Z[C.serviceLevel]||1.6449, t=today();
  const prods=list('products').filter(p=>p.active!==false);
  const dem={}, demCh={};
  const add=(pid,ch,m,q)=>{if(!pid||!q)return;(dem[pid]=dem[pid]||{})[m]=(dem[pid][m]||0)+q;const k=ch||'_';((demCh[pid]=demCh[pid]||{})[k]=demCh[pid][k]||{})[m]=(demCh[pid][k][m]||0)+q};
  list('history').forEach(h=>{Object.entries(h.months||{}).forEach(([m,q])=>add(h.productId,h.channelId,m,+q||0))});
  const alloc={};
  list('orders').forEach(o=>{if(o.status==='cancelled')return;(o.lines||[]).forEach(l=>{add(l.productId,o.channelId,(o.date||t).slice(0,7),+l.qty||0);if(o.status==='open')alloc[l.productId]=(alloc[l.productId]||0)+(+l.qty||0)})});
  const inc={}, incEta={};
  list('pos').forEach(po=>{if(!['placed','in_transit','partial'].includes(po.status))return;(po.lines||[]).forEach(l=>{const r=Math.max(0,(+l.qty||0)-(+l.received||0));inc[l.productId]=(inc[l.productId]||0)+r;const eta=(po.shipment&&po.shipment.eta)||po.expectedDate;if(!incEta[l.productId]||eta<incEta[l.productId])incEta[l.productId]=eta})});
  const R={};
  const calc=(p,series,fcOverride,curQty)=>{
    const l3=series.slice(-3), wma=l3[2]*.5+l3[1]*.3+l3[0]*.2;
    const fcM=fcOverride!=null?fcOverride:wma*(1+(+p.forecastAdj||0)/100);
    const avgDaily=fcM/30;
    const withData=series.filter(x=>x>0).length;
    const mean=series.reduce((a,b)=>a+b,0)/series.length;
    const sd=Math.sqrt(series.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(1,series.length-1));
    const v=V(p.vendorId);
    const lt=+p.leadTimeDays||(v&&+v.leadTimeDays)||C.defaultLeadTime;
    const ss=Math.ceil(withData>=3?z*(sd/Math.sqrt(30))*Math.sqrt(lt):avgDaily*C.safetyDays);
    const rop=Math.ceil(avgDaily*lt+ss);
    const oh=onHand(p), al=alloc[p.id]||0, av=oh-al, ic=inc[p.id]||0, pos=av+ic;
    const cover=avgDaily>0?av/avgDaily:Infinity;
    const target=rop+avgDaily*C.reviewDays;
    let sug=0;
    if(avgDaily>0&&pos<=rop){sug=Math.max(target-pos,+p.moq||0);const cp=+p.casePack||1;sug=Math.ceil(sug/cp)*cp}
    const recent=l3.reduce((a,b)=>a+b,0)+(curQty||0);
    let status='Healthy';
    if(avgDaily===0&&recent===0)status=oh>0?'No demand':'Healthy';
    else if(av<=0)status='Stockout';
    else if(pos<=rop)status='Order now';
    else if(cover>C.overstockDays)status='Overstock';
    const below=avgDaily>0&&av<ss&&av>0;
    const excessU=avgDaily>0?Math.max(0,av-avgDaily*C.overstockDays):(recent===0?oh:0);
    const shortU=Math.max(0,avgDaily*lt-pos);
    const prior=series.slice(0,3).reduce((a,b)=>a+b,0)/3, last=l3.reduce((a,b)=>a+b,0)/3;
    const trend=prior>0?(last-prior)/prior:(last>0?1:0);
    return {p,series,wma,fcM,avgDaily,sd,lt,ss,rop,oh,al,av,ic,pos,cover,sug,status,below,excessU,excessV:excessU*(+p.unitCost||0),shortU,riskV:shortU*(+p.price||0),value:oh*(+p.unitCost||0),trend,eta:incEta[p.id]||null,withData,cur:curQty||0};
  };
  const ser=pid=>M6.map(m=>(dem[pid]&&dem[pid][m])||0);
  const fg=prods.filter(p=>p.type!=='component'), comps=prods.filter(p=>p.type==='component');
  fg.forEach(p=>{R[p.id]=calc(p,ser(p.id),null,(dem[p.id]&&dem[p.id][curM])||0)});
  // dependent demand for components from make items' BOMs
  const usedBy={};
  fg.forEach(p=>{if(p.makeBuy!=='make')return;(p.bom||[]).forEach(b=>{(usedBy[b.componentId]=usedBy[b.componentId]||[]).push({fg:p.id,qty:+b.qty||0})})});
  comps.forEach(p=>{
    const own=ser(p.id), uses=usedBy[p.id]||[];
    const dep=M6.map((m,i)=>own[i]+uses.reduce((a,u)=>a+u.qty*((R[u.fg]&&R[u.fg].series[i])||0),0));
    const fc=uses.reduce((a,u)=>a+u.qty*((R[u.fg]&&R[u.fg].fcM)||0),0)+own.slice(-3).reduce((a,b,i)=>a+b*[.2,.3,.5][i],0);
    const curQ=uses.reduce((a,u)=>a+u.qty*((R[u.fg]&&R[u.fg].cur)||0),0);
    R[p.id]=calc(p,dep,fc,curQ);R[p.id].usedBy=uses;
  });
  // MRP: component needs for planned production of make items
  const mrp={};
  fg.forEach(p=>{if(p.makeBuy!=='make')return;const q=R[p.id].sug;(p.bom||[]).forEach(b=>{mrp[b.componentId]=(mrp[b.componentId]||0)+q*(+b.qty||0)})});
  const rows=Object.values(R);
  const agg={
    value:rows.reduce((a,r)=>a+r.value,0),
    toOrder:rows.filter(r=>r.sug>0).length,
    risk:rows.reduce((a,r)=>a+r.riskV,0),
    excess:rows.reduce((a,r)=>a+r.excessV,0),
    openPOs:list('pos').filter(p=>['placed','in_transit','partial'].includes(p.status)).length
  };
  memo={key,val:{R,rows,agg,mrp,demCh,M6,curM}};
  return memo.val;
}
let stamp=0;
const poTotal=po=>(po.lines||[]).reduce((a,l)=>a+(+l.qty||0)*(+l.unitCost||0),0)+(+po.freight||0);
function cashSchedule(){
  const {rows}=compute(), t=today(), months=[0,1,2,3,4,5].map(monthKey);
  const b={};months.forEach(m=>b[m]={committed:0,planned:0});
  const items=[];
  const put=(date,amt,kind,label)=>{if(!amt)return;let m=date.slice(0,7);if(date<t)m=months[0];if(!b[m])return;b[m][kind]+=amt;items.push({date:date<t?t:date,overdue:date<t,amt,kind,label})};
  list('pos').forEach(po=>{
    if(!['placed','in_transit','partial'].includes(po.status))return;
    const v=V(po.vendorId)||{}, tot=poTotal(po), dep=tot*(+v.depositPct||0)/100;
    const receivedShare=(po.lines||[]).reduce((a,l)=>a+(+l.received||0)*(+l.unitCost||0),0);
    if(po.orderDate>=t)put(po.orderDate,dep,'committed',po.number+' deposit');
    const eta=(po.shipment&&po.shipment.eta)||po.expectedDate||t;
    put(addDays(eta,+v.balanceDays||0),tot-dep,'committed',po.number+' balance');
    void receivedShare;
  });
  rows.forEach(r=>{if(!r.sug||r.p.makeBuy==='make')return;const v=V(r.p.vendorId)||{};const tot=r.sug*(+r.p.unitCost||0);const dep=tot*(+v.depositPct||0)/100;put(t,dep,'planned','Planned buy '+r.p.sku+' deposit');put(addDays(t,r.lt+(+v.balanceDays||0)),tot-dep,'planned','Planned buy '+r.p.sku+' balance')});
  return {months,b,items:sortBy(items,i=>i.date)};
}
function supplierStats(){
  return sortBy(list('vendors'),v=>v.name).map(v=>{
    const pos=list('pos').filter(p=>p.vendorId===v.id&&p.status!=='cancelled');
    const done=pos.filter(p=>p.status==='received'&&p.receivedDate);
    const onTime=done.filter(p=>p.receivedDate<=((p.shipment&&p.shipment.promised)||p.expectedDate));
    let q=0,r=0;done.forEach(p=>(p.lines||[]).forEach(l=>{q+=+l.qty||0;r+=+l.received||0}));
    const lts=done.map(p=>daysBetween(p.orderDate,p.receivedDate));
    const open=pos.filter(p=>['placed','in_transit','partial'].includes(p.status));
    return {v,count:pos.length,done:done.length,onTime:done.length?onTime.length/done.length:null,fill:q?r/q:null,actualLT:lts.length?lts.reduce((a,b)=>a+b,0)/lts.length:null,openVal:open.reduce((a,p)=>a+poTotal(p),0)};
  });
}

/* ============================================================
   RENDER SHELL
============================================================ */
function renderRail(){
  const {agg}=S.mode==='ready'&&S.wsDoc?compute():{agg:{}};
  const counts={inventory:agg.toOrder,purchasing:agg.toOrder};
  let ws='';
  if(S.mode==='ready'){
    if(S.isOwner){
      const opts=Object.values(S.workspaces);if(!S.workspaces[S.uid])opts.push({id:S.uid,brand:'My workspace (not set up)'});
      if(!opts.find(o=>o.id===S.ws))opts.push({id:S.ws,brand:(S.wsDoc&&S.wsDoc.brand)||'Workspace'});
      ws=`<div class="wsbox"><label for="wsSel">Brand workspace</label><select id="wsSel">${sortBy(opts,o=>(o.id===S.uid?'0':'1')+(o.brand||'')).map(o=>`<option value="${esc(o.id)}"${o.id===S.ws?' selected':''}>${esc(o.brand||'Unnamed brand')}${o.id===S.uid?' (you)':''}</option>`).join('')}</select></div>`;
    }else if(S.wsDoc)ws=`<div class="wsbox"><label>Brand workspace</label><div class="wsname">${esc(S.wsDoc.brand)}</div></div>`;
  }
  $('#rail').innerHTML=`<div class="brand"><b>StockVelocity</b><small>by SCaaS Global</small></div>${ws}<nav class="nav" aria-label="StockVelocity">${NAV.map(([g,items])=>(g?`<h6>${g}</h6>`:'')+items.map(([id,lab])=>`<a href="#${id}" data-page="${id}" class="${id===page?'on':''}"${id===page?' aria-current="page"':''}><span>${lab}</span>${counts[id]?`<span class="cnt">${counts[id]}</span>`:''}</a>`).join('')).join('')}</nav>`;
}
function ph(eb,title,desc,acts=''){return `<div class="ph"><div><div class="eb">${eb}</div><h1>${title}</h1>${desc?`<p>${desc}</p>`:''}</div>${acts?`<div class="acts">${acts}</div>`:''}</div>`}
function tbl(heads,rows,emptyTitle,emptyText){
  const h=heads.map(x=>{const [lab,cls]=Array.isArray(x)?x:[x,''];return `<th class="${cls}">${lab}</th>`}).join('');
  const b=rows.length?rows.map(r=>`<tr>${r.join('')}</tr>`).join(''):`<tr><td colspan="${heads.length}"><div class="empty"><b>${emptyTitle||'Nothing here yet'}</b>${emptyText||''}</div></td></tr>`;
  return `<div class="tw"><table><thead><tr>${h}</tr></thead><tbody>${b}</tbody></table></div>`;
}
const td=(v,cls='')=>`<td class="${cls}">${v}</td>`;
const W=()=>S.ro?' disabled title="View-only access"':'';
function panel(title,sub,body,acts=''){return `<section class="panel"><header><div><h2>${title}</h2>${sub?`<p>${sub}</p>`:''}</div>${acts?`<div class="acts">${acts}</div>`:''}</header>${body}</section>`}

function render(){
  renderRail();
  const m=$('#main');
  if(S.mode==='loading'){return}
  if(S.mode==='nodb'||S.mode==='signedout'){m.innerHTML=`<div class="center"><div class="setup"><h1>Sign in to open your workspace</h1><p>StockVelocity keeps each brand's products, stock, orders and purchase orders in its own private workspace. Open the StockVelocity application to start planning.</p><p class="note">Contact SCaaS Global if you need access to a shared workspace.</p></div></div>`;return}
  if(S.mode==='revoked'){m.innerHTML=`<div class="center"><div class="setup"><h1>Access changed</h1><p>Reload the page to continue.</p></div></div>`;return}
  if(S.wsDoc===undefined){m.innerHTML=`<div class="center"><div class="setup"><h1>Loading workspace…</h1></div></div>`;return}
  if(S.wsDoc===null){m.innerHTML=setupView();return}
  const fn=VIEWS[page]||VIEWS.dashboard;
  let html='';
  try{html=fn()}catch(e){console.error(e);html=`<div class="banner warn">This page could not be drawn: ${esc(e.message)}</div>`}
  const sample=list('products').some(p=>p.sample);
  const pre=(S.local&&page==='dashboard'?`<div class="banner warn"><span><b>Standalone mode.</b> Data is saved in this browser on this device only. Clearing browser data erases it. Download a full workspace backup in Workspace settings regularly.</span></div>`:'')+(S.ro?`<div class="banner warn"><span>You have view-only access to this workspace. Changes will not be saved.</span></div>`:'')+(sample&&page==='dashboard'?`<div class="banner"><span><b>Sample data is loaded.</b> These products, vendors and orders are examples so you can see how planning works. Remove them when you're ready to add your own.</span><button class="btn sm" data-act="clearSample"${W()}>Remove sample data</button></div>`:'')+(S.isOwner&&S.ws!==S.uid?`<div class="banner"><span>You're managing <b>${esc(S.wsDoc.brand)}</b>'s workspace as SCaaS Global.</span></div>`:'');
  m.innerHTML=pre+html;
}

/* ============================================================
   SETUP
============================================================ */
function setupView(){
  const mine=S.ws===S.uid;
  if(!mine)return `<div class="center"><div class="setup"><h1>This brand hasn't set up its workspace yet</h1><p class="note">Pick another brand from the workspace list.</p></div></div>`;
  return `<div class="center"><form class="setup" id="setupForm"><div><div class="ph" style="margin:0"><div><div class="eb">New workspace</div><h1>Set up your brand</h1><p>${S.local?'This copy saves data in this browser only.':'Your workspace is private to your account. SCaaS Global can see it to help with planning.'}</p></div></div></div>
  <label class="fld"><span>Brand name</span><input id="su_brand" required placeholder="e.g. Lumi Skin Co."></label>
  <label class="fld"><span>Currency</span><select id="su_cur">${['PHP','USD','SGD','EUR','AUD','CNY'].map(c=>`<option>${c}</option>`).join('')}</select></label>
  <label class="fld"><span>Main warehouse name</span><input id="su_loc" value="SCaaS Global Warehouse"></label>
  <label class="fld"><span>Start with</span><select id="su_start"><option value="sample">Sample data (skincare brand example, removable)</option><option value="empty">An empty workspace</option></select></label>
  <p class="err" id="su_err" hidden></p>
  <button class="btn pri" type="submit" id="su_go">Create workspace</button></form></div>`;
}
async function doSetup(e){
  e.preventDefault();
  const btn=$('#su_go');btn.disabled=true;btn.textContent='Creating…';
  try{
    const brand=$('#su_brand').value.trim()||'My brand';
    const locId=nid();
    await saveWs({brand,currency:$('#su_cur').value,ownerId:S.uid,createdAt:new Date().toISOString(),cfg:Object.assign({},DEF_CFG,{defaultLocation:locId})},true);
    await save('locations',locId,{name:$('#su_loc').value.trim()||'Main warehouse',type:'warehouse'});
    if($('#su_start').value==='sample')await loadSample(locId);
    toast('Workspace created.');
  }catch(err){const el=$('#su_err');if(el){el.hidden=false;el.textContent='Could not create the workspace. '+(err.message||'')};btn.disabled=false;btn.textContent='Create workspace'}
}

/* ============================================================
   SAMPLE DATA
============================================================ */
async function loadSample(mainLoc){
  let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647};
  const t=today(), s={sample:true};
  const v1=nid(),v2=nid(),v3=nid(),l2=nid();
  await save('vendors',v1,{...s,name:'Guangzhou PackRight Co.',country:'China',currency:'CNY',leadTimeDays:35,depositPct:30,balanceDays:30,contact:'sales@packright.example',terms:'30% deposit, balance 30 days after arrival'});
  await save('vendors',v2,{...s,name:'Laguna Contract Labs',country:'Philippines',currency:'PHP',leadTimeDays:21,depositPct:50,balanceDays:15,contact:'orders@lagunalabs.example',terms:'50% deposit, balance 15 days after delivery'});
  await save('vendors',v3,{...s,name:'Seoul Actives Trading',country:'South Korea',currency:'USD',leadTimeDays:28,depositPct:100,balanceDays:0,contact:'export@seoulactives.example',terms:'100% before shipment'});
  await save('locations',l2,{...s,name:'Marketplace fulfillment hub',type:'marketplace'});
  const ch={};
  for(const [n,ty,st,sh] of [['Shopify','shopify','csv',.25],['Shopee','shopee','csv',.33],['Lazada','lazada','csv',.2],['TikTok Shop','tiktok','csv',.16],['Wholesale','wholesale','manual',.06]]){const id=nid();ch[n]={id,sh};await save('channels',id,{...s,name:n,type:ty,status:st})}
  const ids={};['FG-100','FG-101','FG-102','FG-103','FG-104','CP-200','CP-201','CP-202','CP-203','RM-300','RM-301'].forEach(k=>ids[k]=nid());
  const prods=[
    ['FG-100','Niacinamide Serum 30ml','finished','make',null,0,499,7,0,1,{[mainLoc]:220,[l2]:40},[['CP-200',1],['CP-201',1],['CP-202',1],['RM-300',30]]],
    ['FG-101','Gentle Cleanser 150ml','finished','buy',v2,120,399,0,500,50,{[mainLoc]:760,[l2]:140}],
    ['FG-102','Sunscreen SPF50 50ml','finished','buy',v2,165,549,0,500,50,{[mainLoc]:250,[l2]:50}],
    ['FG-103','Hydrating Toner 120ml','finished','make',null,0,449,7,0,1,{[mainLoc]:380},[['CP-203',1],['CP-201',1],['CP-202',1],['RM-301',120]]],
    ['FG-104','Lip Balm Duo','finished','buy',v3,60,249,0,300,30,{[mainLoc]:1400}],
    ['CP-200','30ml dropper bottle','component','buy',v1,9.5,0,0,3000,500,{[mainLoc]:1300}],
    ['CP-201','Front label (shared)','component','buy',v1,1.2,0,0,5000,1000,{[mainLoc]:9000}],
    ['CP-202','Folding box (shared)','component','buy',v1,4.8,0,0,3000,500,{[mainLoc]:1500}],
    ['CP-203','120ml toner bottle','component','buy',v1,11,0,0,2000,500,{[mainLoc]:650}],
    ['RM-300','Serum base (ml)','component','buy',v3,1.6,0,0,10000,1000,{[mainLoc]:18000}],
    ['RM-301','Toner base (ml)','component','buy',v3,.35,0,0,20000,5000,{[mainLoc]:62000}]
  ];
  const costMake={'FG-100':9.5+1.2+4.8+30*1.6,'FG-103':11+1.2+4.8+120*.35};
  for(const [sku,name,type,mb,vend,cost,price,lt,moq,cp,stock,bom] of prods){
    await save('products',ids[sku],{...s,sku,name,type,makeBuy:mb,vendorId:vend||'',unitCost:cost||+(costMake[sku]||0).toFixed(2),price,leadTimeDays:lt||'',moq,casePack:cp,stock,forecastAdj:0,active:true,bom:(bom||[]).map(([c,q])=>({componentId:ids[c],qty:q}))});
  }
  const base={'FG-100':[780,820,860,900,930,980],'FG-101':[640,600,620,590,610,600],'FG-102':[420,500,560,640,720,810],'FG-103':[380,410,390,420,400,415],'FG-104':[260,230,190,160,140,120]};
  const M6=lastMonths(6);
  for(const [sku,arr] of Object.entries(base)){
    for(const [n,c] of Object.entries(ch)){
      const months={};M6.forEach((m,i)=>{months[m]=Math.max(0,Math.round(arr[i]*c.sh*(.88+rnd()*.24)))});
      await save('history',ids[sku]+'__'+c.id,{...s,productId:ids[sku],channelId:c.id,months});
    }
  }
  await save('pos',nid(),{...s,number:'PO-1001',vendorId:v2,locationId:mainLoc,orderDate:addDays(t,-10),expectedDate:addDays(t,11),status:'placed',freight:3500,lines:[{productId:ids['FG-101'],qty:1200,unitCost:120,received:0}],shipment:{stage:'Booked',carrier:'',tracking:'',eta:addDays(t,11)}});
  await save('pos',nid(),{...s,number:'PO-1002',vendorId:v1,locationId:mainLoc,orderDate:addDays(t,-25),expectedDate:addDays(t,10),status:'in_transit',freight:18000,lines:[{productId:ids['CP-201'],qty:10000,unitCost:1.2,received:0},{productId:ids['CP-203'],qty:1000,unitCost:11,received:0}],shipment:{stage:'On the water',carrier:'Sample sea freight',tracking:'SAMPLE-0001',eta:addDays(t,14)}});
  await save('pos',nid(),{...s,number:'PO-1003',vendorId:v3,locationId:mainLoc,orderDate:addDays(t,-60),expectedDate:addDays(t,-32),receivedDate:addDays(t,-28),status:'received',freight:9000,lines:[{productId:ids['RM-301'],qty:40000,unitCost:.35,received:40000}],shipment:{stage:'Delivered',carrier:'Sample air freight',tracking:'SAMPLE-0002',eta:addDays(t,-28)}});
  await save('pos',nid(),{...s,number:'PO-1004',vendorId:v2,locationId:mainLoc,orderDate:addDays(t,-50),expectedDate:addDays(t,-29),receivedDate:addDays(t,-30),status:'received',freight:4200,lines:[{productId:ids['FG-102'],qty:800,unitCost:165,received:780}],shipment:{stage:'Delivered',carrier:'',tracking:'',eta:addDays(t,-30)}});
  await save('orders',nid(),{...s,number:'SO-1001',channelId:ch['Wholesale'].id,customer:'Sample retailer, Cebu',date:addDays(t,-2),status:'open',lines:[{productId:ids['FG-101'],qty:200,price:300},{productId:ids['FG-102'],qty:120,price:410}]});
  await save('orders',nid(),{...s,number:'SO-1002',channelId:ch['Shopify'].id,customer:'Web order',date:addDays(t,-1),status:'open',lines:[{productId:ids['FG-100'],qty:3,price:499}]});
  await save('orders',nid(),{...s,number:'SO-1003',channelId:ch['Shopee'].id,customer:'Shopee batch',date:addDays(t,-3),status:'shipped',lines:[{productId:ids['FG-100'],qty:46,price:479},{productId:ids['FG-103'],qty:18,price:429}]});
  await save('returns',nid(),{...s,number:'RMA-1001',orderRef:'SO-0998',productId:ids['FG-102'],qty:3,reason:'Damaged in transit',disposition:'scrap',status:'open',date:addDays(t,-4)});
  await save('scenarios',nid(),{...s,name:'Dropper bottle sourcing',productId:ids['CP-200'],qty:5000,options:[{label:'Guangzhou PackRight (sea)',vendorId:v1,unitPrice:1.15,fx:7.9,freight:.9,dutyPct:10,other:.3,leadTimeDays:35},{label:'Local supplier, Valenzuela',vendorId:'',unitPrice:12.5,fx:1,freight:.2,dutyPct:0,other:0,leadTimeDays:10},{label:'Guangzhou PackRight (air)',vendorId:v1,unitPrice:1.15,fx:7.9,freight:3.4,dutyPct:10,other:.3,leadTimeDays:12}]});
}
async function wipe(onlySample){
  for(const c of COLS){for(const d of list(c)){if(!onlySample||d.sample)await del(c,d.id)}}
}

/* ============================================================
   VIEWS
============================================================ */
const VIEWS={};
const statusRank={'Stockout':0,'Order now':1,'Overstock':2,'No demand':3,'Healthy':4};
const coverTxt=c=>c===Infinity?'—':Math.max(0,Math.round(c))+'d';
function emptyProducts(){return `<div class="empty"><b>No products yet</b>Add products in Product master or import a CSV to start planning.<div style="margin-top:10px" class="acts" ><a class="btn pri" href="#products">Add products</a><a class="btn" href="#integrations">Import CSV</a></div></div>`}

VIEWS.dashboard=()=>{
  const {rows,agg}=compute(); const C=cfg();
  const cs=cashSchedule(); const t=today(), in30=addDays(t,30);
  const due30=cs.items.filter(i=>i.kind==='committed'&&i.date<=in30).reduce((a,i)=>a+i.amt,0);
  const alerts=sortBy(rows.filter(r=>r.status!=='Healthy'||r.below),r=>statusRank[r.status]*1e6-r.riskV).slice(0,10);
  const inbound=sortBy(list('pos').filter(p=>['placed','in_transit','partial'].includes(p.status)),p=>(p.shipment&&p.shipment.eta)||p.expectedDate).slice(0,5);
  const sold30=list('orders').filter(o=>o.status!=='cancelled'&&o.date>=addDays(t,-30));
  return ph('Supply chain operating system',esc(S.wsDoc.brand),'Demand, inventory, purchasing and cash in one place. Every number below is calculated from your live data.',`<a class="btn" href="#purchasing">Review buys</a><a class="btn pri" href="#orders" data-act="newSO">New sales order</a>`)+
  `<div class="kpis">
    <div class="kpi"><span>Inventory value</span><strong>${money(agg.value,0)}</strong><small>At cost, all locations</small></div>
    <div class="kpi ${agg.toOrder?'warn':''}"><span>Products to order</span><strong>${agg.toOrder}</strong><small>At or below reorder point</small></div>
    <div class="kpi ${agg.risk?'crit':''}"><span>Revenue at risk</span><strong>${money(agg.risk,0)}</strong><small>Shortfall before new stock can land</small></div>
    <div class="kpi"><span>Open purchase orders</span><strong>${agg.openPOs}</strong><small>Placed or in transit</small></div>
    <div class="kpi"><span>Supplier payments, 30 days</span><strong>${money(due30,0)}</strong><small>Committed POs only</small></div>
    <div class="kpi"><span>Cash in excess stock</span><strong>${money(agg.excess,0)}</strong><small>Above ${C.overstockDays} days of cover</small></div>
  </div>`+
  panel('Inventory alerts','Products that need a decision, most urgent first.',rows.length?tbl(['SKU','Product',['Available','n'],['Incoming','n'],['ROP','n'],['Cover','n'],'Status',['Suggested','n'],''],alerts.map(r=>[td(esc(r.p.sku),'sku'),td(esc(r.p.name)),td(num(r.av),'n'),td(num(r.ic),'n'),td(num(r.rop),'n'),td(coverTxt(r.cover),'n'),td(pill(r.status)+(r.below&&r.status!=='Stockout'?' '+pill('Below safety'):'')),td(r.sug?num(r.sug):'—','n'),td(r.sug?`<a class="btn sm" href="#${r.p.makeBuy==='make'?'mrp':'purchasing'}">${r.p.makeBuy==='make'?'Plan production':'Buy'}</a>`:'','act')]),'All products are healthy','Nothing is below its reorder point or overstocked.'):emptyProducts(),'<a class="btn sm" href="#inventory">Full inventory plan</a>')+
  `<div class="grid2">`+
  panel('Inbound next','Purchase orders still to arrive.',tbl(['PO','Vendor','ETA','Stage',['Value','n']],inbound.map(p=>{const eta=(p.shipment&&p.shipment.eta)||p.expectedDate;const late=eta>p.expectedDate;return [td(esc(p.number),'sku'),td(esc(vName(p.vendorId))),td(esc(eta)+(late?' '+pill('Late'):'')),td(esc((p.shipment&&p.shipment.stage)||'—')),td(money(poTotal(p)),'n')]}),'No open purchase orders'),'<a class="btn sm" href="#inbound">Track shipments</a>')+
  panel('Sales, last 30 days','Units by channel from recorded sales orders.',(()=>{const by={};sold30.forEach(o=>{const k=o.channelId||'_';by[k]=(by[k]||0)+(o.lines||[]).reduce((a,l)=>a+(+l.qty||0),0)});const chs=sortBy(list('channels'),c=>c.name);return tbl(['Channel','Connection',['Units','n']],chs.map(c=>[td(esc(c.name)),td(connPill(c.status)),td(num(by[c.id]||0),'n')]),'No sales channels','Add Shopify, Shopee, Lazada or wholesale in Sales channels.')})(),'<a class="btn sm" href="#channels">Manage channels</a>')+
  `</div>`;
};
const connPill=s=>({csv:'<span class="pill acc">CSV import</span>',manual:'<span class="pill mute">Manual entry</span>',connected:'<span class="pill ok">Connected</span>'}[s]||'<span class="pill mute">Manual entry</span>');

VIEWS.products=()=>{
  const ps=sortBy(list('products'),p=>p.sku||'');
  return ph('Master data','Product master','Finished goods and the components you buy to make them. Costs and lead times here drive every plan.',`<button class="btn" data-act="adjustStock"${W()}>Stock count</button><button class="btn pri" data-act="editProduct"${W()}>Add product</button>`)+
  panel('Products',ps.length+' items',tbl(['SKU','Name','Type','Source',['Unit cost','n'],['Price','n'],['On hand','n'],['Lead time','n'],''],ps.map(p=>{const v=V(p.vendorId);const lt=+p.leadTimeDays||(v&&v.leadTimeDays)||cfg().defaultLeadTime;return [td(esc(p.sku),'sku'),td(esc(p.name)+(p.active===false?' <span class="pill mute">Inactive</span>':'')),td(p.type==='component'?'Component':'Finished good'),td(p.makeBuy==='make'?'Made in-house <span class="sub">'+(p.bom||[]).length+' BOM lines</span>':esc(vName(p.vendorId))),td(money(p.unitCost,2),'n'),td(p.price?money(p.price,0):'—','n'),td(num(onHand(p)),'n'),td(lt+'d','n'),td(`<button class="btn sm" data-act="adjustStock" data-id="${p.id}"${W()}>Count</button><button class="btn sm" data-act="editProduct" data-id="${p.id}"${W()}>Edit</button>`,'act')]}),'No products yet','Add your first product or import a product CSV from Integrations.'));
};
VIEWS.vendors=()=>{
  const vs=sortBy(list('vendors'),v=>v.name);const st=supplierStats();
  return ph('Master data','Vendor master','Suppliers, factories and contract manufacturers. Lead times and payment terms feed planning and cash forecasts.',`<button class="btn pri" data-act="editVendor"${W()}>Add vendor</button>`)+
  panel('Vendors',vs.length+' vendors',tbl(['Vendor','Country','Currency',['Lead time','n'],'Payment terms',['Open PO value','n'],''],vs.map(v=>{const s=st.find(x=>x.v.id===v.id);return [td(esc(v.name)+(v.contact?`<span class="sub">${esc(v.contact)}</span>`:'')),td(esc(v.country||'—')),td(esc(v.currency||'—')),td((v.leadTimeDays||'—')+'d','n'),td(`${+v.depositPct||0}% deposit, balance ${+v.balanceDays||0}d after arrival`),td(money(s?s.openVal:0),'n'),td(`<button class="btn sm" data-act="editVendor" data-id="${v.id}"${W()}>Edit</button>`,'act')]}),'No vendors yet','Add the suppliers you buy from.'));
};
VIEWS.locations=()=>{
  const ls=sortBy(list('locations'),l=>l.name), d=defLoc();
  return ph('Master data','Locations','Warehouses and fulfillment points where you hold stock.',`<button class="btn pri" data-act="editLocation"${W()}>Add location</button>`)+
  panel('Locations','',tbl(['Location','Type',['SKUs stocked','n'],['Units','n'],['Value at cost','n'],''],ls.map(l=>{let u=0,val=0,n=0;list('products').forEach(p=>{const q=+(p.stock||{})[l.id]||0;if(q){n++;u+=q;val+=q*(+p.unitCost||0)}});return [td(esc(l.name)+(l.id===d?' <span class="pill acc">Default</span>':'')),td(esc(l.type||'warehouse')),td(n,'n'),td(num(u),'n'),td(money(val,0),'n'),td(`<button class="btn sm" data-act="editLocation" data-id="${l.id}"${W()}>Edit</button>`,'act')]}),'No locations','Add your warehouse to start tracking stock.'));
};
VIEWS.channels=()=>{
  const {demCh,M6}=compute();const last=M6[5];
  const cs=sortBy(list('channels'),c=>c.name);
  const units=id=>Object.values(demCh).reduce((a,o)=>a+((o[id]&&o[id][last])||0),0);
  return ph('Master data','Sales channels','Where your demand comes from. Each channel feeds demand planning through sales orders or imported history.',`<button class="btn pri" data-act="editChannel"${W()}>Add channel</button>`)+
  (cs.length?`<div class="cards">${cs.map(c=>`<div class="card"><h3>${esc(c.name)}</h3><div>${connPill(c.status)}</div><div class="row"><span>Units in ${monthLabel(last)}</span><b>${num(units(c.id))}</b></div><div class="row"><span>Open orders</span><b>${list('orders').filter(o=>o.channelId===c.id&&o.status==='open').length}</b></div><div><button class="btn sm" data-act="editChannel" data-id="${c.id}"${W()}>Edit</button></div></div>`).join('')}</div>`:panel('Channels','',`<div class="empty"><b>No channels yet</b>Add Shopify, Shopee, Lazada, TikTok Shop, Amazon or wholesale.</div>`))+
  `<p class="note" style="margin-top:14px">Direct store connections are not switched on yet. Export orders from Shopify, Shopee or Lazada as CSV and bring them in from <a href="#integrations">Integrations & import</a>.</p>`;
};
function spark(series,fc){
  const w=120,h=30,all=series.concat([fc]),mx=Math.max(1,...all);
  const x=i=>4+i*(w-8)/(all.length-1), y=v=>h-3-(v/mx)*(h-8);
  const pts=series.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area=`4,${h-3} ${pts} ${x(series.length-1).toFixed(1)},${h-3}`;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polygon points="${area}" fill="var(--accent-soft)"/><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.6"/><line x1="${x(series.length-1)}" y1="${y(series[series.length-1])}" x2="${x(all.length-1)}" y2="${y(fc)}" stroke="var(--accent)" stroke-width="1.4" stroke-dasharray="3 2"/><circle cx="${x(all.length-1)}" cy="${y(fc)}" r="2.6" fill="var(--accent)"/></svg>`;
}
VIEWS.demand=()=>{
  const {R,M6,demCh}=compute();
  const chs=sortBy(list('channels'),c=>c.name);
  const f=S.ui.demandCh||'';
  const fgs=sortBy(Object.values(R).filter(r=>r.p.type!=='component'),r=>r.p.sku);
  const row=r=>{let ser=r.series;if(f){const o=(demCh[r.p.id]||{})[f]||{};ser=M6.map(m=>o[m]||0)}
    const l3=ser.slice(-3);const fc=f?(l3[2]*.5+l3[1]*.3+l3[0]*.2)*(1+(+r.p.forecastAdj||0)/100):r.fcM;
    const tr=r.trend;return [td(esc(r.p.sku),'sku'),td(esc(r.p.name)),...M6.slice(-3).map((m,i)=>td(num(ser[3+i]),'n')),td(spark(ser,fc)),td((r.p.forecastAdj?(r.p.forecastAdj>0?'+':'')+r.p.forecastAdj+'%':'—'),'n'),td('<b>'+num(fc)+'</b>','n'),td(num(fc/30,1),'n'),td(f?'—':`<span class="pill ${tr>.08?'ok':tr<-.08?'crit':'mute'}">${tr>0?'+':''}${Math.round(tr*100)}%</span>`),td(`<button class="btn sm" data-act="editAdj" data-id="${r.p.id}"${W()}>Adjust</button>`,'act')]};
  return ph('Planning','Demand planning','Monthly forecast per product from the last three complete months (weighted 50/30/20), plus your adjustment for promos, launches or seasonality.',`<a class="btn" href="#integrations">Import sales history</a>`)+
  `<div class="filters" style="margin-bottom:12px"><label for="demandCh" class="note">Channel</label><select id="demandCh"><option value="">All channels</option>${chs.map(c=>`<option value="${c.id}"${c.id===f?' selected':''}>${esc(c.name)}</option>`).join('')}</select></div>`+
  panel('Finished-goods forecast','Units per month. The dashed segment is next month\'s forecast.',tbl(['SKU','Product',...M6.slice(-3).map(m=>[monthLabel(m),'n']),'6-month trend',['Adj.','n'],['Forecast / mo','n'],['Per day','n'],'Trend',''],fgs.map(row),'No finished goods yet','Add products and sales history to see a forecast.'))+
  `<p class="note">Component demand is not forecast here. It is derived from finished-goods forecasts through each bill of materials on <a href="#mrp">MRP & production</a>.</p>`;
};
VIEWS.inventory=()=>{
  const {rows}=compute();const C=cfg();
  const rs=sortBy(rows,r=>statusRank[r.status]+r.p.sku);
  return ph('Planning','Inventory planning',`Reorder point = daily demand × lead time + safety stock. Safety stock covers demand swings at a ${C.serviceLevel}% service level. Suggested quantity tops up to ${C.reviewDays} days beyond the reorder point, respecting MOQ and case pack.`,`<button class="btn" data-act="editSettings"${W()}>Planning rules</button><a class="btn pri" href="#purchasing">Create POs</a>`)+
  panel('Inventory plan',rs.length+' active products',tbl(['SKU','Product',['Per day','n'],['Lead time','n'],['Safety','n'],['ROP','n'],['On hand','n'],['Allocated','n'],['Available','n'],['Incoming','n'],['Cover','n'],['Suggested','n'],'Status'],rs.map(r=>[td(esc(r.p.sku),'sku'),td(esc(r.p.name)+(r.p.type==='component'?'<span class="sub">Component · from BOMs</span>':'')),td(num(r.avgDaily,1),'n'),td(r.lt+'d','n'),td(num(r.ss),'n'),td(num(r.rop),'n'),td(num(r.oh),'n'),td(num(r.al),'n'),td(num(r.av),'n'),td(num(r.ic)+(r.eta?`<span class="sub">ETA ${esc(r.eta)}</span>`:''),'n'),td(coverTxt(r.cover),'n'),td(r.sug?'<b>'+num(r.sug)+'</b>':'—','n'),td(pill(r.status))]),'No products yet','Add products to calculate reorder points.'));
};
VIEWS.mrp=()=>{
  const {R,mrp}=compute();
  const makes=sortBy(Object.values(R).filter(r=>r.p.makeBuy==='make'),r=>r.p.sku);
  const comps=sortBy(Object.values(R).filter(r=>r.p.type==='component'),r=>r.p.sku);
  return ph('Planning','MRP & production','Turns the production plan for made-in-house products into component requirements, and records production runs against stock.',`<button class="btn pri" data-act="produce"${W()}>Record production</button>`)+
  panel('Production plan','Made-in-house products with a suggested run size.',tbl(['SKU','Product',['Available','n'],['ROP','n'],['Suggested run','n'],'Can build?','BOM',''],makes.map(r=>{const bom=r.p.bom||[];let can=Infinity;bom.forEach(b=>{const c=P(b.componentId);if(!c||!+b.qty)return;can=Math.min(can,Math.floor(onHand(c)/(+b.qty)))});if(!bom.length)can=0;const ok=r.sug&&can>=r.sug;return [td(esc(r.p.sku),'sku'),td(esc(r.p.name)),td(num(r.av),'n'),td(num(r.rop),'n'),td(r.sug?'<b>'+num(r.sug)+'</b>':'—','n'),td(!bom.length?'<span class="pill mute">No BOM</span>':r.sug?(ok?'<span class="pill ok">Yes</span>':`<span class="pill warn">Up to ${num(can)}</span>`):`<span class="note">Up to ${num(can===Infinity?0:can)}</span>`),td(bom.map(b=>`${esc((P(b.componentId)||{}).sku||'?')} ×${b.qty}`).join(', ')||'—'),td(`<button class="btn sm" data-act="editProduct" data-id="${r.p.id}"${W()}>Edit BOM</button><button class="btn sm" data-act="produce" data-id="${r.p.id}"${W()}>Produce</button>`,'act')]}),'No made-in-house products','Set a finished good\'s source to "Made in-house" and add its bill of materials.'))+
  panel('Component requirements','Gross need for the suggested runs above, netted against stock and open POs.',tbl(['SKU','Component','Used in',['Gross need','n'],['Available','n'],['Incoming','n'],['Net short','n'],['Reorder buy','n'],'Status'],comps.map(r=>{const g=mrp[r.p.id]||0;const short=Math.max(0,g-r.av-r.ic);return [td(esc(r.p.sku),'sku'),td(esc(r.p.name)),td((r.usedBy||[]).map(u=>esc((P(u.fg)||{}).sku)).join(', ')||'—'),td(num(g),'n'),td(num(r.av),'n'),td(num(r.ic),'n'),td(short?`<b style="color:var(--crit)">${num(short)}</b>`:'0','n'),td(r.sug?num(r.sug):'—','n'),td(pill(r.status))]}),'No components','Add components (bottles, labels, raw materials) as products with type "Component".'));
};
function landed(o){const base=(+o.unitPrice||0)*(+o.fx||1);return (base+(+o.freight||0))*(1+(+o.dutyPct||0)/100)+(+o.other||0)}
VIEWS.landed=()=>{
  const sc=sortBy(list('scenarios'),s=>s.name);const C=cfg();
  return ph('Planning','Landed cost scenarios',`Compare sourcing options on total landed cost: price × FX + freight, plus duty and other charges per unit. Carrying cost charges ${C.carryPct}% a year on cash tied up during the lead time.`,`<button class="btn pri" data-act="editScenario"${W()}>New scenario</button>`)+
  (sc.length?sc.map(s=>{const opts=(s.options||[]).map(o=>{const lc=landed(o);const tot=lc*(+s.qty||0);const carry=tot*C.carryPct/100*(+o.leadTimeDays||0)/365;return {o,lc,tot,carry,all:tot+carry}});const best=opts.length?opts.reduce((a,b)=>b.all<a.all?b:a):null;const p=P(s.productId);
    return panel(esc(s.name),`${p?esc(p.sku+' '+p.name):'No product'} · ${num(s.qty)} units · current cost ${p?money(p.unitCost,2):'—'}`,tbl(['Option',['Unit price','n'],['FX','n'],['Freight/u','n'],['Duty','n'],['Landed/u','n'],['Lead time','n'],['Order total','n'],['Carrying','n'],['All-in','n'],''],opts.map(x=>[td(esc(x.o.label)+(x===best?' <span class="pill ok">Best</span>':'')),td(num(x.o.unitPrice,2),'n'),td(num(x.o.fx,2),'n'),td(money(x.o.freight,2),'n'),td((+x.o.dutyPct||0)+'%','n'),td('<b>'+money(x.lc,2)+'</b>','n'),td((x.o.leadTimeDays||0)+'d','n'),td(money(x.tot,0),'n'),td(money(x.carry,0),'n'),td(money(x.all,0),'n'),td(p?`<button class="btn sm" data-act="applyOption" data-id="${s.id}" data-i="${(s.options||[]).indexOf(x.o)}"${W()}>Use for product</button>`:'','act')])),`<button class="btn sm" data-act="editScenario" data-id="${s.id}"${W()}>Edit</button>`)}).join(''):panel('Scenarios','',`<div class="empty"><b>No scenarios yet</b>Create one to compare suppliers, freight modes or local vs. imported sourcing.</div>`));
};
VIEWS.orders=()=>{
  const f=S.ui.soStatus;const os=sortBy(list('orders').filter(o=>f==='all'||o.status===f),o=>o.date||'').reverse();
  return ph('Execution','Sales orders','Orders from every channel. Open orders reserve stock; shipping an order takes it out of the default warehouse.',`<button class="btn pri" data-act="newSO"${W()}>New sales order</button>`)+
  `<div class="filters" style="margin-bottom:12px"><label for="soStatus" class="note">Show</label><select id="soStatus">${[['open','Open'],['shipped','Shipped'],['cancelled','Cancelled'],['all','All']].map(([v,l])=>`<option value="${v}"${v===f?' selected':''}>${l}</option>`).join('')}</select></div>`+
  panel('Orders',os.length+' shown',tbl(['Order','Date','Channel','Customer','Items',['Units','n'],['Value','n'],'Status',''],os.slice(0,300).map(o=>{const u=(o.lines||[]).reduce((a,l)=>a+(+l.qty||0),0),v=(o.lines||[]).reduce((a,l)=>a+(+l.qty||0)*(+l.price||0),0);return [td(esc(o.number),'sku'),td(esc(o.date)),td(esc((CH(o.channelId)||{}).name||'—')),td(esc(o.customer||'—')),td((o.lines||[]).map(l=>esc((P(l.productId)||{}).sku||'?')+' ×'+l.qty).join(', ')),td(num(u),'n'),td(money(v,0),'n'),td(pill(o.status)),td(o.status==='open'?`<button class="btn sm" data-act="shipSO" data-id="${o.id}"${W()}>Ship</button><button class="btn sm" data-act="cancelSO" data-id="${o.id}"${W()}>Cancel</button>`:'','act')]}),'No orders here','Create an order or import orders from a CSV.'));
};
VIEWS.purchasing=()=>{
  const {rows}=compute();
  const buys=rows.filter(r=>r.sug>0&&r.p.makeBuy!=='make');
  const groups={};buys.forEach(r=>{(groups[r.p.vendorId||'']=groups[r.p.vendorId||'']||[]).push(r)});
  const sel=S.ui.sel;const selVal=buys.filter(r=>sel[r.p.id]).reduce((a,r)=>a+r.sug*(+r.p.unitCost||0),0);
  const n=buys.filter(r=>sel[r.p.id]).length;
  return ph('Execution','Purchasing','Suggested buys for everything at or below its reorder point, grouped by vendor. Tick what you want and create draft POs in one step.',`<button class="btn pri" data-act="createPOs"${n&&!S.ro?'':' disabled'}>Create ${n||''} draft PO lines${n?' · '+money(selVal,0):''}</button>`)+
  (Object.keys(groups).length?Object.entries(groups).map(([vid,rs])=>{const v=V(vid);const tot=rs.reduce((a,r)=>a+r.sug*(+r.p.unitCost||0),0);
    return panel(v?esc(v.name):'No vendor assigned',v?`${v.leadTimeDays}d lead time · ${+v.depositPct||0}% deposit · suggested total ${money(tot,0)}`:'Assign a vendor in Product master to buy these.',tbl(['',`SKU`,'Product',['Available','n'],['Incoming','n'],['ROP','n'],['Cover','n'],['Suggested','n'],['Unit cost','n'],['Line value','n']],rs.map(r=>[td(`<input type="checkbox" class="chk" id="sel_${r.p.id}" data-sel="${r.p.id}"${sel[r.p.id]?' checked':''}${v?'':' disabled'} aria-label="Select ${esc(r.p.sku)}">`),td(esc(r.p.sku),'sku'),td(esc(r.p.name)+(r.status==='Stockout'?' '+pill('Stockout'):'')),td(num(r.av),'n'),td(num(r.ic),'n'),td(num(r.rop),'n'),td(coverTxt(r.cover),'n'),td('<b>'+num(r.sug)+'</b>','n'),td(money(r.p.unitCost,2),'n'),td(money(r.sug*(+r.p.unitCost||0),0),'n')])),v?`<button class="btn sm" data-act="selVendor" data-id="${vid}">Select all</button>`:'')}).join(''):panel('Suggested buys','',`<div class="empty"><b>Nothing to buy right now</b>Every bought item is above its reorder point once open POs land.</div>`));
};
const poActive=p=>['draft','placed','in_transit','partial'].includes(p.status);
// Approval state is separate from the operational purchase order status.
const poApproval=p=>p.approvalStatus||'not_sent';
function poApprovalPill(status){
  const style={not_sent:'mute',pending:'warn',approved:'ok',rejected:'crit',emailed:'acc'};
  const names={not_sent:'Not submitted',pending:'Pending approval',approved:'Approved',rejected:'Rejected',emailed:'Email confirmed'};
  return `<span class="pill ${style[status]||'mute'}">${names[status]||'Not submitted'}</span>`;
}
function poApprovalButtons(p){
  const ap=poApproval(p), id=esc(p.id), disabled=W();
  const open=`<button class="btn sm" data-act="editPO" data-id="${id}"${disabled}>${p.status==='draft'?'Edit':'Open'}</button>`;
  if(p.status!=='draft')return open;
  if(ap==='not_sent'||ap==='rejected')return `<button class="btn sm" data-act="requestPOApproval" data-id="${id}"${disabled}>${ap==='rejected'?'Resubmit':'Send PO for Approval'}</button>`+open;
  if(ap==='pending')return `<button class="btn sm" data-act="reviewPO" data-id="${id}"${disabled}>Review</button>`+open;
  if(ap==='approved')return `<button class="btn sm pri" data-act="emailPO" data-id="${id}"${disabled}>Email PO</button>`+open;
  if(ap==='emailed')return `<button class="btn sm" data-act="placePO" data-id="${id}"${disabled}>Place</button>`+open;
  return open;
}
VIEWS.pos=()=>{
  const f=S.ui.poStatus;const ps=sortBy(list('pos').filter(p=>f==='all'?true:f==='active'?poActive(p):p.status===f),p=>p.number||'').reverse();
  return ph('Execution','Purchase orders','Draft, approve, email and track purchase orders. Only placed and in-transit POs count as incoming stock.',`<button class="btn pri" data-act="editPO"${W()}>New PO</button>`)+
  `<div class="filters" style="margin-bottom:12px"><label for="poStatus" class="note">Show</label><select id="poStatus">${[['active','Open (draft to partly received)'],['draft','Drafts'],['received','Received'],['cancelled','Cancelled'],['all','All']].map(([v,l])=>`<option value="${v}"${v===f?' selected':''}>${l}</option>`).join('')}</select></div>`+
  panel('Purchase orders',ps.length+' shown',tbl(['PO','Vendor','Ordered','Expected',['Lines','n'],['Value','n'],'PO status','Approval status','Send PO for approval / Email PO'],ps.map(p=>[
    td(esc(p.number),'sku'),td(esc(vName(p.vendorId))),td(esc(p.orderDate||'—')),td(esc(p.expectedDate||'—')),
    td((p.lines||[]).length,'n'),td(money(poTotal(p),0),'n'),td(pill(p.status)),td(poApprovalPill(poApproval(p))),td(poApprovalButtons(p),'act')
  ]),'No purchase orders here','Create one from Purchasing or with New PO.'));
};
const STAGES=['Booked','Ready at origin','On the water','In the air','Arrived at port','Customs clearance','Out for delivery','Delivered'];
VIEWS.inbound=()=>{
  const ps=sortBy(list('pos').filter(p=>['placed','in_transit','partial'].includes(p.status)),p=>(p.shipment&&p.shipment.eta)||p.expectedDate);
  return ph('Execution','Inbound shipments','Where each open PO is right now. A shipment is late when its ETA passes the date the vendor promised.','')+
  panel('In the pipeline',ps.length+' shipments',tbl(['PO','Vendor','Promised','ETA','Stage','Carrier / tracking',['Value','n'],''],ps.map(p=>{const s=p.shipment||{};const eta=s.eta||p.expectedDate;const late=eta>p.expectedDate;return [td(esc(p.number),'sku'),td(esc(vName(p.vendorId))),td(esc(p.expectedDate||'—')),td(esc(eta||'—')+' '+(late?pill('Late'):pill('On time'))+`<span class="sub">${eta?(daysBetween(today(),eta)>=0?'in '+daysBetween(today(),eta)+' days':Math.abs(daysBetween(today(),eta))+' days ago'):''}</span>`),td(esc(s.stage||'Booked')),td(esc(s.carrier||'—')+(s.tracking?`<span class="sub mono">${esc(s.tracking)}</span>`:'')),td(money(poTotal(p),0),'n'),td(`<button class="btn sm" data-act="editShipment" data-id="${p.id}"${W()}>Update</button><button class="btn sm" data-act="receivePO" data-id="${p.id}"${W()}>Receive</button>`,'act')]}),'Nothing inbound','Placed POs appear here until they are received.'));
};
VIEWS.receiving=()=>{
  const ps=sortBy(list('pos').filter(p=>['placed','in_transit','partial'].includes(p.status)),p=>(p.shipment&&p.shipment.eta)||p.expectedDate);
  const done=sortBy(list('pos').filter(p=>p.status==='received'),p=>p.receivedDate||'').reverse().slice(0,10);
  return ph('Execution','Receiving','Receive goods against a PO, fully or in part. Stock goes up at the location you choose and unit cost updates to a weighted average.','')+
  panel('Ready to receive','',tbl(['PO','Vendor','ETA',['Ordered','n'],['Received','n'],['Remaining','n'],''],ps.map(p=>{let q=0,r=0;(p.lines||[]).forEach(l=>{q+=+l.qty||0;r+=+l.received||0});return [td(esc(p.number),'sku'),td(esc(vName(p.vendorId))),td(esc((p.shipment&&p.shipment.eta)||p.expectedDate||'—')),td(num(q),'n'),td(num(r),'n'),td('<b>'+num(q-r)+'</b>','n'),td(`<button class="btn sm pri" data-act="receivePO" data-id="${p.id}"${W()}>Receive</button>`,'act')]}),'Nothing waiting','Placed POs appear here.'))+
  panel('Recently received','',tbl(['PO','Vendor','Received on','Fill rate','Timing'],done.map(p=>{let q=0,r=0;(p.lines||[]).forEach(l=>{q+=+l.qty||0;r+=+l.received||0});const late=p.receivedDate>p.expectedDate;return [td(esc(p.number),'sku'),td(esc(vName(p.vendorId))),td(esc(p.receivedDate||'—')),td(q?Math.round(r/q*100)+'%':'—'),td(late?pill('Late')+` <span class="note">${daysBetween(p.expectedDate,p.receivedDate)}d</span>`:pill('On time'))]}),'No receipts yet'));
};
VIEWS.returns=()=>{
  const rs=sortBy(list('returns'),r=>r.date||'').reverse();
  return ph('Execution','RMA & returns','Log customer returns, decide what happens to the goods, and put sellable units back into stock.',`<button class="btn pri" data-act="editRMA"${W()}>New return</button>`)+
  panel('Returns',rs.length+' returns',tbl(['RMA','Date','Order','Product',['Qty','n'],'Reason','Disposition','Status',''],rs.map(r=>[td(esc(r.number),'sku'),td(esc(r.date)),td(esc(r.orderRef||'—')),td(esc(pName(r.productId))),td(num(r.qty),'n'),td(esc(r.reason||'—')),td({restock:'Restock',scrap:'Scrap',vendor:'Return to vendor'}[r.disposition]||'—'),td(pill(r.status==='received'?'received':'open')),td(r.status!=='received'?`<button class="btn sm" data-act="receiveRMA" data-id="${r.id}"${W()}>Receive</button>`:'','act')]),'No returns logged'));
};
VIEWS.health=()=>{
  const {rows}=compute();const C=cfg();
  const B=['Stockout','Order now','Healthy','Overstock','No demand'];
  const bucket={};B.forEach(b=>bucket[b]={n:0,v:0});rows.forEach(r=>{bucket[r.status].n++;bucket[r.status].v+=r.value});
  const tot=rows.reduce((a,r)=>a+r.value,0)||1;
  const bar=`<div style="display:flex;height:14px;border-radius:4px;overflow:hidden;margin:4px 0 10px;background:var(--soft)">${B.map(b=>`<div title="${b}" style="width:${bucket[b].v/tot*100}%;background:var(--${{'Stockout':'crit','Order now':'warn','Healthy':'ok','Overstock':'info','No demand':'muted'}[b]})"></div>`).join('')}</div><div class="legend">${B.map(b=>`<span><i style="background:var(--${{'Stockout':'crit','Order now':'warn','Healthy':'ok','Overstock':'info','No demand':'muted'}[b]})"></i>${b} · ${bucket[b].n} SKUs · ${money(bucket[b].v,0)}</span>`).join('')}</div>`;
  const ex=sortBy(rows.filter(r=>r.excessV>0),r=>-r.excessV);
  return ph('Performance','Inventory health',`How your stock value splits across health states, and where cash is tied up beyond ${C.overstockDays} days of cover.`,'')+
  panel('Stock value by health','Share of inventory value at cost.',`<div class="pbody">${rows.length?bar:'<p class="note">Add products to see inventory health.</p>'}</div>`)+
  panel('Excess and slow stock',`Units above ${C.overstockDays} days of cover, or with no sales in three months.`,tbl(['SKU','Product',['On hand','n'],['Per day','n'],['Cover','n'],['Excess units','n'],['Cash tied up','n'],'Status'],ex.map(r=>[td(esc(r.p.sku),'sku'),td(esc(r.p.name)),td(num(r.oh),'n'),td(num(r.avgDaily,1),'n'),td(coverTxt(r.cover),'n'),td(num(r.excessU),'n'),td('<b>'+money(r.excessV,0)+'</b>','n'),td(pill(r.status))]),'No excess stock','Everything is within your overstock limit.'));
};
VIEWS.cash=()=>{
  const cs=cashSchedule();const {agg}=compute();
  const com=cs.months.reduce((a,m)=>a+cs.b[m].committed,0), pl=cs.months.reduce((a,m)=>a+cs.b[m].planned,0);
  const mx=Math.max(1,...cs.months.map(m=>cs.b[m].committed+cs.b[m].planned));
  const W2=560,H=200,bw=(W2-60)/6;
  const nice=v=>{const p=10**Math.floor(Math.log10(v));const n=v/p;return (n<=1?1:n<=2?2:n<=5?5:10)*p};const top=nice(mx);
  const y=v=>H-24-(v/top)*(H-40);
  const short=v=>v>=1e6?num(v/1e6,v%1e6?1:0)+'M':v>=1e3?num(v/1e3,v%1e3?1:0)+'k':num(v);
  const chart=`<div class="tw"><svg class="bars" viewBox="0 0 ${W2} ${H}" width="100%" style="max-width:${W2}px;min-width:420px" role="img" aria-label="Supplier payments by month">${[0,.5,1].map(f=>`<line x1="52" x2="${W2-4}" y1="${y(top*f)}" y2="${y(top*f)}" stroke="var(--line)"/><text x="48" y="${y(top*f)+4}" text-anchor="end">${short(top*f)}</text>`).join('')}${cs.months.map((m,i)=>{const x=56+i*bw+8,w=bw-16,c=cs.b[m].committed,p=cs.b[m].planned;return `<rect x="${x}" y="${y(c)}" width="${w}" height="${Math.max(0,H-24-y(c))}" fill="var(--accent)" rx="2"/><rect x="${x}" y="${y(c+p)}" width="${w}" height="${Math.max(0,y(c)-y(c+p))}" fill="var(--warn)" opacity=".75" rx="2"/><text x="${x+w/2}" y="${H-8}" text-anchor="middle">${monthLabel(m)}</text>`}).join('')}</svg></div><div class="legend" style="margin-top:6px"><span><i style="background:var(--accent)"></i>Committed (open POs)</span><span><i style="background:var(--warn)"></i>Planned (suggested buys)</span></div>`;
  return ph('Performance','Cash requirements','Supplier payments coming due over the next six months, from open POs and the buys your plan suggests. Deposits and balances follow each vendor\'s terms.','')+
  `<div class="kpis"><div class="kpi"><span>Committed, 6 months</span><strong>${money(com,0)}</strong><small>Open PO balances and deposits</small></div><div class="kpi warn"><span>Planned, 6 months</span><strong>${money(pl,0)}</strong><small>If you place every suggested buy</small></div><div class="kpi"><span>Inventory at cost</span><strong>${money(agg.value,0)}</strong><small>Cash already in stock</small></div><div class="kpi"><span>Excess stock</span><strong>${money(agg.excess,0)}</strong><small>Cash you could free up</small></div></div>`+
  panel('Payments by month','Amounts in '+cur()+'.',`<div class="pbody">${chart}</div>`)+
  panel('Payment schedule','Overdue amounts are shown as due today.',tbl(['Due','Payment','Type',['Amount','n']],cs.items.map(i=>[td(esc(i.date)+(i.overdue?' <span class="pill crit">Overdue</span>':'')),td(esc(i.label)),td(i.kind==='committed'?'<span class="pill acc">Committed</span>':'<span class="pill warn">Planned</span>'),td(money(i.amt,0),'n')]),'No payments due','Open POs and suggested buys create payments here.'))+
  `<p class="note">Assumes deposits on POs placed before today are already paid and received POs are settled.</p>`;
};
VIEWS.risk=()=>{
  const {rows,agg}=compute();
  const rs=sortBy(rows.filter(r=>r.riskV>0||r.status==='Stockout'),r=>-r.riskV);
  return ph('Performance','Revenue at risk','Sales you could lose before replenishment arrives: demand over each product\'s lead time that available stock plus open POs won\'t cover, valued at selling price.','')+
  `<div class="kpis"><div class="kpi crit"><span>Revenue at risk</span><strong>${money(agg.risk,0)}</strong><small>${rs.length} products affected</small></div></div>`+
  panel('Products at risk','',tbl(['SKU','Product',['Per day','n'],['Lead time','n'],['Available + incoming','n'],['Demand over lead time','n'],['Short units','n'],['Price','n'],['At risk','n'],''],rs.map(r=>[td(esc(r.p.sku),'sku'),td(esc(r.p.name)),td(num(r.avgDaily,1),'n'),td(r.lt+'d','n'),td(num(r.pos),'n'),td(num(r.avgDaily*r.lt),'n'),td(num(r.shortU),'n'),td(r.p.price?money(r.p.price,0):'<span class="note">No price</span>','n'),td('<b>'+money(r.riskV,0)+'</b>','n'),td(`<a class="btn sm" href="#${r.p.makeBuy==='make'?'mrp':'purchasing'}">Act</a>`,'act')]),'No revenue at risk','Stock and open POs cover demand through every lead time.'))+
  `<p class="note">Components carry no selling price, so their risk shows through the finished goods that use them.</p>`;
};
VIEWS.suppliers=()=>{
  const st=supplierStats();const pct=v=>v==null?'—':Math.round(v*100)+'%';
  return ph('Performance','Supplier performance','On-time delivery, fill rate and real lead times, measured from the POs you receive.','')+
  panel('Scorecard','',tbl(['Vendor',['POs','n'],['Received','n'],['On time','n'],['Fill rate','n'],['Quoted lead time','n'],['Actual lead time','n'],['Open PO value','n']],st.map(s=>{const gap=s.actualLT!=null&&s.v.leadTimeDays?s.actualLT-s.v.leadTimeDays:null;return [td(esc(s.v.name)),td(s.count,'n'),td(s.done,'n'),td(s.onTime==null?'—':`<span class="pill ${s.onTime>=.9?'ok':s.onTime>=.7?'warn':'crit'}">${pct(s.onTime)}</span>`,'n'),td(pct(s.fill),'n'),td((s.v.leadTimeDays||'—')+'d','n'),td(s.actualLT==null?'—':Math.round(s.actualLT)+'d'+(gap>2?` <span class="pill crit">+${Math.round(gap)}d</span>`:''),'n'),td(money(s.openVal,0),'n')]}),'No vendors yet'))+
  `<p class="note">If actual lead time keeps running longer than quoted, update the vendor's lead time so reorder points reflect reality.</p>`;
};
const REPORTS={
  reorder:{t:'Reorder report',d:'Every product at or below its reorder point with the suggested quantity.',f:()=>{const {rows}=compute();return [['SKU','Product','Vendor','Available','Incoming','ROP','Suggested qty','Unit cost','Line value'],...sortBy(rows.filter(r=>r.sug>0),r=>r.p.sku).map(r=>[r.p.sku,r.p.name,r.p.makeBuy==='make'?'Made in-house':vName(r.p.vendorId),r.av,r.ic,r.rop,r.sug,r.p.unitCost,(r.sug*(+r.p.unitCost||0)).toFixed(2)])]}},
  valuation:{t:'Inventory valuation',d:'On-hand units and value at cost by product and location.',f:()=>{const ls=sortBy(list('locations'),l=>l.name);return [['SKU','Product',...ls.map(l=>l.name),'Total units','Unit cost','Value'],...sortBy(list('products'),p=>p.sku).map(p=>[p.sku,p.name,...ls.map(l=>+(p.stock||{})[l.id]||0),onHand(p),p.unitCost,(onHand(p)*(+p.unitCost||0)).toFixed(2)])]}},
  excess:{t:'Excess stock',d:'Products above your overstock limit and the cash tied up.',f:()=>{const {rows}=compute();return [['SKU','Product','On hand','Per day','Cover days','Excess units','Excess value'],...sortBy(rows.filter(r=>r.excessV>0),r=>-r.excessV).map(r=>[r.p.sku,r.p.name,r.oh,r.avgDaily.toFixed(1),r.cover===Infinity?'':Math.round(r.cover),Math.round(r.excessU),r.excessV.toFixed(2)])]}},
  openpos:{t:'Open purchase orders',d:'Lines still to arrive with remaining quantity and ETA.',f:()=>{const a=[['PO','Vendor','Status','Expected','ETA','SKU','Ordered','Received','Remaining','Unit cost']];list('pos').filter(p=>['placed','in_transit','partial','draft'].includes(p.status)).forEach(p=>(p.lines||[]).forEach(l=>a.push([p.number,vName(p.vendorId),p.status,p.expectedDate,(p.shipment&&p.shipment.eta)||'',(P(l.productId)||{}).sku||'',l.qty,l.received||0,(+l.qty||0)-(+l.received||0),l.unitCost])));return a}},
  forecast:{t:'Demand forecast',d:'Last six months and next-month forecast for every product.',f:()=>{const {rows,M6}=compute();return [['SKU','Product',...M6,'Forecast per month','Per day','Safety stock','ROP'],...sortBy(rows,r=>r.p.sku).map(r=>[r.p.sku,r.p.name,...r.series,Math.round(r.fcM),r.avgDaily.toFixed(2),r.ss,r.rop])]}},
  suppliers:{t:'Supplier scorecard',d:'On-time, fill rate and lead time by vendor.',f:()=>[['Vendor','POs','Received','On time %','Fill rate %','Quoted LT','Actual LT'],...supplierStats().map(s=>[s.v.name,s.count,s.done,s.onTime==null?'':Math.round(s.onTime*100),s.fill==null?'':Math.round(s.fill*100),s.v.leadTimeDays,s.actualLT==null?'':Math.round(s.actualLT)])]}
};
VIEWS.reports=()=>ph('Performance','Reports','Preview a report, then download it as CSV for Excel or Google Sheets.','')+`<div class="cards">${Object.entries(REPORTS).map(([k,r])=>`<div class="card"><h3>${r.t}</h3><p class="note">${r.d}</p><div class="row"><span>Rows</span><b>${Math.max(0,r.f().length-1)}</b></div><div><button class="btn sm pri" data-act="report" data-id="${k}">Open</button></div></div>`).join('')}</div>`;
const IMPORTS={
  products:{t:'Products',h:'sku,name,type,make_or_buy,vendor,unit_cost,price,lead_time_days,moq,case_pack,on_hand',ex:'FG-200,Vitamin C Serum 30ml,finished,buy,Laguna Contract Labs,150,599,21,500,50,320'},
  history:{t:'Monthly sales history',h:'sku,channel,month,qty',ex:'FG-200,Shopee,2026-08,240'},
  orders:{t:'Sales orders',h:'order_number,date,channel,customer,sku,qty,price,status',ex:'SHP-55102,2026-10-24,Shopify,Web order,FG-200,2,599,shipped'}
};
VIEWS.integrations=()=>ph('System','Integrations & import','Bring data in from your store exports and spreadsheets. Matching is by SKU, channel name and vendor name; anything new is created.','')+
  panel('Store connections','',`<div class="pbody"><p class="note">Live Shopify, Shopee, Lazada, TikTok Shop and Amazon connections are not switched on in this version. Export orders as CSV from each store admin, rename the columns to match the templates below, and import them here. SCaaS Global can do this for you as part of setup.</p></div>`)+
  `<div class="cards">${Object.entries(IMPORTS).map(([k,x])=>`<div class="card"><h3>${x.t}</h3><p class="note">Columns:</p><code class="mono" style="font-size:11.5px;word-break:break-word">${x.h}</code><div><button class="btn sm pri" data-act="import" data-id="${k}"${W()}>Import CSV</button></div></div>`).join('')}</div>`;
VIEWS.workspace=()=>{
  const C=cfg();const wsl=Object.values(S.workspaces);
  return ph('System','Workspace settings','Brand details and the planning rules every calculation uses.',`<button class="btn pri" data-act="editSettings"${W()}>Edit settings</button>`)+
  `<div class="grid2">`+panel('Brand','',`<div class="pbody"><div class="card" style="border:0;padding:0"><div class="row"><span>Brand</span><b>${esc(S.wsDoc.brand)}</b></div><div class="row"><span>Currency</span><b>${esc(cur())}</b></div><div class="row"><span>Default location</span><b>${esc((L(defLoc())||{}).name||'—')}</b></div></div></div>`)+
  panel('Planning rules','',`<div class="pbody"><div class="card" style="border:0;padding:0"><div class="row"><span>Service level</span><b>${C.serviceLevel}%</b></div><div class="row"><span>Safety days (new products)</span><b>${C.safetyDays}d</b></div><div class="row"><span>Order cycle (cover beyond ROP)</span><b>${C.reviewDays}d</b></div><div class="row"><span>Overstock above</span><b>${C.overstockDays}d</b></div><div class="row"><span>Default lead time</span><b>${C.defaultLeadTime}d</b></div><div class="row"><span>Carrying cost</span><b>${C.carryPct}% / yr</b></div></div></div>`)+`</div>`+
  (S.isOwner?panel('Client brands','Brands that have opened StockVelocity and set up a workspace. Only you, as the owner, can see this list.',tbl(['Brand','Currency','Created',''],sortBy(wsl,w=>w.brand||'').map(w=>[td(esc(w.brand)+(w.id===S.uid?' <span class="pill acc">You</span>':'')),td(esc(w.currency||'—')),td(esc((w.createdAt||'').slice(0,10))),td(w.id===S.ws?'<span class="pill ok">Open</span>':`<button class="btn sm" data-act="switchWs" data-id="${esc(w.id)}">Open</button>`,'act')]),'No brands yet','Share this page with a client brand. Their workspace appears here once they set it up.')):'')+
  panel('Workspace backup','Save a full copy of your workspace before major changes.',`<div class="pbody"><p class="note">Backups include all records in this browser. Keep the downloaded JSON file in a secure location. Restore replaces the existing browser workspace after confirmation.</p><div class="acts"><button class="btn pri" data-act="backupWorkspace">Download full backup</button><button class="btn" data-act="restoreWorkspace"${W()}>Restore backup</button></div></div>`)+
  panel('Danger zone','',`<div class="pbody acts"><button class="btn dng" data-act="wipeAll"${W()}>Delete all data in this workspace</button></div>`);
};

/* ============================================================
   MODAL / FORMS
============================================================ */
let MODAL=null;
function closeModal(){MODAL=null;$('#modalRoot').innerHTML=''}
function fieldHtml(f){
  const id='f_'+f.id, v=f.value??'';
  const lab=`<span>${f.label}</span>`, hint=f.hint?`<small>${f.hint}</small>`:'';
  const cls='fld'+(f.full?' full':'');
  if(f.type==='select')return `<label class="${cls}">${lab}<select id="${id}">${f.options.map(([val,l])=>`<option value="${esc(val)}"${String(val)===String(v)?' selected':''}>${esc(l)}</option>`).join('')}</select>${hint}</label>`;
  if(f.type==='textarea')return `<label class="${cls} full">${lab}<textarea id="${id}" placeholder="${esc(f.placeholder||'')}">${esc(v)}</textarea>${hint}</label>`;
  if(f.type==='lines')return `<div class="fld full">${lab}<div class="lines" id="${id}">${linesHtml(f)}</div><div><button type="button" class="btn sm" data-addline="${f.id}">Add line</button></div>${hint}</div>`;
  if(f.type==='html')return `<div class="fld full">${f.html}</div>`;
  return `<label class="${cls}">${lab}<input id="${id}" type="${f.type||'text'}"${f.type==='number'?` step="${f.step||'any'}"`:''} value="${esc(v)}"${f.required?' required':''}${f.placeholder?` placeholder="${esc(f.placeholder)}"`:''}>${hint}</label>`;
}
function linesHtml(f){
  const rows=f.rows||[];
  return `<div class="tw"><table><thead><tr>${f.cols.map(c=>`<th>${c.label}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((r,i)=>`<tr>${f.cols.map(c=>{const val=r[c.key]??'';const id=`l_${f.id}_${i}_${c.key}`;if(c.type==='select')return `<td><select id="${id}" aria-label="${esc(c.label)}">${c.options.map(([ov,ol])=>`<option value="${esc(ov)}"${String(ov)===String(val)?' selected':''}>${esc(ol)}</option>`).join('')}</select></td>`;if(c.type==='static')return `<td class="n">${esc(val)}</td>`;return `<td><input id="${id}" aria-label="${esc(c.label)}" type="${c.type||'text'}"${c.type==='number'?' step="any"':''} value="${esc(val)}" style="min-width:${c.w||70}px"></td>`}).join('')}<td>${f.fixed?'':`<button type="button" class="x" data-delline="${f.id}" data-i="${i}" aria-label="Remove line">×</button>`}</td></tr>`).join('')}</tbody></table></div>`;
}
function syncLines(f){f.rows=(f.rows||[]).map((r,i)=>{const o=Object.assign({},r);f.cols.forEach(c=>{if(c.type==='static')return;const el=document.getElementById(`l_${f.id}_${i}_${c.key}`);if(el)o[c.key]=c.type==='number'?(el.value===''?'':+el.value):el.value});return o})}
function openForm(opt){
  MODAL=opt;
  $('#modalRoot').innerHTML=`<div class="ov" data-ov="1"><form class="modal${opt.wide?' wide':''}" id="mform" role="dialog" aria-modal="true" aria-labelledby="mtitle"><header><h2 id="mtitle">${opt.title}</h2><button type="button" class="x" data-act="closeModal" aria-label="Close">×</button></header><div class="mb">${opt.fields.map(fieldHtml).join('')}<p class="err" id="merr" hidden></p></div><footer>${opt.onDelete?`<button type="button" class="btn dng" id="mdel">${opt.deleteLabel||'Delete'}</button>`:''}${(opt.extraButtons||[]).map(b=>`<button type="button" class="btn" data-extra="${b.id}">${b.label}</button>`).join('')}<div class="r"><button type="button" class="btn" data-act="closeModal">Cancel</button>${opt.onSubmit?`<button type="submit" class="btn pri" id="msave">${opt.submitLabel||'Save'}</button>`:''}</div></footer></form></div>`;
  const first=$('#mform input,#mform select,#mform textarea');if(first)first.focus();
}
function collect(){const o={};MODAL.fields.forEach(f=>{if(f.type==='html')return;if(f.type==='lines'){syncLines(f);o[f.id]=f.rows;return}const el=document.getElementById('f_'+f.id);if(!el)return;o[f.id]=f.type==='number'?(el.value===''?'':+el.value):el.value.trim()});return o}
function mErr(msg){const e=$('#merr');if(e){e.hidden=false;e.textContent=msg}}
async function submitModal(ev){
  ev.preventDefault();if(!MODAL||!MODAL.onSubmit)return;
  const vals=collect();const btn=$('#msave');btn.disabled=true;
  try{const r=await MODAL.onSubmit(vals);if(r!==false)closeModal()}catch(e){console.error(e);mErr(e.userMsg||('Not saved. '+(e.message||'')));}finally{if(btn)btn.disabled=false}
}
const fail=m=>{const e=new Error(m);e.userMsg=m;throw e};
const prodOpts=(filter,blank)=>[...(blank?[['','— Select —']]:[]),...sortBy(list('products').filter(filter||(()=>true)),p=>p.sku).map(p=>[p.id,p.sku+' · '+p.name])];
const vendOpts=blank=>[...(blank?[['','— None —']]:[]),...sortBy(list('vendors'),v=>v.name).map(v=>[v.id,v.name])];
const locOpts=()=>sortBy(list('locations'),l=>l.name).map(l=>[l.id,l.name]);
const chOpts=()=>[['','— None —'],...sortBy(list('channels'),c=>c.name).map(c=>[c.id,c.name])];
const nextNum=(c,prefix)=>{let mx=1000;list(c).forEach(d=>{const m=String(d.number||'').match(/(\d+)$/);if(m&&String(d.number).startsWith(prefix))mx=Math.max(mx,+m[1])});return prefix+(mx+1)};

/* ============================================================
   ACTIONS
============================================================ */
const A={};
A.closeModal=closeModal;
A.navtoggle=()=>$('#app').classList.toggle('navopen');
A.switchWs=d=>{openWorkspace(d.id);location.hash='dashboard'};
A.editProduct=d=>{
  const p=d.id?P(d.id):{type:'finished',makeBuy:'buy',active:true,stock:{},bom:[]};
  openForm({title:d.id?'Edit '+esc(p.sku):'Add product',wide:true,fields:[
    {id:'sku',label:'SKU',value:p.sku,required:true},{id:'name',label:'Name',value:p.name,required:true},
    {id:'type',label:'Type',type:'select',value:p.type,options:[['finished','Finished good'],['component','Component / raw material']]},
    {id:'makeBuy',label:'Source',type:'select',value:p.makeBuy,options:[['buy','Bought from a vendor'],['make','Made in-house (uses a BOM)']]},
    {id:'vendorId',label:'Vendor',type:'select',value:p.vendorId,options:vendOpts(true)},
    {id:'leadTimeDays',label:'Lead time (days)',type:'number',value:p.leadTimeDays,hint:'Leave blank to use the vendor\'s lead time. For made items, the production time.'},
    {id:'unitCost',label:'Unit cost ('+cur()+')',type:'number',value:p.unitCost},{id:'price',label:'Selling price ('+cur()+')',type:'number',value:p.price},
    {id:'moq',label:'Minimum order qty',type:'number',value:p.moq},{id:'casePack',label:'Case pack',type:'number',value:p.casePack,hint:'Orders round up to this multiple.'},
    {id:'active',label:'Status',type:'select',value:p.active===false?'no':'yes',options:[['yes','Active'],['no','Inactive (excluded from planning)']]},
    {id:'bom',label:'Bill of materials (made-in-house only)',type:'lines',rows:(p.bom||[]).map(b=>Object.assign({},b)),cols:[{key:'componentId',label:'Component',type:'select',options:prodOpts(x=>x.type==='component'&&x.id!==d.id,true)},{key:'qty',label:'Qty per unit',type:'number'}]}
  ],onDelete:d.id?async()=>{await del('products',d.id);toast('Product deleted.')}:null,
  onSubmit:async v=>{
    if(!v.sku||!v.name)fail('SKU and name are required.');
    const dup=list('products').find(x=>x.sku.toLowerCase()===v.sku.toLowerCase()&&x.id!==d.id);if(dup)fail('Another product already uses SKU '+v.sku+'.');
    const o=Object.assign({},p,{sku:v.sku,name:v.name,type:v.type,makeBuy:v.makeBuy,vendorId:v.vendorId,leadTimeDays:v.leadTimeDays,unitCost:+v.unitCost||0,price:+v.price||0,moq:+v.moq||0,casePack:+v.casePack||1,active:v.active==='yes',bom:v.bom.filter(b=>b.componentId&&+b.qty>0).map(b=>({componentId:b.componentId,qty:+b.qty})),forecastAdj:p.forecastAdj||0,stock:p.stock||{}});
    await save('products',d.id||nid(),o);toast(d.id?'Product saved.':'Product added.');
  }});
};
A.adjustStock=d=>{
  const locs=locOpts();if(!locs.length){toast('Add a location first.');return}
  const pid=d.id||(sortBy(list('products'),p=>p.sku)[0]||{}).id;if(!pid){toast('Add a product first.');return}
  const build=id=>{const p=P(id);return [{id:'pid',label:'Product',type:'select',value:id,options:prodOpts(),full:true},...locs.map(([lid,ln])=>({id:'loc_'+lid,label:ln,type:'number',value:+(p.stock||{})[lid]||0})),{id:'note',type:'html',html:'<p class="note">Enter the counted quantity at each location. This replaces the system quantity.</p>'}]};
  openForm({title:'Stock count',fields:build(pid),onSubmit:async v=>{const stock={};locs.forEach(([lid])=>stock[lid]=+v['loc_'+lid]||0);await upd('products',v.pid,{stock});toast('Stock updated for '+P(v.pid).sku+'.')}});
  const sel=$('#f_pid');sel.addEventListener('change',()=>{const id=sel.value;const p=P(id);locs.forEach(([lid])=>{const el=$('#f_loc_'+lid);if(el)el.value=+(p.stock||{})[lid]||0})});
};
A.editVendor=d=>{
  const v=d.id?V(d.id):{depositPct:30,balanceDays:30,leadTimeDays:30,currency:cur()};
  openForm({title:d.id?'Edit vendor':'Add vendor',fields:[
    {id:'name',label:'Vendor name',value:v.name,required:true,full:true},{id:'country',label:'Country',value:v.country},{id:'currency',label:'Billing currency',value:v.currency},
    {id:'leadTimeDays',label:'Lead time (days)',type:'number',value:v.leadTimeDays,hint:'Order to arrival at your warehouse.'},{id:'contact',label:'Contact email',value:v.contact},
    {id:'depositPct',label:'Deposit at order (%)',type:'number',value:v.depositPct},{id:'balanceDays',label:'Balance due (days after arrival)',type:'number',value:v.balanceDays}
  ],onDelete:d.id?async()=>{await del('vendors',d.id);toast('Vendor deleted.')}:null,onSubmit:async x=>{if(!x.name)fail('Vendor name is required.');await save('vendors',d.id||nid(),Object.assign({},v,x,{leadTimeDays:+x.leadTimeDays||0,depositPct:+x.depositPct||0,balanceDays:+x.balanceDays||0}));toast('Vendor saved.')}});
};
A.editLocation=d=>{
  const l=d.id?L(d.id):{type:'warehouse'};
  openForm({title:d.id?'Edit location':'Add location',fields:[{id:'name',label:'Name',value:l.name,required:true},{id:'type',label:'Type',type:'select',value:l.type,options:[['warehouse','Warehouse'],['3pl','3PL'],['marketplace','Marketplace fulfillment'],['store','Retail store']]}],
  onDelete:d.id?async()=>{if(list('products').some(p=>+(p.stock||{})[d.id]))fail('Move or count the stock at this location to zero before deleting it.');await del('locations',d.id)}:null,
  onSubmit:async x=>{if(!x.name)fail('Name is required.');await save('locations',d.id||nid(),Object.assign({},l,x));toast('Location saved.')}});
};
A.editChannel=d=>{
  const c=d.id?CH(d.id):{type:'shopify',status:'csv'};
  openForm({title:d.id?'Edit channel':'Add channel',fields:[{id:'name',label:'Name',value:c.name,required:true},{id:'type',label:'Type',type:'select',value:c.type,options:[['shopify','Shopify'],['shopee','Shopee'],['lazada','Lazada'],['tiktok','TikTok Shop'],['amazon','Amazon'],['wholesale','Wholesale / B2B'],['retail','Retail store'],['other','Other']]},{id:'status',label:'Data source',type:'select',value:c.status,options:[['csv','CSV import'],['manual','Manual entry']]}],
  onDelete:d.id?async()=>{await del('channels',d.id)}:null,onSubmit:async x=>{if(!x.name)fail('Name is required.');await save('channels',d.id||nid(),Object.assign({},c,x));toast('Channel saved.')}});
};
A.editAdj=d=>{const p=P(d.id);openForm({title:'Forecast adjustment · '+esc(p.sku),fields:[{id:'adj',label:'Adjustment (%)',type:'number',value:p.forecastAdj||0,hint:'For example +25 for a 9.9 sale or launch month, −15 for a slow season.',full:true}],onSubmit:async v=>{await upd('products',d.id,{forecastAdj:+v.adj||0});toast('Forecast updated.')}})};
A.editSettings=()=>{
  const C=cfg();
  openForm({title:'Workspace settings',fields:[
    {id:'brand',label:'Brand name',value:S.wsDoc.brand},{id:'currency',label:'Currency',type:'select',value:cur(),options:['PHP','USD','SGD','EUR','AUD','CNY'].map(c=>[c,c])},
    {id:'serviceLevel',label:'Service level',type:'select',value:C.serviceLevel,options:[[90,'90%'],[95,'95%'],[97.5,'97.5%'],[98,'98%'],[99,'99%']],hint:'Higher means more safety stock and fewer stockouts.'},
    {id:'safetyDays',label:'Safety days for new products',type:'number',value:C.safetyDays,hint:'Used until a product has three months of sales.'},
    {id:'reviewDays',label:'Order cycle (days)',type:'number',value:C.reviewDays,hint:'How many days of demand each order covers beyond the reorder point.'},
    {id:'overstockDays',label:'Overstock above (days of cover)',type:'number',value:C.overstockDays},
    {id:'defaultLeadTime',label:'Default lead time (days)',type:'number',value:C.defaultLeadTime},
    {id:'carryPct',label:'Carrying cost (% per year)',type:'number',value:C.carryPct},
    {id:'defaultLocation',label:'Default location',type:'select',value:defLoc(),options:locOpts(),hint:'Sales ship from here; returns restock here.'}
  ],onSubmit:async v=>{await saveWs({brand:v.brand||S.wsDoc.brand,currency:v.currency,cfg:{serviceLevel:+v.serviceLevel,safetyDays:+v.safetyDays||0,reviewDays:+v.reviewDays||0,overstockDays:+v.overstockDays||1,defaultLeadTime:+v.defaultLeadTime||1,carryPct:+v.carryPct||0,defaultLocation:v.defaultLocation||''}});toast('Settings saved.')}});
};
function soLinesField(rows){return {id:'lines',label:'Items',type:'lines',rows,cols:[{key:'productId',label:'Product',type:'select',options:prodOpts(p=>p.type!=='component',true)},{key:'qty',label:'Qty',type:'number'},{key:'price',label:'Unit price',type:'number',w:90}]}}
A.newSO=(d,el,ev)=>{
  if(ev)ev.preventDefault();
  if(!list('products').length){toast('Add products first.');return}
  openForm({title:'New sales order',wide:true,fields:[{id:'number',label:'Order number',value:nextNum('orders','SO-')},{id:'date',label:'Date',type:'date',value:today()},{id:'channelId',label:'Channel',type:'select',options:chOpts()},{id:'customer',label:'Customer',value:''},soLinesField([{productId:'',qty:1,price:''}])],
  onSubmit:async v=>{const lines=v.lines.filter(l=>l.productId&&+l.qty>0).map(l=>({productId:l.productId,qty:+l.qty,price:l.price===''?(+(P(l.productId).price)||0):+l.price}));if(!lines.length)fail('Add at least one item with a quantity.');await save('orders',nid(),{number:v.number,date:v.date||today(),channelId:v.channelId,customer:v.customer,status:'open',lines});toast('Order '+v.number+' created.')}});
};
A.shipSO=async d=>{
  const o=S.col.orders[d.id];if(!o||o.status!=='open'){toast('Only open orders can be shipped.');return}const loc=defLoc();if(!loc){toast('Add a location first.');return}
  const short=(o.lines||[]).filter(l=>{const p=P(l.productId);return !p||(+(p.stock||{})[loc]||0)<+l.qty});
  if(short.length){toast('Not enough stock at '+L(loc).name+' for '+short.map(l=>(P(l.productId)||{}).sku||'a deleted product').join(', ')+'. Count stock or receive a PO first.');return}
  try{for(const l of o.lines){const p=P(l.productId);await upd('products',p.id,{stock:{...(p.stock||{}),[loc]:(+(p.stock||{})[loc]||0)-(+l.qty)}})}
  await upd('orders',d.id,{status:'shipped',shippedDate:today()});toast(o.number+' shipped.')}catch(e){}
};
A.cancelSO=async d=>{try{await upd('orders',d.id,{status:'cancelled'});toast('Order cancelled.')}catch(e){}};
A.createPOs=async()=>{
  const {rows}=compute();const sel=rows.filter(r=>S.ui.sel[r.p.id]&&r.sug>0&&r.p.vendorId);
  const by={};sel.forEach(r=>(by[r.p.vendorId]=by[r.p.vendorId]||[]).push(r));
  const btn=document.querySelector('[data-act="createPOs"]');if(btn)btn.disabled=true;
  try{let n=0;for(const [vid,rs] of Object.entries(by)){const v=V(vid);const num1=nextNum('pos','PO-');const lt=Math.max(...rs.map(r=>r.lt));
    await save('pos',nid(),{number:num1,vendorId:vid,locationId:defLoc()||'',orderDate:today(),expectedDate:addDays(today(),lt||v.leadTimeDays||30),status:'draft',freight:0,lines:rs.map(r=>({productId:r.p.id,qty:r.sug,unitCost:+r.p.unitCost||0,received:0})),shipment:{stage:'Booked',carrier:'',tracking:'',eta:''}});n++}
  S.ui.sel={};toast(n+' draft PO'+(n>1?'s':'')+' created. Review and place them in Purchase orders.');location.hash='pos'}catch(e){}
};
A.selVendor=d=>{const {rows}=compute();rows.filter(r=>r.sug>0&&(r.p.vendorId||'')===d.id).forEach(r=>S.ui.sel[r.p.id]=true);render()};
function poFields(po){
  return [{id:'number',label:'PO number',value:po.number},{id:'vendorId',label:'Vendor',type:'select',value:po.vendorId,options:vendOpts(true)},
  {id:'orderDate',label:'Order date',type:'date',value:po.orderDate||today()},{id:'expectedDate',label:'Promised arrival',type:'date',value:po.expectedDate||''},
  {id:'locationId',label:'Deliver to',type:'select',value:po.locationId||defLoc(),options:locOpts()},{id:'freight',label:'Freight & charges ('+cur()+')',type:'number',value:po.freight||0},
  {id:'lines',label:'Lines',type:'lines',rows:(po.lines||[]).map(l=>Object.assign({},l)),cols:[{key:'productId',label:'Product',type:'select',options:prodOpts(null,true)},{key:'qty',label:'Qty',type:'number'},{key:'unitCost',label:'Unit cost',type:'number',w:90}]},
  {id:'sum',type:'html',html:`<p class="note">Status: ${pill(po.status||'draft')} ${po.status&&po.status!=='draft'?'· Received quantities are kept when you edit lines.':''}</p>`}];
}
A.editPO=d=>{
  const po=d.id?S.col.pos[d.id]:{number:nextNum('pos','PO-'),status:'draft',lines:[{productId:'',qty:'',unitCost:''}],freight:0};
  const extra=[];
  if(d.id&&['placed','in_transit','partial'].includes(po.status))extra.push({id:'recv',label:'Receive goods'});
  if(d.id&&po.status==='draft'&&poApproval(po)==='emailed')extra.push({id:'place',label:'Place order'});
  openForm({title:d.id?'Purchase order '+esc(po.number):'New purchase order',wide:true,fields:poFields(po),extraButtons:extra,
    onDelete:d.id&&['draft','placed'].includes(po.status)?async()=>{if(po.status==='draft'){await del('pos',d.id);toast('Draft deleted.')}else{await upd('pos',d.id,{status:'cancelled'});toast('PO cancelled.')}}:null,deleteLabel:po.status==='placed'?'Cancel PO':'Delete draft',
    onSubmit:async v=>{if(!v.vendorId)fail('Choose a vendor.');const lines=v.lines.filter(l=>l.productId&&+l.qty>0).map(l=>({productId:l.productId,qty:+l.qty,unitCost:l.unitCost===''?(+(P(l.productId).unitCost)||0):+l.unitCost,received:+l.received||0}));if(!lines.length)fail('Add at least one line.');
      const vend=V(v.vendorId);await save('pos',d.id||nid(),Object.assign({},po,{approvalStatus:po.status==='draft'?'not_sent':poApproval(po),number:v.number,vendorId:v.vendorId,orderDate:v.orderDate,expectedDate:v.expectedDate||addDays(v.orderDate||today(),+vend.leadTimeDays||30),locationId:v.locationId,freight:+v.freight||0,lines,shipment:po.shipment||{stage:'Booked',carrier:'',tracking:'',eta:''}}));toast('PO saved.')}});
  MODAL.extra={recv:()=>{closeModal();A.receivePO({id:d.id})},place:async()=>{closeModal();await A.placePO({id:d.id})}};
};
A.requestPOApproval=async d=>{
  const po=S.col.pos[d.id];if(!po||po.status!=='draft')return;
  if(!(po.lines||[]).length||!po.vendorId){toast('Complete the vendor and PO lines first.');return}
  if(!['not_sent','rejected'].includes(poApproval(po)))return;
  try{await upd('pos',d.id,{approvalStatus:'pending',approvalRequestedAt:new Date().toISOString(),approvedAt:null,rejectedAt:null});
    toast('PO marked Pending approval. Assign an authorized approver before production use.');}catch(e){}
};
// Standalone mode: human approval on this device only, not an authenticated approval system.
A.reviewPO=d=>{
  const po=S.col.pos[d.id];if(!po||po.status!=='draft'||poApproval(po)!=='pending')return;
  openForm({title:'Review '+esc(po.number),fields:[
    {id:'summary',type:'html',html:`<p class="note">Vendor: ${esc(vName(po.vendorId))} · Total: ${money(poTotal(po))}</p><p class="note">Only an authorized approver should complete this review.</p>`},
    {id:'decision',label:'Approval decision',type:'select',value:'approved',options:[['approved','Approve'],['rejected','Reject']]},
    {id:'reviewer',label:'Approver name',value:''},
    {id:'note',label:'Decision note',value:''}
  ],submitLabel:'Record decision',onSubmit:async v=>{
    if(!v.reviewer.trim())fail('Enter approver name.');
    const approved=v.decision==='approved';
    await upd('pos',d.id,{approvalStatus:v.decision,approvedAt:approved?new Date().toISOString():null,rejectedAt:approved?null:new Date().toISOString(),approvedBy:approved?v.reviewer.trim():null,reviewedBy:v.reviewer.trim(),reviewNote:v.note||''});
    toast('PO '+(approved?'approved. Email PO is now available.':'rejected.'));
  }});
};
A.emailPO=d=>{
  const po=S.col.pos[d.id];if(!po||po.status!=='draft'||poApproval(po)!=='approved'){toast('This PO must be approved first.');return}
  const vendor=V(po.vendorId)||{};
  const to=(vendor.contact||'').trim();
  // Vendor contact must contain an email address, not a phone number or general contact note.
  const found=to.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if(!found){toast('Add a valid vendor email address in Vendor Master first.');return}
  const lines=(po.lines||[]).map(l=>`${(P(l.productId)||{}).sku||'Product'} - ${num(l.qty)} × ${money(l.unitCost,2)}`).join('\n');
  const body=`Dear ${vendor.name||'Supplier'},\n\nPlease review purchase order ${po.number}.\n\n${lines}\n\nTotal: ${money(poTotal(po),2)}\nExpected delivery: ${po.expectedDate||'To be confirmed'}\n\nPlease confirm receipt and delivery schedule.\n\nRegards,\nSCaaS Global`;
  window.location.href=`mailto:${encodeURIComponent(found[0])}?subject=${encodeURIComponent('Purchase Order '+po.number)}&body=${encodeURIComponent(body)}`;
  // Opening an email client does not prove that an email was sent.
  if(confirm('Email draft opened. Have you actually sent this purchase order to the vendor?')){
    upd('pos',d.id,{approvalStatus:'emailed',emailedAt:new Date().toISOString(),emailedTo:found[0]}).then(()=>toast('PO email marked as sent. Place is now available.')).catch(()=>{});
  }
};
A.placePO=async d=>{
  const po=S.col.pos[d.id];if(!po||po.status!=='draft')return;
  if(poApproval(po)!=='emailed'){toast('Approve and email the PO before placing it.');return}
  if(!(po.lines||[]).length){toast('Add lines before placing.');return}
  try{await upd('pos',d.id,{status:'placed',orderDate:today(),shipment:Object.assign({stage:'Booked',carrier:'',tracking:''},po.shipment||{},{eta:(po.shipment&&po.shipment.eta)||po.expectedDate})});toast(po.number+' placed. It now counts as incoming stock.')}catch(e){}
};
A.editShipment=d=>{const po=S.col.pos[d.id];const s=po.shipment||{};
  openForm({title:'Shipment · '+esc(po.number),fields:[{id:'stage',label:'Stage',type:'select',value:s.stage||'Booked',options:STAGES.filter(x=>x!=='Delivered').map(x=>[x,x])},{id:'eta',label:'Current ETA',type:'date',value:s.eta||po.expectedDate},{id:'carrier',label:'Carrier / forwarder',value:s.carrier},{id:'tracking',label:'Tracking or B/L number',value:s.tracking}],
  onSubmit:async v=>{const moving=['On the water','In the air','Arrived at port','Customs clearance','Out for delivery'].includes(v.stage);await upd('pos',d.id,{shipment:Object.assign({},s,v),status:po.status==='partial'?'partial':(moving?'in_transit':'placed')});toast('Shipment updated.')}});
};
A.receivePO=d=>{
  const po=S.col.pos[d.id];
  const rows=(po.lines||[]).map(l=>({sku:(P(l.productId)||{}).sku||'?',ordered:l.qty,prev:+l.received||0,now:Math.max(0,(+l.qty||0)-(+l.received||0))}));
  openForm({title:'Receive '+esc(po.number),wide:true,fields:[{id:'loc',label:'Receive into',type:'select',value:po.locationId||defLoc(),options:locOpts()},{id:'date',label:'Received on',type:'date',value:today()},
    {id:'lines',label:'Quantities',type:'lines',fixed:true,rows,cols:[{key:'sku',label:'SKU',type:'static'},{key:'ordered',label:'Ordered',type:'static'},{key:'prev',label:'Already in',type:'static'},{key:'now',label:'Receiving now',type:'number'}]},
    {id:'n',type:'html',html:'<p class="note">Set a line to 0 if nothing arrived. Short shipments stay open as partly received.</p>'}],submitLabel:'Receive',
  onSubmit:async v=>{
    if(!v.loc)fail('Choose a location.');
    const lines=(po.lines||[]).map((l,i)=>Object.assign({},l,{received:(+l.received||0)+Math.max(0,+v.lines[i].now||0)}));
    if(!v.lines.some(x=>+x.now>0))fail('Enter at least one quantity received.');
    if(v.lines.some((x,i)=>(+x.now||0)<0 || (+x.now||0)>Math.max(0,(+po.lines[i].qty||0)-(+po.lines[i].received||0))))fail('Receiving quantity must be between zero and the outstanding quantity.');
    for(let i=0;i<lines.length;i++){const q=Math.max(0,+v.lines[i].now||0);if(!q)continue;const p=P(lines[i].productId);if(!p)continue;const oh=onHand(p);const cost=oh>0?((oh*(+p.unitCost||0))+q*(+lines[i].unitCost||0))/(oh+q):(+lines[i].unitCost||0);await upd('products',p.id,{stock:{...(p.stock||{}),[v.loc]:(+(p.stock||{})[v.loc]||0)+q},unitCost:Math.round(cost*100)/100})}
    const full=lines.every(l=>l.received>=l.qty);
    await upd('pos',d.id,{lines,status:full?'received':'partial',receivedDate:full?v.date:(po.receivedDate||''),shipment:Object.assign({},po.shipment||{},full?{stage:'Delivered'}:{})});
    toast(full?po.number+' fully received.':po.number+' partly received.');
  }});
};
A.produce=d=>{
  const makes=list('products').filter(p=>p.makeBuy==='make');if(!makes.length){toast('No made-in-house products yet.');return}
  const {R}=compute();const id=d.id||makes[0].id;
  openForm({title:'Record production run',fields:[{id:'pid',label:'Product',type:'select',value:id,options:prodOpts(p=>p.makeBuy==='make'),full:true},{id:'qty',label:'Units produced',type:'number',value:(R[id]&&R[id].sug)||''},{id:'loc',label:'At location',type:'select',value:defLoc(),options:locOpts()},{id:'n',type:'html',html:'<p class="note">Components are taken from the same location according to the bill of materials.</p>'}],submitLabel:'Record',
  onSubmit:async v=>{const p=P(v.pid),q=+v.qty;if(!(q>0))fail('Enter the units produced.');const bom=p.bom||[];if(!bom.length)fail('This product has no bill of materials yet.');
    const short=bom.filter(b=>{const c=P(b.componentId);return !c||(+(c.stock||{})[v.loc]||0)<q*b.qty});if(short.length)fail('Not enough at this location: '+short.map(b=>{const c=P(b.componentId);return c?`${c.sku} (need ${num(q*b.qty)}, have ${num(+(c.stock||{})[v.loc]||0)})`:'deleted component'}).join(', '));
    let cost=0;for(const b of bom){const c=P(b.componentId);cost+=b.qty*(+c.unitCost||0);await upd('products',c.id,{stock:{...(c.stock||{}),[v.loc]:(+(c.stock||{})[v.loc]||0)-q*b.qty}})}
    const oh=onHand(p);const newCost=oh>0?(oh*(+p.unitCost||0)+q*cost)/(oh+q):cost;
    await upd('products',p.id,{stock:{...(p.stock||{}),[v.loc]:(+(p.stock||{})[v.loc]||0)+q},unitCost:Math.round(newCost*100)/100});toast(num(q)+' × '+p.sku+' added to stock.')}});
};
A.editScenario=d=>{
  const s=d.id?S.col.scenarios[d.id]:{qty:1000,options:[{label:'Option A',fx:1,dutyPct:0},{label:'Option B',fx:1,dutyPct:0}]};
  openForm({title:d.id?'Edit scenario':'New landed cost scenario',wide:true,fields:[{id:'name',label:'Scenario name',value:s.name,required:true},{id:'productId',label:'Product',type:'select',value:s.productId,options:prodOpts(null,true)},{id:'qty',label:'Order quantity',type:'number',value:s.qty},
    {id:'options',label:'Options',type:'lines',rows:(s.options||[]).map(o=>Object.assign({},o)),cols:[{key:'label',label:'Option',w:140},{key:'vendorId',label:'Vendor',type:'select',options:vendOpts(true)},{key:'unitPrice',label:'Unit price',type:'number'},{key:'fx',label:'FX to '+cur(),type:'number'},{key:'freight',label:'Freight/u',type:'number'},{key:'dutyPct',label:'Duty %',type:'number'},{key:'other',label:'Other/u',type:'number'},{key:'leadTimeDays',label:'LT days',type:'number'}]}],
  onDelete:d.id?async()=>{await del('scenarios',d.id)}:null,onSubmit:async v=>{if(!v.name)fail('Name is required.');await save('scenarios',d.id||nid(),{name:v.name,productId:v.productId,qty:+v.qty||0,options:v.options.filter(o=>o.label).map(o=>({label:o.label,vendorId:o.vendorId||'',unitPrice:+o.unitPrice||0,fx:+o.fx||1,freight:+o.freight||0,dutyPct:+o.dutyPct||0,other:+o.other||0,leadTimeDays:+o.leadTimeDays||0}))});toast('Scenario saved.')}});
};
A.applyOption=async d=>{const s=S.col.scenarios[d.id];const o=s.options[+d.i];const p=P(s.productId);if(!p)return;const patch={unitCost:Math.round(landed(o)*100)/100,leadTimeDays:o.leadTimeDays||''};if(o.vendorId)patch.vendorId=o.vendorId;try{await upd('products',p.id,patch);toast(p.sku+' now uses '+o.label+': '+money(patch.unitCost,2)+' landed, '+o.leadTimeDays+'d lead time.')}catch(e){}};
A.editRMA=()=>{if(!list('products').length){toast('Add products first.');return}
  openForm({title:'New return',fields:[{id:'number',label:'RMA number',value:nextNum('returns','RMA-')},{id:'date',label:'Date',type:'date',value:today()},{id:'orderRef',label:'Original order',value:''},{id:'productId',label:'Product',type:'select',options:prodOpts(p=>p.type!=='component')},{id:'qty',label:'Quantity',type:'number',value:1},{id:'reason',label:'Reason',type:'select',options:['Damaged in transit','Defective','Wrong item sent','Changed mind','Expired','Other'].map(x=>[x,x])},{id:'disposition',label:'What happens to it',type:'select',options:[['restock','Restock (sellable)'],['scrap','Scrap'],['vendor','Return to vendor']]}],
  onSubmit:async v=>{if(!(+v.qty>0))fail('Enter a quantity.');await save('returns',nid(),Object.assign(v,{qty:+v.qty,status:'open'}));toast('Return logged.')}});
};
A.receiveRMA=async d=>{const r=S.col.returns[d.id];if(!r||r.status==='received')return;try{if(r.disposition==='restock'){const p=P(r.productId),loc=defLoc();if(p&&loc)await upd('products',p.id,{stock:{...(p.stock||{}),[loc]:(+(p.stock||{})[loc]||0)+(+r.qty)}})}await upd('returns',d.id,{status:'received',receivedDate:today()});toast(r.disposition==='restock'?num(r.qty)+' units restocked.':'Return received.')}catch(e){}};
A.report=d=>{
  const r=REPORTS[d.id];const rows=r.f();const csv=rows.map(x=>x.map(csvEsc).join(',')).join('\n');
  openForm({title:r.t,wide:true,fields:[{id:'t',type:'html',html:`<div class="tw" style="max-height:55vh;overflow:auto">${tbl(rows[0].map(h=>esc(h)),rows.slice(1).map(x=>x.map(c=>td(esc(typeof c==='number'?num(c,c%1?2:0):c),typeof c==='number'?'n':''))),'No rows')}</div>`}],extraButtons:[{id:'copy',label:'Copy CSV'},...(S.dl?[{id:'dl',label:'Download CSV'}]:[])]});
  MODAL.extra={copy:async()=>{try{await navigator.clipboard.writeText(csv);toast('Copied. Paste into Excel or Google Sheets.')}catch(e){toast('Copy is blocked here. Use Download CSV instead.')}},dl:async()=>{try{await S.dl.save({filename:r.t.toLowerCase().replace(/\s+/g,'-')+'-'+today()+'.csv',data:csv})}catch(e){if(e&&e.code!=='declined')toast('Download is unavailable here. Use Copy CSV.')}}};
};
A.import=d=>{
  const x=IMPORTS[d.id];
  openForm({title:'Import '+x.t.toLowerCase(),wide:true,fields:[{id:'file',type:'html',html:`<label class="fld"><span>CSV file</span><input type="file" id="impFile" accept=".csv,text/csv"></label>`},{id:'csv',label:'Or paste CSV',type:'textarea',value:'',placeholder:x.h+'\n'+x.ex,hint:'First row must be the header: '+x.h}],submitLabel:'Import',
  onSubmit:async v=>{const rows=parseCSV(v.csv||'');if(rows.length<2)fail('Paste CSV with a header row and at least one data row.');const h=rows[0].map(s=>s.trim().toLowerCase());const recs=rows.slice(1).map(r=>{const o={};h.forEach((k,i)=>o[k]=(r[i]||'').trim());return o});const n=await IMPORTERS[d.id](recs);toast('Imported '+n+' rows.')}});
  $('#impFile').addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>{$('#f_csv').value=rd.result};rd.readAsText(f)});
};
async function ensureVendor(name){if(!name)return '';const v=list('vendors').find(x=>x.name.toLowerCase()===name.toLowerCase());if(v)return v.id;const id=nid();await save('vendors',id,{name,leadTimeDays:cfg().defaultLeadTime,depositPct:0,balanceDays:30,currency:cur()});S.col.vendors[id]={id,name,leadTimeDays:cfg().defaultLeadTime};return id}
async function ensureChannel(name){if(!name)return '';const c=list('channels').find(x=>x.name.toLowerCase()===name.toLowerCase());if(c)return c.id;const id=nid();await save('channels',id,{name,type:'other',status:'csv'});S.col.channels[id]={id,name};return id}
const bySku=sku=>list('products').find(p=>p.sku.toLowerCase()===String(sku).toLowerCase());
const IMPORTERS={
  products:async recs=>{let n=0;const loc=defLoc();for(const r of recs){if(!r.sku)continue;const ex=bySku(r.sku);const vid=await ensureVendor(r.vendor);const o=Object.assign({stock:{},bom:[],forecastAdj:0,active:true},ex||{},{sku:r.sku,name:r.name||(ex&&ex.name)||r.sku,type:(r.type||'').toLowerCase().startsWith('comp')?'component':'finished',makeBuy:(r.make_or_buy||'').toLowerCase()==='make'?'make':'buy',vendorId:vid||(ex&&ex.vendorId)||'',unitCost:+r.unit_cost||(ex&&ex.unitCost)||0,price:+r.price||(ex&&ex.price)||0,leadTimeDays:r.lead_time_days?+r.lead_time_days:((ex&&ex.leadTimeDays)||''),moq:+r.moq||0,casePack:+r.case_pack||1});if(r.on_hand!==''&&r.on_hand!=null&&loc)o.stock=Object.assign({},o.stock,{[loc]:+r.on_hand||0});const id=ex?ex.id:nid();await save('products',id,o);S.col.products[id]=Object.assign({id},o);n++}return n},
  history:async recs=>{const acc={};let n=0;for(const r of recs){const p=bySku(r.sku);if(!p||!/^\d{4}-\d{2}$/.test(r.month))continue;const ch=await ensureChannel(r.channel);const k=p.id+'__'+(ch||'none');const ex=acc[k]||Object.assign({productId:p.id,channelId:ch,months:{}},S.col.history[k]||{});ex.months=Object.assign({},ex.months,{[r.month]:+r.qty||0});acc[k]=ex;n++}for(const [k,v] of Object.entries(acc))await save('history',k,v);return n},
  orders:async recs=>{const g={};let n=0;for(const r of recs){const p=bySku(r.sku);if(!p||!r.order_number)continue;const o=g[r.order_number]=g[r.order_number]||{number:r.order_number,date:/^\d{4}-\d{2}-\d{2}$/.test(r.date)?r.date:today(),channelId:await ensureChannel(r.channel),customer:r.customer||'',status:['open','shipped','cancelled'].includes((r.status||'').toLowerCase())?r.status.toLowerCase():'shipped',lines:[]};o.lines.push({productId:p.id,qty:+r.qty||0,price:+r.price||0});n++}
    for(const o of Object.values(g)){const ex=list('orders').find(x=>x.number===o.number);await save('orders',ex?ex.id:nid(),o)}return n}
};
A.clearSample=async(d,el)=>{if(!el.classList.contains('armed')){el.classList.add('armed');el.textContent='Click again to remove';setTimeout(()=>{if(el.isConnected){el.classList.remove('armed');el.textContent='Remove sample data'}},4000);return}el.disabled=true;el.textContent='Removing…';try{await wipe(true);toast('Sample data removed.')}catch(e){}};
A.wipeAll=async(d,el)=>{if(!el.classList.contains('armed')){el.classList.add('armed');el.textContent='Click again to delete everything';setTimeout(()=>{if(el.isConnected){el.classList.remove('armed');el.textContent='Delete all data in this workspace'}},4000);return}el.disabled=true;el.textContent='Deleting…';try{await wipe(false);const loc=nid();await save('locations',loc,{name:'Main warehouse',type:'warehouse'});await saveWs({cfg:Object.assign({},cfg(),{defaultLocation:loc})});toast('Workspace emptied.')}catch(e){}};

/* ============================================================
   EVENTS
============================================================ */
document.addEventListener('click',async e=>{
  const nav=e.target.closest('a[data-page]');if(nav){$('#app').classList.remove('navopen')}
  if(e.target.matches('[data-ov]')){closeModal();return}
  const add=e.target.closest('[data-addline]');if(add&&MODAL){const f=MODAL.fields.find(x=>x.id===add.dataset.addline);syncLines(f);f.rows.push({});$('#f_'+f.id).innerHTML=linesHtml(f);return}
  const dl=e.target.closest('[data-delline]');if(dl&&MODAL){const f=MODAL.fields.find(x=>x.id===dl.dataset.delline);syncLines(f);f.rows.splice(+dl.dataset.i,1);$('#f_'+f.id).innerHTML=linesHtml(f);return}
  const ex=e.target.closest('[data-extra]');if(ex&&MODAL&&MODAL.extra){MODAL.extra[ex.dataset.extra]();return}
  if(e.target.id==='mdel'&&MODAL){const b=e.target;if(!b.classList.contains('armed')){b.classList.add('armed');b.dataset.l=b.textContent;b.textContent='Click again to confirm';return}b.disabled=true;try{await MODAL.onDelete();closeModal()}catch(err){mErr(err.userMsg||'Could not delete.');b.disabled=false}return}
  const a=e.target.closest('[data-act]');if(!a||a.disabled)return;
  const fn=A[a.dataset.act];if(fn){fn(a.dataset,a,e)}
});
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.id==='wsSel'){openWorkspace(t.value);return}
  if(t.id==='demandCh'){S.ui.demandCh=t.value;render();return}
  if(t.id==='soStatus'){S.ui.soStatus=t.value;render();return}
  if(t.id==='poStatus'){S.ui.poStatus=t.value;render();return}
  if(t.dataset&&t.dataset.sel){if(t.checked)S.ui.sel[t.dataset.sel]=true;else delete S.ui.sel[t.dataset.sel];render();return}
});
document.addEventListener('submit',e=>{if(e.target.id==='mform')submitModal(e);else if(e.target.id==='setupForm')doSetup(e)});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&MODAL)closeModal()});
window.addEventListener('hashchange',()=>{const h=location.hash.slice(1);if(PAGES.includes(h)){page=h;render();window.scrollTo(0,0)}});


/* ============================================================
   STANDALONE MODE: browser-storage database
   ============================================================ */
function localDB(){
  const K='sv.db';let data={};
  try{data=JSON.parse(localStorage.getItem(K)||'{}')}catch(e){data={}}
  const subs=new Set();
  const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
  const merge=(a,b)=>{const o=Object.assign({},a);for(const k in b){o[k]=isObj(b[k])&&isObj(o[k])?merge(o[k],b[k]):b[k]}return o};
  const persist=()=>{try{localStorage.setItem(K,JSON.stringify(data))}catch(e){toast('Storage is full or blocked. Change was not saved.');throw e}subs.forEach(f=>f())};
  const meta={fromCache:false,hasPendingWrites:false};
  const snapDoc=path=>({id:path.split('/').pop(),exists:path in data,data:()=>data[path],metadata:meta});
  const doc=path=>({id:path.split('/').pop(),path,
    get:async()=>snapDoc(path),
    set:async d=>{const old=data[path];data[path]=JSON.parse(JSON.stringify(d));try{persist()}catch(e){if(old===undefined)delete data[path];else data[path]=old;throw e}},
    update:async d=>{if(!(path in data))throw {code:'not_found',message:'Record not found'};const old=data[path];data[path]=merge(data[path],JSON.parse(JSON.stringify(d)));try{persist()}catch(e){data[path]=old;throw e}},
    delete:async()=>{const old=data[path];delete data[path];try{persist()}catch(e){if(old!==undefined)data[path]=old;throw e}},
    onSnapshot(next){const f=()=>next(snapDoc(path));subs.add(f);setTimeout(f,0);return()=>subs.delete(f)}});
  const collection=cp=>{const depth=cp.split('/').length+1;return {path:cp,doc:id=>doc(cp+'/'+(id||nid())),
    onSnapshot(next){const f=()=>{const docs=Object.keys(data).filter(k=>k.startsWith(cp+'/')&&k.split('/').length===depth).sort().map(snapDoc);next({docs,size:docs.length,empty:!docs.length,metadata:meta,docChanges:()=>[]})};subs.add(f);setTimeout(f,0);return()=>subs.delete(f)}}};
  return {doc,collection,exportData:()=>JSON.parse(JSON.stringify(data)),importData:incoming=>{if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))throw Error('Invalid backup data.');const old=data;data=JSON.parse(JSON.stringify(incoming));try{persist()}catch(e){data=old;throw e}}};
}
const localDownloads={save:async({filename,data})=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type:'text/csv'}));a.download=filename;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);return {status:'saved'}}};

/* ============================================================
   BOOT — standalone StockVelocity application
   ============================================================ */
(function startStockVelocity(){
  try{
    S.db=localDB();
    S.dl=localDownloads;
    S.uid='local';
    S.isOwner=false;
    S.local=true;
    S.mode='ready';
    openWorkspace('local');
  }catch(error){
    console.error('StockVelocity startup failed:',error);
    S.mode='nodb';
    render();
  }
})();
setInterval(()=>{stamp++;scheduleRender()},60000);

/* Full workspace JSON backup and restore */
A.backupWorkspace=async()=>{
  try{
    const payload={app:'StockVelocity',schemaVersion:1,exportedAt:new Date().toISOString(),workspace:S.ws,records:S.db.exportData()};
    const data=JSON.stringify(payload,null,2);
    const filename='stockvelocity-backup-'+today()+'.json';
    const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),3000);
    toast('Full workspace backup downloaded.');
  }catch(error){toast('Backup failed: '+error.message)}
};
A.restoreWorkspace=()=>{
  const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
  input.addEventListener('change',async()=>{
    const file=input.files&&input.files[0];if(!file)return;
    try{
      const obj=JSON.parse(await file.text());
      if(obj.app!=='StockVelocity'||obj.schemaVersion!==1||!obj.records||typeof obj.records!=='object'||Array.isArray(obj.records))throw Error('Not a supported StockVelocity backup.');
      if(obj.workspace!=='local'||!obj.records['workspaces/local'])throw Error('This backup does not contain a compatible local workspace.');
      if(!confirm('Restore this backup? All records in this browser will be replaced. This cannot be undone.'))return;
      S.db.importData(obj.records);openWorkspace('local');toast('Workspace backup restored.');
    }catch(error){toast('Restore failed: '+error.message)}
  });input.click();
};
