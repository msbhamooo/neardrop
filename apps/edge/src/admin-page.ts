/** The private owner dashboard: plain HTML + Chart.js (pinned, from cdnjs). All dynamic text uses textContent. */
export const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>NearDrop admin</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14171a;--mut:#667085;--line:#e4e7ec;--acc:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#171b22;--fg:#e8eaed;--mut:#98a2b3;--line:#2a303a;--acc:#6ea0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;padding:16px;max-width:1100px;margin-inline:auto}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{font-size:18px;margin:0}h2{font-size:13px;margin:0 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.seg button{border:1px solid var(--line);background:var(--card);color:var(--fg);padding:6px 12px;cursor:pointer}
.seg button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}
.big{font-size:26px;font-weight:650}.sub{color:var(--mut);font-size:12px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)}td:last-child,th:last-child{text-align:right}
canvas{max-height:220px}#err{color:#b42318;display:none}
</style></head><body>
<header><h1>NearDrop usage (private)</h1>
<div class="seg" id="seg"></div></header>
<p id="err"></p>
<div class="grid" id="tiles"></div>
<div class="grid">
 <div class="card"><h2>Transfers per day</h2><canvas id="c1"></canvas></div>
 <div class="card"><h2>Bytes per day (GB)</h2><canvas id="c2"></canvas></div>
 <div class="card"><h2>Avg speed over time (MB/s)</h2><canvas id="c3"></canvas></div>
 <div class="card"><h2>Daily active devices</h2><canvas id="c4"></canvas></div>
</div>
<div class="grid" id="speed"></div>
<div class="grid" id="breakdowns"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
const RANGES=[['today','Today'],['7d','7 days'],['30d','30 days'],['all','All time']];
let range='7d',charts={};
const $=(id)=>document.getElementById(id);
const fmtBytes=(n)=>{const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<4){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i]};
const f1=(n)=>n==null?'–':n.toFixed(1);
const ms=(n)=>n==null?'–':n>=1000?(n/1000).toFixed(1)+' s':Math.round(n)+' ms';
function el(tag,text,cls){const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e}
function tile(label,value,sub){const c=el('div',null,'card');c.append(el('h2',label),el('div',value,'big'));if(sub)c.append(el('div',sub,'sub'));return c}
function table(title,rows,fmt){const c=el('div',null,'card');c.append(el('h2',title));const t=el('table');
 if(!rows.length){c.append(el('div','No data yet','sub'));return c}
 for(const r of rows){const tr=el('tr');tr.append(el('td',r[0]),el('td',fmt?fmt(r[1]):r[1]));t.append(tr)}c.append(t);return c}
function chart(id,type,labels,data,label){charts[id]&&charts[id].destroy();
 charts[id]=new Chart($(id),{type,data:{labels,datasets:[{label,data,borderColor:'#2563eb',backgroundColor:'rgba(37,99,235,.35)',tension:.25}]},options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}})}
function render(s){
 const T=s.totals;
 const tiles=$('tiles');tiles.replaceChildren(
  tile('Transfers',T.transfers),tile('Files sent',T.files),tile('Data moved',fmtBytes(T.bytes)),
  tile('Success rate',T.successRate==null?'–':(T.successRate*100).toFixed(1)+'%',T.done+' of '+T.transfers),
  tile('Avg connect time',ms(s.avgConnectMs),'tap to first byte'),tile('Avg time to discover',ms(s.avgDiscoverMs),'peer on radar'),
  tile('QR pairing',s.qr.ok+s.qr.fail?Math.round(100*s.qr.ok/(s.qr.ok+s.qr.fail))+'%':'–',s.qr.ok+' ok / '+s.qr.fail+' failed'),
  tile('Largest transfer',s.largest?fmtBytes(s.largest.bytes):'–',s.largest?s.largest.type+', '+new Date(s.largest.ts).toISOString().slice(0,10):''),
  tile('Fastest transfer',s.fastest?f1(s.fastest.speed)+' MB/s':'–',s.fastest?s.fastest.type+', '+fmtBytes(s.fastest.bytes):''));
 const sp=$('speed');sp.replaceChildren();
 for(const k of ['all','lan','qr','relay']){const v=s.speed[k];
  sp.append(table('Speed MB/s: '+k,[['avg',v.avg],['median',v.median],['p90',v.p90]],f1))}
 const b=$('breakdowns');b.replaceChildren(
  table('Browser',s.browser.map(x=>[x.key,x.count])),table('OS',s.os.map(x=>[x.key,x.count])),
  table('Mobile vs desktop',s.deviceKind.map(x=>[x.key,x.count])),table('Failure reasons (fix first)',s.errors.map(x=>[x.key,x.count])));
 const d=s.perDay.map(x=>x.day);
 chart('c1','bar',d,s.perDay.map(x=>x.transfers),'Transfers');
 chart('c2','bar',d,s.perDay.map(x=>x.bytes/1073741824),'GB');
 chart('c3','line',d,s.perDay.map(x=>x.speed),'MB/s');
 chart('c4','line',s.dau.map(x=>x.day),s.dau.map(x=>x.count),'Devices');
}
async function load(){
 $('err').style.display='none';
 try{const r=await fetch('/admin/api/stats?range='+range,{cache:'no-store'});
  if(!r.ok)throw new Error('HTTP '+r.status);render(await r.json())}
 catch(e){$('err').textContent='Failed to load: '+e.message;$('err').style.display='block'}
}
const seg=$('seg');
for(const [k,l] of RANGES){const b=el('button',l);b.onclick=()=>{range=k;[...seg.children].forEach(c=>c.classList.toggle('on',c===b));load()};
 if(k===range)b.className='on';seg.append(b)}
load();
</script></body></html>`;
