let cameras=[], recordings=[], currentViewer=null;
let editingId=null;

const $ = s=>document.querySelector(s);
const grid=$('#grid'), hdrStats=$('#hdrStats');

function api(p,opts){ return fetch(p,opts).then(r=>r.json()); }

async function loadCameras(){
  cameras = await api('/api/cameras');
  const sel=$('#filterCam'); sel.innerHTML='<option value="">All Cameras</option>';
  cameras.forEach(c=>{ const o=document.createElement('option'); o.value=c.id; o.textContent=c.name; sel.appendChild(o); });
  renderGrid();
}
function renderGrid(){
  grid.innerHTML='';
  cameras.forEach(c=>{
    const card=document.createElement('div'); card.className='card';
    const online=c.status==='online' || c._forceOnline;
    const rec=c.recording_enabled;
    card.innerHTML=`
      <div class="card-head"><b>${c.name}</b> <span class="badge ${online?'online':'offline'}">${online?'🟢 ONLINE':'🔴 OFFLINE'}</span></div>
      <div class="card-video" data-id="${c.id}" style="cursor:pointer">
        <img src="/api/cameras/${c.id}/stream" alt="live" style="width:100%;height:100%;object-fit:contain;background:#000" onerror="this.style.display='none'; this.nextElementSibling.style.display='block'">
        <span class="placeholder" style="display:${online?'none':'block'};position:absolute">Last seen: ${c.last_seen||'-'}<br>${c.url}</span>
      </div>
      <div class="card-foot">
        <span>${c.resolution||'640x480'} • ${c.fps||15} FPS ${rec?'<span class="badge rec">🔴 REC</span>':''}</span>
        <div class="card-actions">
          <button class="btn small" data-edit="${c.id}">✎</button>
          <button class="btn small" data-del="${c.id}">🗑</button>
          <button class="btn small ${rec?'danger':''}" data-rec="${c.id}">${rec?'■':'⏺'}</button>
        </div>
      </div>`;
    grid.appendChild(card);
  });
  // bind
  grid.querySelectorAll('.card-video').forEach(el=>el.addEventListener('click',()=>openViewer(Number(el.dataset.id))));
  grid.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>openModal(Number(b.dataset.edit))));
  grid.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',()=>delCam(Number(b.dataset.del))));
  grid.querySelectorAll('[data-rec]').forEach(b=>b.addEventListener('click',()=>toggleRec(Number(b.dataset.rec))));
}

async function delCam(id){
  if(!confirm('Delete camera?'))return;
  await fetch('/api/cameras/'+id,{method:'DELETE'});
  loadCameras();
}
async function toggleRec(id){
  const c=cameras.find(x=>x.id===id);
  const url=c.recording_enabled?`/api/cameras/${id}/record/stop`:`/api/cameras/${id}/record/start`;
  await fetch(url,{method:'POST'});
  loadCameras();
}

function openViewer(id){
  currentViewer=id;
  const cam=cameras.find(c=>c.id===id);
  $('#viewerName').textContent=cam.name;
  $('#viewerStatus').textContent=cam.status==='online'?'🟢 ONLINE':'🔴 OFFLINE';
  $('#viewerImg').src=`/api/cameras/${id}/stream?ts=${Date.now()}`;
  // thumbs
  const thumbs=$('#viewerThumbs'); thumbs.innerHTML='';
  cameras.forEach(c=>{
    const img=document.createElement('img');
    img.src=c.status==='online'?`/api/cameras/${c.id}/stream`:'';
    img.alt=c.name; img.title=c.name;
    if(c.id===id) img.classList.add('active');
    img.addEventListener('click',()=>openViewer(c.id));
    thumbs.appendChild(img);
  });
  $('#viewer').classList.add('open');
  $('#viewerRec').onclick=()=>fetch(`/api/cameras/${id}/record/start`,{method:'POST'}).then(loadCameras);
  $('#viewerStop').onclick=()=>fetch(`/api/cameras/${id}/record/stop`,{method:'POST'}).then(loadCameras);
}
$('#viewerClose').onclick=()=>{ $('#viewer').classList.remove('open'); $('#viewerImg').src=''; };
$('#viewerFs').onclick=()=>{ const el=$('#viewerMain'); if(document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen(); };

// modal
function toggleScheduleBox(){ $('#scheduleBox').classList.toggle('hidden', $('#fMode').value!=='schedule'); }
$('#fMode').addEventListener('change', toggleScheduleBox);
async function loadStorageOptions(){
  const storages=await api('/api/storage');
  const sel=$('#fStorage'); sel.innerHTML='';
  storages.forEach(s=>{ const o=document.createElement('option'); o.value=s.id; o.textContent=`${s.name} (${s.path}) ${s.exists?'':'⚠'}`; sel.appendChild(o); });
  return storages;
}
async function openModal(id=null){
  editingId=id;
  $('#modal').classList.add('open');
  $('#modalTitle').textContent=id?'Edit Camera':'Add Camera';
  await loadStorageOptions();
  if(id){
    const c=cameras.find(x=>x.id===id);
    $('#fName').value=c.name; $('#fUrl').value=c.url; $('#fEnabled').value=c.enabled?1:0;
    $('#fRecEnabled').value=c.recording_enabled?1:0; $('#fFormat').value=c.recording_format||'mp4'; $('#fMode').value=c.recording_mode||'manual'; $('#fStorage').value=String(c.storage_id||1);
    fetch(`/api/cameras/${id}/schedules`).then(r=>r.json()).then(rows=>{
      if(rows.length){ const s=rows[0]; $('#fSchedStart').value=s.start_time; $('#fSchedEnd').value=s.end_time; const days=s.days.split(','); document.querySelectorAll('.schedDay').forEach(cb=>cb.checked=days.includes(cb.value)); }
    });
  } else {
    $('#fName').value=''; $('#fUrl').value='http://192.168.1.100:4747/video'; $('#fEnabled').value=1; $('#fRecEnabled').value=0; $('#fFormat').value='mp4'; $('#fMode').value='continuous'; $('#fStorage').value=2;
  }
  toggleScheduleBox();
  $('#testRes').textContent='';
}
$('#addCamBtn').onclick=()=>openModal(null);
$('#checkCamBtn').onclick=async()=>{
  const btn=$('#checkCamBtn'); btn.textContent='⏳ Checking...'; btn.disabled=true;
  let results=[];
  for(const c of cameras){
    try{
      const r=await fetch(`/api/cameras/${c.id}/test`,{method:'POST'}).then(r=>r.json());
      results.push(`${c.name}: ${r.ok?'✅ OK':'❌ FAIL'} ${r.contentType||r.error||''}`);
      if(r.ok) c._forceOnline=true;
    }catch(e){ results.push(`${c.name}: ❌ FAIL`); }
  }
  renderGrid();
  alert(results.join('\n') || 'No cameras');
  btn.textContent='🔄 Check Cameras'; btn.disabled=false;
};
$('#modalCancel').onclick=()=>$('#modal').classList.remove('open');
$('#modalSave').onclick=async()=>{
  const body={ name:$('#fName').value, url:$('#fUrl').value, enabled:Number($('#fEnabled').value), recording_enabled:Number($('#fRecEnabled').value), recording_format:$('#fFormat').value, recording_mode:$('#fMode').value, storage_id:Number($('#fStorage').value)||1 };
  if(!body.name||!body.url) return alert('Name and URL required');
  let camId=editingId;
  if(editingId) await fetch('/api/cameras/'+editingId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  else { const r=await fetch('/api/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()); camId=r.id; }
  // save schedule if mode=schedule (dormant otherwise)
  if(body.recording_mode==='schedule'){
    const days=[...document.querySelectorAll('.schedDay:checked')].map(cb=>cb.value).join(',') || '1,2,3,4,5,6,0';
    const start_time=$('#fSchedStart').value||'22:00';
    const end_time=$('#fSchedEnd').value||'06:00';
    // upsert: delete old then insert
    const existing=await fetch(`/api/cameras/${camId}/schedules`).then(r=>r.json());
    for(const s of existing) await fetch(`/api/cameras/${camId}/schedules/${s.id}`,{method:'DELETE'});
    await fetch(`/api/cameras/${camId}/schedules`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days,start_time,end_time})});
  }
  $('#modal').classList.remove('open'); loadCameras();
};
$('#testBtn').onclick=async()=>{
  if(!editingId) return alert('Save first');
  const r=await fetch('/api/cameras/'+editingId+'/test',{method:'POST'}).then(r=>r.json());
  $('#testRes').textContent=r.ok?`OK ${r.status} ${r.contentType}`:`FAIL ${r.error||r.status}`;
};

// tabs
document.querySelectorAll('nav button[data-tab]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('nav button[data-tab]').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  ['cameras','recordings','storage','settings'].forEach(t=>$('#tab-'+t).classList.toggle('hidden', t!==b.dataset.tab));
  if(b.dataset.tab==='recordings') loadRecordings();
  if(b.dataset.tab==='storage') loadStorage();
  if(b.dataset.tab==='settings') loadSettings();
}));

// recordings
let recPage=1;
async function loadRecordings(){
  const cam=$('#filterCam').value, date=$('#filterDate').value;
  const q=new URLSearchParams({page:recPage,limit:20});
  if(cam) q.set('camera_id',cam); if(date) q.set('date',date);
  const res=await api('/api/recordings?'+q.toString());
  recordings=res.data;
  const tbody=$('#recTable'); tbody.innerHTML='';
  recordings.forEach(r=>{
    const tr=document.createElement('tr');
    const size=(r.size/1024/1024).toFixed(1)+' MB';
    const dateStr=r.start_time?new Date(r.start_time).toLocaleString():'-';
    tr.innerHTML=`<td>${dateStr}</td><td>${cameras.find(c=>c.id===r.camera_id)?.name||r.camera_id}</td><td>${r.filename}</td><td>${size}</td><td><button class="btn small" data-play="${r.id}">▶</button> <a class="btn small" href="/api/recordings/${r.id}/stream" download>⬇</a> <button class="btn small" data-delrec="${r.id}">🗑</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('[data-play]').forEach(b=>b.addEventListener('click',()=>playRec(Number(b.dataset.play))));
  tbody.querySelectorAll('[data-delrec]').forEach(b=>b.addEventListener('click',async()=>{ if(confirm('Delete?')){ await fetch('/api/recordings/'+b.dataset.delrec,{method:'DELETE'}); loadRecordings(); }}));
  renderTimeline();
  // attach player continuous
  setupPlayer();
}
$('#filterBtn').onclick=()=>{ recPage=1; loadRecordings(); };
$('#refreshRec').onclick=loadRecordings;

function renderTimeline(){
  const tl=$('#timeline'); tl.innerHTML='';
  if(!recordings.length) return;
  // simple: map 24h to width
  const now=new Date(); const start=new Date(now); start.setHours(0,0,0,0);
  const end=new Date(now); end.setHours(23,59,59,999);
  const total=end-start;
  recordings.slice(0,30).reverse().forEach(r=>{
    const s=new Date(r.start_time).getTime();
    const e=r.end_time?new Date(r.end_time).getTime():s+5*60*1000;
    const left=((s-start)/total)*100, w=((e-s)/total)*100;
    const seg=document.createElement('div'); seg.className='seg'; seg.style.left=left+'%'; seg.style.width=Math.max(w,0.5)+'%'; seg.title=r.filename; seg.addEventListener('click',()=>playRec(r.id)); tl.appendChild(seg);
  });
}
let queue=[], qIndex=0;
function playRec(id){
  // continuous: sort by start_time ascending, play from idx onward
  const sorted=[...recordings].sort((a,b)=>new Date(a.start_time)-new Date(b.start_time));
  const pos=sorted.findIndex(x=>x.id===id);
  queue=sorted.slice(pos);
  qIndex=0;
  const v=$('#player'); const wrap=$('#playerWrap'); wrap.style.display='block';
  v.src=`/api/recordings/${queue[0].id}/stream`; v.play();
}
function setupPlayer(){
  const v=$('#player');
  v.onended=()=>{
    qIndex++;
    if(qIndex<queue.length) { v.src=`/api/recordings/${queue[qIndex].id}/stream`; v.play(); }
  };
}
$('#closePlayer').onclick=()=>{
  const v=$('#player'); const wrap=$('#playerWrap');
  v.pause(); v.removeAttribute('src'); v.load();
  wrap.style.display='none';
  queue=[]; qIndex=0;
};

// storage
async function loadStorage(){
  const data=await api('/api/storage');
  const g=$('#storageGrid'); g.innerHTML='';
  data.forEach(s=>{
    const card=document.createElement('div'); card.className='storage-card';
    const pct=s.percent||0;
    const isExternal=s.path.includes('/media');
    card.innerHTML=`<b>${s.name}</b><div style="color:var(--muted);font-size:12px">${s.path} ${s.exists?'':'⚠ not found'}</div><div class="bar"><div style="width:${pct}%"></div></div><div style="font-size:12px;margin-top:4px">${(s.used/1024/1024/1024).toFixed(1)} / ${(s.total/1024/1024/1024).toFixed(1)} GB • ${pct}%</div><div style="margin-top:8px;display:flex;gap:6px">${isExternal?`<button class="btn small" onclick="mountStorage(${s.id})">Mount</button><button class="btn small" onclick="unmountStorage(${s.id})">Unmount</button>`:''}</div><div id="mountMsg${s.id}" style="font-size:11px;color:var(--muted);margin-top:4px"></div>`;
    g.appendChild(card);
  });
}
async function mountStorage(id){ const el=document.getElementById('mountMsg'+id); el.textContent='Mounting...'; const r=await fetch(`/api/storage/${id}/mount`,{method:'POST'}).then(r=>r.json()); el.textContent=r.ok?`✅ ${r.out||'mounted'}`:`❌ ${r.error||r.hint||'need sudo'}`; setTimeout(loadStorage,1500); }
async function unmountStorage(id){ const el=document.getElementById('mountMsg'+id); el.textContent='Unmounting...'; const r=await fetch(`/api/storage/${id}/unmount`,{method:'POST'}).then(r=>r.json()); el.textContent=r.ok?`✅ ${r.out||'unmounted'}`:`❌ ${r.error||r.hint||''}`; setTimeout(loadStorage,1500); }
$('#runRetention').onclick=async()=>{ await fetch('/api/storage/retention/run',{method:'POST'}); loadStorage(); };

// settings
async function loadSettings(){
  const s=await api('/api/system/settings');
  $('#setRetention').value=s.retention_days||7;
  $('#setMaxStorage').value=s.max_storage_percent||80;
  const sys=await api('/api/system/status');
  const est=sys.storage.est; let estStr=est&&est.days>0?` • Est. ${est.days}d`:est&&est.hours>0?` • Est. ${est.hours}h`:'';
  $('#sysInfo').innerHTML=`CPU ${sys.cpu}% • RAM ${(sys.ram.used/1024/1024).toFixed(0)} MB / ${(sys.ram.total/1024/1024).toFixed(0)} MB • Storage ${(sys.storage.used/1024/1024/1024).toFixed(1)} / ${(sys.storage.total/1024/1024/1024).toFixed(1)} GB${estStr} • Cameras ${sys.cameras.online}/${sys.cameras.total} • Recording ${sys.recording.active} • FFmpeg ${sys.ffmpeg.processes} • Uptime ${Math.floor(sys.uptime/60)}m`;
}
$('#saveSettings').onclick=async()=>{
  await fetch('/api/system/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({retention_days:$('#setRetention').value,max_storage_percent:$('#setMaxStorage').value})});
  alert('Saved');
};

// SSE header stats
const es=new EventSource('/api/events');
es.onmessage=e=>{
  const d=JSON.parse(e.data);
  const sys=d.system;
  const est=sys.storage.est;
  let estStr='';
  if(est && est.days>0) estStr=` • Est. ${est.days}d`;
  else if(est && est.hours>0) estStr=` • Est. ${est.hours}h`;
  hdrStats.innerHTML=`<span>🟢 Server Online</span> <span>Cameras: <b>${sys.cameras.online} / ${sys.cameras.total} Online</b></span> <span>Recording: <b>${sys.recording.active}</b></span> <span>CPU: <b>${sys.cpu}%</b></span> <span>RAM: <b>${(sys.ram.used/1024/1024).toFixed(0)} MB</b></span> <span>Storage: <b>${sys.storage.total?Math.round(sys.storage.used/sys.storage.total*100):0}%</b>${estStr} • Uptime ${Math.floor(sys.uptime/60)}m</span>`;
  if(d.cameras){ cameras=d.cameras.map(c=>{ const old=cameras.find(o=>o.id===c.id); return {...(old||{}),...c}; }); renderGrid(); }
};

loadCameras();
