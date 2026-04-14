import { useState, useMemo } from "react";

const safe=v=>(v==null||!isFinite(v)||isNaN(v))?null:v;
const div=(a,b)=>(b==null||Math.abs(b)<1e-10)?null:safe(a/b);
const pmtF=(P,r,n)=>{if(!P||P<=0||!n||n<=0)return 0;if(r<1e-8)return P/n;return P*r/(1-Math.pow(1+r,-n));};
const balF=(P,r,n,k)=>{if(!P||P<=0)return 0;if(k>=n)return 0;if(r<1e-8)return Math.max(0,P*(1-k/n));const p=pmtF(P,r,n);return Math.max(0,P*Math.pow(1+r,k)-p*(Math.pow(1+r,k)-1)/r);};
const npvF=(cfs,r)=>{try{return cfs.reduce((s,c,i)=>s+(isFinite(c)?c:0)/Math.pow(1+r,i),0);}catch{return null;}};
function irrF(cfs){
  try{
    const cl=cfs.map(c=>isFinite(c)?c:0);
    const f=r=>cl.reduce((s,c,i)=>s+c/Math.pow(1+r,i),0);
    if(!cl.some(c=>c>0)||!cl.some(c=>c<0))return null;
    let lo=-0.9,hi=50;
    if(f(lo)*f(hi)>0){hi=500;if(f(lo)*f(hi)>0)return null;}
    for(let i=0;i<600;i++){const m=(lo+hi)/2;const fm=f(m);if(!isFinite(fm))return null;if(Math.abs(fm)<0.1)return m;fm>0?lo=m:hi=m;}
    return(lo+hi)/2;
  }catch{return null;}
}

const BATT=105000,BOP=30000,TRAFO_B=450000,TRAFO_MW=11,RTB=600000;
const RTE0=0.8661,RTEDEG=0.0032;
const capexFn=(mwh,mw)=>Math.max(1,mwh)*(BATT+BOP)+Math.max(1,mw)*(TRAFO_B/TRAFO_MW)+RTB;

function buildYrs(sp,cr,mwh,op1,op2){
  return Array.from({length:20},(_,i)=>{
    const y=i+1,rte=Math.max(0.70,RTE0-RTEDEG*(y-1));
    const eR=Math.max(0,mwh)*rte*Math.max(0,sp)*365;
    const opex=y<=5?op1:op2;
    return{y,rte,eR,opex,ebitda:eR+Math.max(0,cr)-opex};
  });
}

function runModel(sp,cr,mwh,mw,op1,op2,pctTIM,buyoutPct,bkLev,bkRate,bkTenor,hR,payMode){
  try{
    const CAPEX=capexFn(mwh,mw);
    const pct=Math.min(1,Math.max(0,pctTIM/100));
    const bkDebt=CAPEX*Math.min(0.99,Math.max(0,bkLev/100));
    const timEq=Math.max(1,CAPEX-bkDebt);
    const rB=Math.max(0.001,bkRate/100);
    const rh=Math.max(0.001,hR/100);
    const tnr=Math.max(1,bkTenor);
    const bankDS=bkDebt>0?pmtF(bkDebt,rB,tnr):0;
    const bankBal5=bkDebt>0&&tnr>5?balF(bkDebt,rB,tnr,5):0;
    const buyout=CAPEX*Math.max(0,buyoutPct/100);
    const yrs=buildYrs(sp,cr,mwh,op1,op2);
    const ebitdaY1=yrs[0].ebitda;
    const fixedPmt=pct*Math.max(0,ebitdaY1);
    let oenCum=0,payback=null;
    const rows=yrs.map(yr=>{
      const eb=yr.ebitda;
      let pmtToTIM=0;
      if(yr.y<=4){pmtToTIM=payMode==="fixed"?fixedPmt:pct*Math.max(0,eb);}
      else if(yr.y===5){pmtToTIM=buyout;}
      const oenNet=eb-pmtToTIM;
      const dscrOen=pmtToTIM>1e-6?safe(eb/pmtToTIM):null;
      const dscrTIM=(bankDS>1e-6&&yr.y<=4)?safe(pmtToTIM/bankDS):null;
      oenCum+=oenNet;
      if(oenCum>=CAPEX&&payback===null)payback=yr.y;
      const pctToTIM=eb>1e-6?Math.min(100,pmtToTIM/eb*100):(pmtToTIM>0?100:0);
      return{...yr,pmtToTIM,oenNet,oenCum,dscrOen,dscrTIM,pctToTIM,pctToOen:Math.max(0,100-pctToTIM)};
    });
    const timCFs=[-timEq];
    for(let i=0;i<4;i++)timCFs.push(rows[i].pmtToTIM-bankDS);
    timCFs.push(buyout-bankBal5);
    const timIRR=irrF(timCFs);
    const timNetRec=timCFs.slice(1).reduce((s,c)=>s+(isFinite(c)?c:0),0);
    const timMOIC=timEq>0?safe(timNetRec/timEq)??0:0;
    const timNPV=npvF(timCFs,rh);
    const tot20=yrs.reduce((s,y)=>s+y.ebitda,0);
    const tot20Net=rows.reduce((s,r)=>s+r.oenNet,0);
    const dOenVals=rows.slice(0,4).map(r=>r.dscrOen).filter(v=>v!=null);
    const dTIMVals=rows.slice(0,4).map(r=>r.dscrTIM).filter(v=>v!=null);
    return{
      CAPEX,timEq,bkDebt,bankDS,bankBal5,buyout,fixedPmt,ebitdaY1,
      timCFs,timIRR,timMOIC,timNPV,timNetRec,rows,payback,tot20,tot20Net,
      oen20MOIC:CAPEX>0?safe(tot20Net/CAPEX)??0:0,
      dscrOenAvg:dOenVals.length>0?dOenVals.reduce((s,v)=>s+v,0)/dOenVals.length:null,
      dscrTIMAvg:dTIMVals.length>0?dTIMVals.reduce((s,v)=>s+v,0)/dTIMVals.length:null,
      meetIRR:timIRR!=null&&timIRR>=0.15,
      meetMOIC:timMOIC>=1.5,
    };
  }catch(e){console.error(e);return null;}
}

function findOpt(sp,cr,mwh,mw,op1,op2,buyoutPct,bkLev,bkRate,bkTenor,hR,payMode){
  for(let p=1;p<=100;p+=0.5){
    try{
      const r=runModel(sp,cr,mwh,mw,op1,op2,p,buyoutPct,bkLev,bkRate,bkTenor,hR,payMode);
      if(r&&r.meetIRR&&r.meetMOIC)return parseFloat(p.toFixed(1));
    }catch{}
  }
  return null;
}

const f$=v=>(v==null||!isFinite(v))?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(v);
const fp=v=>(v==null||!isFinite(v))?"—":(v*100).toFixed(1)+"%";
const fm=v=>(v==null||!isFinite(v))?"—":v.toFixed(2)+"x";
const pn=v=>(v==null||!isFinite(v))?"—":v.toFixed(1)+"%";
const fd=v=>(v==null||!isFinite(v))?"—":v.toFixed(2)+"x";
const dscrCol=v=>!v?"#9ca3af":v>=1.25?"#059669":v>=1.0?"#d97706":"#dc2626";
const dscrSt=v=>!v?"neutral":v>=1.25?"ok":v>=1.0?"warn":"fail";

function Sld({label,min,max,step,val,set,disp,note,col}){
  const ac={blue:"#3b82f6",purple:"#8b5cf6",amber:"#f59e0b",teal:"#0d9488",green:"#10b981",gray:"#6b7280",red:"#ef4444"}[col]||"#3b82f6";
  return(
    <div style={{marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
        <span style={{fontSize:11,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.06em"}}>{label}</span>
        <span style={{fontSize:13,fontWeight:600,fontFamily:"monospace",color:ac}}>{disp(val)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val} onChange={e=>set(+e.target.value)} style={{width:"100%",height:4,accentColor:ac,cursor:"pointer"}}/>
      {note&&<p style={{fontSize:10,color:"#9ca3af",marginTop:2,fontStyle:"italic",lineHeight:1.4}}>{note}</p>}
    </div>
  );
}
function KPI({label,val,sub,st,sm}){
  const tc={ok:"#059669",fail:"#dc2626",warn:"#d97706",neutral:"#374151",info:"#2563eb"}[st||"neutral"];
  const bg={ok:"#ecfdf5",fail:"#fef2f2",warn:"#fffbeb",neutral:"#f9fafb",info:"#eff6ff"}[st||"neutral"];
  const br={ok:"#a7f3d0",fail:"#fecaca",warn:"#fde68a",neutral:"#e5e7eb",info:"#bfdbfe"}[st||"neutral"];
  return(
    <div style={{background:bg,border:`1px solid ${br}`,borderRadius:10,padding:sm?"8px 10px":"11px 13px"}}>
      <p style={{fontSize:10,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.07em",margin:0}}>{label}</p>
      <p style={{fontSize:sm?13:17,fontWeight:700,fontFamily:"monospace",color:tc,margin:"3px 0 2px"}}>{val}</p>
      {sub&&<p style={{fontSize:10,color:"#6b7280",lineHeight:1.4,margin:0}}>{sub}</p>}
    </div>
  );
}
function Box({title,col,accent,children}){
  const tc={blue:"#2563eb",purple:"#7c3aed",amber:"#d97706",teal:"#0d9488",green:"#059669",gray:"#6b7280"}[col]||"#6b7280";
  return(
    <div style={{background:"#fff",border:accent?`2px solid ${tc}`:"1px solid #e5e7eb",borderRadius:12,padding:13,marginBottom:10}}>
      {title&&<h3 style={{fontSize:10,fontWeight:700,color:tc,textTransform:"uppercase",letterSpacing:"0.1em",margin:"0 0 10px"}}>{title}</h3>}
      {children}
    </div>
  );
}
function Hr(){return <div style={{borderTop:"1px solid #f3f4f6",margin:"9px 0"}}/>;}
function SplitBar({timPct,h}){
  const t=Math.min(100,Math.max(0,timPct||0));
  return(
    <div style={{display:"flex",borderRadius:4,overflow:"hidden",height:h||14}}>
      <div style={{width:`${t}%`,background:"#3b82f6",transition:"width 0.2s"}}/>
      <div style={{width:`${100-t}%`,background:"#10b981",transition:"width 0.2s"}}/>
    </div>
  );
}
function DSCRBox({val,label}){
  const col=dscrCol(val);
  const bg=!val?"#f9fafb":val>=1.25?"#ecfdf5":val>=1.0?"#fffbeb":"#fef2f2";
  const br=!val?"#e5e7eb":val>=1.25?"#a7f3d0":val>=1.0?"#fde68a":"#fecaca";
  return(
    <div style={{background:bg,border:`1px solid ${br}`,borderRadius:7,padding:"6px 10px",textAlign:"center",flex:1}}>
      <p style={{fontSize:9,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.05em",margin:0}}>{label}</p>
      <p style={{fontSize:15,fontWeight:700,fontFamily:"monospace",color:col,margin:"2px 0"}}>{fd(val)}</p>
      <p style={{fontSize:9,color:col,margin:0,fontWeight:600}}>{!val?"n/a":val>=1.25?"✓ ≥1.25x":val>=1.0?"⚠ 1.0–1.25x":"✗ <1.0x"}</p>
    </div>
  );
}
function ScenCol({label,badge,borderCol,r,CAPEX}){
  if(!r)return(
    <div style={{flex:1,background:"#f9fafb",border:"1px dashed #d1d5db",borderRadius:12,padding:13,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <p style={{fontSize:11,color:"#9ca3af",textAlign:"center"}}>Sin solución<br/>con parámetros actuales</p>
    </div>
  );
  const ok=r.meetIRR&&r.meetMOIC,partial=r.meetIRR||r.meetMOIC;
  return(
    <div style={{flex:1,minWidth:0,background:"#fff",border:`2px solid ${borderCol}`,borderRadius:12,padding:13}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
        <div>
          <p style={{fontSize:10,fontWeight:700,color:"#374151",textTransform:"uppercase",letterSpacing:"0.07em",margin:0}}>{label}</p>
          {badge&&<p style={{fontSize:10,color:"#6b7280",margin:"3px 0 0"}}>{badge}</p>}
        </div>
        <span style={{fontSize:11,fontWeight:700,color:ok?"#059669":partial?"#d97706":"#dc2626"}}>{ok?"✓ TIM OK":partial?"⚠":"✗"}</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
        <KPI label="TIR TIM" val={r.timIRR!=null?fp(r.timIRR):"N/A"} sub="Mín 15%" st={r.meetIRR?"ok":"fail"} sm/>
        <KPI label="MOIC TIM" val={fm(r.timMOIC)} sub="Mín 1.5x" st={r.meetMOIC?"ok":"fail"} sm/>
        <KPI label="Capital TIM" val={f$(r.timEq)} sub={r.bkDebt>0?`+${f$(r.bkDebt)} banco`:"equity puro"} st="neutral" sm/>
        <KPI label="Payback" val={r.payback?`Año ${r.payback}`:"¿>20?"} st={r.payback&&r.payback<=15?"ok":r.payback?"warn":"fail"} sm/>
      </div>
      <Hr/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
        <KPI label="FCF Oenergy Y1" val={f$(r.rows[0]?.oenNet)} sub={`retiene ${pn(r.rows[0]?.pctToOen)}`} st={r.rows[0]?.oenNet>=0?"ok":"fail"} sm/>
        <KPI label="FCF Oenergy 20yr" val={f$(r.tot20Net)} sub={fm(r.oen20MOIC)+" × CAPEX"} st={r.oen20MOIC>=1?"ok":"warn"} sm/>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:8}}>
        <DSCRBox val={r.dscrOenAvg} label="DSCR Oen avg"/>
        {r.dscrTIMAvg!=null&&<DSCRBox val={r.dscrTIMAvg} label="DSCR TIM-bco avg"/>}
      </div>
      <SplitBar timPct={r.rows[0]?.pctToTIM||0} h={12}/>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:3,fontSize:10,fontFamily:"monospace"}}>
        <span style={{color:"#3b82f6",fontWeight:700}}>{pn(r.rows[0]?.pctToTIM)} TIM</span>
        <span style={{color:"#10b981",fontWeight:700}}>{pn(r.rows[0]?.pctToOen)} Oen</span>
      </div>
    </div>
  );
}

export default function App(){
  const[mw,setMw]=useState(11);
  const[mwh,setMwh]=useState(55);
  const[projectName,setProjectName]=useState("Pozo Almonte");
  const[sp,setSp]=useState(65);
  const[cr,setCr]=useState(396000);
  const[op1,setOp1]=useState(285000);
  const[op2,setOp2]=useState(430000);
  const[pctTIM,setPctTIM]=useState(70);
  const[buyoutPct,setBuyoutPct]=useState(90);
  const[payMode,setPayMode]=useState("fixed");
  const[bkLev,setBkLev]=useState(60);
  const[bkRate,setBkRate]=useState(8);
  const[bkTenor,setBkTenor]=useState(12);
  const[hR,setHR]=useState(15);
  const[tab,setTab]=useState("split");
  const[sel,setSel]=useState(1);

  const CAPEX=useMemo(()=>capexFn(mwh,mw),[mwh,mw]);
  const dur=mw>0?(mwh/mw).toFixed(1):"—";

  const s0=useMemo(()=>runModel(sp,cr,mwh,mw,op1,op2,pctTIM,buyoutPct,0,bkRate,bkTenor,hR,payMode),[sp,cr,mwh,mw,op1,op2,pctTIM,buyoutPct,bkRate,bkTenor,hR,payMode]);
  const s1=useMemo(()=>runModel(sp,cr,mwh,mw,op1,op2,pctTIM,buyoutPct,bkLev,bkRate,bkTenor,hR,payMode),[sp,cr,mwh,mw,op1,op2,pctTIM,buyoutPct,bkLev,bkRate,bkTenor,hR,payMode]);
  const optPct=useMemo(()=>findOpt(sp,cr,mwh,mw,op1,op2,buyoutPct,bkLev,bkRate,bkTenor,hR,payMode),[sp,cr,mwh,mw,op1,op2,buyoutPct,bkLev,bkRate,bkTenor,hR,payMode]);
  const s2=useMemo(()=>optPct!=null?runModel(sp,cr,mwh,mw,op1,op2,optPct,buyoutPct,bkLev,bkRate,bkTenor,hR,payMode):null,[sp,cr,mwh,mw,op1,op2,optPct,buyoutPct,bkLev,bkRate,bkTenor,hR,payMode]);

  const active=sel===0?s0:sel===2?(s2||s1):s1;
  const buyoutAbs=CAPEX*(buyoutPct/100);
  const hOk=s1&&s1.meetIRR&&s1.meetMOIC;
  const hP=s1&&(s1.meetIRR||s1.meetMOIC);
  const[hbg,hbr,hcl]=hOk?["#ecfdf5","#6ee7b7","#065f46"]:hP?["#fffbeb","#fcd34d","#92400e"]:["#fef2f2","#fca5a5","#7f1d1d"];

  const exportPDF=()=>{
    if(!active)return;
    const sc=sel===0?"Sin apalancamiento TIM":sel===2?"Óptimo (mínimo TIM)":"Con banco TIM";
    const rows=active.rows;
    const buildRows=()=>rows.map(r=>{
      const isPb=active.payback===r.y,isY5=r.y===5,isFree=r.y>=6;
      const bg=isPb?"#d1fae5":isY5?"#fee2e2":isFree?"#f0fdf4":r.y%2===0?"#fafafa":"#fff";
      const phase=r.y<=4?"Período TIM":r.y===5?"Buyout":"Libre";
      const dscrOen=r.dscrOen!=null?r.dscrOen.toFixed(2)+"x":isFree?"∞":"—";
      const dscrTIM=r.dscrTIM!=null?r.dscrTIM.toFixed(2)+"x":"—";
      return`<tr style="background:${bg};border-bottom:1px solid #e5e7eb">
        <td style="padding:5px 8px;font-weight:700;color:${isY5?"#dc2626":isFree?"#059669":"#2563eb"};white-space:nowrap">Y${r.y}${isPb?" ★":""}</td>
        <td style="padding:5px 8px;font-size:11px;color:${isY5?"#dc2626":isFree?"#059669":"#2563eb"}">${phase}</td>
        <td style="padding:5px 8px;text-align:right">${(r.rte*100).toFixed(1)}%</td>
        <td style="padding:5px 8px;text-align:right">${f$(r.eR)}</td>
        <td style="padding:5px 8px;text-align:right">${f$(cr)}</td>
        <td style="padding:5px 8px;text-align:right">(${f$(r.opex)})</td>
        <td style="padding:5px 8px;text-align:right;font-weight:700;color:${r.ebitda<0?"#dc2626":"#111827"}">${f$(r.ebitda)}</td>
        <td style="padding:5px 8px;text-align:right;color:${r.pmtToTIM>0?"#2563eb":"#9ca3af"}">${r.pmtToTIM>0?"("+f$(r.pmtToTIM)+")":"—"}</td>
        <td style="padding:5px 8px;text-align:right;font-weight:700;color:${r.oenNet<0?"#dc2626":"#059669"}">${f$(r.oenNet)}</td>
        <td style="padding:5px 8px;text-align:right;font-weight:700;color:${r.oenCum<0?"#dc2626":r.oenCum>=CAPEX?"#059669":"#d97706"}">${f$(r.oenCum)}${isPb?" ★":""}</td>
        <td style="padding:5px 8px;text-align:right;font-weight:700;color:${!r.dscrOen?"#9ca3af":r.dscrOen>=1.25?"#059669":r.dscrOen>=1.0?"#d97706":"#dc2626"}">${dscrOen}</td>
        <td style="padding:5px 8px;text-align:right;font-weight:700;color:${!r.dscrTIM?"#9ca3af":r.dscrTIM>=1.25?"#059669":r.dscrTIM>=1.0?"#d97706":"#dc2626"}">${dscrTIM}</td>
      </tr>`;
    }).join("");
    const mkKPI=(label,val,col)=>`<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;text-align:center;flex:1">
      <p style="font-size:10px;color:#9ca3af;text-transform:uppercase;margin:0 0 4px">${label}</p>
      <p style="font-size:16px;font-weight:700;font-family:monospace;color:${col};margin:0">${val}</p>
    </div>`;
    const scStatus=active.meetIRR&&active.meetMOIC?"✓ TIM cumple TIR≥15% y MOIC≥1.5x":active.meetIRR||active.meetMOIC?"⚠ Cumple parcialmente":"✗ TIM no cumple criterios";
    const statusCol=active.meetIRR&&active.meetMOIC?"#059669":active.meetIRR||active.meetMOIC?"#d97706":"#dc2626";
    const html=`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>${projectName} — Análisis BESS — Reporte</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:system-ui,sans-serif;background:#fff;color:#111827;padding:24px;font-size:12px}
      h1{font-size:20px;font-weight:700;margin-bottom:4px}
      h2{font-size:13px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.08em;margin:20px 0 10px;padding-bottom:4px;border-bottom:2px solid #e5e7eb}
      table{width:100%;border-collapse:collapse;font-size:11px}
      th{padding:6px 8px;background:#f9fafb;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;border-bottom:2px solid #e5e7eb;white-space:nowrap}
      th:first-child,th:nth-child(2){text-align:left}
      .kpi-row{display:flex;gap:10px;margin-bottom:12px}
      .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
      .grid5{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px}
      .chip{display:inline-block;padding:4px 12px;border-radius:6px;font-weight:700;font-size:12px}
      @media print{body{padding:12px}h2{margin-top:14px}}
    </style></head><body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
      <div>
        <h1>${projectName} — BESS ${mw} MW / ${mwh} MWh</h1>
        <p style="color:#6b7280;font-size:11px;margin-top:3px">CAPEX ${f$(CAPEX)} · ${dur}h duración · TIM equity${bkLev>0?` + ${bkLev}% banco (${bkRate}%, ${bkTenor}yr)`:""} · Pago Oenergy: ${payMode==="fixed"?"% fijo ($)":"% variable"} · Vida 20 años</p>
        <p style="color:#6b7280;font-size:11px;margin-top:2px">Escenario activo: <strong>${sc}</strong> · % TIM: ${pctTIM}% · Buyout Y5: ${buyoutPct}% CAPEX = ${f$(buyoutAbs)}</p>
      </div>
      <div style="text-align:right">
        <span class="chip" style="background:${active.meetIRR&&active.meetMOIC?"#ecfdf5":active.meetIRR||active.meetMOIC?"#fffbeb":"#fef2f2"};color:${statusCol}">${scStatus}</span>
        <p style="font-size:10px;color:#9ca3af;margin-top:4px">Generado: ${new Date().toLocaleDateString("es-CL",{day:"2-digit",month:"short",year:"numeric"})}</p>
      </div>
    </div>
    <h2>Retorno TIM / Taranis</h2>
    <div class="grid4">
      ${mkKPI("TIR TIM",active.timIRR!=null?fp(active.timIRR):"N/A",active.meetIRR?"#059669":"#dc2626")}
      ${mkKPI("MOIC TIM",fm(active.timMOIC),active.meetMOIC?"#059669":"#dc2626")}
      ${mkKPI("Capital TIM",f$(active.timEq),"#374151")}
      ${mkKPI("NPV TIM",f$(active.timNPV),active.timNPV>=0?"#059669":"#dc2626")}
    </div>
    <h2>Flujo de caja Oenergy — 20 años</h2>
    <table>
      <thead><tr>
        <th style="text-align:left">Año</th><th style="text-align:left">Fase</th><th>RTE</th>
        <th>Ing. Energía</th><th>Rev. Cap.</th><th>OPEX</th><th>EBITDA</th>
        <th>→ TIM</th><th>FCF Oenergy</th><th>FCF Acum.</th>
        <th>DSCR Oen.</th><th>DSCR TIM-bco</th>
      </tr></thead>
      <tbody>${buildRows()}</tbody>
      <tfoot><tr style="background:#f3f4f6;border-top:2px solid #d1d5db;font-weight:700">
        <td colspan="2" style="padding:6px 8px">TOTAL Y1–20</td>
        <td></td><td></td>
        <td style="padding:6px 8px;text-align:right;color:#7c3aed">${f$(cr*20)}</td>
        <td style="padding:6px 8px;text-align:right;color:#9ca3af">(${f$(rows.reduce((s,r)=>s+r.opex,0))})</td>
        <td style="padding:6px 8px;text-align:right">${f$(active.tot20)}</td>
        <td style="padding:6px 8px;text-align:right;color:#2563eb">(${f$(rows.reduce((s,r)=>s+r.pmtToTIM,0))})</td>
        <td style="padding:6px 8px;text-align:right;color:${active.tot20Net>=0?"#059669":"#dc2626"}">${f$(active.tot20Net)}</td>
        <td style="padding:6px 8px;text-align:right;color:${active.oen20MOIC>=1?"#059669":"#dc2626"}">${fm(active.oen20MOIC)}×CAPEX</td>
        <td style="padding:6px 8px;text-align:right;color:${!active.dscrOenAvg?"#9ca3af":active.dscrOenAvg>=1.25?"#059669":active.dscrOenAvg>=1?"#d97706":"#dc2626"}">${active.dscrOenAvg!=null?active.dscrOenAvg.toFixed(2)+"x avg":"—"}</td>
        <td style="padding:6px 8px;text-align:right;color:${!active.dscrTIMAvg?"#9ca3af":active.dscrTIMAvg>=1.25?"#059669":active.dscrTIMAvg>=1?"#d97706":"#dc2626"}">${active.dscrTIMAvg!=null?active.dscrTIMAvg.toFixed(2)+"x avg":"—"}</td>
      </tr></tfoot>
    </table>
    <h2>Resumen Oenergy 20 años</h2>
    <div class="grid5">
      ${mkKPI("EBITDA total 20yr",f$(active.tot20),"#374151")}
      ${mkKPI("Total → TIM",f$(rows.slice(0,5).reduce((s,r)=>s+r.pmtToTIM,0)),"#3b82f6")}
      ${mkKPI("FCF neto Oenergy",f$(active.tot20Net),active.tot20Net>=CAPEX?"#059669":active.tot20Net>=0?"#d97706":"#dc2626")}
      ${mkKPI("MOIC Oenergy / CAPEX",fm(active.oen20MOIC),active.oen20MOIC>=2?"#059669":active.oen20MOIC>=1?"#d97706":"#dc2626")}
      ${mkKPI("Payback CAPEX",active.payback?"Año "+active.payback:">20 años",active.payback&&active.payback<=15?"#059669":active.payback?"#d97706":"#dc2626")}
    </div>
    <h2>Desglose CAPEX</h2>
    <div class="grid5">
      ${mkKPI("Baterías",f$(mwh*BATT),"#7c3aed")}
      ${mkKPI("BOP",f$(mwh*BOP),"#2563eb")}
      ${mkKPI("Transformador",f$(mw*(TRAFO_B/TRAFO_MW)),"#0d9488")}
      ${mkKPI("RTB / permisos",f$(RTB),"#d97706")}
      ${mkKPI("Total CAPEX",f$(CAPEX),"#059669")}
    </div>
    <p style="margin-top:24px;font-size:10px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:10px">
      Modelo analítico independiente — ${projectName} BESS ${mw}MW/${mwh}MWh · ★ = año payback CAPEX (FCF acum. Oenergy ≥ ${f$(CAPEX)}) · DSCR: ≥1.25x OK · 1.0–1.25x marginal · &lt;1.0x no bancable
    </p>
    <script>window.onload=function(){window.print();}<\/script>
    </body></html>`;
    const win=window.open("","_blank","width=1100,height=820");
    if(!win){
      alert("Tu navegador bloqueó la ventana emergente.\nPor favor permite popups para este sitio e intenta de nuevo.");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  if(!active)return<div style={{padding:32,textAlign:"center",color:"#9ca3af",fontSize:14}}>⚠ Ajusta los parámetros — modelo fuera de rango</div>;

  return(
    <div style={{fontFamily:"system-ui,sans-serif",background:"#f3f4f6",minHeight:"100vh",padding:16}}>
      <style>{`@media print{.no-print{display:none!important;}input[type=range]{display:none!important;}body{background:#fff!important;}}`}</style>

      {/* HEADER */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <input
              value={projectName}
              onChange={e=>setProjectName(e.target.value)}
              style={{fontSize:17,fontWeight:700,color:"#111827",border:"none",borderBottom:"2px solid #e5e7eb",background:"transparent",outline:"none",padding:"2px 4px",fontFamily:"system-ui,sans-serif",minWidth:200,cursor:"text"}}
              placeholder="Nombre del proyecto"
            />
            <span style={{fontSize:11,color:"#9ca3af",fontStyle:"italic"}}>← editable</span>
          </div>
          <p style={{fontSize:11,color:"#6b7280",margin:0}}>BESS {mw} MW / {mwh} MWh · CAPEX {f$(CAPEX)} · {dur}h · TIM equity{bkLev>0?` + ${bkLev}% banco`:""} · Pago: <strong>{payMode==="fixed"?"% fijo ($)":"% variable"}</strong> · 20 años</p>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <div style={{background:hbg,border:`1.5px solid ${hbr}`,borderRadius:10,padding:"7px 14px",fontWeight:700,fontSize:12,color:hcl,whiteSpace:"nowrap"}}>
            {hOk?"✓ TIM OK + Oenergy viable":hP?"⚠ Parcialmente viable":"✗ TIM no cumple criterios"}
          </div>
          <button className="no-print" onClick={exportPDF} style={{padding:"8px 16px",background:"#1e40af",color:"#fff",border:"none",borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer"}}>↓ Exportar PDF</button>
        </div>
      </div>

      {/* STRIP */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(8,1fr)",gap:6,marginBottom:12}}>
        {[["CAPEX",f$(CAPEX),"#374151"],["Potencia",`${mw} MW`,"#374151"],["Energía",`${mwh} MWh`,"#374151"],["Duración",`${dur}h`,+dur<2?"#dc2626":+dur>=4?"#059669":"#d97706"],["% TIM",`${pctTIM}% ${payMode==="fixed"?"fijo":"var"}`,"#3b82f6"],["Buyout Y5",f$(buyoutAbs),"#ef4444"],["Banco TIM",bkLev>0?`${bkLev}%@${bkRate}%`:"Sin banco","#0d9488"],["Desde Y6","100% Oenergy","#059669"]].map(([k,v,c])=>(
          <div key={k} style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,padding:"6px 8px",textAlign:"center"}}>
            <p style={{fontSize:9,color:"#9ca3af",textTransform:"uppercase",margin:0}}>{k}</p>
            <p style={{fontSize:11,fontWeight:600,fontFamily:"monospace",color:c,margin:"2px 0 0"}}>{v}</p>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"268px 1fr",gap:12}}>

        {/* LEFT */}
        <div className="no-print">
          <Box title="Tamaño del BESS" col="blue">
            <Sld label="Potencia (MW)" min={1} max={50} step={0.5} val={mw} set={setMw} disp={v=>`${v} MW`} note={`Duración: ${(mwh/mw).toFixed(1)}h`} col="blue"/>
            <Sld label="Energía (MWh)" min={5} max={250} step={5} val={mwh} set={setMwh} disp={v=>`${v} MWh`} note={`CAPEX ≈ ${f$(capexFn(mwh,mw))}`} col="blue"/>
          </Box>

          <Box title="Ingresos y costos" col="blue">
            <Sld label="Spread energía" min={0} max={150} step={1} val={sp} set={setSp} disp={v=>`$${v}/MWh`} note="Base: $65/MWh" col="blue"/>
            <Sld label="Revenue capacidad" min={0} max={800000} step={5000} val={cr} set={setCr} disp={v=>f$(v)+"/yr"} note="Base: $396k · mecanismo no documentado" col="blue"/>
            <Hr/>
            <Sld label="OPEX años 1–5" min={0} max={600000} step={5000} val={op1} set={setOp1} disp={v=>f$(v)+"/yr"} note="O&M + land lease + peaje" col="green"/>
            <Sld label="OPEX años 6–20" min={0} max={800000} step={5000} val={op2} set={setOp2} disp={v=>f$(v)+"/yr"} note="+ warranty extendida baterías" col="green"/>
          </Box>

          <Box title="Trade-off TIM ↔ Oenergy" col="purple" accent>
            <div style={{display:"flex",marginBottom:10,background:"#f3f4f6",borderRadius:8,padding:3}}>
              {[["fixed","% fijo ($)"],["variable","% variable"]].map(([k,l])=>(
                <button key={k} onClick={()=>setPayMode(k)} style={{flex:1,padding:"6px 0",borderRadius:6,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,background:payMode===k?"#7c3aed":"transparent",color:payMode===k?"#fff":"#6b7280"}}>{l}</button>
              ))}
            </div>
            <div style={{padding:"7px 10px",borderRadius:7,background:"#faf5ff",border:"1px solid #e9d5ff",marginBottom:10,fontSize:10,color:"#6b7280",lineHeight:1.5}}>
              {payMode==="fixed"?"Pago fijo: Oenergy paga $X/año constante. DSCR Oenergy varía si el EBITDA cambia.":"Pago variable: Oenergy paga siempre % del EBITDA real. DSCR Oenergy constante. TIM asume el riesgo operacional."}
            </div>
            <Sld label="% EBITDA → TIM (años 1-4)" min={0} max={100} step={1} val={pctTIM} set={setPctTIM}
              disp={v=>`${v}% TIM / ${100-v}% Oen`}
              note={s1?(payMode==="fixed"?`Fijo: ${f$(s1.fixedPmt)}/yr · Oenergy: ${f$(s1.ebitdaY1-s1.fixedPmt)}/yr`:`Variable Y1: TIM ${f$(s1.rows[0]?.pmtToTIM)} · Oen ${f$(s1.rows[0]?.oenNet)}`):""} col="purple"/>
            <Sld label="Buyout Y5 (% del CAPEX)" min={0} max={150} step={5} val={buyoutPct} set={setBuyoutPct}
              disp={v=>`${v}% = ${f$(CAPEX*v/100)}`} note="90% ≈ Taranis original (~$7.6M)" col="red"/>
          </Box>

          <Box title="Estructura financiera TIM" col="teal">
            <Sld label="Deuda banco (% CAPEX)" min={0} max={80} step={5} val={bkLev} set={setBkLev}
              disp={v=>`${v}%`} note={bkLev>0?`Banco: ${f$(CAPEX*bkLev/100)} · Equity TIM: ${f$(CAPEX*(1-bkLev/100))}`:"Sin banco — TIM equity puro"} col="teal"/>
            <Sld label="Tasa deuda banco" min={1} max={15} step={0.5} val={bkRate} set={setBkRate} disp={v=>`${v}%`} col="teal"/>
            <Sld label="Tenor deuda banco" min={5} max={20} step={1} val={bkTenor} set={setBkTenor} disp={v=>`${v} años`} col="teal"/>
            <Hr/>
            <Sld label="Hurdle rate TIM (NPV)" min={8} max={30} step={1} val={hR} set={setHR} disp={v=>`${v}%`} col="amber"/>
          </Box>

          <Box title="% mínimo TIM → TIR≥15% + MOIC≥1.5x" col="green" accent>
            <div style={{padding:"10px 12px",borderRadius:8,background:optPct!=null?"#f0fdf4":"#fef2f2",border:`1px solid ${optPct!=null?"#bbf7d0":"#fecaca"}`}}>
              {optPct!=null&&s2!=null?(
                <>
                  <p style={{fontSize:12,fontWeight:700,fontFamily:"monospace",color:"#065f46",margin:"0 0 4px"}}>% mínimo TIM: <strong>{pn(optPct)}</strong> → Oenergy retiene: <strong>{pn(100-optPct)}</strong></p>
                  <p style={{fontSize:10,color:"#047857",margin:"0 0 6px",lineHeight:1.5}}>TIR: {fp(s2.timIRR)} · MOIC: {fm(s2.timMOIC)}<br/>DSCR Oenergy avg: {fd(s2.dscrOenAvg)}{s2.dscrTIMAvg!=null?` · DSCR TIM-banco: ${fd(s2.dscrTIMAvg)}`:""}</p>
                  <SplitBar timPct={optPct} h={12}/>
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:3,fontSize:10,fontFamily:"monospace"}}>
                    <span style={{color:"#3b82f6",fontWeight:700}}>{pn(optPct)} TIM</span>
                    <span style={{color:"#10b981",fontWeight:700}}>{pn(100-optPct)} Oenergy</span>
                  </div>
                  <button onClick={()=>{setPctTIM(optPct);setSel(2);}} style={{marginTop:8,width:"100%",padding:"7px 0",background:"#059669",color:"#fff",border:"none",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer"}}>Aplicar {pn(optPct)} → escenario óptimo</button>
                </>
              ):(
                <p style={{fontSize:11,color:"#7f1d1d",margin:0}}>✗ Sin solución con parámetros actuales.<br/>Prueba: subir spread, bajar buyout, o aumentar leverage banco.</p>
              )}
            </div>
          </Box>
        </div>

        {/* RIGHT */}
        <div>
          {/* 3 SCENARIOS */}
          <div style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <h3 style={{fontSize:10,fontWeight:700,color:"#374151",textTransform:"uppercase",letterSpacing:"0.1em",margin:0}}>3 escenarios — {projectName} · {payMode==="fixed"?"pago fijo":"pago variable"} · {pctTIM}% EBITDA → TIM</h3>
              <div style={{display:"flex",gap:4}} className="no-print">
                {[["0","Sin banco"],["1","Con banco"],["2","Óptimo"]].map(([k,l])=>(
                  <button key={k} onClick={()=>setSel(+k)} style={{padding:"5px 12px",borderRadius:6,border:"1px solid #e5e7eb",cursor:"pointer",fontSize:11,fontWeight:600,background:sel===+k?"#2563eb":"#fff",color:sel===+k?"#fff":"#6b7280"}}>{l}</button>
                ))}
              </div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <ScenCol label="Sin apalancamiento TIM" badge={`equity puro · ${pctTIM}% EBITDA`} borderCol="#93c5fd" r={s0} CAPEX={CAPEX}/>
              <ScenCol label="Con banco TIM" badge={`${bkLev}% banco · ${pctTIM}% EBITDA`} borderCol="#5eead4" r={s1} CAPEX={CAPEX}/>
              <ScenCol label={optPct!=null?`Óptimo: ${pn(optPct)} TIM`:"Óptimo"} badge={optPct!=null?`mín TIR≥15% + MOIC≥1.5x`:"Sin solución"} borderCol="#a78bfa" r={s2} CAPEX={CAPEX}/>
            </div>
          </div>

          {/* TABS */}
          <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,overflow:"hidden",marginBottom:10}}>
            <div style={{display:"flex",borderBottom:"1px solid #e5e7eb",background:"#f9fafb"}} className="no-print">
              {[["split","Split EBITDA Y1-5"],["table","Flujo 20 años + DSCR"],["charts","Gráficos flujo de caja"]].map(([k,l])=>(
                <button key={k} onClick={()=>setTab(k)} style={{padding:"10px 18px",border:"none",cursor:"pointer",fontSize:11,fontWeight:700,background:"transparent",color:tab===k?"#2563eb":"#6b7280",borderBottom:tab===k?"2px solid #2563eb":"2px solid transparent"}}>{l}</button>
              ))}
              <div style={{marginLeft:"auto",padding:"8px 14px",fontSize:10,color:"#6b7280"}}>
                Activo: <strong style={{color:"#2563eb"}}>{sel===0?"Sin banco":sel===1?"Con banco":"Óptimo"}</strong>
              </div>
            </div>

            {tab==="split"&&(
              <div style={{padding:14}}>
                <div style={{display:"flex",gap:16,marginBottom:12,fontSize:11,flexWrap:"wrap"}}>
                  <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:12,height:12,borderRadius:2,background:"#3b82f6",display:"inline-block"}}/> → TIM</span>
                  <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:12,height:12,borderRadius:2,background:"#10b981",display:"inline-block"}}/> → Oenergy</span>
                  <span style={{marginLeft:"auto",fontSize:10,color:"#6b7280",fontStyle:"italic"}}>Y6-Y20: 100% EBITDA → Oenergy (DSCR = ∞)</span>
                </div>

                {active.rows.slice(0,4).map(row=>(
                  <div key={row.y} style={{marginBottom:12,padding:"11px 13px",background:"#f9fafb",borderRadius:8,border:"1px solid #e5e7eb"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                      <span style={{fontSize:12,fontWeight:700,fontFamily:"monospace",color:"#2563eb"}}>Año {row.y}</span>
                      <span style={{fontSize:12,fontFamily:"monospace",fontWeight:600}}>EBITDA: <strong style={{color:row.ebitda<0?"#dc2626":"#111827"}}>{f$(row.ebitda)}</strong></span>
                    </div>
                    <SplitBar timPct={row.pctToTIM} h={18}/>
                    <div style={{display:"flex",justifyContent:"space-between",marginTop:5,fontSize:12}}>
                      <div><span style={{color:"#3b82f6",fontFamily:"monospace",fontWeight:700}}>{f$(row.pmtToTIM)}</span><span style={{color:"#6b7280",fontSize:10}}> ({pn(row.pctToTIM)}) → TIM</span></div>
                      <div><span style={{color:row.oenNet>=0?"#059669":"#dc2626",fontFamily:"monospace",fontWeight:700}}>{f$(row.oenNet)}</span><span style={{color:"#6b7280",fontSize:10}}> ({pn(row.pctToOen)}) Oenergy</span></div>
                    </div>
                    <div style={{display:"flex",gap:8,marginTop:8}}>
                      <DSCRBox val={row.dscrOen} label="DSCR Oenergy"/>
                      {row.dscrTIM!=null&&<DSCRBox val={row.dscrTIM} label="DSCR TIM-banco"/>}
                      <div style={{flex:1,padding:"6px 10px",borderRadius:7,background:"#fff",border:"1px solid #e5e7eb",textAlign:"center"}}>
                        <p style={{fontSize:9,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.05em",margin:0}}>FCF acum. Oenergy</p>
                        <p style={{fontSize:15,fontWeight:700,fontFamily:"monospace",color:row.oenCum>=0?"#059669":"#dc2626",margin:"2px 0"}}>{f$(row.oenCum)}</p>
                        <p style={{fontSize:9,color:"#9ca3af",margin:0}}>hasta Y{row.y}</p>
                      </div>
                    </div>
                  </div>
                ))}

                <div style={{marginBottom:12,padding:"11px 13px",background:"#fef2f2",borderRadius:8,border:"1px solid #fecaca"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{fontSize:12,fontWeight:700,fontFamily:"monospace",color:"#dc2626"}}>Año 5 — BUYOUT / TRANSFERENCIA</span>
                    <span style={{fontSize:12,fontFamily:"monospace"}}>EBITDA: {f$(active.rows[4]?.ebitda)}</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                    <KPI label="Pago buyout a TIM" val={f$(buyoutAbs)} sub={`${buyoutPct}% del CAPEX`} st="neutral" sm/>
                    <KPI label="EBITDA Y5" val={f$(active.rows[4]?.ebitda)} st="neutral" sm/>
                    <KPI label="FCF Oenergy Y5" val={f$(active.rows[4]?.oenNet)} sub="EBITDA − buyout" st={active.rows[4]?.oenNet>=0?"ok":"fail"} sm/>
                  </div>
                </div>

                <div style={{padding:"11px 13px",background:"#f0fdf4",borderRadius:8,border:"1px solid #bbf7d0"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                    <span style={{fontSize:12,fontWeight:700,fontFamily:"monospace",color:"#059669"}}>Años 6 → 20 — 100% Oenergy</span>
                    <span style={{fontSize:11,color:"#047857"}}>Sin obligaciones con TIM</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                    <KPI label="EBITDA Y6" val={f$(active.rows[5]?.ebitda)} sub="100% Oenergy" st="ok" sm/>
                    <KPI label="Avg Y6-20" val={f$(active.rows.slice(5).reduce((s,r)=>s+r.ebitda,0)/15)} sub="promedio" st="ok" sm/>
                    <KPI label="Total Y6-20" val={f$(active.rows.slice(5).reduce((s,r)=>s+r.ebitda,0))} sub="ingreso libre" st="ok" sm/>
                    <KPI label="Payback CAPEX" val={active.payback?`Año ${active.payback}`:"¿>20?"} st={active.payback&&active.payback<=15?"ok":active.payback?"warn":"fail"} sm/>
                  </div>
                </div>

                <div style={{borderTop:"1px solid #e5e7eb",marginTop:14,paddingTop:12,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                  {[["Total EBITDA 20yr",f$(active.tot20),"#374151"],["Total → TIM",f$(active.rows.slice(0,5).reduce((s,r)=>s+r.pmtToTIM,0)),"#3b82f6"],["FCF Oenergy neto 20yr",f$(active.tot20Net),active.tot20Net>=CAPEX?"#059669":active.tot20Net>=0?"#d97706":"#dc2626"],["MOIC Oenergy/CAPEX",fm(active.oen20MOIC),active.oen20MOIC>=2?"#059669":active.oen20MOIC>=1?"#d97706":"#dc2626"]].map(([k,v,c])=>(
                    <div key={k} style={{background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,padding:"9px 11px",textAlign:"center"}}>
                      <p style={{fontSize:10,color:"#9ca3af",textTransform:"uppercase",margin:0}}>{k}</p>
                      <p style={{fontSize:14,fontWeight:700,fontFamily:"monospace",color:c,margin:"3px 0 0"}}>{v}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab==="table"&&(
              <div>
                <div style={{overflowX:"auto",overflowY:"auto",maxHeight:500}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:10.5}}>
                    <thead style={{position:"sticky",top:0,zIndex:2}}>
                      <tr style={{background:"#f9fafb"}}>
                        {["Año","Fase","RTE","Ing. Energía","Rev. Cap.","OPEX","EBITDA","→ TIM","FCF Oenergy","FCF Acum.","DSCR Oen.","DSCR TIM-bco"].map(h=>(
                          <th key={h} style={{padding:"6px 8px",textAlign:["Año","Fase"].includes(h)?"left":"right",color:"#6b7280",fontWeight:600,fontSize:9.5,textTransform:"uppercase",letterSpacing:"0.04em",borderBottom:"2px solid #e5e7eb",background:"#f9fafb",whiteSpace:"nowrap"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {active.rows.map(row=>{
                        const isPb=active.payback===row.y,isY5=row.y===5,isFree=row.y>=6;
                        const bg=isPb?"#dcfce7":isY5?"#fef2f2":isFree?"#f0fdf4":row.y%2===0?"#fafafa":"#fff";
                        const yCol=isY5?"#dc2626":isFree?"#059669":"#2563eb";
                        const fase=row.y<=4?"Período TIM":row.y===5?"Buyout":"Libre";
                        return(
                          <tr key={row.y} style={{background:bg,borderBottom:"1px solid #f3f4f6"}}>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",fontWeight:700,color:yCol,whiteSpace:"nowrap"}}>Y{row.y}{isPb?" ★":""}</td>
                            <td style={{padding:"5px 8px",fontSize:9.5,color:yCol,whiteSpace:"nowrap"}}>{fase}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",color:"#9ca3af"}}>{fp(row.rte)}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",color:"#0369a1"}}>{f$(row.eR)}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",color:"#7c3aed"}}>{f$(cr)}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",color:"#9ca3af"}}>({f$(row.opex)})</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:600,color:row.ebitda<0?"#dc2626":"#111827"}}>{f$(row.ebitda)}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",color:row.pmtToTIM>0?"#2563eb":"#9ca3af",fontWeight:row.pmtToTIM>0?600:400}}>{row.pmtToTIM>0?`(${f$(row.pmtToTIM)})`:"—"}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:row.oenNet<0?"#dc2626":"#059669"}}>{f$(row.oenNet)}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:row.oenCum<0?"#dc2626":row.oenCum>=CAPEX?"#059669":"#d97706"}}>{f$(row.oenCum)}{isPb?" ★":""}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:dscrCol(row.dscrOen)}}>{row.dscrOen!=null?fd(row.dscrOen):isFree?"∞":"—"}</td>
                            <td style={{padding:"5px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:dscrCol(row.dscrTIM)}}>{row.dscrTIM!=null?fd(row.dscrTIM):"—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{background:"#f3f4f6",borderTop:"2px solid #d1d5db",position:"sticky",bottom:0}}>
                        <td colSpan={2} style={{padding:"6px 8px",fontWeight:700,color:"#374151",fontSize:10}}>TOTAL Y1–20</td>
                        <td/><td/>
                        <td style={{padding:"6px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:"#7c3aed"}}>{f$(cr*20)}</td>
                        <td style={{padding:"6px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:"#9ca3af"}}>({f$(active.rows.reduce((s,r)=>s+r.opex,0))})</td>
                        <td style={{padding:"6px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700}}>{f$(active.tot20)}</td>
                        <td style={{padding:"6px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:"#2563eb"}}>({f$(active.rows.reduce((s,r)=>s+r.pmtToTIM,0))})</td>
                        <td style={{padding:"6px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:active.tot20Net>=0?"#059669":"#dc2626"}}>{f$(active.tot20Net)}</td>
                        <td style={{padding:"6px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:active.oen20MOIC>=1?"#059669":"#dc2626"}}>{fm(active.oen20MOIC)}×C</td>
                        <td style={{padding:"6px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:dscrCol(active.dscrOenAvg)}}>{fd(active.dscrOenAvg)}</td>
                        <td style={{padding:"6px 8px",fontFamily:"monospace",textAlign:"right",fontWeight:700,color:dscrCol(active.dscrTIMAvg)}}>{active.dscrTIMAvg!=null?fd(active.dscrTIMAvg):"—"}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {(()=>{
                  const fc=active.rows[19]?.oenCum??0;
                  const rawPct=CAPEX>0&&isFinite(fc/CAPEX)?fc/CAPEX*100:0;
                  const pct=Math.min(100,Math.max(0,rawPct));
                  const bc=pct>=100?"#059669":pct>=50?"#d97706":"#dc2626";
                  return(
                    <div style={{padding:"10px 14px",borderTop:"1px solid #e5e7eb",background:"#f9fafb"}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#6b7280",marginBottom:3}}>
                        <span>Recuperación CAPEX {f$(CAPEX)}</span>
                        <span style={{fontWeight:700,color:bc,fontFamily:"monospace"}}>{f$(fc)} = {pct.toFixed(0)}%{active.payback?` · Payback Año ${active.payback}`:" · no recuperado"}</span>
                      </div>
                      <div style={{background:"#e5e7eb",borderRadius:6,height:10,overflow:"hidden"}}>
                        <div style={{background:bc,height:"100%",width:`${pct}%`,borderRadius:6}}/>
                      </div>
                      <div style={{display:"flex",gap:12,marginTop:5,fontSize:10,color:"#9ca3af",flexWrap:"wrap"}}>
                        <span>★ Payback CAPEX</span>
                        <span style={{color:"#2563eb"}}>■ Período TIM Y1-4</span>
                        <span style={{color:"#dc2626"}}>■ Buyout Y5</span>
                        <span style={{color:"#059669"}}>■ Libre Y6-20</span>
                        <span>DSCR: ≥1.25✓ · 1.0-1.25⚠ · &lt;1.0✗</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ── CHARTS TAB — pure SVG, no recharts ── */}
            {tab==="charts"&&(()=>{
              const W=860,H1=260,H2=200,PAD={t:20,r:60,b:28,l:62};
              const mk=v=>(!v||!isFinite(v))?0:v;
              const rows=active.rows;
              const fcfs=rows.map(r=>mk(r.oenNet));
              const cums=rows.map(r=>mk(r.oenCum));
              const ebs=rows.map(r=>mk(r.ebitda));
              const tims=rows.map(r=>r.y<=5?mk(r.pmtToTIM):0);
              const allVals1=[...fcfs,...cums,0,CAPEX];
              const minV1=Math.min(...allVals1)*1.1,maxV1=Math.max(...allVals1)*1.15;
              const allVals2=[...ebs,0];
              const minV2=Math.min(...allVals2)*1.1,maxV2=Math.max(...allVals2)*1.15;
              const cw=(W-PAD.l-PAD.r)/20,bw=cw*0.55;
              const sy1=(v)=>PAD.t+(1-(v-minV1)/(maxV1-minV1))*(H1-PAD.t-PAD.b);
              const sy2=(v)=>PAD.t+(1-(v-minV2)/(maxV2-minV2))*(H2-PAD.t-PAD.b);
              const sx=(i)=>PAD.l+i*cw+cw/2;
              const fmt=v=>{if(!isFinite(v)||v==null)return"$0";const a=Math.abs(v);if(a>=1e6)return`${v<0?"-":""}$${(a/1e6).toFixed(1)}M`;return`${v<0?"-":""}$${Math.round(a/1000)}k`;};
              const phCol=p=>p==="tim"?"#3b82f6":p==="buyout"?"#ef4444":"#10b981";
              const phases=rows.map(r=>r.y<=4?"tim":r.y===5?"buyout":"free");
              // y-axis ticks
              const ticks1=Array.from({length:6},(_,i)=>minV1+(maxV1-minV1)*i/5);
              const ticks2=Array.from({length:5},(_,i)=>minV2+(maxV2-minV2)*i/4);
              // cumulative line path
              const linePts=cums.map((v,i)=>`${sx(i).toFixed(1)},${sy1(v).toFixed(1)}`).join(" ");
              const [hovI,setHovI]=useState(null);
              return(
                <div style={{padding:16}}>
                  {/* legend */}
                  <div style={{display:"flex",gap:14,marginBottom:12,fontSize:11,flexWrap:"wrap",alignItems:"center"}}>
                    {[["#3b82f6","FCF Oenergy Y1-4"],["#ef4444","Y5 Buyout"],["#10b981","FCF libre Y6-20"]].map(([c,l])=>(
                      <span key={l} style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:12,height:12,borderRadius:2,background:c,display:"inline-block"}}/>{l}</span>
                    ))}
                    <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:20,height:3,background:"#f59e0b",display:"inline-block",borderRadius:2}}/> FCF acumulado</span>
                    <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:20,height:0,display:"inline-block",borderTop:"2px dashed #374151"}}/> CAPEX {f$(CAPEX)}</span>
                    {active.payback&&<span style={{marginLeft:"auto",background:"#dcfce7",color:"#065f46",padding:"3px 8px",borderRadius:5,fontWeight:700,fontSize:10}}>★ Payback: Año {active.payback}</span>}
                  </div>

                  {/* CHART 1: FCF anual + acumulado */}
                  <p style={{fontSize:10,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>FCF anual Oenergy (barras) + FCF acumulado (línea naranja)</p>
                  <div style={{overflowX:"auto"}}>
                  <svg width={W} height={H1} style={{display:"block",fontFamily:"system-ui,sans-serif"}}>
                    {/* grid */}
                    {ticks1.map((v,i)=>(
                      <g key={i}>
                        <line x1={PAD.l} x2={W-PAD.r} y1={sy1(v).toFixed(1)} y2={sy1(v).toFixed(1)} stroke="#f0f0f0" strokeWidth={1}/>
                        <text x={PAD.l-4} y={sy1(v)+3} textAnchor="end" fontSize={9} fill="#9ca3af">{fmt(v)}</text>
                      </g>
                    ))}
                    {/* zero line */}
                    <line x1={PAD.l} x2={W-PAD.r} y1={sy1(0).toFixed(1)} y2={sy1(0).toFixed(1)} stroke="#d1d5db" strokeWidth={1.5}/>
                    {/* CAPEX dashed line */}
                    <line x1={PAD.l} x2={W-PAD.r} y1={sy1(CAPEX).toFixed(1)} y2={sy1(CAPEX).toFixed(1)} stroke="#374151" strokeWidth={1.5} strokeDasharray="6 3"/>
                    <text x={W-PAD.r+2} y={sy1(CAPEX)-3} fontSize={8} fill="#374151">CAPEX</text>
                    {/* bars */}
                    {fcfs.map((v,i)=>{
                      const x=sx(i)-bw/2,y0=sy1(0),yv=sy1(v);
                      const barH=Math.abs(y0-yv);
                      const barY=v>=0?yv:y0;
                      const col=v<0?"#fca5a5":phCol(phases[i]);
                      const isHov=hovI===i;
                      return(
                        <g key={i} style={{cursor:"pointer"}} onMouseEnter={()=>setHovI(i)} onMouseLeave={()=>setHovI(null)}>
                          <rect x={x} y={barY} width={bw} height={Math.max(1,barH)} fill={col} rx={2} opacity={isHov?1:0.85}/>
                          {/* X label */}
                          <text x={sx(i)} y={H1-4} textAnchor="middle" fontSize={9} fill={phases[i]==="buyout"?"#dc2626":phases[i]==="free"?"#059669":"#6b7280"} fontWeight={phases[i]==="buyout"?700:400}>
                            Y{i+1}
                          </text>
                          {/* payback marker */}
                          {active.payback===i+1&&<text x={sx(i)} y={PAD.t-6} textAnchor="middle" fontSize={12} fill="#059669">★</text>}
                          {/* hover tooltip */}
                          {isHov&&(
                            <g>
                              <rect x={Math.min(sx(i)-60,W-PAD.r-126)} y={Math.max(4,sy1(Math.max(v,0))-72)} width={124} height={64} fill="white" rx={6} stroke="#e5e7eb" strokeWidth={1}/>
                              <text x={Math.min(sx(i)-60,W-PAD.r-126)+8} y={Math.max(4,sy1(Math.max(v,0))-72)+14} fontSize={10} fontWeight={700} fill="#374151">Año {i+1}</text>
                              <text x={Math.min(sx(i)-60,W-PAD.r-126)+8} y={Math.max(4,sy1(Math.max(v,0))-72)+28} fontSize={9} fill="#6b7280">EBITDA: {fmt(ebs[i])}</text>
                              <text x={Math.min(sx(i)-60,W-PAD.r-126)+8} y={Math.max(4,sy1(Math.max(v,0))-72)+41} fontSize={9} fill={v>=0?"#059669":"#dc2626"} fontWeight={700}>FCF Oen: {fmt(v)}</text>
                              <text x={Math.min(sx(i)-60,W-PAD.r-126)+8} y={Math.max(4,sy1(Math.max(v,0))-72)+54} fontSize={9} fill="#f59e0b">Acum: {fmt(cums[i])}</text>
                            </g>
                          )}
                        </g>
                      );
                    })}
                    {/* cumulative line */}
                    <polyline points={linePts} fill="none" stroke="#f59e0b" strokeWidth={2.5} strokeLinejoin="round"/>
                    {cums.map((v,i)=>(
                      <circle key={i} cx={sx(i)} cy={sy1(v)} r={3} fill="#f59e0b" stroke="white" strokeWidth={1}/>
                    ))}
                    {/* Y5 vertical */}
                    <line x1={sx(4)} x2={sx(4)} y1={PAD.t} y2={H1-PAD.b} stroke="#ef4444" strokeWidth={1} strokeDasharray="3 3" opacity={0.6}/>
                  </svg>
                  </div>

                  {/* CHART 2: EBITDA split */}
                  <p style={{fontSize:10,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6,marginTop:18}}>EBITDA — split TIM (azul) vs Oenergy (verde) por año</p>
                  <div style={{overflowX:"auto"}}>
                  <svg width={W} height={H2} style={{display:"block",fontFamily:"system-ui,sans-serif"}}>
                    {ticks2.map((v,i)=>(
                      <g key={i}>
                        <line x1={PAD.l} x2={W-PAD.r} y1={sy2(v).toFixed(1)} y2={sy2(v).toFixed(1)} stroke="#f0f0f0" strokeWidth={1}/>
                        <text x={PAD.l-4} y={sy2(v)+3} textAnchor="end" fontSize={9} fill="#9ca3af">{fmt(v)}</text>
                      </g>
                    ))}
                    <line x1={PAD.l} x2={W-PAD.r} y1={sy2(0).toFixed(1)} y2={sy2(0).toFixed(1)} stroke="#d1d5db" strokeWidth={1.5}/>
                    {rows.map((r,i)=>{
                      const tim=mk(r.pmtToTIM),oen=mk(r.oenNet),eb=mk(r.ebitda);
                      const x=sx(i)-bw/2,y0=sy2(0);
                      const timH=Math.max(0,sy2(0)-sy2(Math.max(0,tim)));
                      const oenH=Math.max(0,sy2(0)-sy2(Math.max(0,oen)));
                      const negH=Math.max(0,sy2(Math.min(0,oen))-sy2(0));
                      return(
                        <g key={i}>
                          {/* TIM bar (bottom) */}
                          {timH>0&&<rect x={x} y={y0-timH} width={bw} height={timH} fill="#3b82f6" rx={2} opacity={0.8}/>}
                          {/* Oenergy bar (on top of TIM) */}
                          {oenH>0&&<rect x={x} y={y0-timH-oenH} width={bw} height={oenH} fill={phCol(phases[i])} rx={2} opacity={0.85}/>}
                          {/* negative part */}
                          {negH>0&&<rect x={x} y={y0} width={bw} height={negH} fill="#fca5a5" rx={2} opacity={0.85}/>}
                          <text x={sx(i)} y={H2-4} textAnchor="middle" fontSize={9} fill="#6b7280">Y{i+1}</text>
                        </g>
                      );
                    })}
                    <line x1={sx(4)} x2={sx(4)} y1={PAD.t} y2={H2-PAD.b} stroke="#ef4444" strokeWidth={1} strokeDasharray="3 3" opacity={0.6}/>
                  </svg>
                  </div>

                  {/* summary strip */}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginTop:14}}>
                    {[
                      ["EBITDA total 20yr",f$(active.tot20),"#374151"],
                      ["Total → TIM",f$(active.rows.slice(0,5).reduce((s,r)=>s+r.pmtToTIM,0)),"#3b82f6"],
                      ["FCF Oenergy 20yr",f$(active.tot20Net),active.tot20Net>=0?"#059669":"#dc2626"],
                      ["FCF acum. Y20",f$(active.rows[19]?.oenCum),active.rows[19]?.oenCum>=CAPEX?"#059669":"#d97706"],
                      ["Payback CAPEX",active.payback?`Año ${active.payback}`:"¿>20?",active.payback&&active.payback<=15?"#059669":active.payback?"#d97706":"#dc2626"],
                    ].map(([k,v,c])=>(
                      <div key={k} style={{background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                        <p style={{fontSize:10,color:"#9ca3af",textTransform:"uppercase",margin:0}}>{k}</p>
                        <p style={{fontSize:13,fontWeight:700,fontFamily:"monospace",color:c,margin:"3px 0 0"}}>{v}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* CAPEX BREAKDOWN */}
          <Box title="Desglose CAPEX" col="gray">
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
              {[["Baterías",f$(mwh*BATT),`${mwh}×$105k`,"#7c3aed"],["BOP",f$(mwh*BOP),`${mwh}×$30k`,"#2563eb"],["Transformador",f$(mw*(TRAFO_B/TRAFO_MW)),`${mw}×$40.9k`,"#0d9488"],["RTB",f$(RTB),"fijo","#d97706"],["Total",f$(CAPEX),`$${Math.round(CAPEX/Math.max(1,mwh)/1000)}k/MWh`,"#059669"]].map(([k,v,n,c])=>(
                <div key={k} style={{background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,padding:"8px 10px"}}>
                  <p style={{fontSize:10,color:"#9ca3af",textTransform:"uppercase",margin:0}}>{k}</p>
                  <p style={{fontSize:13,fontWeight:700,fontFamily:"monospace",color:c,margin:"3px 0 2px"}}>{v}</p>
                  <p style={{fontSize:10,color:"#9ca3af",margin:0}}>{n}</p>
                </div>
              ))}
            </div>
          </Box>
        </div>
      </div>
    </div>
  );
}
