import { useState, useEffect, useCallback, useRef } from "react";


const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Barlow+Condensed:wght@500;600;700;800;900&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{background:#05111F;color:#C8DCF0;font-family:'IBM Plex Mono',monospace;min-height:100vh;}
::-webkit-scrollbar{width:5px;height:5px;}::-webkit-scrollbar-track{background:#05111F;}::-webkit-scrollbar-thumb{background:#1A3554;border-radius:3px;}
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
