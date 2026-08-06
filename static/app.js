"use strict";
// ---- API -------------------------------------------------------------------
const api = {
  async get(u){ const r=await fetch(u); if(!r.ok) throw await err(r); return r.json(); },
  async post(u,b){ const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(b||{})}); if(!r.ok) throw await err(r); return r.json(); },
  async del(u){ const r=await fetch(u,{method:"DELETE"}); if(!r.ok) throw await err(r); return r.json(); },
};
async function err(r){
  if(r.status===401){ location.href="/login"; return new Error("未登录"); }
  try{const j=await r.json(); return new Error(j.error||r.statusText);}catch(_){return new Error(r.statusText);}
}
const $=s=>document.querySelector(s);
const ce=(t,c)=>{const e=document.createElement(t); if(c)e.className=c; return e;};
const esc=s=>(s==null?"":String(s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function btn(label,cls,fn){ const b=ce("button","btn "+cls); b.textContent=label; b.onclick=fn; return b; }
function toast(msg,kind){ const t=ce("div","toast "+(kind||"")); t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),3400); }
function fmtMin(m){ if(m==null) return ""; if(!isFinite(m)) return "∞"; const d=Math.floor(m/1440),h=Math.floor(m%1440/60),mm=m%60; return (d?d+"d":"")+(h?h+"h":"")+(mm?mm+"m":"")||"0m"; }
function fmtBytes(n){ if(!n) return "0"; const u=["B","K","M","G"]; let i=0; while(n>=1024&&i<3){n/=1024;i++;} return n.toFixed(i?1:0)+u[i]; }
function fmtAge(s){ if(s==null) return ""; if(s<60) return s+"s 前"; if(s<3600) return Math.floor(s/60)+"m 前"; return Math.floor(s/3600)+"h 前"; }

// ---- state -----------------------------------------------------------------
let STATE={nodes:[],jobs:[],finished:[],partitions:[],me:"",site:""};
let QOS=[], MIGRATIONS=[], DRAFTS=[], HELP={};
let FILTERS={onlyFree:false,onlyMine:false,type:""};
// finished jobs: shown in their own tab, auto-dropped 3 min after they end
const FIN_TTL_MS=180000;
const TERMINAL=new Set(["COMPLETED","FAILED","CANCELLED","TIMEOUT","OUT_OF_MEMORY",
  "NODE_FAIL","PREEMPTED","BOOT_FAIL","DEADLINE","REVOKED","SPECIAL_EXIT","ENDED"]);
let FINISHED=new Map();      // job id -> entry currently shown in the Finished tab
let FIN_GONE=new Set();      // ids already expired/dismissed — never resurrect them
let LAST_JOBS=new Map();     // previous poll's live jobs, to catch ones that vanish
window.__drag=null;

// ===========================================================================
// CLUSTER
// ===========================================================================
function renderCluster(){
  const body=$("#clusterBody");
  let nodes=STATE.nodes.slice();
  if(FILTERS.onlyFree) nodes=nodes.filter(n=>n.free>0);
  if(FILTERS.onlyMine) nodes=nodes.filter(n=>n.usable_by_me);
  if(FILTERS.type) nodes=nodes.filter(n=>n.gpu_types.includes(FILTERS.type));
  const groups={};
  for(const n of nodes){ const g=n.gpu_types[0]||"?"; (groups[g]=groups[g]||[]).push(n); }
  body.innerHTML="";
  const types=Object.keys(groups).sort();
  if(!types.length){ body.innerHTML='<div class="empty">没有匹配的节点</div>'; return; }
  for(const g of types){
    const list=groups[g].sort((a,b)=>b.free-a.free||a.name.localeCompare(b.name));
    const tot=list.reduce((s,n)=>s+n.total,0), free=list.reduce((s,n)=>s+n.free,0);
    const grp=ce("div","group");
    const gh=ce("div","group-head");
    gh.innerHTML=`<span class="gtype">${g}</span><span class="gsum"><span class="gfree">${free} free</span> / ${tot} GPUs · ${list.length} nodes</span>`;
    grp.appendChild(gh);
    const nd=ce("div","nodes"); for(const n of list) nd.appendChild(nodeCard(n));
    grp.appendChild(nd); body.appendChild(grp);
  }
}
function nodeCard(n){
  const stale=!n.grabbable && n.free>0;   // idle GPUs you cannot actually get
  const c=ce("div","node "+(n.usable_by_me?"mine":"notmine")+(n.free===0?" full":"")+(stale?" stale":"")+(n.drain?" drain":""));
  let tag="";
  if(n.drain) tag=`<span class="ntag drain" title="${esc((n.state||[]).join("+"))}">draining</span>`;
  else if(n.reserved&&!n.reserved_for_me) tag=`<span class="ntag resv" title="${esc(n.reservation||"")}">reserved 🔒</span>`;
  else if(n.reserved_for_me) tag=`<span class="ntag resvme" title="需 --reservation=${esc(n.reservation||"")}">resv✓</span>`;
  else if(n.planned&&n.free>0) tag=`<span class="ntag planned" title="空卡已被 backfill 预留给更高优先级排队任务">planned</span>`;
  const top=ce("div","node-top");
  top.innerHTML=`<span class="node-name">${n.name}</span>`+(n.usable_by_me?"":'<span class="lock" title="无可用分区">🔒</span>')+tag;
  c.appendChild(top);
  // map GPU index -> occupying job (exact IDX from gres_detail when available)
  const owner={}; let haveIdx=false;
  for(const o of n.occupants||[]) for(const ix of (o.gpu_idxs||[])){ owner[ix]=o; haveIdx=true; }
  const cells=ce("div","cells"); let gi=0;
  for(const pt of n.per_type) for(let i=0;i<pt.total;i++,gi++){
    const o=owner[gi];
    const used=haveIdx?(o!==undefined):(i<pt.used);
    const cls=used?"":(n.grabbable?" free":" idle");
    const cell=ce("span","cell"+cls);
    cell.title=used
      ?`${pt.type} #${gi} — ${o?`${o.user} · ${o.job_id} ${o.name}`:"used"}`
      :`${pt.type} #${gi} ${n.grabbable?"free":"idle — 不可用("+(n.drain?"draining":n.reserved?"reserved":"")+")"}`;
    cells.appendChild(cell);
  }
  c.appendChild(cells);
  const meta=ce("div","node-meta");
  if(stale) meta.innerHTML=`<span>${n.used}/${n.total} used</span><span class="muted">${n.free} idle · 0 可抢</span>`;
  else meta.innerHTML=`<span>${n.used}/${n.total} used</span><span class="nf">${n.free_grabbable} free${n.planned&&n.free?" ⚠":""}</span>`;
  c.appendChild(meta);
  c.addEventListener("dragover",e=>{ if(window.__drag){ e.preventDefault(); c.classList.add("drop"); }});
  c.addEventListener("dragleave",()=>c.classList.remove("drop"));
  c.addEventListener("drop",e=>{ e.preventDefault(); c.classList.remove("drop");
    if(stale && !confirm(`${n.name} 的空卡当前不可抢(${n.drain?"draining":"reserved"}),仍要投过去?`)) return;
    onDropNode(n); });
  c.addEventListener("mouseenter",()=>{ if(!window.__drag) showNodeTip(c,n); });
  c.addEventListener("mouseleave",hideNodeTip);
  c.addEventListener("click",()=>{ hideNodeTip(); openNode(n.name); });
  c.style.cursor="zoom-in";
  return c;
}

// ===========================================================================
// NODE ZOOM-IN
// ===========================================================================
let NODE_OPEN=null;   // node name while the detail modal is open
const jobColor=id=>`hsl(${(id*137.508)%360} 55% 30%)`;
const jobColorB=id=>`hsl(${(id*137.508)%360} 65% 52%)`;
function fmtDur(sec){ if(sec==null||sec<0) return ""; const d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600),m=Math.floor(sec%3600/60);
  return d?`${d}d${h}h`:h?`${h}h${m}m`:`${m}m`; }

function openNode(name){ NODE_OPEN=name; renderNodeModal(); $("#nodeModal").classList.remove("hidden"); }
function closeNode(){ NODE_OPEN=null; $("#nodeModal").classList.add("hidden"); }

function renderNodeModal(){
  if(!NODE_OPEN) return;
  const n=STATE.nodes.find(x=>x.name===NODE_OPEN);
  if(!n){ closeNode(); return; }
  $("#nodeTitle").textContent=n.name;
  $("#nodeLive").textContent="live · "+new Date().toLocaleTimeString();
  // tags
  let tags="";
  if(n.drain) tags+=`<span class="ntag drain">draining</span>`;
  if(n.reserved) tags+=`<span class="ntag ${n.reserved_for_me?"resvme":"resv"}" title="${esc(n.resv_accounts||n.resv_users||"")}">${n.reserved_for_me?"resv✓":"reserved 🔒"} ${esc(n.reservation||"")}</span>`;
  if(n.planned) tags+=`<span class="ntag planned">planned</span>`;
  if(!n.usable_by_me) tags+=`<span class="ntag">no partition 🔒</span>`;
  $("#nodeTags").innerHTML=tags;
  // info: state / partitions / cpu / mem
  const cpuPct=n.cpu_total?Math.round(100*n.cpu_alloc/n.cpu_total):0;
  const memPct=n.mem_total_mb?Math.round(100*n.mem_alloc_mb/n.mem_total_mb):0;
  $("#nodeInfo").innerHTML=
    `<div class="ninfo-row"><span class="muted">state</span> ${esc((n.state||[]).join("+").toLowerCase())}
       <span class="muted" style="margin-left:14px">partitions</span> ${esc((n.partitions||[]).join(", "))}</div>`+
    `<div class="ninfo-row nbar"><span class="muted">CPU</span><div class="pbar"><div class="pfill" style="width:${cpuPct}%"></div></div>
       <span>${n.cpu_alloc}/${n.cpu_total} (${cpuPct}%) · load ${Math.round(n.cpu_load||0)}</span></div>`+
    `<div class="ninfo-row nbar"><span class="muted">MEM</span><div class="pbar"><div class="pfill" style="width:${memPct}%"></div></div>
       <span>${Math.round((n.mem_alloc_mb||0)/1024)}/${Math.round((n.mem_total_mb||0)/1024)}G (${memPct}%)</span></div>`;
  // big gpu grid colored per job
  const owner={}; let haveIdx=false;
  for(const o of n.occupants||[]) for(const ix of (o.gpu_idxs||[])){ owner[ix]=o; haveIdx=true; }
  const grid=$("#nodeGrid"); grid.innerHTML=""; let gi=0;
  for(const pt of n.per_type) for(let i=0;i<pt.total;i++,gi++){
    const o=owner[gi];
    const used=haveIdx?(o!==undefined):(i<pt.used);
    const cell=ce("div","bigcell"+(used?"":(n.grabbable?" bfree":" bidle")));
    if(used&&o){ cell.style.background=jobColor(o.job_id); cell.style.borderColor=jobColorB(o.job_id); }
    cell.innerHTML=`<div class="bidx">${esc(pt.type)} #${gi}</div>`+
      (used?`<div class="buser">${esc(o?o.user:"used")}</div><div class="bjob">${o?`${o.job_id}`:""}</div>`
           :`<div class="buser ${n.grabbable?"freetxt":"idletxt"}">${n.grabbable?"free":"idle"}</div><div class="bjob">${n.grabbable?"可抢":(n.drain?"draining":n.reserved?"reserved":"")}</div>`);
    if(used&&o) cell.title=`${o.user} · ${o.job_id} ${o.name}`;
    grid.appendChild(cell);
  }
  // occupants table
  const occ=n.occupants||[];
  const me=STATE.me;
  const nowSec=Date.now()/1000;
  let html="";
  if(occ.length){
    html=`<div class="nocc-head">运行中任务 (${occ.length})</div>`;
    for(const o of occ){
      const run=o.start_time?fmtDur(nowSec-o.start_time):"";
      const lim=o.time_limit_min?fmtMin(o.time_limit_min):"";
      html+=`<div class="nocc-row">
        <span class="sw" style="background:${jobColorB(o.job_id)}"></span>
        <b class="tuser">${esc(o.user)}</b>
        <span class="jid">${o.job_id}</span>
        <span class="oname" title="${esc(o.name)}">${esc(o.name)}</span>
        <span class="og">${o.gpus?`${o.gpus}×gpu${o.gpu_idxs&&o.gpu_idxs.length?` [${o.gpu_idxs.join(",")}]`:""}`:"cpu"}${o.cpus?` · ${o.cpus}c`:""}</span>
        <span class="muted">${run?`跑了 ${run}`:""}${lim?` / ${lim}`:""}</span>
        <span class="oact" data-job="${o.job_id}" data-name="${esc(o.name)}">${o.user===me?`<button class="btn sm ghost olog">logs</button><button class="btn sm ghost danger ocxl">cancel</button>`:""}</span>
      </div>`;
    }
  } else html=`<div class="empty">没有运行中任务</div>`;
  const box=$("#nodeOcc"); box.innerHTML=html;
  box.querySelectorAll(".olog").forEach(b=>b.onclick=e=>{ const a=e.target.closest(".oact");
    openLog({job_id:+a.dataset.job,id:a.dataset.job,name:a.dataset.name}); });
  box.querySelectorAll(".ocxl").forEach(b=>b.onclick=e=>{ const a=e.target.closest(".oact");
    if(confirm(`scancel ${a.dataset.job}?`)) jobAction(+a.dataset.job,"cancel"); });
  // ---- queue: pending jobs in line for this node (with sprio breakdown) ----
  const q=n.queued||[], qbox=$("#nodeQueue");
  if(!q.length){ qbox.innerHTML=`<div class="nocc-head">排队中 (0)</div><div class="empty">没有排队任务</div>`; }
  else{
    const held=(n.queued_count||q.length)-(n.queued_active??q.length);
    const maxT=Math.max(1,...q.map(p=>(p.sprio&&p.sprio.total)||p.priority||0));
    qbox.innerHTML=`<div class="nocc-head">排队中 · 竞争本节点资源 (${n.queued_count}${held>0?` · ${n.queued_active} 活跃 / ${held} 挂起·依赖`:""})${n.queued_count>q.length?` · 前 ${q.length}`:""}
        <span class="prio-legend"><i style="background:#7c5cff"></i>nice <i style="background:#4f9cf9"></i>age <i style="background:#2ecc71"></i>fair <i style="background:#f5a623"></i>qos</span></div>`+
      q.map((p,i)=>`<div class="nq-item${p.waiting?"":" dim"}">
        <div class="nq-row">
          <span class="qrank">${p.waiting?"#"+(i+1):"·"}</span>
          ${p.pinned?`<span class="qpin" title="--nodelist 指定本节点">📌</span>`:""}
          <b class="tuser">${esc(p.user)}</b>
          <span class="jid">${esc(p.id)}</span>
          <span class="oname" title="${esc(p.name)}">${esc(p.name)}</span>
          <span class="og">${p.gpus}×${esc(p.gpu_type||"gpu")}</span>
          <span class="muted">${esc(p.reason||"")}${p.qos?` · ${esc(p.qos)}`:""}</span>
        </div>
        ${prioBar(p.sprio,p.priority,maxT)}
      </div>`).join("");
  }
}
// stacked priority bar from sprio breakdown; length ∝ total vs queue leader
function prioBar(spr,fallback,maxT){
  const total=(spr&&spr.total)||fallback||0;
  if(!total) return "";
  const segs=[["nice",spr?spr.nice_boost:0,"#7c5cff"],["age",spr?spr.age:0,"#4f9cf9"],
              ["fair",spr?spr.fairshare:0,"#2ecc71"],["qos",spr?spr.qos:0,"#f5a623"],
              ["part",spr?spr.partition:0,"#5a6573"]].filter(s=>s[1]>0);
  const sum=segs.reduce((s,x)=>s+x[1],0)||total;
  const wpct=Math.max(3,Math.round(100*total/maxT));
  const inner=segs.map(([k,v,c])=>`<span class="ps" style="width:${Math.round(100*v/sum)}%;background:${c}"></span>`).join("");
  const fmt=x=>x.toLocaleString();
  const tip=`总 ${fmt(total)}`+(spr?` = ${spr.nice_boost?`nice +${fmt(spr.nice_boost)} · `:""}age ${fmt(spr.age)} · fair ${fmt(spr.fairshare)} · qos ${fmt(spr.qos)}${spr.partition?` · part ${fmt(spr.partition)}`:""}`:"");
  return `<div class="prio-wrap" title="${tip}"><div class="pbar2" style="width:${wpct}%">${inner}</div><span class="ptot">${fmt(total)}</span></div>`;
}

function showNodeTip(card,n){
  const tip=$("#tip");
  let html=`<div class="flag">${esc(n.name)} · ${esc((n.state||[]).join("+").toLowerCase())}</div>`;
  if(n.reserved){
    const who=[n.resv_accounts&&`accounts: ${n.resv_accounts}`,n.resv_users&&`users: ${n.resv_users}`].filter(Boolean).join(" · ");
    html+=`<div class="trow resv">🔒 reservation <b>${esc(n.reservation||"")}</b>${n.reserved_for_me?" (含你)":""}${who?`<div class="tsub">${esc(who)}</div>`:""}</div>`;
  }
  const occ=n.occupants||[];
  if(occ.length){
    const rows=occ.slice(0,10).map(o=>
      `<div class="trow"><b class="tuser">${esc(o.user)}</b> · ${o.job_id} ${esc(o.name)}`+
      `<span class="tg">${o.gpus?` ${o.gpus}×gpu${o.gpu_idxs&&o.gpu_idxs.length?` [${o.gpu_idxs.join(",")}]`:""}`:" (cpu)"}</span></div>`).join("");
    html+=rows+(occ.length>10?`<div class="tsub">… +${occ.length-10} more</div>`:"");
  } else if(!n.reserved) html+=`<div class="tsub">无运行中任务</div>`;
  if(n.queued_count){
    const top=(n.queued||[]).filter(q=>q.waiting).slice(0,3)
      .map(q=>`${esc(q.user)} (${q.gpus}×${esc(q.gpu_type||"gpu")}${q.pinned?" 📌":""})`).join(", ");
    html+=`<div class="trow qrow">⏳ 排队 ${n.queued_active||0} 活跃${n.queued_count>(n.queued_active||0)?` / ${n.queued_count} 总`:""}${top?`<div class="tsub">${top}${(n.queued_active||0)>3?" …":""}</div>`:""}</div>`;
  }
  html+=`<div class="tsub">点击查看节点详情 →</div>`;
  tip.innerHTML=html;
  tip.style.maxWidth="380px";
  tip.classList.remove("hidden");
  const r=card.getBoundingClientRect(), tw=Math.min(380,tip.offsetWidth||320);
  tip.style.left=Math.max(8,Math.min(r.left,window.innerWidth-tw-12))+"px";
  tip.style.top=(r.bottom+6+(tip.offsetHeight||0)>window.innerHeight?r.top-tip.offsetHeight-6:r.bottom+6)+"px";
}
function hideNodeTip(){ const tip=$("#tip"); tip.classList.add("hidden"); tip.style.maxWidth=""; }
async function onDropNode(node){
  const d=window.__drag; if(!d) return;
  if(d.type==="job"){
    const j=d.job;
    if(!confirm(`make-before-break 迁移任务 ${j.id} → ${node.name}?\n会克隆一份钉到该节点,等它 RUNNING 再取消原任务。`)) return;
    try{ await api.post("/api/migrate",{src_job_id:j.job_id,target_node:node.name,mode:"clone"});
      toast(`已发起迁移 → ${node.name}`,"good"); switchTab("migrations"); loadMigrations(); }
    catch(e){ toast("迁移失败: "+e.message,"bad"); }
  } else if(d.type==="draft"){
    await api.post(`/api/drafts/${d.draft.id}`,{nodelist:node.name,gpu_type:node.gpu_types[0]});
    toast(`草稿锁定到 ${node.name}`,"good"); loadDrafts();
  }
}

// ===========================================================================
// JOBS (management)
// ===========================================================================
function liveJobs(){ return STATE.jobs.filter(j=>!TERMINAL.has(j.state)&&!FINISHED.has(String(j.id))); }
let FOLD_CLOSED=new Set(JSON.parse(localStorage.gpuvizFoldClosed||"[]"));
function saveFold(){ localStorage.gpuvizFoldClosed=JSON.stringify([...FOLD_CLOSED]); }
function renderJobs(){
  const body=$("#jobsBody"); const list=liveJobs(); $("#jobsCount").textContent=list.length;
  body.innerHTML="";
  const folders=[...new Set([...(STATE.folders||[]),...list.map(j=>j.folder).filter(Boolean)])];
  if(!folders.length&&!list.length){ body.innerHTML='<div class="empty">没有运行/排队任务</div>'; return; }
  if(!folders.length){ for(const j of list) body.appendChild(jobCard(j)); return; }  // 没建过文件夹 → 保持平铺
  const by={}, loose=[];
  for(const j of list){ if(j.folder) (by[j.folder]=by[j.folder]||[]).push(j); else loose.push(j); }
  for(const f of folders) body.appendChild(folderSection(f,by[f]||[]));
  body.appendChild(folderSection(null,loose));
}
function folderSection(name,jobs){
  const label=name||"未分组";
  const sec=ce("section","folder"+(name&&FOLD_CLOSED.has(name)?" closed":""));
  const head=ce("div","folder-head");
  const gpuSum=jobs.reduce((s,j)=>s+(j.gpus||0),0);
  head.innerHTML=`<span class="caret">▾</span><span class="fname">${esc(label)}</span><span class="pill">${jobs.length}</span>`+
    (gpuSum?`<span class="fsum">${gpuSum} GPU</span>`:"")+`<span class="fspace"></span>`;
  if(name){
    const ren=btn("✎","sm ghost",e=>{ e.stopPropagation(); const nn=(prompt(`重命名文件夹「${name}」为:`,name)||"").trim();
      if(nn&&nn!==name) api.post("/api/groups/rename",{old:name,new:nn}).then(refresh).catch(er=>toast(er.message,"bad")); });
    ren.title="重命名";
    const del=btn("✕","sm ghost danger",e=>{ e.stopPropagation();
      if(confirm(`删除文件夹「${name}」?任务回到未分组,不影响 Slurm 任务本身。`))
        api.del(`/api/groups/${encodeURIComponent(name)}`).then(refresh).catch(er=>toast(er.message,"bad")); });
    del.title="删除文件夹";
    head.appendChild(ren); head.appendChild(del);
    head.onclick=()=>{ FOLD_CLOSED.has(name)?FOLD_CLOSED.delete(name):FOLD_CLOSED.add(name); saveFold(); renderJobs(); };
  }
  head.addEventListener("dragover",e=>{ const d=window.__drag; if(d&&(d.type==="job"||d.type==="draft")){ e.preventDefault(); head.classList.add("drop"); }});
  head.addEventListener("dragleave",()=>head.classList.remove("drop"));
  head.addEventListener("drop",async e=>{ e.preventDefault(); head.classList.remove("drop"); const d=window.__drag; if(!d) return;
    try{
      if(d.type==="job"){ await api.post("/api/groups/assign",{job_id:d.job.job_id,name:d.job.name,folder:name||""}); toast(`${d.job.id} → ${label}`,"good"); refresh(); }
      else if(d.type==="draft"){ await api.post(`/api/drafts/${d.draft.id}`,{project:name||""}); toast(`草稿「${d.draft.name}」→ ${label}`,"good"); loadDrafts(); }
    }catch(er){ toast(er.message,"bad"); }
  });
  sec.appendChild(head);
  const bd=ce("div","folder-body");
  if(!jobs.length) bd.innerHTML='<div class="empty sm">空 — 拖任务卡到标题归类</div>';
  else for(const j of jobs) bd.appendChild(jobCard(j));
  sec.appendChild(bd);
  return sec;
}
function jobCard(j){
  const c=ce("div","card");
  c.draggable=true;
  c.addEventListener("dragstart",()=>{window.__drag={type:"job",job:j};});
  c.addEventListener("dragend",()=>{window.__drag=null;});
  const sc=["RUNNING","PENDING"].includes(j.state)?j.state:"OTHER";
  const top=ce("div","card-top");
  top.innerHTML=`<span class="jid">${j.id}</span><span class="jname" title="${esc(j.name)}">${esc(j.name)}</span>`+
    (j.origin?`<span class="origin" title="from ${esc(j.origin.project)}">${esc(j.origin.job_key)}</span>`:"")+
    `<span class="state ${sc}">${j.state}</span>`;
  c.appendChild(top);
  const meta=ce("div","card-meta");
  const gpu=j.gpus?`<span class="gchip">${j.gpus}×${j.gpu_type||"gpu"}</span>`:"";
  const where=j.state==="RUNNING"?`@ ${j.nodes}`:`<span class="reason">${esc(j.reason||"")}</span>`;
  meta.innerHTML=`${gpu}<span>${j.partition||""}${j.time_limit_min?" · "+fmtMin(j.time_limit_min):""}</span><span>${where}</span>`;
  c.appendChild(meta);
  const act=ce("div","card-actions");
  act.appendChild(btn("info","sm ghost",()=>openJobInfo(j)));
  act.appendChild(btn("logs","sm ghost",()=>openLog(j)));
  if(j.state==="PENDING"){
    act.appendChild(btn("hold","sm ghost",()=>jobAction(j.job_id,"hold")));
    act.appendChild(btn("release","sm ghost",()=>jobAction(j.job_id,"release")));
    act.appendChild(btn("edit","sm ghost",()=>editPending(j)));
  }
  if(j.state==="RUNNING") act.appendChild(btn("swap→","sm ghost",(e)=>openSwap(e.target,j)));
  act.appendChild(btn("cancel","sm ghost danger",()=>{ if(confirm(`scancel ${j.id}?`)) jobAction(j.job_id,"cancel"); }));
  c.appendChild(act);
  return c;
}
async function jobAction(id,action){ try{ await api.post(`/api/jobs/${id}/${action}`,{}); toast(`${action} ${id} ✓`,"good"); refresh(); } catch(e){ toast(`${action} 失败: ${e.message}`,"bad"); } }
function editPending(j){
  const v=prompt(`修改排队任务 ${j.id}(scontrol update)\nkey=value 逗号分隔,如 TimeLimit=4:00:00,NumNodes=1`,`TimeLimit=${fmtMin(j.time_limit_min)}`);
  if(!v) return; const fields={};
  for(const part of v.split(",")){ const i=part.indexOf("="); if(i>0) fields[part.slice(0,i).trim()]=part.slice(i+1).trim(); }
  api.post(`/api/jobs/${j.job_id}/update`,fields).then(()=>{toast("updated ✓","good");refresh();}).catch(e=>toast("update 失败: "+e.message,"bad"));
}
// job info modal: everything squeue knows about one job (live while open)
let JOB_INFO_OPEN=null, JOB_INFO_SNAP=null;   // id string + last snapshot (kept if job leaves squeue)
function fmtTs(sec){ return sec?new Date(sec*1000).toLocaleString("sv-SE"):""; }
function openJobInfo(j){ JOB_INFO_OPEN=String(j.id); JOB_INFO_SNAP=j; renderJobInfo(); $("#jobInfoModal").classList.remove("hidden"); }
function closeJobInfo(){ JOB_INFO_OPEN=null; JOB_INFO_SNAP=null; $("#jobInfoModal").classList.add("hidden"); }
function renderJobInfo(){
  if(!JOB_INFO_OPEN) return;
  const live=STATE.jobs.find(x=>String(x.id)===JOB_INFO_OPEN);
  const j=live||JOB_INFO_SNAP; if(!j) return;
  if(live) JOB_INFO_SNAP=live;
  $("#jobInfoTitle").textContent=`${j.id} · ${j.name||""}`;
  $("#jobInfoLive").textContent=live?"实时(随轮询刷新)":"任务已不在队列,显示最后快照";
  const nowSec=Date.now()/1000;
  const rows=[];
  const add=(k,v)=>{ if(v!==""&&v!=null) rows.push(`<span class="k">${k}</span><span class="v">${v}</span>`); };
  const sep=()=>rows.push('<span class="sep"></span>');
  add("Job ID",esc(j.id));
  add("名称",esc(j.name||""));
  add("用户",esc(STATE.me||""));
  add("状态",`${esc(j.state)}${j.state_full&&j.state_full.length>1?" ("+esc(j.state_full.join(","))+")":""}`);
  sep();
  add("分区",esc(j.partition||""));
  add("QoS",esc(j.qos||""));
  add("账户",esc(j.account||""));
  add("GPU",j.gpus?`${j.gpus} × ${esc(j.gpu_type||"gpu")}`:"无");
  add("节点数",j.node_count);
  if(j.nodes) add("节点",esc(j.nodes));
  sep();
  if(j.state==="RUNNING"&&j.start_time){
    add("开始时间",fmtTs(j.start_time));
    add("已运行",fmtDur(Math.floor(nowSec-j.start_time)));
    if(j.time_limit_min) add("剩余时间",fmtDur(Math.max(0,j.start_time+j.time_limit_min*60-nowSec)));
  }
  if(j.state==="PENDING"){
    add("预计开始",j.start_time?fmtTs(j.start_time):"未知(调度器尚未给出)");
    add("排队原因",esc(j.reason||""));
    add("已等待",j.submit_time?fmtDur(Math.floor(nowSec-j.submit_time)):"");
  }
  add("时限",fmtMin(j.time_limit_min));
  add("提交时间",fmtTs(j.submit_time));
  sep();
  add("工作目录",esc(j.workdir||""));
  add("命令",esc(j.command||""));
  $("#jobInfoBody").innerHTML=rows.join("");
}
// handoff: replace a running job with a job template on the same node (make-before-break)
function openSwap(anchor,j){
  if(FINISHED.has(String(j.id))||TERMINAL.has(j.state)){ toast(`${j.id} 已结束,无法 swap`,"bad"); return; }
  const items=DRAFTS.map(d=>({label:`${d.name||"job"} · ${d.gpus}×${d.gpu_type||"gpu"}${d.project?" ["+d.project+"]":""}`,did:d.id}));
  if(!items.length){ toast("没有任务模板可接管 — 先在 Templates 里建一个","bad"); return; }
  popMenu(anchor,items,async it=>{
    if(!confirm(`make-before-break:在 ${j.nodes} 上用「${it.label}」接管 ${j.id}?\n新任务 RUNNING 后才取消旧的(模板的 nodelist 会被钉到该节点)。`)) return;
    try{ await api.post("/api/migrate",{mode:"handoff",src_job_id:j.job_id,target_node:j.nodes,draft_id:it.did});
      toast(`已发起接管 → ${j.nodes}`,"good"); switchTab("migrations"); loadMigrations(); }
    catch(e){ toast("接管失败: "+e.message,"bad"); }
  });
}
function popMenu(anchor,items,onPick){
  const old=$("#popmenu"); if(old) old.remove();
  const m=ce("div"); m.id="popmenu"; m.className="tip";
  m.style.maxWidth="320px"; m.style.pointerEvents="auto";
  for(const it of items){ const b=ce("div"); b.style.cssText="padding:5px 6px;cursor:pointer;border-radius:4px";
    b.textContent=it.label; b.onmouseover=()=>b.style.background="#1c2230"; b.onmouseout=()=>b.style.background="";
    b.onclick=()=>{m.remove();onPick(it);}; m.appendChild(b); }
  document.body.appendChild(m);
  const r=anchor.getBoundingClientRect(); m.style.left=Math.min(r.left,window.innerWidth-330)+"px"; m.style.top=(r.bottom+5)+"px"; m.classList.remove("hidden");
  setTimeout(()=>document.addEventListener("click",function h(){ m.remove(); document.removeEventListener("click",h); },{once:true}),0);
}

// ===========================================================================
// FINISHED (terminal jobs, auto-expiring)
// ===========================================================================
// Two sources: sacct via /api/state (authoritative final state + exit code),
// and jobs that silently vanish from squeue before accounting catches up.
function finAdd(key,rec){
  key=String(key);
  if(FIN_GONE.has(key)) return;
  const now=Date.now(), prev=FINISHED.get(key)||{};
  // clamp: a browser clock ahead of the controller must not expire cards instantly
  const endedAt=Math.min(rec.end_time?rec.end_time*1000:(prev.endedAt||now),now);
  FINISHED.set(key,{...prev,...rec,key,endedAt,firstSeen:prev.firstSeen||now});
}
const finExpiry=f=>Math.max(f.endedAt+FIN_TTL_MS,f.firstSeen+15000);
function ingestFinished(){
  for(const r of STATE.finished||[]) finAdd(r.id,r);
  const live=new Set(STATE.jobs.map(j=>String(j.id)));
  for(const j of STATE.jobs) if(TERMINAL.has(j.state)) finAdd(j.id,{...j,state_detail:j.state});
  for(const [k,j] of LAST_JOBS){          // gone from squeue and not in sacct yet
    if(live.has(k)||FINISHED.has(k)||FIN_GONE.has(k)) continue;
    finAdd(k,{...j,state:"ENDED",state_detail:"ENDED · 已离开 squeue",
      elapsed_s:j.start_time?Math.floor(Date.now()/1000-j.start_time):null});
  }
  LAST_JOBS=new Map(STATE.jobs.filter(j=>!TERMINAL.has(j.state)).map(j=>[String(j.id),j]));
}
function pruneFinished(){
  const now=Date.now(); let changed=false;
  for(const [k,f] of FINISHED) if(!f.fixed&&now>=finExpiry(f)){ FINISHED.delete(k); FIN_GONE.add(k); changed=true; }
  return changed;
}
function finLeft(f){ return f.fixed?"已固定,不会自动清除":Math.max(0,Math.ceil((finExpiry(f)-Date.now())/1000))+"s 后清除"; }
function finCls(s){ return s==="COMPLETED"?"DONE":(s==="CANCELLED"||s==="ENDED")?"OTHER":"FAIL"; }
function renderFinished(){
  pruneFinished();
  const rows=[...FINISHED.values()].sort((a,b)=>b.endedAt-a.endedAt);
  $("#finCount").textContent=rows.length||"";
  const body=$("#finishedBody");
  if(!rows.length){ body.innerHTML='<div class="empty">最近 3 分钟没有结束的任务</div>'; return; }
  body.innerHTML=""; for(const f of rows) body.appendChild(finishedCard(f));
}
function finishedCard(f){
  const cls=finCls(f.state);
  const c=ce("div","card finished "+cls.toLowerCase());
  c.dataset.fin=f.key;
  const top=ce("div","card-top");
  top.innerHTML=`<span class="jid">${esc(f.id)}</span><span class="jname" title="${esc(f.name)}">${esc(f.name)}</span>`+
    (f.origin?`<span class="origin" title="from ${esc(f.origin.project)}">${esc(f.origin.job_key)}</span>`:"")+
    `<span class="state ${cls}" title="${esc(f.state_detail||f.state)}">${esc(f.state)}</span>`;
  c.appendChild(top);
  const meta=ce("div","card-meta");
  meta.innerHTML=(f.gpus?`<span class="gchip">${f.gpus}×${esc(f.gpu_type||"gpu")}</span>`:"")+
    `<span>${esc(f.partition||"")}${f.elapsed_s!=null?" · 跑了 "+fmtDur(f.elapsed_s):""}</span>`+
    (f.nodes?`<span>@ ${esc(f.nodes)}</span>`:"")+
    (f.exit_code?`<span class="reason">exit ${f.exit_code}${f.signal?":"+f.signal:""}</span>`:"")+
    `<span class="muted fincd">${finLeft(f)}</span>`;
  c.appendChild(meta);
  const act=ce("div","card-actions");
  act.appendChild(btn("logs","sm ghost",()=>openLog({job_id:f.job_id,id:f.id,name:f.name})));
  const fx=btn(f.fixed?"unfix":"fix","sm ghost"+(f.fixed?" stopon":""),()=>{
    f.fixed=!f.fixed;
    if(!f.fixed) f.firstSeen=Date.now();   // unfix 后至少留 15s,避免瞬间消失
    renderFinished();
  });
  fx.title=f.fixed?"取消固定,恢复 3 分钟后自动清除":"固定此任务,不再 3 分钟后自动清除";
  act.appendChild(fx);
  const sw=btn("swap→","sm ghost off",()=>{});
  sw.disabled=true; sw.title="任务已结束,无法再 swap / 接管";
  act.appendChild(sw);
  act.appendChild(btn("dismiss","sm ghost",()=>{ FIN_GONE.add(f.key); FINISHED.delete(f.key); renderFinished(); renderJobs(); }));
  c.appendChild(act);
  return c;
}
function tickFinished(){
  if(pruneFinished()){ renderFinished(); return; }
  if($("#tab-finished").classList.contains("hidden")) return;
  for(const el of document.querySelectorAll("#finishedBody .card[data-fin]")){
    const f=FINISHED.get(el.dataset.fin), s=el.querySelector(".fincd");
    if(f&&s) s.textContent=finLeft(f);
  }
}

// ===========================================================================
// MIGRATIONS
// ===========================================================================
let TRANSFERS=[], MONITORS=[];
async function loadMigrations(){
  const [mr,tr,mo]=await Promise.all([api.get("/api/migrations"),api.get("/api/transfers"),api.get("/api/monitors")]);
  MIGRATIONS=mr.migrations; TRANSFERS=tr.transfers; MONITORS=mo.monitors;
  const act=MIGRATIONS.filter(m=>["submitting","waiting","swapping"].includes(m.state)).length
    +TRANSFERS.filter(t=>t.state==="running").length
    +MONITORS.filter(m=>m.status==="running").length;
  $("#migCount").textContent=act||"";
  renderActivity(); renderMigBar();
}
function renderMigBar(){
  const am=MIGRATIONS.filter(m=>["submitting","waiting","swapping"].includes(m.state));
  const at=TRANSFERS.filter(t=>t.state==="running");
  const ao=MONITORS.filter(m=>m.status==="running");
  const bar=$("#migBar");
  if(!am.length&&!at.length&&!ao.length){ bar.classList.add("hidden"); bar.innerHTML=""; return; }
  bar.classList.remove("hidden"); bar.innerHTML="";
  for(const m of am){ const p=ce("div","migpill "+m.state);
    p.innerHTML=`<span class="dot"></span><span>${esc(m.label||("→"+m.target_node))}</span><span class="muted">${m.state}${m.new_job_id?" · job "+m.new_job_id:""}</span>`;
    p.appendChild(btn("abort","ghost sm",()=>abortMig(m.id))); bar.appendChild(p); }
  for(const t of at){ const p=ce("div","migpill swapping");
    p.innerHTML=`<span class="dot"></span><span>⇄ ${esc(t.dst.split("/").pop())}</span><span class="muted">${t.percent}% ${esc(t.rate||"")}</span>`;
    p.appendChild(btn("abort","ghost sm",()=>abortTransfer(t.id))); bar.appendChild(p); }
  for(const m of ao){ const p=ce("div","migpill "+(m.stale?"failed":"swapping"));
    p.innerHTML=`<span class="dot"></span><span>📡 ${esc(m.label||m.key)}</span><span class="muted">${m.percent!=null?m.percent+"%":""}${m.stale?" stale":""}</span>`;
    bar.appendChild(p); }
}
function renderActivity(){
  const body=$("#migrationsBody"); body.innerHTML="";
  if(!MIGRATIONS.length&&!TRANSFERS.length&&!MONITORS.length){ body.innerHTML='<div class="empty">没有迁移 / 传输 / 外部监控</div>'; return; }
  for(const m of MONITORS){
    const c=ce("div","card monitor"+(m.stale?" stale":""));
    const st=m.stale?"stale":m.status;
    const cls=m.status==="done"?"RUNNING":m.status==="failed"||m.stale?"OTHER":"PENDING";
    const top=ce("div","card-top");
    top.innerHTML=`<span class="state ${cls}">📡 ${esc(st)}</span><span class="jname" title="${esc(m.key)}">${esc(m.label||m.key)}</span>`+
      (m.repo?`<span class="origin">${esc(m.repo)}</span>`:"");
    c.appendChild(top);
    if(m.percent!=null){ const bar=ce("div","pbar"); const fill=ce("div","pfill"); fill.style.width=m.percent+"%"; bar.appendChild(fill); c.appendChild(bar); }
    const meta=ce("div","card-meta");
    meta.innerHTML=`<span>${m.percent!=null?m.percent+"%":esc(m.kind||"custom")}</span>`+
      (m.job_id?`<span>job ${esc(String(m.job_id))}</span>`:"")+(m.node?`<span>@${esc(m.node)}</span>`:"")+
      `<span class="muted">${m.age_s!=null?fmtAge(m.age_s):""}${m.stale?" · 无更新":""}</span>`;
    c.appendChild(meta);
    if(m.message){ const l=ce("div","deplist"); l.textContent=m.message; c.appendChild(l); }
    const a=ce("div","card-actions"); a.appendChild(btn("dismiss","sm ghost",async()=>{ await api.del(`/api/monitors/${encodeURIComponent(m.key)}`); loadMigrations(); })); c.appendChild(a);
    body.appendChild(c);
  }
  if(!MIGRATIONS.length&&!TRANSFERS.length) return;
  for(const m of MIGRATIONS){
    const c=ce("div","card");
    const top=ce("div","card-top");
    top.innerHTML=`<span class="state ${m.state==="done"?"RUNNING":m.state==="waiting"?"PENDING":"OTHER"}">${m.state}</span><span class="jname">${esc(m.label||"")}</span>`;
    c.appendChild(top);
    const waitS=m.created_at?Math.max(0,Math.floor(Date.now()/1000-m.created_at)):null;
    const toS=m.timeout_s||0;
    const meta=ce("div","card-meta"); meta.innerHTML=`<span>src ${m.src_job_id}</span>${m.new_job_id?`<span>new ${m.new_job_id}</span>`:""}<span>→ ${m.target_node}</span>`+
      (m.state==="waiting"&&waitS!=null?`<span class="muted">等待 ${fmtDur(waitS)}${toS?` / 上限 ${fmtDur(toS)}`:""}</span>`:"");
    c.appendChild(meta);
    const log=ce("div","deplist"); log.textContent=m.log&&m.log.length?m.log[m.log.length-1].msg:""; c.appendChild(log);
    if(["submitting","waiting","swapping"].includes(m.state)){ const a=ce("div","card-actions"); a.appendChild(btn("abort","sm ghost danger",()=>abortMig(m.id))); c.appendChild(a); }
    body.appendChild(c);
  }
  for(const t of TRANSFERS){
    const c=ce("div","card");
    const top=ce("div","card-top");
    top.innerHTML=`<span class="state ${t.state==="done"?"RUNNING":t.state==="running"?"PENDING":"OTHER"}">⇄ ${t.state}</span><span class="jname">${esc(t.src)}</span>`;
    c.appendChild(top);
    const bar=ce("div","pbar"); const fill=ce("div","pfill"); fill.style.width=t.percent+"%"; bar.appendChild(fill); c.appendChild(bar);
    const meta=ce("div","card-meta"); meta.innerHTML=`<span>${t.percent}% ${esc(t.rate||"")}</span><span>→ ${esc(t.dst)}</span>`; c.appendChild(meta);
    if(t.line){ const l=ce("div","deplist"); l.textContent=t.line; c.appendChild(l); }
    if(t.state==="running"){ const a=ce("div","card-actions"); a.appendChild(btn("abort","sm ghost danger",()=>abortTransfer(t.id))); c.appendChild(a); }
    body.appendChild(c);
  }
}
async function abortMig(id){ try{ await api.post(`/api/migrations/${id}/abort`,{}); toast("已中止迁移(保留原任务)","good"); loadMigrations(); } catch(e){ toast(e.message,"bad"); } }
async function abortTransfer(id){ try{ await api.post(`/api/transfers/${id}/abort`,{}); toast("已中止传输","good"); loadMigrations(); } catch(e){ toast(e.message,"bad"); } }

// ===========================================================================
// LOG VIEWER
// ===========================================================================
let LOG={job:null,stream:"out",timer:null,data:null,stopped:false};
function setLogStopped(v){
  const was=LOG.stopped; LOG.stopped=v;
  $("#logStop").classList.toggle("stopon",v);
  $("#logStop").title=v?"已暂停更新,点击恢复":"暂停/恢复日志内容更新";
  if(was&&!v) fetchLog();   // resume: catch up immediately instead of waiting for the next tick
}
async function openLog(j){
  LOG.job=j; LOG.stream="out"; setLogStopped(false);
  $("#logTitle").textContent=`${j.id} · ${j.name}`;
  document.querySelectorAll(".ltab").forEach(t=>t.classList.toggle("active",t.dataset.stream==="out"));
  $("#logModal").classList.remove("hidden");
  await fetchLog(); startLogFollow();
}
async function fetchLog(){
  try{ LOG.data=await api.get(`/api/jobs/${LOG.job.job_id}/log`); }catch(e){ $("#logPre").textContent="读取失败: "+e.message; return; }
  renderLog();
}
function renderLog(){
  const d=LOG.data; if(!d) return;
  const errDisabled=!d.err;
  const eb=document.querySelector('.ltab[data-stream="err"]'); eb.style.opacity=errDisabled?.4:1; eb.style.pointerEvents=errDisabled?"none":"auto";
  const s=LOG.stream==="err"?d.err:d.out;
  const pre=$("#logPre");
  const follow=$("#logFollow").checked;
  if(!s){ pre.textContent="(无)"; $("#logMeta").textContent=""; return; }
  $("#logMeta").textContent=`${s.path||""}  ·  ${fmtBytes(s.size)}${s.truncated?"  · 仅显示末尾":""}${s.exists?"":"  · 文件尚未生成"}`;
  pre.textContent=s.text||(s.exists?"(空)":"(等待日志生成…)");
  if(follow) pre.scrollTop=pre.scrollHeight;
}
function startLogFollow(){ stopLogFollow(); LOG.timer=setInterval(()=>{ if(!LOG.stopped&&$("#logFollow").checked) fetchLog(); },3000); }
function stopLogFollow(){ if(LOG.timer) clearInterval(LOG.timer); LOG.timer=null; }
function closeLog(){ $("#logModal").classList.add("hidden"); stopLogFollow(); LOG.job=null; }

// ===========================================================================
// JOB TEMPLATES (the submit path)
// ===========================================================================
async function loadDrafts(){ DRAFTS=(await api.get("/api/drafts")).drafts; renderDrafts(); }
function renderDrafts(){
  const body=$("#draftsBody"); $("#draftsCount").textContent=DRAFTS.length||"";
  if(!DRAFTS.length){ body.innerHTML='<div class="empty">还没有任务模板。点 + New 写一个,提交后可重复使用。</div>'; return; }
  body.innerHTML="";
  for(const d of DRAFTS){
    const c=ce("div","card draft"+(d.kind==="holder"?" holder":""));
    c.draggable=true; c.addEventListener("dragstart",()=>{window.__drag={type:"draft",draft:d};}); c.addEventListener("dragend",()=>{window.__drag=null;});
    const n=Math.max(1,Math.min(8,+d.gpus||1));
    const top=ce("div","card-top");
    top.innerHTML=`<span class="gpublock">${"<i></i>".repeat(n)}</span><span class="jname">${esc(d.name)}</span>`+
      (d.project?`<span class="origin" title="project 文件夹">${esc(d.project)}</span>`:"")+
      `${d.submitted_job_id?`<span class="state RUNNING">→ ${d.submitted_job_id}</span>`:""}`;
    c.appendChild(top);
    const meta=ce("div","card-meta"); meta.innerHTML=`<span>${d.gpus}×${d.gpu_type||"gpu"}</span><span>${d.partition||""} · ${d.time||""}</span>${d.nodelist?`<span>📍${d.nodelist}</span>`:""}`;
    c.appendChild(meta);
    const act=ce("div","card-actions");
    act.appendChild(btn("edit","sm ghost",()=>openEditor(d)));
    act.appendChild(btn("clone","sm ghost",()=>cloneDraft(d)));
    act.appendChild(btn("submit","sm primary",()=>submitDraft(d)));
    act.appendChild(btn("delete","sm ghost danger",()=>delDraft(d)));
    c.appendChild(act); body.appendChild(c);
  }
}
async function submitDraft(d){ if(!confirm(`提交「${d.name}」?`)) return; try{ const r=await api.post(`/api/drafts/${d.id}/submit`,{}); toast(`已提交 ✓ job ${r.job_id}`,"good"); loadDrafts(); refresh(); }catch(e){ toast("提交失败: "+e.message,"bad"); } }
async function delDraft(d){ if(!confirm(`删除「${d.name}」?`)) return; await api.del(`/api/drafts/${d.id}`); loadDrafts(); }
async function cloneDraft(d){
  const {id,submitted_job_id,...rest}=d;
  const copy=(await api.post("/api/drafts",{...rest,name:(d.name||"job")+"-copy"})).draft;
  await loadDrafts(); openEditor(copy);
}

// job template editor (full sbatch fields)
const FIELDS=[["name","Name","text"],["project","Project","proj"],["gpus","GPUs","number"],["gpu_type","GPU type","gtype"],["nodes","Nodes","number"],
  ["cpus","CPUs","number"],["mem","Mem","text"],["time","Time","text"],["partition","Partition","text"],
  ["qos","QOS","qos"],["nodelist","Nodelist","text"],["workdir","Workdir","text",1],
  ["output","Output","text",1],["script","Script","textarea",1]];
let editing=null,prevTimer=null;
function openEditor(d){ editing={...d}; $("#modalTitle").textContent=`Edit ${d.name||""}`; $("#modalErr").textContent="";
  const f=$("#draftForm"); f.innerHTML="";
  for(const [k,label,t,full] of FIELDS){ const w=ce("div","field"+(full?" full":"")); const lab=ce("label"); lab.textContent=label;
    const q=ce("span","q"); q.textContent="?"; q.dataset.help=k; lab.appendChild(q); w.appendChild(lab);
    let inp;
    if(t==="textarea") inp=ce("textarea");
    else if(t==="qos"){ inp=ce("select");
      const cur=editing[k]||"", known=QOS.some(qq=>qq.name===cur);
      inp.innerHTML='<option value="">(default)</option>'+
        QOS.map(qq=>`<option value="${qq.name}">${qq.name} · prio ${qq.priority_pct}%${qq.can_preempt?" ⚡":""}</option>`).join("")+
        (cur&&!known?`<option value="${esc(cur)}">${esc(cur)} (已保存)</option>`:""); }
    else if(t==="gtype"){ inp=ce("input"); inp.setAttribute("list","gtypes2"); inp.placeholder="任意"; }
    else if(t==="proj"){ inp=ce("input"); inp.setAttribute("list","projlist"); inp.placeholder="(未分组)"; }
    else { inp=ce("input"); inp.type=t==="number"?"number":"text"; }
    inp.id="f_"+k; inp.value=editing[k]??""; inp.addEventListener("input",editPreview); inp.addEventListener("change",editPreview);
    w.appendChild(inp); f.appendChild(w); }
  const note=ce("div","qosnote"); note.innerHTML="QOS 几乎决定起跑优先级(本集群 QOS 权重压倒 age/fairshare)。Project 决定提交后归入哪个文件夹。"; f.appendChild(note);
  let dl=ce("datalist"); dl.id="gtypes2"; dl.innerHTML=[...new Set(STATE.nodes.flatMap(n=>n.gpu_types))].map(t=>`<option value="${t}">`).join(""); f.appendChild(dl);
  let pl=ce("datalist"); pl.id="projlist"; pl.innerHTML=(STATE.folders||[]).map(t=>`<option value="${esc(t)}">`).join(""); f.appendChild(pl);
  $("#modal").classList.remove("hidden"); editPreview();
}
function maxSched(){
  $("#f_nodelist").value=""; $("#f_gpu_type").value=""; $("#f_partition").value=STATE.partitions.join(",");
  editPreview(); toast("已切到最大可调度:任意卡型 + 多分区 + 不钉节点。建议把 Time 收紧以利 backfill。","good");
}
function collectDraft(){ const o={...editing}; for(const [k] of FIELDS){ const el=$("#f_"+k); if(el)o[k]=el.value; } o.gpus=+o.gpus||1; return o; }
function editPreview(){ if(prevTimer)clearTimeout(prevTimer); $("#previewStatus").textContent="…";
  prevTimer=setTimeout(async()=>{ try{ const r=await api.post("/api/preview",collectDraft()); $("#previewPre").textContent=r.sbatch; $("#previewStatus").textContent=""; }catch(e){ $("#previewStatus").textContent="err"; } },250); }
async function saveEditor(submit){ const o=collectDraft();
  try{ let saved=o.id?(await api.post(`/api/drafts/${o.id}`,o)).draft:(await api.post("/api/drafts",o)).draft; await loadDrafts();
    $("#modal").classList.add("hidden"); if(submit) await submitDraft(saved); else toast("已保存","good"); }
  catch(e){ $("#modalErr").textContent=e.message; } }

// ===========================================================================
// USAGE (per-project GPU accounting from sacct)
// ===========================================================================
const GT_COLOR=["#4f9cf9","#2ecc71","#f5a623","#7c5cff","#e0556b","#2ec4c4","#9aa4b6"];
let USAGE=null, USAGE_DAYS=+(localStorage.gpuvizUsageDays||30), USAGE_OPEN=new Set();
function gtColor(t,types){ const i=types.indexOf(t); return GT_COLOR[(i<0?0:i)%GT_COLOR.length]; }
function fmtH(h){ return h>=1000?(h/1000).toFixed(1)+"k":(h>=10?h.toFixed(0):h.toFixed(1)); }
async function loadUsage(){
  const body=$("#usageBody"); if(!USAGE) body.innerHTML='<div class="empty">统计中…(sacct 查询)</div>';
  try{ USAGE=await api.get(`/api/usage?days=${USAGE_DAYS}`); }
  catch(e){ body.innerHTML=`<div class="empty">读取失败: ${esc(e.message)}</div>`; return; }
  renderUsage();
}
function renderUsage(){
  const u=USAGE; if(!u) return;
  const types=Object.keys(u.total.by_type);
  $("#usageSummary").innerHTML=
    `<b>${fmtH(u.total.gpu_hours)}</b> GPU·h · ${u.total.jobs} 个任务 · 近 ${u.days} 天` +
    types.map(t=>` <i class="lg" style="background:${gtColor(t,types)}"></i>${t} ${fmtH(u.total.by_type[t])}`).join("");
  const max=Math.max(1,...u.folders.map(f=>f.gpu_hours));
  const body=$("#usageBody"); body.innerHTML="";
  if(!u.folders.length){ body.innerHTML='<div class="empty">这段时间没有任务记录</div>'; return; }
  for(const f of u.folders){
    const row=ce("div","urow"+(USAGE_OPEN.has(f.folder)?" open":""));
    const head=ce("div","urow-head");
    const segs=Object.entries(f.by_type).map(([t,v])=>
      `<span class="ps" style="width:${(v/f.gpu_hours*100).toFixed(1)}%;background:${gtColor(t,types)}" title="${t}: ${fmtH(v)} GPU·h"></span>`).join("");
    head.innerHTML=
      `<span class="ufold">${esc(f.folder)}</span>`+
      `<span class="ugh"><b>${fmtH(f.gpu_hours)}</b> GPU·h</span>`+
      `<span class="ushare">${(f.gpu_hours/Math.max(u.total.gpu_hours,1e-9)*100).toFixed(0)}%</span>`+
      `<div class="pbar2" style="width:${Math.max(3,f.gpu_hours/max*100).toFixed(1)}%">${segs}</div>`;
    head.onclick=()=>{ USAGE_OPEN.has(f.folder)?USAGE_OPEN.delete(f.folder):USAGE_OPEN.add(f.folder); renderUsage(); };
    row.appendChild(head);
    const sub=ce("div","urow-sub");
    const states=Object.entries(f.by_state).sort((a,b)=>b[1]-a[1])
      .map(([s,n])=>`<span class="ust ${s}">${s} ${n}</span>`).join("");
    sub.innerHTML=`<span>${f.jobs} 个任务${f.running?` · <b class="run">${f.running} 运行中</b>`:""}</span>`+
      `<span>${fmtH(f.wall_hours)} 机时(wall)· ${fmtH(f.cpu_hours)} CPU·h</span>`+
      (f.last?`<span>最近 ${fmtAge(Math.floor(Date.now()/1000-f.last))}</span>`:"");
    row.appendChild(sub);
    if(USAGE_OPEN.has(f.folder)){
      const det=ce("div","urow-det");
      det.innerHTML=`<div class="ustates">${states}</div>`+
        f.top_names.map(n=>`<div class="uname"><span>${esc(n.name)}</span><span class="muted">×${n.runs}</span><b>${fmtH(n.gpu_hours)}</b></div>`).join("");
      row.appendChild(det);
    }
    body.appendChild(row);
  }
  const spark=$("#usageSpark"); const d=u.daily; const dmax=Math.max(1,...d);
  spark.innerHTML=d.map((v,i)=>{
    const day=new Date((u.day0+i*86400)*1000).toLocaleDateString("sv-SE");
    return `<i style="height:${Math.max(2,v/dmax*100)}%" title="${day}: ${fmtH(v)} GPU·h"></i>`;
  }).join("");
  $("#usageSparkNote").textContent=`每日 GPU·h(峰值 ${fmtH(dmax)})`;
}

// ===========================================================================
// HELP TIPS
// ===========================================================================
function setupTips(){
  const tip=$("#tip");
  document.addEventListener("mouseover",e=>{ const q=e.target.closest(".q[data-help]"); if(!q) return;
    const h=HELP[q.dataset.help]; if(!h) return;
    tip.innerHTML=`<div class="flag">${esc(h.flag)}</div><div>${esc(h.what)}</div>`+(h.example?`<div class="eg">例: <code>${esc(h.example)}</code></div>`:"");
    tip.classList.remove("hidden"); const r=q.getBoundingClientRect(); tip.style.left=Math.min(r.left,window.innerWidth-300)+"px"; tip.style.top=(r.bottom+6)+"px"; });
  document.addEventListener("mouseout",e=>{ if(e.target.closest(".q[data-help]")) tip.classList.add("hidden"); });
}

// ===========================================================================
// QUEUE (cluster-wide pending jobs, by priority)
// ===========================================================================
let QUEUE=[], QSUMMARY={};
let QFILT={mine:false,type:""};
async function loadQueue(){
  try{ const r=await api.get("/api/queue"); QUEUE=r.queue; QSUMMARY=r.summary; }
  catch(e){ $("#queueBody").innerHTML=`<div class="empty">读取队列失败: ${esc(e.message)}</div>`; return; }
  renderQueue();
}
function renderQueue(){
  let rows=QUEUE.slice();
  if(QFILT.mine) rows=rows.filter(p=>p.mine);
  if(QFILT.type) rows=rows.filter(p=>(p.gpu_type||"")===QFILT.type);
  // header summary by gpu type (independent of row filter)
  const sm=Object.entries(QSUMMARY).sort().map(([t,s])=>
    `<b>${s.waiting}</b>${s.jobs>s.waiting?`<span class="muted">+${s.jobs-s.waiting}</span>`:""} 个等 <b>${t}</b>(${s.gpus} 卡)`).join(" · ");
  const mineN=QUEUE.filter(p=>p.mine).length;
  $("#queueSummary").innerHTML=(sm||"无 GPU 排队任务")+(mineN?` · 我的 ${mineN}`:"");
  $("#queueCount").textContent=QUEUE.filter(p=>p.waiting).length||"";
  const body=$("#queueBody");
  if(!rows.length){ body.innerHTML='<div class="empty">没有匹配的排队任务</div>'; return; }
  const maxT=Math.max(1,...rows.map(p=>(p.sprio&&p.sprio.total)||p.priority||0));
  body.innerHTML=rows.map(p=>`<div class="qitem${p.waiting?"":" dim"}${p.mine?" me":""}">
    <div class="nq-row">
      <span class="qrank">${p.waiting?"#"+p.rank:"·"}</span>
      ${p.pinned?`<span class="qpin" title="--nodelist ${esc((p.nodelist||[]).join(","))}">📌</span>`:""}
      <b class="tuser">${esc(p.user)}</b>
      <span class="jid">${esc(p.id)}</span>
      <span class="oname" title="${esc(p.name)}">${esc(p.name)}</span>
      <span class="og">${p.gpus?`${p.gpus}×${esc(p.gpu_type||"gpu")}`:"cpu"}</span>
      <span class="muted">${esc(p.partition||"")}${p.qos?` · ${esc(p.qos)}`:""}</span>
      <span class="qreason muted" title="${esc(p.reason||"")}">${esc(p.reason||"")}</span>
    </div>
    ${prioBar(p.sprio,p.priority,maxT)}
  </div>`).join("");
}

// ===========================================================================
// POLLING / WIRING
// ===========================================================================
async function refresh(){
  try{ STATE=await api.get("/api/state"); $("#banner").classList.add("hidden");
    ingestFinished();
    renderCluster(); renderJobs(); renderFinished(); renderHeader(); renderNodeModal(); renderJobInfo();
    $("#updated").textContent=new Date().toLocaleTimeString();
    await loadMigrations();
    if(!$("#tab-queue").classList.contains("hidden")) loadQueue();
  }catch(e){ const b=$("#banner"); b.textContent="无法读取 Slurm: "+e.message; b.classList.remove("hidden"); }
}
function renderHeader(){
  const byType={};
  for(const n of STATE.nodes) for(const pt of n.per_type){
    const e=byType[pt.type]=byType[pt.type]||{grab:0,idle:0,total:0};
    e.idle+=pt.free; e.total+=pt.total; if(n.grabbable) e.grab+=pt.free;
  }
  const parts=Object.entries(byType).sort().map(([t,e])=>
    `<span><b class="free">${e.grab}</b>${e.idle>e.grab?`<span class="muted" title="idle but drain/reserved">+${e.idle-e.grab}</span>`:""}/${e.total} <b>${t}</b></span>`);
  $("#headStats").innerHTML=`<span>${STATE.me} @ ${STATE.site}</span>`+parts.join("")+`<span class="muted">绿=可抢 · +N=空闲但不可用</span>`;
}
let pollTimer=null;
function startPolling(){ stopPolling(); const ms=+$("#refreshSel").value; if(ms>0) pollTimer=setInterval(refresh,ms); }
function stopPolling(){ if(pollTimer) clearInterval(pollTimer); pollTimer=null; }
function switchTab(name){ document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===name));
  for(const n of ["jobs","queue","usage","migrations","drafts","finished"]) $("#tab-"+n).classList.toggle("hidden",n!==name);
  if(name==="queue") loadQueue();
  if(name==="usage") loadUsage();
  if(name==="finished") renderFinished(); }

function wire(){
  $("#refreshBtn").onclick=refresh;
  $("#refreshSel").onchange=()=>{ localStorage.gpuvizRefresh=$("#refreshSel").value; startPolling(); };
  $("#onlyFree").onchange=e=>{FILTERS.onlyFree=e.target.checked;renderCluster();};
  $("#onlyMine").onchange=e=>{FILTERS.onlyMine=e.target.checked;renderCluster();};
  $("#typeFilter").onchange=e=>{FILTERS.type=e.target.value;renderCluster();};
  $("#queueMine").onchange=e=>{QFILT.mine=e.target.checked;renderQueue();};
  $("#queueType").onchange=e=>{QFILT.type=e.target.value;renderQueue();};
  document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>switchTab(t.dataset.tab));
  $("#addFolderBtn").onclick=async()=>{ const n=$("#newFolderName").value.trim(); if(!n) return;
    try{ await api.post("/api/groups",{name:n}); $("#newFolderName").value=""; refresh(); }catch(e){ toast(e.message,"bad"); } };
  $("#newFolderName").addEventListener("keydown",e=>{ if(e.key==="Enter") $("#addFolderBtn").click(); });
  $("#clearFinBtn").onclick=()=>{ for(const k of FINISHED.keys()) FIN_GONE.add(k); FINISHED.clear(); renderFinished(); };
  $("#clearMigBtn").onclick=async()=>{ await Promise.all([api.post("/api/migrations/clear",{}),api.post("/api/transfers/clear",{}),api.post("/api/monitors/clear",{})]); loadMigrations(); };
  $("#stageBtn").onclick=()=>{
    const host=(prompt("源 login node 主机名(能 ssh 到的):")||"").trim(); if(!host) return;
    const src=(prompt("源路径(绝对):")||"").trim(); if(!src) return;
    const dst=(prompt("目标路径(默认同源路径):",src)||src).trim();
    api.post("/api/stage",{src_host:host,src_path:src,dst_path:dst})
      .then(()=>{ toast("已开始 rsync 暂存","good"); loadMigrations(); })
      .catch(e=>toast("暂存失败: "+e.message,"bad"));
  };
  // usage
  $("#usageDays").onchange=e=>{ USAGE_DAYS=+e.target.value; localStorage.gpuvizUsageDays=USAGE_DAYS; USAGE=null; loadUsage(); };
  $("#usageRefresh").onclick=()=>{ USAGE=null; loadUsage(); };
  // template editor modal
  $("#newDraftBtn").onclick=async()=>{ const d=(await api.post("/api/drafts",{})).draft; await loadDrafts(); openEditor(d); };
  $("#newHolderBtn").onclick=async()=>{ const d=(await api.post("/api/drafts",{kind:"holder"})).draft; await loadDrafts(); openEditor(d); };
  $("#modalClose").onclick=$("#modalCancel").onclick=()=>$("#modal").classList.add("hidden");
  $("#modalSave").onclick=()=>saveEditor(false); $("#modalSubmit").onclick=()=>saveEditor(true);
  $("#maxSchedBtn").onclick=maxSched;
  // node zoom-in modal
  $("#nodeClose").onclick=closeNode;
  $("#nodeModal").addEventListener("click",e=>{ if(e.target.id==="nodeModal") closeNode(); });
  // job info modal
  $("#jobInfoClose").onclick=closeJobInfo;
  $("#jobInfoModal").addEventListener("click",e=>{ if(e.target.id==="jobInfoModal") closeJobInfo(); });
  // log modal
  $("#logStop").onclick=()=>setLogStopped(!LOG.stopped);
  $("#logClose").onclick=closeLog;
  document.querySelectorAll(".ltab").forEach(t=>t.onclick=()=>{ LOG.stream=t.dataset.stream; document.querySelectorAll(".ltab").forEach(x=>x.classList.toggle("active",x===t)); renderLog(); });
  $("#logModal").addEventListener("click",e=>{ if(e.target.id==="logModal") closeLog(); });
  // logout
  $("#logoutBtn").onclick=async()=>{ try{ await api.post("/api/logout",{}); }catch(_){} location.href="/login"; };
}

function setupSplitter(){
  const bar=$("#dragbar"); if(!bar) return;
  const root=document.documentElement;
  const apply=w=>root.style.setProperty("--side-w",Math.round(w)+"px");
  const clamp=w=>Math.max(280,Math.min(window.innerWidth-360,w));
  if(localStorage.gpuvizSideW) apply(clamp(+localStorage.gpuvizSideW));
  let dragging=false;
  bar.addEventListener("mousedown",e=>{ dragging=true; bar.classList.add("dragging");
    document.body.style.userSelect="none"; document.body.style.cursor="col-resize"; e.preventDefault(); });
  window.addEventListener("mousemove",e=>{ if(dragging) apply(clamp(window.innerWidth-e.clientX)); });
  window.addEventListener("mouseup",()=>{ if(!dragging) return; dragging=false; bar.classList.remove("dragging");
    document.body.style.userSelect=""; document.body.style.cursor="";
    localStorage.gpuvizSideW=getComputedStyle(root).getPropertyValue("--side-w").trim().replace("px",""); });
  bar.addEventListener("dblclick",()=>{ apply(380); localStorage.gpuvizSideW=380; });
}

async function init(){
  wire(); setupTips(); setupSplitter();
  if(localStorage.gpuvizRefresh) $("#refreshSel").value=localStorage.gpuvizRefresh;
  try{ HELP=(await api.get("/api/sbatch/help")).help; }catch(_){}
  try{ QOS=(await api.get("/api/qos")).qos; }catch(_){}
  await refresh();
  const allTypes=[...new Set(STATE.nodes.flatMap(n=>n.gpu_types))].sort();
  $("#typeFilter").innerHTML='<option value="">all types</option>'+allTypes.map(t=>`<option>${t}</option>`).join("");
  $("#queueType").innerHTML='<option value="">all GPU</option>'+allTypes.map(t=>`<option>${t}</option>`).join("");
  $("#usageDays").value=String(USAGE_DAYS);
  await loadDrafts();
  startPolling();
  setInterval(tickFinished,1000);   // countdown + 3-min auto-expiry, independent of polling
  setInterval(renderJobInfo,1000);  // keep 已运行/剩余时间 ticking while the info modal is open
}
init();
