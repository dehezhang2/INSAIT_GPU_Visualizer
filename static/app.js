"use strict";
// ---- API -------------------------------------------------------------------
const api = {
  async get(u){ const r=await fetch(u); if(!r.ok) throw await err(r); return r.json(); },
  async post(u,b){ const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(b||{})}); if(!r.ok) throw await err(r); return r.json(); },
  async del(u){ const r=await fetch(u,{method:"DELETE"}); if(!r.ok) throw await err(r); return r.json(); },
};
async function err(r){ try{const j=await r.json(); return new Error(j.error||r.statusText);}catch(_){return new Error(r.statusText);} }
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
let PROJECTS=[], CATALOGS={}, QOS=[], MIGRATIONS=[], DRAFTS=[], HELP={};
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
// PROJECTS + CATALOG
// ===========================================================================
async function loadProjects(){
  PROJECTS=(await api.get("/api/projects")).projects;
  $("#projCount").textContent=PROJECTS.length;
  await Promise.all(PROJECTS.map(p=>loadCatalog(p.id)));
  renderProjects();
}
async function loadCatalog(pid){
  try{ CATALOGS[pid]=(await api.get(`/api/projects/${pid}/catalog`)).catalog; }
  catch(e){ CATALOGS[pid]={error:e.message,jobs:[]}; }
}
function renderProjects(){
  const body=$("#projectsBody"); body.innerHTML="";
  if(!PROJECTS.length){ body.innerHTML='<div class="empty">还没注册项目。填 repo 路径点 Add。</div>'; return; }
  for(const p of PROJECTS){
    const cat=CATALOGS[p.id]||{jobs:[]};
    const card=ce("div","project");
    const head=ce("div","project-head");
    head.innerHTML=`<span class="pname">${esc(cat.project||p.name)}</span><span class="ppath">${esc(p.path)}</span>`;
    const rm=btn("✕","ghost sm",ev=>{ev.stopPropagation(); removeProject(p);});
    head.appendChild(rm);
    card.appendChild(head);
    const pb=ce("div","project-body");
    if(!p.exists) pb.innerHTML=`<div class="cfgwarn">路径不存在</div>`;
    else if(cat.error) pb.innerHTML=`<div class="cfgwarn">${esc(cat.error)}</div>`;
    else if(!cat.jobs.length) pb.innerHTML=`<div class="cfgwarn">gpuviz.toml 里没有 [[job]]</div>`;
    else for(const spec of cat.jobs) pb.appendChild(catalogJob(p,spec));
    card.appendChild(pb);
    body.appendChild(card);
  }
}
function catalogJob(proj,spec){
  const c=ce("div","cjob"+(spec.kind==="holder"?" holder":""));
  const n=Math.max(1,Math.min(8,+spec.gpus||1));
  const top=ce("div","cjob-top");
  top.innerHTML=`<span class="gpublock">${"<i></i>".repeat(n)}</span><span class="ckey">${esc(spec.key)}</span>`;
  const dep=spec.deps||{overall:"none"};
  const depBadge=ce("span","dep "+dep.overall);
  depBadge.textContent={ok:"data ✓",none:"no deps",missing:"data ✗",small:"data ⚠",remote:"data ⇄"}[dep.overall]||dep.overall;
  top.appendChild(depBadge);
  c.appendChild(top);
  const meta=ce("div","cjob-meta");
  const src=spec.script_file?`file:${spec.script_file.split("/").pop()}`:(spec.command?spec.command.slice(0,40):"inline");
  meta.innerHTML=`<span>${spec.gpus}×${spec.gpu_type||"gpu"}</span><span>${spec.time||""}</span><span>${esc(src)}</span>`;
  c.appendChild(meta);
  const bad=(dep.items||[]).filter(i=>i.status!=="ok");
  if(bad.length){
    const dl=ce("div","deplist");
    for(const it of bad){
      const row=ce("div"); row.textContent=`[${it.status}] ${it.raw_path} — ${it.detail}`;
      if(it.stageable){ const sb=btn("stage ⇄","sm ghost",()=>stageDep(it)); sb.style.marginLeft="6px"; row.appendChild(sb); }
      dl.appendChild(row);
    }
    c.appendChild(dl);
  }
  const act=ce("div","card-actions");
  act.appendChild(btn("preview / submit","sm primary",()=>openSubmit(proj,spec)));
  c.appendChild(act);
  return c;
}
async function removeProject(p){ if(!confirm(`移除项目「${p.name}」?(不删 repo 文件)`)) return; await api.del(`/api/projects/${p.id}`); delete CATALOGS[p.id]; loadProjects(); }

// ===========================================================================
// SUBMIT / OVERRIDE MODAL
// ===========================================================================
const OVR=[["name","Name","text"],["gpus","GPUs","number"],["gpu_type","GPU type","gtype"],
  ["nodes","Nodes","number"],["cpus","CPUs","number"],["mem","Mem","text"],["time","Time","text"],
  ["partition","Partition","text"],["qos","QOS","qos"],["nodelist","Nodelist","text"],
  ["exclude","Exclude","text"],["array","Array","text"]];
let SUB=null; // {proj, spec}
let subTimer=null;
function openSubmit(proj,spec){
  SUB={proj,spec};
  $("#subTitle").textContent=`${proj.name} · ${spec.key}`;
  $("#subErr").textContent="";
  const f=$("#subForm"); f.innerHTML="";
  for(const [k,label,t] of OVR){
    const wrap=ce("div","field");
    const lab=ce("label"); lab.textContent=label;
    const q=ce("span","q"); q.textContent="?"; q.dataset.help=k==="gpus"?"gpus":k; lab.appendChild(q);
    wrap.appendChild(lab);
    let inp;
    if(t==="qos"){
      inp=ce("select"); inp.innerHTML='<option value="">(default)</option>'+
        QOS.map(qq=>`<option value="${qq.name}">${qq.name} · prio ${qq.priority_pct}%${qq.can_preempt?" ⚡":""}</option>`).join("");
    } else if(t==="gtype"){ inp=ce("input"); inp.setAttribute("list","gtypes"); inp.placeholder="任意"; }
    else { inp=ce("input"); inp.type=t==="number"?"number":"text"; }
    inp.id="o_"+k; inp.value=spec[k]??""; inp.addEventListener("input",subPreview);
    inp.addEventListener("change",subPreview);
    wrap.appendChild(inp); f.appendChild(wrap);
  }
  const note=ce("div","qosnote"); note.innerHTML="QOS 几乎决定起跑优先级(本集群 QOS 权重压倒 age/fairshare)。debug 最高但常受 4h 限制;其余基本同级。"; f.appendChild(note);
  let dl=ce("datalist"); dl.id="gtypes"; dl.innerHTML=[...new Set(STATE.nodes.flatMap(n=>n.gpu_types))].map(t=>`<option value="${t}">`).join(""); f.appendChild(dl);
  $("#subModal").classList.remove("hidden");
  subPreview();
}
function subOverrides(){ const o={}; for(const [k] of OVR){ const el=$("#o_"+k); if(el&&el.value!=="") o[k]=el.value; } if(o.gpus)o.gpus=+o.gpus; if(o.nodes)o.nodes=+o.nodes; if(o.cpus)o.cpus=+o.cpus; return o; }
function subPreview(){ if(subTimer)clearTimeout(subTimer); $("#subPrevStatus").textContent="…";
  subTimer=setTimeout(async()=>{ try{ const r=await api.post(`/api/projects/${SUB.proj.id}/preview`,{job_key:SUB.spec.key,overrides:subOverrides()});
    $("#subPrev").textContent=r.sbatch; $("#subPrevStatus").textContent=r.extra&&r.extra.length?("+ "+r.extra.join(" ")):""; }
    catch(e){ $("#subPrevStatus").textContent="预览失败"; } },250); }
function maxSched(){
  $("#o_nodelist").value=""; $("#o_gpu_type").value=""; $("#o_partition").value=STATE.partitions.join(",");
  subPreview(); toast("已切到最大可调度:任意卡型 + 多分区 + 不钉节点。建议把 Time 收紧以利 backfill。","good");
}
async function doSubmit(){
  try{ const r=await api.post(`/api/projects/${SUB.proj.id}/submit`,{job_key:SUB.spec.key,overrides:subOverrides()});
    toast(`已提交 ✓ job ${r.submission.job_id}(快照已存入 repo)`,"good");
    $("#subModal").classList.add("hidden"); refresh(); }
  catch(e){ $("#subErr").textContent=e.message; }
}

// ===========================================================================
// JOBS (management)
// ===========================================================================
function liveJobs(){ return STATE.jobs.filter(j=>!TERMINAL.has(j.state)&&!FINISHED.has(String(j.id))); }
function renderJobs(){
  const body=$("#jobsBody"); const list=liveJobs(); $("#jobsCount").textContent=list.length;
  if(!list.length){ body.innerHTML='<div class="empty">没有运行/排队任务</div>'; return; }
  body.innerHTML=""; for(const j of list) body.appendChild(jobCard(j));
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
// handoff: replace a running job with a catalog job on the same node (make-before-break)
function openSwap(anchor,j){
  if(FINISHED.has(String(j.id))||TERMINAL.has(j.state)){ toast(`${j.id} 已结束,无法 swap`,"bad"); return; }
  const items=[];
  for(const p of PROJECTS){ const c=CATALOGS[p.id]; if(c&&c.jobs) for(const s of c.jobs) items.push({label:`${p.name} · ${s.key}`,pid:p.id,key:s.key}); }
  if(!items.length){ toast("没有可用的 catalog 任务做接管","bad"); return; }
  popMenu(anchor,items,async it=>{
    if(!confirm(`make-before-break:在 ${j.nodes} 上用「${it.label}」接管 ${j.id}?\n新任务 RUNNING 后才取消旧的。`)) return;
    try{ await api.post("/api/migrate",{mode:"handoff",src_job_id:j.job_id,target_node:j.nodes,project_id:it.pid,job_key:it.key});
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
  const fx=btn(f.fixed?"unfix":"fix","sm ghost",()=>{
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
async function stageDep(it){
  if(!confirm(`rsync 暂存(站内 Ceph)?\n源: ${it.src_host}:${it.path}\n目标: ${it.path}`)) return;
  try{ await api.post("/api/stage",{src_host:it.src_host,src_path:it.path,dst_path:it.path});
    toast("已开始 rsync 暂存","good"); switchTab("migrations"); loadMigrations(); }
  catch(e){ toast("暂存失败: "+e.message,"bad"); }
}

// ===========================================================================
// LOG VIEWER
// ===========================================================================
let LOG={job:null,stream:"out",timer:null,data:null};
async function openLog(j){
  LOG.job=j; LOG.stream="out";
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
function startLogFollow(){ stopLogFollow(); LOG.timer=setInterval(()=>{ if($("#logFollow").checked) fetchLog(); },3000); }
function stopLogFollow(){ if(LOG.timer) clearInterval(LOG.timer); LOG.timer=null; }
function closeLog(){ $("#logModal").classList.add("hidden"); stopLogFollow(); LOG.job=null; }

// ===========================================================================
// AD-HOC DRAFTS (secondary)
// ===========================================================================
async function loadDrafts(){ DRAFTS=(await api.get("/api/drafts")).drafts; renderDrafts(); }
function renderDrafts(){
  const body=$("#draftsBody"); $("#draftsCount").textContent=DRAFTS.length||"";
  if(!DRAFTS.length){ body.innerHTML='<div class="empty">无临时任务</div>'; return; }
  body.innerHTML="";
  for(const d of DRAFTS){
    const c=ce("div","card draft"+(d.kind==="holder"?" holder":""));
    c.draggable=true; c.addEventListener("dragstart",()=>{window.__drag={type:"draft",draft:d};}); c.addEventListener("dragend",()=>{window.__drag=null;});
    const n=Math.max(1,Math.min(8,+d.gpus||1));
    const top=ce("div","card-top");
    top.innerHTML=`<span class="gpublock">${"<i></i>".repeat(n)}</span><span class="jname">${esc(d.name)}</span>${d.submitted_job_id?`<span class="state RUNNING">→ ${d.submitted_job_id}</span>`:""}`;
    c.appendChild(top);
    const meta=ce("div","card-meta"); meta.innerHTML=`<span>${d.gpus}×${d.gpu_type||"gpu"}</span><span>${d.partition||""} · ${d.time||""}</span>${d.nodelist?`<span>📍${d.nodelist}</span>`:""}`;
    c.appendChild(meta);
    const act=ce("div","card-actions");
    act.appendChild(btn("edit","sm ghost",()=>openEditor(d)));
    act.appendChild(btn("submit","sm primary",()=>submitDraft(d)));
    act.appendChild(btn("delete","sm ghost danger",()=>delDraft(d)));
    c.appendChild(act); body.appendChild(c);
  }
}
async function submitDraft(d){ if(!confirm(`提交「${d.name}」?`)) return; try{ const r=await api.post(`/api/drafts/${d.id}/submit`,{}); toast(`已提交 ✓ job ${r.job_id}`,"good"); loadDrafts(); refresh(); }catch(e){ toast("提交失败: "+e.message,"bad"); } }
async function delDraft(d){ if(!confirm(`删除「${d.name}」?`)) return; await api.del(`/api/drafts/${d.id}`); loadDrafts(); }

// draft editor (full sbatch fields)
const FIELDS=[["name","Name","text"],["gpus","GPUs","number"],["gpu_type","GPU type","gtype"],["nodes","Nodes","number"],
  ["cpus","CPUs","number"],["mem","Mem","text"],["time","Time","text"],["partition","Partition","text"],
  ["qos","QOS","text"],["nodelist","Nodelist","text"],["output","Output","text",1],["script","Script","textarea",1]];
let editing=null,prevTimer=null;
function openEditor(d){ editing={...d}; $("#modalTitle").textContent=`Edit ${d.name||""}`; $("#modalErr").textContent="";
  const f=$("#draftForm"); f.innerHTML="";
  for(const [k,label,t,full] of FIELDS){ const w=ce("div","field"+(full?" full":"")); const lab=ce("label"); lab.textContent=label;
    const q=ce("span","q"); q.textContent="?"; q.dataset.help=k; lab.appendChild(q); w.appendChild(lab);
    let inp; if(t==="textarea")inp=ce("textarea"); else if(t==="gtype"){inp=ce("input");inp.setAttribute("list","gtypes2");} else {inp=ce("input");inp.type=t==="number"?"number":"text";}
    inp.id="f_"+k; inp.value=editing[k]??""; inp.addEventListener("input",editPreview); w.appendChild(inp); f.appendChild(w); }
  let dl=ce("datalist"); dl.id="gtypes2"; dl.innerHTML=[...new Set(STATE.nodes.flatMap(n=>n.gpu_types))].map(t=>`<option value="${t}">`).join(""); f.appendChild(dl);
  $("#modal").classList.remove("hidden"); editPreview();
}
function collectDraft(){ const o={...editing}; for(const [k] of FIELDS){ const el=$("#f_"+k); if(el)o[k]=el.value; } o.gpus=+o.gpus||1; return o; }
function editPreview(){ if(prevTimer)clearTimeout(prevTimer); $("#previewStatus").textContent="…";
  prevTimer=setTimeout(async()=>{ try{ const r=await api.post("/api/preview",collectDraft()); $("#previewPre").textContent=r.sbatch; $("#previewStatus").textContent=""; }catch(e){ $("#previewStatus").textContent="err"; } },250); }
async function saveEditor(submit){ const o=collectDraft();
  try{ let saved=o.id?(await api.post(`/api/drafts/${o.id}`,o)).draft:(await api.post("/api/drafts",o)).draft; await loadDrafts();
    $("#modal").classList.add("hidden"); if(submit) await submitDraft(saved); else toast("已保存","good"); }
  catch(e){ $("#modalErr").textContent=e.message; } }

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
  for(const n of ["projects","jobs","queue","migrations","drafts","finished"]) $("#tab-"+n).classList.toggle("hidden",n!==name);
  if(name==="queue") loadQueue();
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
  $("#addProjBtn").onclick=async()=>{ const p=$("#projPath").value.trim(); if(!p) return; try{ await api.post("/api/projects",{path:p}); $("#projPath").value=""; loadProjects(); }catch(e){ toast(e.message,"bad"); } };
  $("#projPath").addEventListener("keydown",e=>{ if(e.key==="Enter") $("#addProjBtn").click(); });
  $("#clearFinBtn").onclick=()=>{ for(const k of FINISHED.keys()) FIN_GONE.add(k); FINISHED.clear(); renderFinished(); };
  $("#clearMigBtn").onclick=async()=>{ await Promise.all([api.post("/api/migrations/clear",{}),api.post("/api/transfers/clear",{}),api.post("/api/monitors/clear",{})]); loadMigrations(); };
  // submit modal
  $("#subClose").onclick=$("#subCancel").onclick=()=>$("#subModal").classList.add("hidden");
  $("#subSubmit").onclick=doSubmit; $("#maxSchedBtn").onclick=maxSched;
  $("#subModal").addEventListener("click",e=>{ if(e.target.id==="subModal") $("#subModal").classList.add("hidden"); });
  // draft modal
  $("#newDraftBtn").onclick=async()=>{ const d=(await api.post("/api/drafts",{})).draft; await loadDrafts(); openEditor(d); };
  $("#newHolderBtn").onclick=async()=>{ const d=(await api.post("/api/drafts",{kind:"holder"})).draft; await loadDrafts(); openEditor(d); };
  $("#modalClose").onclick=$("#modalCancel").onclick=()=>$("#modal").classList.add("hidden");
  $("#modalSave").onclick=()=>saveEditor(false); $("#modalSubmit").onclick=()=>saveEditor(true);
  // node zoom-in modal
  $("#nodeClose").onclick=closeNode;
  $("#nodeModal").addEventListener("click",e=>{ if(e.target.id==="nodeModal") closeNode(); });
  // job info modal
  $("#jobInfoClose").onclick=closeJobInfo;
  $("#jobInfoModal").addEventListener("click",e=>{ if(e.target.id==="jobInfoModal") closeJobInfo(); });
  // log modal
  $("#logClose").onclick=closeLog;
  document.querySelectorAll(".ltab").forEach(t=>t.onclick=()=>{ LOG.stream=t.dataset.stream; document.querySelectorAll(".ltab").forEach(x=>x.classList.toggle("active",x===t)); renderLog(); });
  $("#logModal").addEventListener("click",e=>{ if(e.target.id==="logModal") closeLog(); });
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
  await loadProjects(); await loadDrafts();
  startPolling();
  setInterval(tickFinished,1000);   // countdown + 3-min auto-expiry, independent of polling
  setInterval(renderJobInfo,1000);  // keep 已运行/剩余时间 ticking while the info modal is open
}
init();
