import { useState, useEffect, useCallback, useRef } from "react";

const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Barlow+Condensed:wght@500;600;700;800;900&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{background:#05111F;color:#C8DCF0;font-family:'IBM Plex Mono',monospace;min-height:100vh;}
::-webkit-scrollbar{width:5px;height:5px;}::-webkit-scrolhlbar-track{background:#05111F;}::-webkit-scrollbar-thumb{background:#1A3554;border-radius:3px;}
button{cursor:pointer;border:none;font-family:'Barlow Condensed',sans-serif;}
input,select{font-family:'IBM Plex Mono',monospace;}
.fade-in{animation:fadeIn .3s ease;}@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.pulse{animation:pulse 2s ease-in-out infinite;}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}.spin{animation:spin .9s linear infinite;}
.tbl{width:100%;border-collapse:collapse;}
.tbl th{padding:9px 12px;text-align:left;font:700 9px/1 'Barlow Condensed',sans-serif;letter-spacing:2px;text-transform:uppercase;color:#2E5070;border-bottom:1px solid #0D1F33;white-space:nowrap;}
.tbl td{padding:11px 12px;font:400 11px/1.4 'IBM Plex Mono',monospace;border-bottom:1px solid rgba(13,31,51,.85);vertical-align:middle;}
.tbl tbody tr{transition:background .12s;}.tbl tbody tr:hover{background:rgba(13,31,51,.7);}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:4px;font:700 9px/1 'Barlow Condensed',sans-serif;letter-spacing:1.5px;text-transform:uppercase;white-space:nowrap;}
.badge-transit{background:rgba(30,86,210,.18);color:#5B9FFF;border:1px solid rgba(30,86,210,.35);}
.badge-port{background:rgba(59,175,219,.15);color:#3BAFD8;border:1px solid rgba(59,175,219,.3);}
.badge-customs{background:rgba(240,180,0,.15);color:#F0B400;border:1px solid rgba(240,180,0,.3);}
.badge-delayed{background:rgba(220,60,60,.15);color:#E05050;border:1px solid rgba(220,60,60,.3);}
.badge-arrived{background:rgba(40,200,120,.15);color:#28C878;border:1px solid rgba(40,200,120,.3);}
.badge-default{background:rgba(100,130,160,.15);color:#7A9AB8;border:1px solid rgba(100,130,160,.25);}
.progress-track{width:90px;height:4px;background:#0D1F33;border-radius:2px;overflow:hidden;}
.progress-fill{height:100%;border-radius:2px;transition:width .4s ease;}
`;

const DEFAULT_SHEETS_URL="https://docs.google.com/spreadsheets/d/1e1smHhHSIZ89xltCWhDuK-tQI0LqQN7a0tPSxyLeZzs/gviz/tq?tqx=out:json&sheet=ONE+Line+Daily+Monitor";
const REFRESH_MS=10*60*1000;
const STATUS_CONFIG={
"In Transit":{cls:"badge-transit",icon:"🚢",color:"#5B9FFF",progress:55},
"At Port":{cls:"badge-port",icon:"⚓",color:"#3BAFD8",progress:75},
"Customs":{cls:"badge-customs",icon:"🛂",color:"#F0B400",progress:82},
"Delayed":{cls:"badge-delayed",icon:"⚠️",color:"#E05050",progress:45},
"Arrived":{cls:"badge-arrived",icon:"✅",color:"#28C878",progress:90},
"Delivered":{cls:"badge-arrived",icon:"✅",color:"#28C878",progress:100},
"Departed":{cls:"badge-transit",icon:"🚢",color:"#5B9FFF",progress:30},
};
const getStatusCfg=(s)=>STATUS_CONFIG[s]||{cls:"badge-default",icon:"📦",color:"#7A9AB8",progress:62};

function parseSheets(raw){
const json=JSON.parse(raw.replace(/^[^{]*/,"").replace(/\);?\s*$/,""));
const rows=json.table?.rows||[];
return rows.slice(1).map(r=>{
const cells=r.c||[];
const val=(i)=>cells[i]?.v??cells[i]?.f??"";
return{bl:String(val(0)).trim(),searchBL:String(val(1)).trim(),ctr:String(val(2)).trim(),type:String(val(3)).trim(),orig:String(val(4)).trim(),dest:String(val(5)).trim(),vessel:String(val(6)).trim(),voy:String(val(7)).trim(),eta:String(val(8)).trim(),status:String(val(9)).trim()||"In Transit",updated:String(val(10)).trim(),note:String(val(11)).trim()};
}).filter(r=>r.bl);
}

function exportCSV(shipments){
const headers=["BL Number","Search Code","Container","Type","Origin","Destination","Vessel","Voyage","ETA","Status","Updated","Note"];
const rows=shipments.map(s=>[s.bl,s.searchBL,s.ctr,s.type,s.orig,s.dest,s.vessel,s.voy,s.eta,s.status,s.updated,s.note].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(","));
const csv=[headers.join(","),...rows].join("\n");
const a=document.createElement("a");
a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
a.download="ONE-Line-Monitor-"+new Date().toISOString().slice(0,10)+".csv";
a.click();URL.revokeObjectURL(a.href);
}

function StatusBadge({status}){
const cfg=getStatusCfg(status);
return <span className={"badge "+cfg.cls}><span>{cfg.icon}</span><span>{status||"—"}</span></span>;
}

function ProgressBar({status}){
const cfg=getStatusCfg(status);
return <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:10,color:cfg.color,fontWeight:600,minWidth:30}}>{cfg.progress}%</span><div className="progress-track"><div className="progress-fill" style={{width:cfg.progress+"%",background:cfg.color}}/></div></div>;
}

function KpiCard({label,value,icon,color}){
return <div style={{flex:1,minWidth:140,background:"rgba(8,22,38,.7)",border:"1px solid #0D1F33",borderRadius:8,padding:"14px 18px"}}><div style={{fontSize:9,fontFamily:"'Barlow Condensed'",letterSpacing:2,color:"#2E5070",textTransform:"uppercase",marginBottom:8}}>{label}</div><div style={{display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:32,fontFamily:"'Barlow Condensed'",fontWeight:900,color:color||"#C8DCF0",lineHeight:1}}>{value}</span><span style={{fontSize:20}}>{icon}</span></div></div>;
}

function SettingsModal({sheetsUrl,onSave,onClose}){
const [url,setUrl]=useState(sheetsUrl);
return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}><div style={{background:"#071624",border:"1px solid #1A3554",borderRadius:12,padding:28,width:"100%",maxWidth:520}}><div style={{fontFamily:"'Barlow Condensed'",fontWeight:800,fontSize:18,color:"#C8DCF0",marginBottom:20}}>⚙ SETTINGS</div><label style={{display:"block",fontSize:10,letterSpacing:1.5,color:"#2E5070",marginBottom:8,fontFamily:"'Barlow Condensed'",textTransform:"uppercase"}}>Google Sheets JSON URL</label><input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." style={{width:"100%",padding:"10px 12px",background:"#0D1F33",border:"1px solid #1A3554",borderRadius:6,color:"#C8DCF0",fontSize:10,outline:"none",marginBottom:20}}/><div style={{display:"flex",gap:10,justifyContent:"flex-end"}}><button onClick={onClose} style={{padding:"8px 20px",background:"#0D1F33",color:"#7A9AB8",borderRadius:6,fontSize:13,fontWeight:700}}>CANCEL</button><button onClick={()=>{onSave(url);onClose();}} style={{padding:"8px 20px",background:"#1E56D2",color:"#fff",borderRadius:6,fontSize:13,fontWeight:700}}>SAVE</button></div></div></div>;
}

function AddBLModal({onAdd,onClose}){
const [bl,setBl]=useState("");
return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}><div style={{background:"#071624",border:"1px solid #1A3554",borderRadius:12,padding:28,width:"100%",maxWidth:420}}><div style={{fontFamily:"'Barlow Condensed'",fontWeight:800,fontSize:18,color:"#C8DCF0",marginBottom:20}}>+ ADD SHIPMENT</div><input autoFocus value={bl} onChange={e=>setBl(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&bl.trim()){onAdd(bl.trim().toUpperCase());onClose();}}} placeholder="e.g. TYOG45334400" style={{width:"100%",padding:"10px 12px",background:"#0D1F33",border:"1px solid #1A3554",borderRadius:6,color:"#C8DCF0",fontSize:12,outline:"none",marginBottom:20}}/><div style={{display:"flex",gap:10,justifyContent:"flex-end"}}><button onClick={onClose} style={{padding:"8px 20px",background:"#0D1F33",color:"#7A9AB8",borderRadius:6,fontSize:13,fontWeight:700}}>CANCEL</button><button onClick={()=>{if(bl.trim()){onAdd(bl.trim().toUpperCase());onClose();}}} style={{padding:"8px 20px",background:"#F0A020",color:"#000",borderRadius:6,fontSize:13,fontWeight:800}}>+ ADD</button></div></div></div>;
               }

// ✅ AI REPORT — calls /.netlify/functions/ai-report (server-side proxy)
function AIReportTab({shipments}){
const [report,setReport]=useState("");
const [loading,setLoading]=useState(false);
const [error,setError]=useState("");

const generateReport=useCallback(async()=>{
if(!shipments.length){setError("No shipment data available.");return;}
setLoading(true);setError("");setReport("");
const today=new Date().toLocaleDateString("en-GB",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
const summary=shipments.map((s,i)=>(i+1)+". BL: "+s.bl+" | Container: "+(s.ctr||"N/A")+" | Route: "+(s.orig||"?")+" → "+(s.dest||"?")+" | Status: "+s.status+" | Updated: "+(s.updated||"?")).join("\n");
const statusCounts=shipments.reduce((acc,s)=>{acc[s.status]=(acc[s.status]||0)+1;return acc;},{});
const prompt="You are a senior logistics manager. Generate a professional Daily Cargo Status Report for "+today+".\n\nSHIPMENT DATA ("+shipments.length+" total):\n"+summary+"\n\nSTATUS SUMMARY:\n"+Object.entries(statusCounts).map(([k,v])=>" "+k+": "+v).join("\n")+"\n\nWrite with: 1) Executive Summary 2) Status Breakdown 3) Attention Items 4) Recommendations. Keep it professional and concise.";
try{
const res=await fetch("/.netlify/functions/ai-report",{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({messages:[{role:"user",content:prompt}]}),
});
if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||e.error||"HTTP "+res.status);}
const data=await res.json();
const text=data.content?.find(b=>b.type==="text")?.text||"";
if(!text)throw new Error("Empty response. Check ANTHROPIC_API_KEY in Netlify env vars.");
setReport(text);
}catch(err){setError(err.message);}
finally{setLoading(false);}
},[shipments]);

return <div className="fade-in" style={{padding:"24px 0"}}>
<div style={{display:"flex",alignItems:"center",gap:14,marginBottom:20}}>
<div style={{fontFamily:"'Barlow Condensed'",fontWeight:900,fontSize:22,color:"#C8DCF0",letterSpacing:1}}>⚡ AI DAILY REPORT</div>
<button onClick={generateReport} disabled={loading} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 18px",background:loading?"#1A3554":"#F0A020",color:loading?"#7A9AB8":"#000",borderRadius:6,fontWeight:800,fontSize:13,letterSpacing:1,opacity:loading?.7:1}}>
<span className={loading?"spin":""} style={{display:"inline-block"}}>⚡</span>{loading?"GENERATING...":"REGENERATE"}
</button>
</div>
<div style={{background:"rgba(8,22,38,.8)",border:"1px solid #0D1F33",borderRadius:8,padding:24,minHeight:200,fontSize:13,lineHeight:1.8,color:"#A8C4DC",whiteSpace:"pre-wrap"}}>
{loading&&<div style={{display:"flex",alignItems:"center",gap:12,color:"#5B9FFF"}}><span className="spin" style={{display:"inline-block",fontSize:20}}>⚙</span><span>Analyzing {shipments.length} shipment(s)…</span></div>}
{error&&<div style={{color:"#E05050"}}><strong>✗ Error:</strong> {error}<div style={{marginTop:8,fontSize:11,color:"#7A9AB8"}}>💡 Make sure ANTHROPIC_API_KEY is set in Netlify → Site → Environment Variables.</div></div>}
{!loading&&!error&&!report&&<div style={{textAlign:"center",color:"#2E5070",paddingTop:40}}><div style={{fontSize:32,marginBottom:12}}>📊</div><div style={{fontFamily:"'Barlow Condensed'",fontSize:14,letterSpacing:1}}>CLICK ⚡ TO GENERATE TODAY'S REPORT</div></div>}
{report&&<div>{report}</div>}
</div>
{!loading&&!error&&<div style={{marginTop:10,fontSize:10,color:"#2E5070"}}>Powered by Claude via Netlify serverless function ✅</div>}
</div>;
}

function SetupGuideTab(){
const steps=[
{n:"01",title:"Google Sheets",body:"Create a sheet named 'ONE Line Daily Monitor'. Share as 'Anyone with link → Viewer' and publish to web."},
{n:"02",title:"GitHub Actions Scraper",body:"Add repo secrets: GOOGLE_SHEET_ID, GOOGLE_CREDS, ALERT_EMAIL, SMTP_HOST, SMTP_USER, SMTP_PASS. Scraper runs daily at 08:00 WIB."},
{n:"03",title:"Netlify AI Report",body:"Netlify Dashboard → Site → Environment Variables → Add ANTHROPIC_API_KEY=sk-ant-... The AI Report now calls /.netlify/functions/ai-report server-side."},
{n:"04",title:"Connect Dashboard",body:"Click ⚙ Settings and paste your Google Sheets JSON URL."},
];
return <div className="fade-in" style={{padding:"24px 0"}}>
<div style={{fontFamily:"'Barlow Condensed'",fontWeight:900,fontSize:22,color:"#C8DCF0",letterSpacing:1,marginBottom:20}}>✦ SETUP GUIDE</div>
{steps.map(s=><div key={s.n} style={{display:"flex",gap:16,background:"rgba(8,22,38,.7)",border:"1px solid #0D1F33",borderRadius:8,padding:18,marginBottom:14}}><div style={{fontFamily:"'Barlow Condensed'",fontWeight:900,fontSize:28,color:"#1A3554",minWidth:36,lineHeight:1}}>{s.n}</div><div><div style={{fontFamily:"'Barlow Condensed'",fontWeight:800,fontSize:14,color:"#5B9FFF",marginBottom:6}}>{s.title}</div><div style={{fontSize:11,color:"#7A9AB8",lineHeight:1.7}}>{s.body}</div></div></div>)}
</div>;
  }

function ShipmentsTable({shipments,search,statusFilter,onRemove}){
const filtered=shipments.filter(s=>{
const q=search.toLowerCase();
return(!q||s.bl.toLowerCase().includes(q)||s.searchBL.toLowerCase().includes(q)||s.ctr.toLowerCase().includes(q)||s.vessel.toLowerCase().includes(q))&&(!statusFilter||statusFilter==="All Status"||s.status===statusFilter);
});
if(!filtered.length)return <div style={{textAlign:"center",padding:48,color:"#2E5070",fontSize:12}}>{shipments.length?"No shipments match the current filter.":"No shipments found. Check your Google Sheets connection."}</div>;
return <div style={{overflowX:"auto"}}><table className="tbl"><thead><tr><th style={{width:32}}>#</th><th>BL NUMBER</th><th>SEARCH CODE</th><th>CONTAINER</th><th>TYPE</th><th>ROUTE</th><th>VESSEL / VOY</th><th>ETA</th><th>STATUS</th><th>PROGRESS</th><th>UPDATED</th><th>ACTIONS</th></tr></thead><tbody>{filtered.map((s,i)=>{const blUrl="https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam="+s.searchBL+"&trakNoTpCdParam=B";return <tr key={s.bl+i} className="fade-in"><td style={{color:"#2E5070",fontSize:10}}>{i+1}</td><td><a href={blUrl} target="_blank" rel="noopener noreferrer" style={{color:"#5B9FFF",textDecoration:"none",fontWeight:600}}>{s.bl}</a></td><td style={{color:"#F0A020",fontSize:10}}>{s.searchBL||"—"}</td><td style={{fontSize:10}}>{s.ctr||"—"}</td><td>{s.type?<span style={{background:"#0D1F33",border:"1px solid #1A3554",borderRadius:3,padding:"2px 6px",fontSize:9,color:"#7A9AB8"}}>{s.type}</span>:"—"}</td><td style={{fontSize:10,color:"#7A9AB8",whiteSpace:"nowrap"}}>{s.orig||"?"} → {s.dest||"?"}</td><td style={{fontSize:10,color:"#7A9AB8",whiteSpace:"nowrap"}}>{s.vessel||"—"} {s.voy?"/"+s.voy:"/ —"}</td><td style={{fontSize:10,whiteSpace:"nowrap"}}>{s.eta||"—"}</td><td><StatusBadge status={s.status}/></td><td><ProgressBar status={s.status}/></td><td style={{fontSize:10,color:"#7A9AB8",whiteSpace:"nowrap"}}>{s.updated||"—"}</td><td><div style={{display:"flex",gap:6}}><a href={blUrl} target="_blank" rel="noopener noreferrer" style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 10px",background:"#0D1F33",border:"1px solid #1A3554",borderRadius:4,fontSize:10,color:"#5B9FFF",textDecoration:"none",fontFamily:"'Barlow Condensed'",fontWeight:700}}>🔗 TRACK</a><button onClick={()=>onRemove(s.bl)} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:28,height:28,background:"rgba(220,60,60,.1)",border:"1px solid rgba(220,60,60,.3)",borderRadius:4,color:"#E05050",fontSize:12}}>✕</button></div></td></tr>;})}
</tbody></table></div>;
}

export default function App(){
const [sheetsUrl,setSheetsUrl]=useState(()=>localStorage.getItem("sheetsUrl")||DEFAULT_SHEETS_URL);
const [shipments,setShipments]=useState([]);
const [loading,setLoading]=useState(true);
const [error,setError]=useState("");
const [lastSync,setLastSync]=useState(null);
const [connected,setConnected]=useState(false);
const [tab,setTab]=useState("shipments");
const [search,setSearch]=useState("");
const [statusFilter,setStatusFilter]=useState("All Status");
const [showSettings,setShowSettings]=useState(false);
const [showAddBL,setShowAddBL]=useState(false);
const [hiddenBLs,setHiddenBLs]=useState(()=>JSON.parse(localStorage.getItem("hiddenBLs")||"[]"));
const intervalRef=useRef(null);

const fetchSheets=useCallback(async(url)=>{
setLoading(true);setError("");
try{
const res=await fetch(url+"&cacheBust="+Date.now());
if(!res.ok)throw new Error("HTTP "+res.status);
const text=await res.text();
const parsed=parseSheets(text);
setShipments(parsed.filter(s=>!hiddenBLs.includes(s.bl)));
setConnected(true);setLastSync(new Date());
}catch(e){setError("Cannot connect to Google Sheets. Check the URL in Settings.");setConnected(false);}
finally{setLoading(false);}
},[hiddenBLs]);

useEffect(()=>{
fetchSheets(sheetsUrl);
intervalRef.current=setInterval(()=>fetchSheets(sheetsUrl),REFRESH_MS);
return()=>clearInterval(intervalRef.current);
},[sheetsUrl,fetchSheets]);

useEffect(()=>{localStorage.setItem("sheetsUrl",sheetsUrl);},[sheetsUrl]);
useEffect(()=>{localStorage.setItem("hiddenBLs",JSON.stringify(hiddenBLs));},[hiddenBLs]);

const handleRemove=(bl)=>{setHiddenBLs(p=>[...p,bl]);setShipments(p=>p.filter(s=>s.bl!==bl));};
const handleAddBL=(bl)=>{if(!shipments.find(s=>s.bl===bl))setShipments(p=>[...p,{bl,searchBL:bl.startsWith("ONEY")?bl.slice(4):bl,ctr:"",type:"",orig:"",dest:"",vessel:"",voy:"",eta:"",status:"In Transit",updated:"",note:""}]);};

const counts=shipments.reduce((acc,s)=>{acc.total++;const st=s.status;if(st==="In Transit"||st==="Departed")acc.transit++;else if(st==="At Port"||st==="Customs"||st==="Arrived")acc.port++;else if(st==="Delayed")acc.delayed++;if(st==="Delivered")acc.delivered++;return acc;},{total:0,transit:0,port:0,delayed:0,delivered:0});
const statuses=["All Status",...new Set(shipments.map(s=>s.status))];
const formattedSync=lastSync?lastSync.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"}):"—";

return <>
<style>{GLOBAL_CSS}</style>
<header style={{background:"#060F1C",borderBottom:"1px solid #0D1F33",padding:"0 20px",display:"flex",alignItems:"center",justifyContent:"space-between",height:52,position:"sticky",top:0,zIndex:100}}>
<div style={{display:"flex",alignItems:"center",gap:12}}>
<span style={{fontSize:20}}>🚢</span>
<div>
<div style={{fontFamily:"'Barlow Condensed'",fontWeight:900,fontSize:17,color:"#C8DCF0",letterSpacing:1,lineHeight:1}}>ONE LINE LIVE MONITOR</div>
<div style={{fontSize:9,color:connected?"#28C878":"#E05050",letterSpacing:1.5,fontFamily:"'Barlow Condensed'"}}>
<span className={connected?"":"pulse"} style={{marginRight:4}}>●</span>{connected?"CONNECTED TO GOOGLE SHEETS":"DISCONNECTED"}
</div>
</div>
</div>
<div style={{display:"flex",alignItems:"center",gap:8}}>
<span style={{fontSize:11,color:"#2E5070",marginRight:4}}>{new Date().toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric"})}</span>
<button onClick={()=>setShowSettings(true)} style={{padding:"6px 14px",background:"#0D1F33",border:"1px solid #1A3554",borderRadius:6,color:"#7A9AB8",fontSize:12,fontWeight:700,letterSpacing:1}}>⚙ SETTINGS</button>
<button onClick={()=>exportCSV(shipments)} style={{padding:"6px 14px",background:"#0D1F33",border:"1px solid #1A3554",borderRadius:6,color:"#7A9AB8",fontSize:12,fontWeight:700,letterSpacing:1}}>↓ CSV</button>
<button onClick={()=>setTab("ai")} style={{padding:"6px 14px",background:"#F0A020",borderRadius:6,color:"#000",fontSize:12,fontWeight:800,letterSpacing:1}}>⚡ AI REPORT</button>
<button onClick={()=>setShowAddBL(true)} style={{padding:"6px 14px",background:"#1E56D2",borderRadius:6,color:"#fff",fontSize:12,fontWeight:800,letterSpacing:1}}>+ ADD BL</button>
</div>
</header>
<div style={{background:"#060F1C",borderBottom:"1px solid #0D1F33",padding:"6px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:10,color:"#2E5070"}}>
<div>{loading?<span style={{color:"#F0A020"}}><span className="pulse" style={{marginRight:6}}>●</span>Syncing…</span>:<span>Live · last synced {formattedSync} · auto-refresh every 10 min</span>}</div>
<button onClick={()=>fetchSheets(sheetsUrl)} style={{background:"none",border:"none",color:"#2E5070",fontSize:10,cursor:"pointer",letterSpacing:1,fontFamily:"'Barlow Condensed'",fontWeight:700}}>↺ REFRESH NOW</button>
</div>
<main style={{padding:"16px 20px",maxWidth:1400,margin:"0 auto"}}>
<div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:20}}>
<KpiCard label="Total" value={counts.total} icon="📦" color="#C8DCF0"/>
<KpiCard label="In Transit" value={counts.transit} icon="🚢" color="#5B9FFF"/>
<KpiCard label="At Port/Customs" value={counts.port} icon="⚓" color="#3BAFD8"/>
<KpiCard label="Delayed" value={counts.delayed} icon="⚠️" color="#E05050"/>
<KpiCard label="Arrived" value={counts.delivered} icon="✅" color="#28C878"/>
</div>
<div style={{borderBottom:"1px solid #0D1F33",marginBottom:20,display:"flex"}}>
{[{id:"shipments",label:"■ SHIPMENTS"},{id:"ai",label:"⚡ AI REPORT"},{id:"guide",label:"✦ SETUP GUIDE"}].map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"10px 18px",background:"none",borderBottom:tab===t.id?"2px solid #1E56D2":"2px solid transparent",color:tab===t.id?"#5B9FFF":"#2E5070",fontFamily:"'Barlow Condensed'",fontWeight:700,fontSize:12,letterSpacing:1.5,transition:"all .15s"}}>{t.label}</button>)}
</div>
{tab==="shipments"&&<div className="fade-in">
<div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap"}}>
<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search BL, container, vessel, port…" style={{flex:1,minWidth:220,padding:"8px 12px",background:"#07121E",border:"1px solid #1A3554",borderRadius:6,color:"#C8DCF0",fontSize:11,outline:"none"}}/>
<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)} style={{padding:"8px 12px",background:"#07121E",border:"1px solid #1A3554",borderRadius:6,color:"#C8DCF0",fontSize:11,outline:"none",cursor:"pointer"}}>
{statuses.map(s=><option key={s}>{s}</option>)}
</select>
</div>
{error&&<div style={{background:"rgba(220,60,60,.1)",border:"1px solid rgba(220,60,60,.3)",borderRadius:6,padding:"10px 14px",color:"#E05050",fontSize:11,marginBottom:14}}>✗ {error}</div>}
<div style={{background:"rgba(8,22,38,.7)",border:"1px solid #0D1F33",borderRadius:8,overflow:"hidden"}}>
{loading?<div style={{textAlign:"center",padding:48,color:"#2E5070"}}><span className="spin" style={{display:"inline-block",fontSize:22}}>⚙</span><div style={{marginTop:10,fontSize:11}}>Loading shipment data…</div></div>:<ShipmentsTable shipments={shipments} search={search} statusFilter={statusFilter} onRemove={handleRemove}/>}
</div>
</div>}
{tab==="ai"&&<AIReportTab shipments={shipments}/>}
{tab==="guide"&&<SetupGuideTab/>}
</main>
{showSettings&&<SettingsModal sheetsUrl={sheetsUrl} onSave={url=>{setSheetsUrl(url);setHiddenBLs([]);}} onClose={()=>setShowSettings(false)}/>}
{showAddBL&&<AddBLModal onAdd={handleAddBL} onClose={()=>setShowAddBL(false)}/>}
</>;
  }
