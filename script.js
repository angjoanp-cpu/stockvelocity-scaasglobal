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
 ['Planning',[['demand','Demand planning'],['inventory','Inventory planning'],['ai','AI Intelligence'],['mrp','MRP & production'],['landed','Landed cost scenarios']]],
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

function compute() {
  const key = S.ws + ':' + ver + ':' + stamp + ':' + today();
  if (memo.key === key) return memo.val;

  const C = cfg(),
    M6 = lastMonths(6),
    curM = monthKey(0),
    z = Z[C.serviceLevel] || 1.6449,
    t = today();

  const prods = list('products').filter(p => p.active !== false);
  const dem = {}, demCh = {};

  const add = (pid, ch, m, q) => {
    if (!pid || !q) return;

    (dem[pid] = dem[pid] || {})[m] =
      (dem[pid][m] || 0) + q;

    const k = ch || '_';
    ((demCh[pid] = demCh[pid] || {})[k] =
      demCh[pid][k] || {})[m] =
      (demCh[pid][k][m] || 0) + q;
  };

  list('history').forEach(h => {
    Object.entries(h.months || {}).forEach(([m, q]) =>
      add(h.productId, h.channelId, m, +q || 0)
    );
  });

  // Confirmed open sales orders reserve inventory.
  const alloc = {};

  list('orders').forEach(o => {
    if (o.status === 'cancelled') return;

    (o.lines || []).forEach(l => {
      add(
        l.productId,
        o.channelId,
        (o.date || t).slice(0, 7),
        +l.qty || 0
      );

      if (o.status === 'open') {
        alloc[l.productId] =
          (alloc[l.productId] || 0) + (+l.qty || 0);
      }
    });
  });

  // Incoming quantities from active purchase orders.
  const inc = {}, incEta = {};

  list('pos').forEach(po => {
    if (!['placed', 'in_transit', 'partial'].includes(po.status)) return;

    (po.lines || []).forEach(l => {
      const r = Math.max(0,
        (+l.qty || 0) - (+l.received || 0)
      );

      inc[l.productId] = (inc[l.productId] || 0) + r;

      const eta =
        (po.shipment && po.shipment.eta) || po.expectedDate;

      if (!incEta[l.productId] || eta < incEta[l.productId]) {
        incEta[l.productId] = eta;
      }
    });
  });

  const R = {};

  const calc = (p, series, fcOverride, curQty, grossRequirement = 0) => {
    const l3 = series.slice(-3);
    const wma = l3[2] * .5 + l3[1] * .3 + l3[0] * .2;

    const fcM = fcOverride != null
      ? fcOverride
      : wma * (1 + (+p.forecastAdj || 0) / 100);

    const avgDaily = fcM / 30;
    const withData = series.filter(x => x > 0).length;
    const mean = series.reduce((a, b) => a + b, 0) / series.length;

    const sd = Math.sqrt(
      series.reduce((a, b) => a + (b - mean) ** 2, 0) /
      Math.max(1, series.length - 1)
    );

    const v = V(p.vendorId);

    const lt =
      +p.leadTimeDays ||
      (v && +v.leadTimeDays) ||
      C.defaultLeadTime;

    const ssAuto = Math.ceil(
      withData >= 3
        ? z * (sd / Math.sqrt(30)) * Math.sqrt(lt)
        : avgDaily * C.safetyDays
    );

    // A planner-entered safety stock replaces the calculated one.
    const ss = aiNum(p.ssOverride) ? Math.ceil(+p.ssOverride) : ssAuto;

    const rop = Math.ceil(avgDaily * lt + ss);

    const oh = onHand(p);
    const al = alloc[p.id] || 0;
    const av = oh - al;
    const ic = inc[p.id] || 0;
    const pos = av + ic;

    const cover = avgDaily > 0 ? av / avgDaily : Infinity;
    const target = rop + avgDaily * C.reviewDays;

    // FIX 1: Open sales orders trigger replenishment,
    // even when historical demand and forecast are zero.
    const salesShortage = Math.max(0, -pos);

    // FIX 2: BOM requirements trigger component purchases.
    const productionShortage = Math.max(
      0, grossRequirement - pos
    );

    const forecastShortage =
      avgDaily > 0 && pos <= rop
        ? Math.max(0, target - pos)
        : 0;

    const rawNeed = Math.max(
      salesShortage,
      productionShortage,
      forecastShortage
    );

    let sug = 0;

    if (rawNeed > 0) {
      const minimum = Math.max(rawNeed, +p.moq || 0);
      const pack = Math.max(1, +p.casePack || 1);
      sug = Math.ceil(minimum / pack) * pack;
    }

    const recent = l3.reduce((a, b) => a + b, 0) + (curQty || 0);

    let status = 'Healthy';

    if (av <= 0 && (al > 0 || grossRequirement > 0 || avgDaily > 0)) {
      status = 'Stockout';
    } else if (sug > 0) {
      status = 'Order now';
    } else if (avgDaily === 0 && recent === 0) {
      status = oh > 0 ? 'No demand' : 'Healthy';
    } else if (cover > C.overstockDays) {
      status = 'Overstock';
    }

    const below = avgDaily > 0 && av < ss && av > 0;

    const excessU = avgDaily > 0
      ? Math.max(0, av - avgDaily * C.overstockDays)
      : (recent === 0 ? oh : 0);

    const shortU = Math.max(0, avgDaily * lt - pos);

    const prior = series.slice(0, 3)
      .reduce((a, b) => a + b, 0) / 3;

    const last = l3.reduce((a, b) => a + b, 0) / 3;

    const trend = prior > 0
      ? (last - prior) / prior
      : (last > 0 ? 1 : 0);

    return {
      p, series, wma, fcM, avgDaily, sd,
      lt, ss, ssAuto, rop, oh, al, av, ic, pos,
      cover, sug, status, below,
      excessU,
      excessV: excessU * (+p.unitCost || 0),
      shortU,
      riskV: shortU * (+p.price || 0),
      value: oh * (+p.unitCost || 0),
      trend,
      eta: incEta[p.id] || null,
      withData,
      cur: curQty || 0
    };
  };

  const ser = pid =>
    M6.map(m => (dem[pid] && dem[pid][m]) || 0);

  const fg = prods.filter(p => p.type !== 'component');
  const comps = prods.filter(p => p.type === 'component');

  // Calculate finished-goods replenishment first.
  fg.forEach(p => {
    R[p.id] = calc(
      p,
      ser(p.id),
      null,
      (dem[p.id] && dem[p.id][curM]) || 0
    );
  });

  // Identify every component used by manufactured products.
  const usedBy = {};

  fg.forEach(p => {
    if (p.makeBuy !== 'make') return;

    (p.bom || []).forEach(b => {
      (usedBy[b.componentId] =
        usedBy[b.componentId] || []).push({
          fg: p.id,
          qty: +b.qty || 0
        });
    });
  });

  // FIX 3: Calculate material requirements before
  // evaluating component replenishment.
  const mrp = {};

  fg.forEach(p => {
    if (p.makeBuy !== 'make') return;

    const q = R[p.id].sug;

    (p.bom || []).forEach(b => {
      mrp[b.componentId] =
        (mrp[b.componentId] || 0) +
        q * (+b.qty || 0);
    });
  });

  // Include BOM requirements in purchasing recommendations.
  comps.forEach(p => {
    const own = ser(p.id);
    const uses = usedBy[p.id] || [];

    const dep = M6.map((m, i) =>
      own[i] +
      uses.reduce(
        (a, u) =>
          a + u.qty *
          ((R[u.fg] && R[u.fg].series[i]) || 0),
        0
      )
    );

    const fc =
      uses.reduce(
        (a, u) =>
          a + u.qty *
          ((R[u.fg] && R[u.fg].fcM) || 0),
        0
      ) +
      own.slice(-3).reduce(
        (a, b, i) => a + b * [.2, .3, .5][i],
        0
      );

    const curQ = uses.reduce(
      (a, u) =>
        a + u.qty *
        ((R[u.fg] && R[u.fg].cur) || 0),
      0
    );

    R[p.id] = calc(p, dep, fc, curQ, mrp[p.id] || 0);
    R[p.id].usedBy = uses;
  });

  const rows = Object.values(R);

  const agg = {
    value: rows.reduce((a, r) => a + r.value, 0),
    toOrder: rows.filter(r => r.sug > 0).length,
    risk: rows.reduce((a, r) => a + r.riskV, 0),
    excess: rows.reduce((a, r) => a + r.excessV, 0),
    openPOs: list('pos').filter(p =>
      ['placed', 'in_transit', 'partial'].includes(p.status)
    ).length
  };

  memo = {
    key,
    val: { R, rows, agg, mrp, demCh, M6, curM }
  };

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
  const act=document.activeElement, keepFk=S.ui.focusFk||(act&&act.dataset&&act.dataset.fk)||null;S.ui.focusFk=null;
  const keepVal=act&&act.dataset&&act.dataset.fk===keepFk&&act.value!==act.defaultValue?act.value:null;
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
  if(keepFk){const el=m.querySelector('[data-fk="'+CSS.escape(keepFk)+'"]');if(el){if(keepVal!=null)el.value=keepVal;el.focus();if(keepVal==null&&el.select&&el.type!=='search')el.select()}}
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
  await save('vendors',v1,{...s,name:'Guangzhou PackRight Co.',country:'China',currency:'CNY',leadTimeDays:35,depositPct:30,balanceDays:30,originPort:'Guangzhou (Nansha)',productionDays:21,seaTransitDays:14,airTransitDays:4,airRatePerKg:260,seaRatePerCbm:4800,contact:'sales@packright.example',terms:'30% deposit, balance 30 days after arrival'});
  await save('vendors',v2,{...s,name:'Laguna Contract Labs',country:'Philippines',currency:'PHP',leadTimeDays:21,depositPct:50,balanceDays:15,originPort:'Laguna (road)',productionDays:18,seaTransitDays:3,contact:'orders@lagunalabs.example',terms:'50% deposit, balance 15 days after delivery'});
  await save('vendors',v3,{...s,name:'Seoul Actives Trading',country:'South Korea',currency:'USD',leadTimeDays:28,depositPct:100,balanceDays:0,originPort:'Busan',productionDays:14,seaTransitDays:14,airTransitDays:5,airRatePerKg:230,seaRatePerCbm:5200,contact:'export@seoulactives.example',terms:'100% before shipment'});
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
  const size={'FG-100':[.09,160],'FG-101':[.2,420],'FG-102':[.08,150],'FG-103':[.17,330],'FG-104':[.03,60],'CP-200':[.025,90],'CP-201':[.001,4],'CP-202':[.015,300],'CP-203':[.04,300],'RM-300':[.001,1.1],'RM-301':[.001,1.05]};
  const costMake={'FG-100':9.5+1.2+4.8+30*1.6,'FG-103':11+1.2+4.8+120*.35};
  for(const [sku,name,type,mb,vend,cost,price,lt,moq,cp,stock,bom] of prods){
    await save('products',ids[sku],{...s,sku,name,type,makeBuy:mb,vendorId:vend||'',unitCost:cost||+(costMake[sku]||0).toFixed(2),price,leadTimeDays:lt||'',moq,casePack:cp,unitWeightKg:size[sku][0],unitVolumeCm3:size[sku][1],stock,forecastAdj:0,active:true,bom:(bom||[]).map(([c,q])=>({componentId:ids[c],qty:q}))});
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
  panel('Vendors',vs.length+' vendors',tbl(['Vendor','Country','Lane','Currency',['Lead time','n'],'Payment terms',['Open PO value','n'],''],vs.map(v=>{const s=st.find(x=>x.v.id===v.id);return [td(esc(v.name)+(v.contact?`<span class="sub">${esc(v.contact)}</span>`:'')),td(esc(v.country||'—')),td(esc(v.originPort||'—')+`<span class="sub">${aiNum(v.productionDays)&&aiNum(v.seaTransitDays)?`${+v.productionDays}d make · ${+v.seaTransitDays}d sea${aiNum(v.airTransitDays)?' · '+(+v.airTransitDays)+'d air':''}`:'Lane times not set'}</span>`),td(esc(v.currency||'—')),td((v.leadTimeDays||'—')+'d','n'),td(`${+v.depositPct||0}% deposit, balance ${+v.balanceDays||0}d after arrival`),td(money(s?s.openVal:0),'n'),td(`<button class="btn sm" data-act="editVendor" data-id="${v.id}"${W()}>Edit</button>`,'act')]}),'No vendors yet','Add the suppliers you buy from.'));
};
VIEWS.locations=()=>{
  const ls=sortBy(list('locations'),l=>l.name), d=defLoc();
  return ph('Master data','Locations','Warehouses and fulfillment points where you hold stock.',`<button class="btn pri" data-act="editLocation"${W()}>Add location</button>`)+
  panel('Locations','',tbl(['Location','Type','Sales channel',['SKUs stocked','n'],['Units','n'],['Value at cost','n'],''],ls.map(l=>{let u=0,val=0,n=0;list('products').forEach(p=>{const q=+(p.stock||{})[l.id]||0;if(q){n++;u+=q;val+=q*(+p.unitCost||0)}});return [td(esc(l.name)+(l.id===d?' <span class="pill acc">Default</span>':'')),td(esc(l.type||'warehouse')),td(esc((CH(l.channelId)||{}).name||'—')),td(n,'n'),td(num(u),'n'),td(money(val,0),'n'),td(`<button class="btn sm" data-act="editLocation" data-id="${l.id}"${W()}>Edit</button>`,'act')]}),'No locations','Add your warehouse to start tracking stock.'));
};
VIEWS.channels=()=>{
  const {demCh,M6}=compute();const last=M6[5];
  const cs=sortBy(list('channels'),c=>c.name);
  const units=id=>Object.values(demCh).reduce((a,o)=>a+((o[id]&&o[id][last])||0),0);
  return ph('Master data','Sales channels','Where your demand comes from. Each channel feeds demand planning through sales orders or imported history.',`<button class="btn pri" data-act="editChannel"${W()}>Add channel</button>`)+
  (cs.length?`<div class="cards">${cs.map(c=>`<div class="card"><h3>${esc(c.name)}</h3><div>${connPill(c.status)}</div><div class="row"><span>Units in ${monthLabel(last)}</span><b>${num(units(c.id))}</b></div><div class="row"><span>Open orders</span><b>${list('orders').filter(o=>o.channelId===c.id&&o.status==='open').length}</b></div><div class="row"><span>Stock held at channel</span><b>${(()=>{const ls=list('locations').filter(l=>l.channelId===c.id).map(l=>l.id);return ls.length?num(list('products').reduce((a,p)=>a+ls.reduce((b,id)=>b+(+(p.stock||{})[id]||0),0),0)):'—'})()}</b></div><div><button class="btn sm" data-act="editChannel" data-id="${c.id}"${W()}>Edit</button></div></div>`).join('')}</div>`:panel('Channels','',`<div class="empty"><b>No channels yet</b>Add Shopify, Shopee, Lazada, TikTok Shop, Amazon or wholesale.</div>`))+
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
  const ui=S.ui.inv||(S.ui.inv={view:'plan',q:'',status:''});
  const locs=sortBy(list('locations'),l=>l.name);
  let rs=sortBy(rows,r=>statusRank[r.status]+r.p.sku);
  if(ui.q){const q=ui.q.toLowerCase();rs=rs.filter(r=>(r.p.sku+' '+r.p.name).toLowerCase().includes(q))}
  if(ui.status)rs=rs.filter(r=>r.status===ui.status);
  // While editing, keep rows where they were so a saved cell doesn't jump to another position.
  if(ui.frozen){const ix={};ui.frozen.forEach((id,i)=>ix[id]=i);rs=sortBy(rs,r=>ix[r.p.id]??1e9)}
  ui.lastOrder=rs.map(r=>r.p.id);
  const ro=S.ro?' disabled title="View-only access"':'';
  const inp=(r,i,field,val,o={})=>`<input class="cellin${o.ovr?' ovr':''}" type="number" min="0" step="any" inputmode="decimal" data-inv="${field}" data-id="${esc(r.p.id)}"${o.loc?` data-loc="${esc(o.loc)}"`:''} data-row="${i}" data-col="${esc(o.loc||field)}" data-fk="${esc(field+':'+r.p.id+':'+(o.loc||''))}" value="${esc(val??'')}" placeholder="${esc(o.ph??'')}" aria-label="${esc(o.label+' for '+r.p.sku)}"${o.title?` title="${esc(o.title)}"`:''}${ro}>`;
  const prodCell=r=>td(esc(r.p.name)+(r.p.type==='component'?'<span class="sub">Component · from BOMs</span>':''));
  const toggle=[['plan','Plan'],['stock','Stock by location']].map(([k,l])=>`<button class="btn sm${ui.view===k?' pri':''}" data-act="invView" data-id="${k}" aria-pressed="${ui.view===k}">${l}</button>`).join('');
  const filters=`<div class="filters" style="margin-bottom:12px"><input type="search" id="invQ" data-fk="invQ" placeholder="Search SKU or name" value="${esc(ui.q)}" aria-label="Search products"><select id="invStatus" aria-label="Filter by status"><option value="">All statuses</option>${['Stockout','Order now','Healthy','Overstock','No demand'].map(x=>`<option${x===ui.status?' selected':''}>${x}</option>`).join('')}</select><span class="acts" style="margin-left:auto">${toggle}</span></div>`;
  const tip=`<div class="pbody" style="padding-bottom:0"><p class="note">Edit the white cells directly. Changes save when you leave the cell; Enter moves down a row. ${ui.view==='plan'?'Leave Lead time or Safety blank to use the calculated value shown in grey. Blue outlines mark manual overrides.':'Typed quantities replace the system count at that location.'}</p></div>`;
  let body;
  if(ui.view==='stock'){
    body=tbl(['SKU','Product',...locs.map(l=>[esc(l.name)+(l.channelId&&CH(l.channelId)?`<span class="sub" style="text-transform:none;letter-spacing:0">${esc(CH(l.channelId).name)} stock</span>`:''),'n']),['Total','n'],['Allocated','n'],['Available','n'],'Status'],
      rs.map((r,i)=>[td(esc(r.p.sku),'sku'),prodCell(r),...locs.map(l=>td(inp(r,i,'stock',+(r.p.stock||{})[l.id]||0,{loc:l.id,label:l.name}),'n')),td('<b>'+num(r.oh)+'</b>','n'),td(num(r.al),'n'),td(num(r.av),'n'),td(pill(r.status))]),
      locs.length?'No products match':'No locations yet',locs.length?'Clear the search or status filter.':'Add a location first.');
  }else{
    body=tbl(['SKU','Product',['Per day','n'],['Lead time','n'],['Safety','n'],['ROP','n'],['On hand','n'],['Allocated','n'],['Available','n'],['Incoming','n'],['Cover','n'],['MOQ','n'],['Case pack','n'],['Suggested','n'],'Status',''],
      rs.map((r,i)=>{const v=V(r.p.vendorId);const ltAuto=(v&&+v.leadTimeDays)||C.defaultLeadTime;return [
        td(esc(r.p.sku),'sku'),prodCell(r),td(num(r.avgDaily,1),'n'),
        td(inp(r,i,'leadTimeDays',r.p.leadTimeDays,{ph:ltAuto,ovr:aiNum(r.p.leadTimeDays)&&+r.p.leadTimeDays>0,label:'Lead time days',title:'Days. Blank uses the vendor lead time ('+ltAuto+'d).'}),'n'),
        td(inp(r,i,'ssOverride',r.p.ssOverride,{ph:r.ssAuto,ovr:aiNum(r.p.ssOverride),label:'Safety stock',title:'Units. Blank uses the calculated '+num(r.ssAuto)+'.'}),'n'),
        td(num(r.rop),'n'),td(num(r.oh),'n'),td(num(r.al),'n'),td(num(r.av),'n'),
        td(num(r.ic)+(r.eta?`<span class="sub">ETA ${esc(r.eta)}</span>`:''),'n'),td(coverTxt(r.cover),'n'),
        td(inp(r,i,'moq',+r.p.moq||0,{label:'Minimum order quantity'}),'n'),
        td(inp(r,i,'casePack',+r.p.casePack||1,{label:'Case pack'}),'n'),
        td(r.sug?'<b>'+num(r.sug)+'</b>':'—','n'),td(pill(r.status)),
        td(`<button class="btn sm" data-act="editPlan" data-id="${esc(r.p.id)}"${W()}>Edit</button>`,'act')]}),
      rows.length?'No products match':'No products yet',rows.length?'Clear the search or status filter.':'Add products to calculate reorder points.');
  }
  return ph('Planning','Inventory planning',`Reorder point = daily demand × lead time + safety stock. Safety stock covers demand swings at a ${C.serviceLevel}% service level. Suggested quantity tops up to ${C.reviewDays} days beyond the reorder point, respecting MOQ and case pack.`,`<button class="btn" data-act="stockExport">Download stock CSV</button><button class="btn" data-act="import" data-id="stock"${W()}>Upload stock CSV</button><button class="btn" data-act="editSettings"${W()}>Planning rules</button><a class="btn pri" href="#purchasing">Create POs</a>`)+
  filters+panel(ui.view==='stock'?'Stock by location':'Inventory plan',`${rs.length} of ${rows.length} active products${ui.view==='stock'?' · '+locs.length+' locations':''}`,tip+body);
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
    td(esc(p.number)+(p.shipment&&p.shipment.mode?`<span class="sub">${p.shipment.mode==='air'?'By air':'By sea'}</span>`:''),'sku'),td(esc(vName(p.vendorId))),td(esc(p.orderDate||'—')),td(esc(p.expectedDate||'—')),
    td((p.lines||[]).length,'n'),td(money(poTotal(p),0),'n'),td(pill(p.status)),td(poApprovalPill(poApproval(p))),td(poApprovalButtons(p),'act')
  ]),'No purchase orders here','Create one from Purchasing or with New PO.'));
};
const STAGES=['Booked','Ready at origin','On the water','In the air','Arrived at port','Customs clearance','Out for delivery','Delivered'];
VIEWS.inbound=()=>{
  const ps=sortBy(list('pos').filter(p=>['placed','in_transit','partial'].includes(p.status)),p=>(p.shipment&&p.shipment.eta)||p.expectedDate);
  return ph('Execution','Inbound shipments','Where each open PO is right now. A shipment is late when its ETA passes the date the vendor promised.','')+
  panel('In the pipeline',ps.length+' shipments',tbl(['PO','Vendor','Promised','ETA','Stage','Carrier / tracking',['Value','n'],''],ps.map(p=>{const s=p.shipment||{};const eta=s.eta||p.expectedDate;const late=eta>p.expectedDate;return [td(esc(p.number),'sku'),td(esc(vName(p.vendorId))),td(esc(p.expectedDate||'—')),td(esc(eta||'—')+' '+(late?pill('Late'):pill('On time'))+`<span class="sub">${eta?(daysBetween(today(),eta)>=0?'in '+daysBetween(today(),eta)+' days':Math.abs(daysBetween(today(),eta))+' days ago'):''}</span>`),td(esc(s.stage||'Booked')),td((s.mode?(s.mode==='air'?'Air · ':'Sea · '):'')+esc(s.carrier||'—')+(s.tracking?`<span class="sub mono">${esc(s.tracking)}</span>`:'')),td(money(poTotal(p),0),'n'),td(`<button class="btn sm" data-act="editShipment" data-id="${p.id}"${W()}>Update</button><button class="btn sm" data-act="receivePO" data-id="${p.id}"${W()}>Receive</button>`,'act')]}),'Nothing inbound','Placed POs appear here until they are received.'));
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
  products:{t:'Products',h:'sku,name,type,make_or_buy,vendor,unit_cost,price,lead_time_days,moq,case_pack,on_hand,unit_weight_kg,unit_volume_cm3',ex:'FG-200,Vitamin C Serum 30ml,finished,buy,Laguna Contract Labs,150,599,21,500,50,320,0.09,180'},
  history:{t:'Monthly sales history',h:'sku,channel,month,qty',ex:'FG-200,Shopee,2026-08,240'},
  stock:{t:'Current stock',h:'sku,location,channel,qty',ex:'FG-100,SCaaS Global Warehouse,,220\nFG-100,,Shopee,40',d:'Use location for a warehouse, channel for stock held by a sales channel, or both. Rows with neither go to the default location.'},
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
   AI INTELLIGENCE v2 — disruption, reorder and air/sea engine.
   Rule-based and transparent. Reads Workspace settings, Vendor
   master (country, origin port, production and transit days,
   freight rates), Demand planning (forecast, trend) and Inventory
   planning (available, incoming POs, safety stock).
   No external disruption feed or language model is connected.
   Records change only when the planner clicks "Create draft POs",
   which feeds the normal approve → email → place workflow.
============================================================ */
const AI_DEF={pid:'',scope:'all',supplierDelay:10,seaDelay:0,airDays:5,seaDays:30,airPremium:0,applyToPOs:true,showAll:false};
function aiN(v,f=0){const n=Number(v);return Number.isFinite(n)?Math.max(0,n):f}
const aiNum=v=>v!==''&&v!=null&&Number.isFinite(+v);
function aiUI(){const u=S.ui.ai||(S.ui.ai={});Object.keys(AI_DEF).forEach(k=>{if(u[k]===undefined)u[k]=AI_DEF[k]});return u}
function aiInScope(v,scope){
  if(!scope||scope==='all')return true;
  if(scope.startsWith('c:'))return ((v&&v.country)||'').trim().toLowerCase()===scope.slice(2);
  if(scope.startsWith('v:'))return !!v&&v.id===scope.slice(2);
  return true;
}
// Splits the single planning lead time into production + transit by mode.
function aiLane(p,v,u){
  const flags=[];
  const lt=+p.leadTimeDays||(v&&+v.leadTimeDays)||cfg().defaultLeadTime;
  let sea=v&&aiNum(v.seaTransitDays)&&+v.seaTransitDays>0?+v.seaTransitDays:null;
  let air=v&&aiNum(v.airTransitDays)&&+v.airTransitDays>0?+v.airTransitDays:null;
  if(sea==null){sea=Math.min(aiN(u.seaDays),lt);flags.push('Sea transit assumed')}
  if(air==null){air=aiN(u.airDays);flags.push('Air transit assumed')}
  let prod;
  if(v&&aiNum(v.productionDays))prod=+v.productionDays;
  else{prod=Math.max(0,lt-sea);flags.push('Production time derived from lead time')}
  return {lt,prod,sea,air,flags};
}
// Air is priced on chargeable weight (greater of actual and volumetric = cm³/6000); sea on CBM.
function aiFreight(p,v,u){
  const kg=+p.unitWeightKg||0, cm3=+p.unitVolumeCm3||0;
  const ar=v?+v.airRatePerKg||0:0, sr=v?+v.seaRatePerCbm||0:0;
  const chg=Math.max(kg,cm3/6000);
  const air=ar&&chg?chg*ar:null, sea=sr&&cm3?cm3/1e6*sr:null;
  if(air!=null&&sea!=null)return {premium:Math.max(0,air-sea),air,sea,chg,src:'rates',known:true};
  const m=aiN(u.airPremium);
  return {premium:m,air,sea,chg,src:'manual',known:m>0};
}
// Margin lost per unit short. Components inherit margin from the finished good they go into.
function aiMargin(r,R){
  if(+r.p.price>0)return {m:Math.max(0,(+r.p.price)-(+r.p.unitCost||0)),src:'own'};
  let m=0,via='';
  (r.usedBy||[]).forEach(x=>{const f=R[x.fg];if(!f||!(+x.qty))return;const fm=((+f.p.price||0)-(+f.p.unitCost||0))/(+x.qty);if(fm>m){m=fm;via=f.p.sku}});
  return {m,src:m?'parent':'none',via};
}
// Open PO receipts by day from today, with the disruption applied to affected vendors.
function aiArrivals(pid,u,t){
  const out=[];
  list('pos').forEach(po=>{
    if(!['placed','in_transit','partial'].includes(po.status))return;
    const s=po.shipment||{}, eta=s.eta||po.expectedDate||t;
    let shift=0;
    if(u.applyToPOs&&aiInScope(V(po.vendorId),u.scope)){
      const seaShift=(s.mode==='air'||s.stage==='In the air')?0:aiN(u.seaDelay);
      const atOrigin=po.status==='placed'&&(!s.stage||['Booked','Ready at origin'].includes(s.stage));
      shift=(atOrigin?aiN(u.supplierDelay):0)+seaShift;
    }
    (po.lines||[]).forEach(l=>{
      if(l.productId!==pid)return;
      const q=Math.max(0,(+l.qty||0)-(+l.received||0));
      if(q)out.push({day:Math.max(0,daysBetween(t,eta))+shift,qty:q,po:po.number,shift});
    });
  });
  return sortBy(out,a=>a.day);
}
function aiPlanSku(r,R,u,t){
  const p=r.p, v=V(p.vendorId), hit=aiInScope(v,u.scope), C=cfg();
  const lane=aiLane(p,v,u), fr=aiFreight(p,v,u), mg=aiMargin(r,R);
  const d=aiN(r.avgDaily), sd=hit?aiN(u.supplierDelay):0, sl=hit?aiN(u.seaDelay):0;
  const seaArr=Math.ceil(lane.prod+lane.sea+sd+sl), airFaster=lane.prod+lane.air+sd<seaArr;
  // When air is not faster than sea on this lane, nothing can land before the sea date.
  const airArr=airFaster?Math.ceil(lane.prod+lane.air+sd):seaArr;
  const arr=aiArrivals(p.id,u,t), byDay={};
  arr.forEach(a=>{byDay[a.day]=(byDay[a.day]||0)+a.qty});
  // Day-by-day projection until a new sea order could land. Unmet demand is lost, not back-ordered.
  const av=+r.av||0, backlog=Math.max(0,-av);
  let s=Math.max(0,av)+(byDay[0]||0), lostEarly=0, lostWindow=0, runway=null;
  for(let day=1;day<=seaArr;day++){
    s+=byDay[day]||0;
    const want=d+(day===1?backlog:0);
    if(runway==null&&s<want)runway=day-1+(want>0?s/want:0);
    const short=Math.max(0,want-s);s=Math.max(0,s-want);
    if(day<=airArr)lostEarly+=short;else lostWindow+=short;
  }
  if(runway==null)runway=d>0?seaArr+s/d:Infinity;
  // Total order: cover demand until sea arrival plus one order cycle, plus safety stock.
  const horizon=seaArr+aiN(C.reviewDays);
  const incH=arr.filter(a=>a.day<=horizon).reduce((a,b)=>a+b.qty,0);
  const need=Math.max(0,Math.ceil(d*horizon+aiN(r.ss)-av-incH));
  const pack=Math.max(1,+p.casePack||1), moq=+p.moq||0;
  let reorder=need>0?Math.ceil(Math.max(need,moq)/pack)*pack:0;
  let airQty=lostWindow>0?Math.ceil(Math.ceil(lostWindow)/pack)*pack:0;
  if(airQty>reorder)reorder=airQty;
  const reasons=[], flags=lane.flags.slice();
  if(fr.src==='manual')flags.push(fr.known?'Air premium entered manually':'No freight rates or unit size');
  if(mg.src==='none')flags.push('No selling price');
  if(!airFaster)reasons.push(`Air is not faster than sea or road on this lane (${lane.air}d vs ${lane.sea}d transit), so air is not an option.`);
  if(mg.src==='parent')reasons.push(`${p.sku} has no selling price, so a shortage is valued at the margin of ${mg.via}, which uses it.`);
  if(!hit&&u.scope!=='all')reasons.push('This vendor is outside the disruption scope, so normal lead times apply.');
  let rec='No action', tone='ok', declinedAir=0;
  const airCost=()=>airQty*fr.premium, prot=()=>Math.min(airQty,lostWindow)*mg.m;
  if(airQty>0){
    if(!fr.known||mg.src==='none'){
      rec='Air + sea (verify)';tone='warn';
      reasons.push(`Stock runs out around day ${num(runway,0)}, but sea freight lands on day ${seaArr}. About ${num(lostWindow)} units of demand fall between air arrival (day ${airArr}) and sea arrival.`);
      reasons.push(!fr.known?'Air freight cost is unknown, so air cannot be weighed against lost margin. Add unit size and freight rates, or enter an air premium.':'Margin is unknown, so air cannot be weighed against lost sales. Add a selling price.');
    }else if(prot()<airCost()){
      reasons.push(`Air would add ${money(airCost(),0)} in freight but only protect ${money(prot(),0)} of margin. Accepting the gap is cheaper, so everything goes by sea.`);
      declinedAir=airQty;airQty=0;rec='Sea only';tone='info';
    }else{
      rec=airQty>=reorder?'All air':'Air + sea split';tone='warn';
      reasons.push(`Stock runs out around day ${num(runway,0)}, before sea freight lands on day ${seaArr}. Air lands on day ${airArr} and bridges ${num(airQty)} units.`);
      reasons.push(`Air adds ${money(airCost(),0)} in freight and protects ${money(prot(),0)} of margin (${money(mg.m,2)} per unit vs ${money(fr.premium,2)} extra freight per unit).`);
    }
  }else if(reorder>0){
    rec='Sea';tone='acc';
    if(runway>=seaArr)reasons.push(Number.isFinite(runway)&&runway<horizon?`Stock and open POs last until about day ${num(runway,0)}, beyond sea arrival on day ${seaArr}, so sea freight is enough.`:`Sea arrival on day ${seaArr} comes before stock runs short.`);
    else reasons.push('Order now by sea to restore stock as early as possible.');
  }
  if(lostEarly>0){
    tone='crit';if(rec==='Sea')rec='Sea, order now';
    reasons.push(`${num(lostEarly)} units of demand fall before ${airFaster?'even air freight':'any new order'} can land on day ${airArr}. Consider moving stock between locations, a local backup supplier, or pausing promotions.`);
  }
  if(reorder>0&&moq&&airQty&&reorder-airQty<moq)reasons.push(`The MOQ of ${num(moq)} applies to the combined order, so confirm the vendor accepts a split shipment.`);
  const seaQty=reorder-airQty;
  return {r,p,v,hit,lane,fr,mg,d,airArr,seaArr,arr,runway,lostEarly,lostWindow,need,reorder,airQty,seaQty,declinedAir,
    airCost:airQty*fr.premium,protectedM:Math.min(airQty,lostWindow)*mg.m,rec,tone,reasons,flags,horizon,act:reorder>0||lostEarly>0};
}
let aiMemo={k:null,v:null};
function aiAll(){
  const u=aiUI(), c=compute(), k=memo.key+'|'+JSON.stringify(u);
  if(aiMemo.k===k)return aiMemo.v;
  const t=today();
  const rows=c.rows.filter(r=>r.p.makeBuy!=='make'&&r.p.active!==false).map(r=>aiPlanSku(r,c.R,u,t));
  const rank={crit:0,warn:1,info:2,acc:3,ok:4};
  aiMemo={k,v:{u,c,rows:sortBy(rows,x=>rank[x.tone]*1e6+(Number.isFinite(x.runway)?x.runway:99999))}};
  return aiMemo.v;
}
function aiTimeline(x){
  const fin=Number.isFinite(x.runway);
  const end=Math.max(x.seaArr,x.airArr,fin?Math.min(x.runway,x.seaArr*1.6):0,1)*1.1;
  const W=640,H=92,L=14,R=W-14,X=dd=>L+(Math.min(Math.max(dd,0),end)/end)*(R-L);
  const rw=fin?Math.min(x.runway,end):end, y=38;
  const mark=(dd,lab,col,below)=>{const xx=X(dd), anc=xx<70?'start':xx>W-70?'end':'middle';return `<line x1="${xx}" x2="${xx}" y1="${y-12}" y2="${y+24}" stroke="${col}" stroke-width="2"/><text x="${xx}" y="${below?y+38:y-17}" text-anchor="${anc}" fill="${col}">${lab}</text>`};
  return `<div class="tw"><svg class="bars aitl" viewBox="0 0 ${W} ${H}" width="100%" style="min-width:420px" role="img" aria-label="Stock runway against air and sea arrival">
    <rect x="${L}" y="${y}" width="${R-L}" height="12" rx="3" fill="var(--soft)"/>
    <rect x="${L}" y="${y}" width="${Math.max(0,X(rw)-L)}" height="12" rx="3" fill="var(--ok)" opacity=".75"/>
    ${fin&&x.runway<x.seaArr?`<rect x="${X(x.runway)}" y="${y}" width="${Math.max(0,X(x.seaArr)-X(x.runway))}" height="12" fill="var(--crit)" opacity=".7"/>`:''}
    ${x.arr.filter(a=>a.day<=end).map(a=>`<circle cx="${X(a.day)}" cy="${y+6}" r="4" fill="var(--panel)" stroke="var(--ink)" stroke-width="1.5"><title>${esc(a.po)}: ${num(a.qty)} units, day ${a.day}${a.shift?' (+'+a.shift+'d delay)':''}</title></circle>`).join('')}
    ${mark(0,'Today','var(--muted)',true)}
    ${x.airArr<x.seaArr?mark(x.airArr,'Air lands · day '+x.airArr,'var(--info)',false):''}
    ${mark(x.seaArr,'Sea lands · day '+x.seaArr,'var(--accent)',true)}
  </svg></div><div class="legend" style="margin-top:4px"><span><i style="background:var(--ok)"></i>Covered by stock + open POs</span><span><i style="background:var(--crit)"></i>Gap before sea arrives</span><span><i style="background:var(--panel);border:1.5px solid var(--ink)"></i>Open PO receipt</span></div>`;
}
const aiRunTxt=x=>!Number.isFinite(x.runway)?'No demand':x.runway>=x.horizon?`${x.horizon}d+`:num(x.runway,0)+'d';
VIEWS.ai=()=>{
  const {u,c,rows}=aiAll(), C=cfg();
  const head=ph('Supply chain intelligence','AI Intelligence','Simulates a supplier or shipping disruption, then recommends a reorder quantity and an air/sea split for every bought product, using your workspace rules, vendor lanes, demand forecast and inventory plan.');
  if(!rows.length)return head+panel('No bought products yet','',`<div class="pbody"><p class="note">Add products bought from vendors, plus sales history, to run the planner. Made-in-house items are planned on MRP & production; their components appear here.</p></div>`);
  const countries={};list('vendors').forEach(v=>{const k=(v.country||'').trim();if(k)countries[k.toLowerCase()]=k});
  const scopeOpts=[['all','All vendors'],...Object.entries(countries).sort((a,b)=>a[1]<b[1]?-1:1).map(([k,n])=>['c:'+k,'Country: '+n]),...sortBy(list('vendors'),v=>v.name).map(v=>['v:'+v.id,'Vendor: '+v.name])];
  const numIn=(id,label,hint,step=1)=>`<label class="fld"><span>${label}</span><input type="number" min="0" step="${step}" data-ai="${id}" value="${esc(u[id])}">${hint?`<small>${hint}</small>`:''}</label>`;
  const act=rows.filter(x=>x.act), shown=u.showAll?rows:act;
  const sum=f=>act.reduce((a,x)=>a+f(x),0);
  if(!rows.some(x=>x.p.id===u.pid))u.pid=(act[0]||rows[0]).p.id;
  const x=rows.find(y=>y.p.id===u.pid);
  const recPill=y=>`<span class="pill ${y.tone}">${esc(y.rec)}</span>`;

  const scenario=panel('Disruption scenario','Enter what is happening. Everything below recalculates.',`<div class="pbody"><div class="grid2" style="gap:12px">
    <label class="fld"><span>Who is affected</span><select data-ai="scope">${scopeOpts.map(([v,l])=>`<option value="${esc(v)}"${v===u.scope?' selected':''}>${esc(l)}</option>`).join('')}</select><small>Vendors outside the scope keep normal lead times.</small></label>
    ${numIn('supplierDelay','Supplier delay (days)','Factory shutdown, holiday, material shortage. Delays air and sea.')}
    ${numIn('seaDelay','Sea and port delay (days)','Port congestion, rerouting, blank sailings. Delays sea only.')}
    <div class="fld"><span>Open purchase orders</span><label class="aichk"><input type="checkbox" class="chk" data-ai="applyToPOs"${u.applyToPOs?' checked':''}> Apply the delay to open POs from affected vendors</label><small>Not yet shipped: supplier + sea delay. On the water: sea delay only.</small></div>
    ${numIn('airDays','Fallback air transit (days)','Used only where a vendor has no air transit days.')}
    ${numIn('seaDays','Fallback sea transit (days)','Used only where a vendor has no sea transit days.')}
    ${numIn('airPremium',`Fallback air premium per unit (${esc(cur())})`,'Used only where unit size or freight rates are missing.',.01)}
  </div></div>`);

  const kpis=`<div class="kpis">
    <div class="kpi ${act.length?'warn':''}"><span>SKUs needing a decision</span><strong>${act.length}</strong><small>of ${rows.length} bought products</small></div>
    <div class="kpi"><span>Air bridges</span><strong>${act.filter(y=>y.airQty).length}</strong><small>SKUs where flying part of the order pays off</small></div>
    <div class="kpi"><span>Extra air freight</span><strong>${money(sum(y=>y.airCost),0)}</strong><small>Over sea, where rates are known</small></div>
    <div class="kpi"><span>Margin protected</span><strong>${money(sum(y=>y.protectedM),0)}</strong><small>Sales saved by flying</small></div>
    <div class="kpi ${sum(y=>y.lostEarly)?'crit':''}"><span>Unavoidable shortfall</span><strong>${money(sum(y=>y.lostEarly*y.mg.m),0)}</strong><small>Margin lost on ${act.filter(y=>y.lostEarly>0).length} SKUs before any order can land</small></div>
  </div>`;

  const recTable=panel('Recommendations',`${act.length} SKUs need action under this scenario. Days are counted from today.`,tbl(['SKU','Vendor',['Runway','n'],['Air lands','n'],['Sea lands','n'],['Reorder','n'],['By air','n'],['By sea','n'],['Extra freight','n'],'Recommendation',''],shown.map(y=>[
      td(esc(y.p.sku)+`<span class="sub">${esc(y.p.name)}</span>`,'sku'),
      td(esc(vName(y.p.vendorId))+`<span class="sub">${esc((y.v&&y.v.country)||'No country')}${y.hit&&u.scope!=='all'?' · affected':''}</span>`),
      td(aiRunTxt(y),'n'),td(y.airArr<y.seaArr?'day '+y.airArr:'—','n'),td('day '+y.seaArr,'n'),
      td(y.reorder?'<b>'+num(y.reorder)+'</b>':'—','n'),td(y.airQty?num(y.airQty):'—','n'),td(y.seaQty?num(y.seaQty):'—','n'),
      td(y.airQty?(y.fr.known?money(y.airCost,0):'<span class="note">Unknown</span>'):'—','n'),
      td(recPill(y)+(y.flags.length?`<span class="sub">${y.flags.length} data gap${y.flags.length>1?'s':''}</span>`:'')),
      td(`<button class="btn sm${y.p.id===u.pid?' pri':''}" data-act="aiPick" data-id="${esc(y.p.id)}">Details</button>`,'act')
    ]),'No action needed','Every bought product is covered under this scenario.'),
    `<label class="aichk note"><input type="checkbox" class="chk" data-ai="showAll"${u.showAll?' checked':''}> Show all SKUs</label>`);

  const detail=x?`<section class="panel" id="aiDetail"><header><div><h2>${esc(x.p.sku)} · ${esc(x.p.name)}</h2><p>${esc(vName(x.p.vendorId))} · ${esc((x.v&&x.v.originPort)||(x.v&&x.v.country)||'No origin set')}</p></div><div class="acts">${recPill(x)}<button class="btn pri" data-act="aiCreatePO" data-id="${esc(x.p.id)}"${x.reorder&&x.p.vendorId&&!S.ro?'':' disabled'}${S.ro?' title="View-only access"':''}>Create draft PO${x.airQty&&x.seaQty?'s':''}</button></div></header>
    <div class="pbody">${aiTimeline(x)}
    <div class="kpis" style="margin:16px 0 8px">
      <div class="kpi"><span>Daily demand</span><strong>${num(x.d,1)}</strong><small>Forecast ${num(x.r.fcM)}/mo${x.r.p.forecastAdj?' incl. '+(x.r.p.forecastAdj>0?'+':'')+x.r.p.forecastAdj+'% adj.':''}</small></div>
      <div class="kpi"><span>Available + incoming</span><strong>${num(x.r.av)} + ${num(x.arr.reduce((a,b)=>a+b.qty,0))}</strong><small>Safety stock ${num(x.r.ss)} at ${C.serviceLevel}%</small></div>
      <div class="kpi"><span>Lane</span><strong>${x.lane.prod}+${x.lane.sea}d</strong><small>Production + sea · air ${x.lane.air}d</small></div>
      <div class="kpi ${x.reorder?'warn':''}"><span>Reorder</span><strong>${num(x.reorder)}</strong><small>${num(x.airQty)} air · ${num(x.seaQty)} sea</small></div>
    </div>
    <h3 class="aih">Why</h3><ul class="aiul">${x.reasons.length?x.reasons.map(t=>`<li>${esc(t)}</li>`).join(''):'<li>Stock and open POs cover demand beyond the sea arrival date and one order cycle. No order needed.</li>'}</ul>
    <h3 class="aih">How the quantity is built</h3><ul class="aiul">
      <li>Covers ${x.horizon} days of demand (sea arrival day ${x.seaArr} + ${C.reviewDays}-day order cycle) plus ${num(x.r.ss)} safety stock, less available stock and open POs landing in that window: <b>${num(x.need)}</b> units.</li>
      <li>Rounded up to MOQ ${num(+x.p.moq||0)} and case pack ${num(+x.p.casePack||1)}: <b>${num(x.reorder)}</b> units.</li>
      <li>Freight per unit: ${x.fr.air!=null?'air '+money(x.fr.air,2)+' ('+num(x.fr.chg,3)+' chargeable kg)':'air unknown'} · ${x.fr.sea!=null?'sea '+money(x.fr.sea,2):'sea unknown'}${x.fr.src==='manual'&&x.fr.known?' · using fallback premium '+money(x.fr.premium,2):''}. Margin per unit short: ${x.mg.m?money(x.mg.m,2):'unknown'}.</li>
      ${x.declinedAir?`<li>Air bridge of ${num(x.declinedAir)} units considered and rejected on cost.</li>`:''}
    </ul>
    ${x.flags.length?`<h3 class="aih">Data gaps</h3><p class="note">${x.flags.map(esc).join(' · ')}. Fill these in <a href="#vendors">Vendor master</a> and <a href="#products">Product master</a> for a firmer recommendation.</p>`:''}
    <p class="note" style="margin-top:12px">Draft POs go through Send for approval → Email PO → Place, like any other PO.</p>
    </div></section>`:'';

  // Trends and issues
  const st=supplierStats().filter(s=>s.actualLT!=null&&s.v.leadTimeDays&&s.actualLT-s.v.leadTimeDays>2);
  const shifts=sortBy(c.rows.filter(r=>r.p.type!=='component'&&r.withData>=3&&Math.abs(r.trend)>=.2),r=>-Math.abs(r.trend)).slice(0,8);
  const exp={};rows.forEach(y=>{const k=(y.v&&y.v.country)||'No country';const e=exp[k]=exp[k]||{n:0,stock:0,buy:0,air:0};e.n++;e.stock+=y.r.value;e.buy+=y.reorder*(+y.p.unitCost||0);e.air+=y.airQty});
  const totStock=Object.values(exp).reduce((a,e)=>a+e.stock,0)||1;
  const trends=`<div class="grid2">`+
    panel('Exposure by supplier country','Where your bought products come from.',tbl(['Country',['SKUs','n'],['Stock value','n'],['Share','n'],['Reorder value','n']],sortBy(Object.entries(exp),([,e])=>-e.stock).map(([k,e])=>[td(esc(k)),td(e.n,'n'),td(money(e.stock,0),'n'),td(Math.round(e.stock/totStock*100)+'%','n'),td(e.buy?money(e.buy,0):'—','n')]),'No vendors'))+
    panel('Demand shifts','Finished goods whose last 3 months moved 20%+ against the 3 before.',tbl(['SKU',['Trend','n'],['Forecast / mo','n']],shifts.map(r=>[td(esc(r.p.sku)+`<span class="sub">${esc(r.p.name)}</span>`,'sku'),td(`<span class="pill ${r.trend>0?'ok':'crit'}">${r.trend>0?'+':''}${Math.round(r.trend*100)}%</span>`,'n'),td(num(r.fcM),'n')]),'No big demand shifts','Demand is steady across finished goods.'))+
    `</div>`+
    (st.length?panel('Supplier lead-time drift','Received POs are taking longer than quoted. The planner uses quoted times until you update them.',tbl(['Vendor',['Quoted','n'],['Actual','n'],['Gap','n']],st.map(s=>[td(esc(s.v.name)),td(s.v.leadTimeDays+'d','n'),td(Math.round(s.actualLT)+'d','n'),td(`<span class="pill crit">+${Math.round(s.actualLT-s.v.leadTimeDays)}d</span>`,'n')]),''),'<a class="btn sm" href="#vendors">Update vendors</a>'):'');

  const noLane=list('vendors').filter(v=>!aiNum(v.seaTransitDays)||!aiNum(v.airTransitDays)||!aiNum(v.productionDays)).length;
  const noSize=rows.filter(y=>!(+y.p.unitVolumeCm3)).length, noRate=list('vendors').filter(v=>!(+v.airRatePerKg)||!(+v.seaRatePerCbm)).length;
  const gaps=noLane||noSize||noRate?`<div class="banner warn"><span><b>Data gaps lower confidence.</b> ${[noLane?noLane+' vendor'+(noLane>1?'s':'')+' missing production or transit days':'',noRate?noRate+' vendor'+(noRate>1?'s':'')+' missing freight rates':'',noSize?noSize+' product'+(noSize>1?'s':'')+' missing unit size':''].filter(Boolean).join(' · ')}. Fallback values on this page fill the gaps.</span><span class="acts"><a class="btn sm" href="#vendors">Vendor master</a><a class="btn sm" href="#products">Product master</a></span></div>`:'';

  return head+
    `<div class="banner"><span><b>Scenario planner.</b> The disruption is what you enter here, not a live news or port feed. Recommendations come from transparent rules, shown in full for each SKU. Nothing changes until you create a draft PO.</span></div>`+
    gaps+scenario+kpis+recTable+detail+trends;
};
document.addEventListener('change',e=>{
  const el=e.target;if(!el.matches||!el.matches('[data-ai]'))return;
  const u=aiUI(), k=el.dataset.ai;
  if(el.type==='checkbox')u[k]=el.checked;
  else if(k==='pid'||k==='scope')u[k]=el.value;
  else u[k]=aiN(el.value);
  render();
});
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
A.invView=d=>{const u=S.ui.inv=S.ui.inv||{};u.view=d.id;u.frozen=null;render()};
A.stockExport=async()=>{
  const locs=sortBy(list('locations'),l=>l.name), rows=[['sku','location','channel','qty']];
  sortBy(list('products'),p=>p.sku).forEach(p=>locs.forEach(l=>rows.push([p.sku,l.name,(CH(l.channelId)||{}).name||'',+(p.stock||{})[l.id]||0])));
  const csv=rows.map(r=>r.map(csvEsc).join(',')).join('\n');
  try{await S.dl.save({filename:'stock-by-location-'+today()+'.csv',data:csv});toast('Stock CSV downloaded. Edit the qty column and upload it back.')}catch(e){toast('Download is unavailable here.')}
};
A.editPlan=d=>{
  const p=P(d.id);if(!p)return;const {R}=compute();const r=R[p.id];const locs=locOpts();const v=V(p.vendorId);
  openForm({title:'Edit plan · '+esc(p.sku),fields:[
    {id:'leadTimeDays',label:'Lead time (days)',type:'number',value:p.leadTimeDays,placeholder:String((v&&+v.leadTimeDays)||cfg().defaultLeadTime),hint:'Blank uses the vendor lead time.'},
    {id:'ssOverride',label:'Safety stock (units)',type:'number',value:p.ssOverride,placeholder:r?String(r.ssAuto):'',hint:'Blank uses the calculated value'+(r?' ('+num(r.ssAuto)+')':'')+'.'},
    {id:'moq',label:'Minimum order qty',type:'number',value:p.moq},{id:'casePack',label:'Case pack',type:'number',value:p.casePack||1},
    {id:'forecastAdj',label:'Forecast adjustment (%)',type:'number',value:p.forecastAdj||0,hint:'E.g. +25 for a sale month.'},
    {id:'vendorId',label:'Vendor',type:'select',value:p.vendorId,options:vendOpts(true)},
    {id:'stockHead',type:'html',html:'<p class="note"><b>Stock on hand by location.</b> These replace the system count.</p>'},
    ...locs.map(([lid,ln])=>({id:'loc_'+lid,label:ln,type:'number',value:+(p.stock||{})[lid]||0}))
  ],onSubmit:async x=>{
    const bad=Object.entries(x).find(([k,val])=>k!=='vendorId'&&k!=='forecastAdj'&&val!==''&&!(+val>=0));if(bad)fail('Quantities and days must be zero or more.');
    const stock=Object.assign({},p.stock||{});locs.forEach(([lid])=>{stock[lid]=+x['loc_'+lid]||0});
    await upd('products',p.id,{leadTimeDays:x.leadTimeDays===''?'':+x.leadTimeDays,ssOverride:x.ssOverride===''?'':+x.ssOverride,moq:+x.moq||0,casePack:Math.max(1,+x.casePack||1),forecastAdj:+x.forecastAdj||0,vendorId:x.vendorId,stock});
    toast(p.sku+' plan saved.');
  }});
};
A.aiPick=d=>{aiUI().pid=d.id;render();const el=document.getElementById('aiDetail');if(el)el.scrollIntoView({behavior:'smooth',block:'start'})};
A.aiCreatePO=async(d,el)=>{
  const {rows}=aiAll();const x=rows.find(y=>y.p.id===d.id);
  if(!x||!x.reorder){toast('Nothing to order for this SKU.');return}
  if(!x.p.vendorId){toast('Assign a vendor to this product first.');return}
  if(el)el.disabled=true;
  const t=today();
  const mk=async(mode,qty,days,unitFreight)=>{
    const number=nextNum('pos','PO-');
    await save('pos',nid(),{number,vendorId:x.p.vendorId,locationId:defLoc()||'',orderDate:t,expectedDate:addDays(t,days),status:'draft',approvalStatus:'not_sent',
      freight:unitFreight!=null?Math.round(qty*unitFreight*100)/100:0,lines:[{productId:x.p.id,qty,unitCost:+x.p.unitCost||0,received:0}],
      shipment:{stage:'Booked',carrier:'',tracking:'',eta:'',mode},aiNote:'Created from AI Intelligence: '+x.rec});
    return number;
  };
  try{
    const made=[];
    if(x.airQty)made.push(await mk('air',x.airQty,x.airArr,x.fr.air));
    if(x.seaQty)made.push(await mk('sea',x.seaQty,x.seaArr,x.fr.sea));
    toast('Draft '+made.join(' (air) and ')+(x.airQty&&x.seaQty?' (sea)':'')+' created. Send for approval in Purchase orders.');
    location.hash='pos';
  }catch(e){if(el)el.disabled=false}
};
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
    {id:'unitWeightKg',label:'Unit weight (kg)',type:'number',value:p.unitWeightKg,hint:'Packed weight per unit. Used for air freight.'},{id:'unitVolumeCm3',label:'Unit volume (cm³)',type:'number',value:p.unitVolumeCm3,hint:'Packed L × W × H per unit. Used for sea freight and air volumetric weight.'},
    {id:'active',label:'Status',type:'select',value:p.active===false?'no':'yes',options:[['yes','Active'],['no','Inactive (excluded from planning)']]},
    {id:'bom',label:'Bill of materials (made-in-house only)',type:'lines',rows:(p.bom||[]).map(b=>Object.assign({},b)),cols:[{key:'componentId',label:'Component',type:'select',options:prodOpts(x=>x.type==='component'&&x.id!==d.id,true)},{key:'qty',label:'Qty per unit',type:'number'}]}
  ],onDelete:d.id?async()=>{await del('products',d.id);toast('Product deleted.')}:null,
  onSubmit:async v=>{
    if(!v.sku||!v.name)fail('SKU and name are required.');
    const dup=list('products').find(x=>x.sku.toLowerCase()===v.sku.toLowerCase()&&x.id!==d.id);if(dup)fail('Another product already uses SKU '+v.sku+'.');
    const o=Object.assign({},p,{sku:v.sku,name:v.name,type:v.type,makeBuy:v.makeBuy,vendorId:v.vendorId,leadTimeDays:v.leadTimeDays,unitCost:+v.unitCost||0,price:+v.price||0,moq:+v.moq||0,casePack:+v.casePack||1,unitWeightKg:v.unitWeightKg===''?'':+v.unitWeightKg,unitVolumeCm3:v.unitVolumeCm3===''?'':+v.unitVolumeCm3,active:v.active==='yes',bom:v.bom.filter(b=>b.componentId&&+b.qty>0).map(b=>({componentId:b.componentId,qty:+b.qty})),forecastAdj:p.forecastAdj||0,stock:p.stock||{}});
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
    {id:'leadTimeDays',label:'Lead time (days)',type:'number',value:v.leadTimeDays,hint:'Order to arrival at your warehouse. Left blank, it becomes production + sea transit.'},{id:'contact',label:'Contact email',value:v.contact},
    {id:'depositPct',label:'Deposit at order (%)',type:'number',value:v.depositPct},{id:'balanceDays',label:'Balance due (days after arrival)',type:'number',value:v.balanceDays},
    {id:'laneHead',type:'html',html:'<p class="note"><b>Shipping lane.</b> Used by AI Intelligence to compare air and sea. Rates are in '+esc(cur())+'.</p>'},
    {id:'originPort',label:'Origin city / port',value:v.originPort,placeholder:'e.g. Guangzhou (Nansha)'},
    {id:'productionDays',label:'Production days',type:'number',value:v.productionDays,hint:'PO placed to goods ready at origin.'},
    {id:'seaTransitDays',label:'Sea transit days',type:'number',value:v.seaTransitDays,hint:'Ready at origin to your warehouse, incl. customs. Use road time for local vendors.'},
    {id:'airTransitDays',label:'Air transit days',type:'number',value:v.airTransitDays,hint:'Ready at origin to your warehouse by air, incl. customs.'},
    {id:'airRatePerKg',label:'Air rate per chargeable kg',type:'number',value:v.airRatePerKg},
    {id:'seaRatePerCbm',label:'Sea rate per CBM',type:'number',value:v.seaRatePerCbm}
  ],onDelete:d.id?async()=>{await del('vendors',d.id);toast('Vendor deleted.')}:null,onSubmit:async x=>{if(!x.name)fail('Vendor name is required.');const laneLT=aiNum(x.productionDays)&&aiNum(x.seaTransitDays)?(+x.productionDays)+(+x.seaTransitDays):0;await save('vendors',d.id||nid(),Object.assign({},v,x,{leadTimeDays:+x.leadTimeDays||laneLT||0,depositPct:+x.depositPct||0,balanceDays:+x.balanceDays||0}));toast('Vendor saved.')}});
};
A.editLocation=d=>{
  const l=d.id?L(d.id):{type:'warehouse'};
  openForm({title:d.id?'Edit location':'Add location',fields:[{id:'name',label:'Name',value:l.name,required:true},{id:'type',label:'Type',type:'select',value:l.type,options:[['warehouse','Warehouse'],['3pl','3PL'],['marketplace','Marketplace fulfillment'],['store','Retail store']]},{id:'channelId',label:'Stock held for sales channel',type:'select',value:l.channelId||'',options:chOpts(),hint:'For stock sitting with a marketplace, e.g. Shopee or Lazada fulfillment.',full:true}],
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
A.createPOs = async () => {
  const { rows } = compute();

  const sel = rows.filter(r =>
    S.ui.sel[r.p.id] &&
    r.sug > 0 &&
    r.p.makeBuy !== 'make' &&
    r.p.vendorId
  );

  if (!sel.length) {
    toast('Select purchased items with assigned vendors first.');
    return;
  }

  const by = {};

  sel.forEach(r => {
    (by[r.p.vendorId] = by[r.p.vendorId] || []).push(r);
  });

  const btn = document.querySelector('[data-act="createPOs"]');
  if (btn) btn.disabled = true;

  try {
    let n = 0;

    for (const [vid, rs] of Object.entries(by)) {
      const v = V(vid);
      const num1 = nextNum('pos', 'PO-');
      const lt = Math.max(...rs.map(r => r.lt));

      await save('pos', nid(), {
        number: num1,
        vendorId: vid,
        locationId: defLoc() || '',
        orderDate: today(),
        expectedDate: addDays(
          today(),
          lt || (v && v.leadTimeDays) || 30
        ),
        status: 'draft',
        freight: 0,
        lines: rs.map(r => ({
          productId: r.p.id,
          qty: r.sug,
          unitCost: +r.p.unitCost || 0,
          received: 0
        })),
        shipment: {
          stage: 'Booked',
          carrier: '',
          tracking: '',
          eta: ''
        }
      });

      n++;
    }

    S.ui.sel = {};
    toast(
      n + ' draft PO' + (n > 1 ? 's' : '') +
      ' created. Review and place them in Purchase orders.'
    );
    location.hash = 'pos';

  } catch (e) {
    console.error('PO creation failed:', e);
  } finally {
    if (btn) btn.disabled = false;
  }
};

A.createPOs = async () => {
  const { rows } = compute();

  const sel = rows.filter(r =>
    S.ui.sel[r.p.id] &&
    r.sug > 0 &&
    r.p.makeBuy !== 'make' &&
    r.p.vendorId
  );

  if (!sel.length) {
    toast('Select purchased items with assigned vendors first.');
    return;
  }

  const by = {};

  sel.forEach(r => {
    (by[r.p.vendorId] = by[r.p.vendorId] || []).push(r);
  });

  const btn = document.querySelector('[data-act="createPOs"]');
  if (btn) btn.disabled = true;

  try {
    let n = 0;

    for (const [vid, rs] of Object.entries(by)) {
      const v = V(vid);
      const num1 = nextNum('pos', 'PO-');
      const lt = Math.max(...rs.map(r => r.lt));

      await save('pos', nid(), {
        number: num1,
        vendorId: vid,
        locationId: defLoc() || '',
        orderDate: today(),
        expectedDate: addDays(
          today(),
          lt || (v && v.leadTimeDays) || 30
        ),
        status: 'draft',
        freight: 0,
        lines: rs.map(r => ({
          productId: r.p.id,
          qty: r.sug,
          unitCost: +r.p.unitCost || 0,
          received: 0
        })),
        shipment: {
          stage: 'Booked',
          carrier: '',
          tracking: '',
          eta: ''
        }
      });

      n++;
    }

    S.ui.sel = {};

    toast(
      n + ' draft PO' +
      (n > 1 ? 's' : '') +
      ' created.'
    );

    location.hash = 'pos';

  } catch (e) {
    console.error('PO creation failed:', e);
    toast('Could not create purchase orders.');
  } finally {
    if (btn) btn.disabled = false;
  }
};

A.selVendor = d => {
  const { rows } = compute();

  rows
    .filter(r =>
      r.sug > 0 &&
      r.p.makeBuy !== 'make' &&
      (r.p.vendorId || '') === d.id
    )
    .forEach(r => {
      S.ui.sel[r.p.id] = true;
    });

  render();
};
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
  const extra=d.id==='stock'?[{id:'mode',label:'How to apply',type:'select',value:'set',options:[['set','Replace: quantities become the counted stock'],['add','Add: quantities are added to current stock']],full:true}]:[];
  openForm({title:'Import '+x.t.toLowerCase(),wide:true,fields:[...(x.d?[{id:'desc',type:'html',html:`<p class="note">${esc(x.d)}</p>`}]:[]),{id:'file',type:'html',html:`<label class="fld"><span>CSV file</span><input type="file" id="impFile" accept=".csv,text/csv"></label>`},...extra,{id:'csv',label:'Or paste CSV',type:'textarea',value:'',placeholder:x.h+'\n'+x.ex,hint:'First row must be the header: '+x.h}],submitLabel:'Import',
  onSubmit:async v=>{const rows=parseCSV(v.csv||'');if(rows.length<2)fail('Paste CSV with a header row and at least one data row.');const h=rows[0].map(s=>s.trim().toLowerCase().replace(/\s+/g,'_'));const recs=rows.slice(1).map(r=>{const o={};h.forEach((k,i)=>o[k]=(r[i]||'').trim());return o});const res=await IMPORTERS[d.id](recs,v);const n=typeof res==='number'?res:res.n,sk=(res&&res.skipped)||[];toast('Imported '+n+' rows.'+(sk.length?' Skipped '+sk.length+': '+sk.slice(0,4).join(', ')+(sk.length>4?'…':''):''))}});
  $('#impFile').addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>{$('#f_csv').value=rd.result};rd.readAsText(f)});
};
async function ensureVendor(name){if(!name)return '';const v=list('vendors').find(x=>x.name.toLowerCase()===name.toLowerCase());if(v)return v.id;const id=nid();await save('vendors',id,{name,leadTimeDays:cfg().defaultLeadTime,depositPct:0,balanceDays:30,currency:cur()});S.col.vendors[id]={id,name,leadTimeDays:cfg().defaultLeadTime};return id}
async function ensureChannel(name){if(!name)return '';const c=list('channels').find(x=>x.name.toLowerCase()===name.toLowerCase());if(c)return c.id;const id=nid();await save('channels',id,{name,type:'other',status:'csv'});S.col.channels[id]={id,name};return id}
async function resolveStockLocation(locName,chName){
  locName=(locName||'').trim();chName=(chName||'').trim();
  const chId=chName?await ensureChannel(chName):'';
  const make=async o=>{const id=nid();await save('locations',id,o);S.col.locations[id]=Object.assign({id},o);return id};
  if(locName){
    const l=list('locations').find(x=>x.name.toLowerCase()===locName.toLowerCase());
    if(!l)return make({name:locName,type:chId?'marketplace':'warehouse',channelId:chId||''});
    if(chId&&!l.channelId)await upd('locations',l.id,{channelId:chId});
    return l.id;
  }
  if(chId){
    const l=list('locations').find(x=>x.channelId===chId)||list('locations').find(x=>x.name.toLowerCase()===(chName+' stock').toLowerCase());
    return l?l.id:make({name:chName+' stock',type:'marketplace',channelId:chId});
  }
  return defLoc();
}
const bySku=sku=>list('products').find(p=>p.sku.toLowerCase()===String(sku).toLowerCase());
const IMPORTERS={
  stock:async(recs,v)=>{
    const mode=(v&&v.mode)==='add'?'add':'set', changes={}, seen={}, skipped=[];let n=0;
    for(const r of recs){
      const p=r.sku&&bySku(r.sku), q=r.qty??r.on_hand??r.quantity??'';
      if(!p){skipped.push(r.sku?r.sku+' (unknown SKU)':'blank SKU');continue}
      if(q===''||!Number.isFinite(+q)||+q<0){skipped.push(r.sku+' (quantity)');continue}
      const lid=await resolveStockLocation(r.location||r.warehouse||'',r.channel||r.sales_channel||'');
      if(!lid){skipped.push(r.sku+' (no location)');continue}
      const st=changes[p.id]||(changes[p.id]=Object.assign({},p.stock||{})), k=p.id+'|'+lid;
      // Replace mode: the first row for a SKU and location resets it; repeated rows (e.g. several bins) add up.
      if(mode==='set'&&!seen[k])st[lid]=0;
      seen[k]=1;st[lid]=(+st[lid]||0)+(+q);n++;
    }
    for(const [pid,stock] of Object.entries(changes))await upd('products',pid,{stock});
    return {n,skipped};
  },
  products:async recs=>{let n=0;const loc=defLoc();for(const r of recs){if(!r.sku)continue;const ex=bySku(r.sku);const vid=await ensureVendor(r.vendor);const o=Object.assign({stock:{},bom:[],forecastAdj:0,active:true},ex||{},{sku:r.sku,name:r.name||(ex&&ex.name)||r.sku,type:(r.type||'').toLowerCase().startsWith('comp')?'component':'finished',makeBuy:(r.make_or_buy||'').toLowerCase()==='make'?'make':'buy',vendorId:vid||(ex&&ex.vendorId)||'',unitCost:+r.unit_cost||(ex&&ex.unitCost)||0,price:+r.price||(ex&&ex.price)||0,leadTimeDays:r.lead_time_days?+r.lead_time_days:((ex&&ex.leadTimeDays)||''),moq:+r.moq||0,casePack:+r.case_pack||1});if(aiNum(r.unit_weight_kg)&&r.unit_weight_kg!=='')o.unitWeightKg=+r.unit_weight_kg;if(aiNum(r.unit_volume_cm3)&&r.unit_volume_cm3!=='')o.unitVolumeCm3=+r.unit_volume_cm3;if(r.on_hand!==''&&r.on_hand!=null&&loc)o.stock=Object.assign({},o.stock,{[loc]:+r.on_hand||0});const id=ex?ex.id:nid();await save('products',id,o);S.col.products[id]=Object.assign({id},o);n++}return n},
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
document.addEventListener('change',async e=>{
  const el=e.target;
  if(el.id==='invQ'){const u=S.ui.inv=S.ui.inv||{};u.q=el.value.trim();u.frozen=null;render();return}
  if(el.id==='invStatus'){const u=S.ui.inv=S.ui.inv||{};u.status=el.value;u.frozen=null;render();return}
  if(!el.dataset||!el.dataset.inv)return;
  const p=P(el.dataset.id);if(!p)return;
  if(S.ui.inv&&!S.ui.inv.frozen)S.ui.inv.frozen=S.ui.inv.lastOrder;
  const f=el.dataset.inv, raw=el.value.trim();
  if(raw!==''&&!(Number(raw)>=0)){toast('Enter a number of zero or more.');render();return}
  try{
    if(f==='stock')await upd('products',p.id,{stock:{...(p.stock||{}),[el.dataset.loc]:raw===''?0:+raw}});
    else if(f==='leadTimeDays'||f==='ssOverride')await upd('products',p.id,{[f]:raw===''?'':+raw});
    else if(f==='moq')await upd('products',p.id,{moq:+raw||0});
    else if(f==='casePack')await upd('products',p.id,{casePack:Math.max(1,Math.round(+raw)||1)});
  }catch(err){}
});
document.addEventListener('keydown',e=>{
  const el=e.target;
  if(el.id==='invQ'&&e.key==='Enter'){el.blur();return}
  if(!el.classList||!el.classList.contains('cellin')||(e.key!=='Enter'&&e.key!=='Escape'))return;
  e.preventDefault();
  if(e.key==='Escape'){el.value=el.defaultValue;el.blur();return}
  const next=document.querySelector(`.cellin[data-col="${CSS.escape(el.dataset.col)}"][data-row="${(+el.dataset.row)+(e.shiftKey?-1:1)}"]`);
  if(next){S.ui.focusFk=next.dataset.fk;next.focus();next.select()}else el.blur();
});
document.addEventListener('submit',e=>{if(e.target.id==='mform')submitModal(e);else if(e.target.id==='setupForm')doSetup(e)});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&MODAL)closeModal()});
window.addEventListener('hashchange',()=>{const h=location.hash.slice(1);if(S.ui.inv)S.ui.inv.frozen=null;if(PAGES.includes(h)){page=h;render();window.scrollTo(0,0)}});


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
