import { useState, useMemo } from 'react'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'

// ── Typography constants ──────────────────────────────────────────────────────
const SORA  = "'Sora', ui-sans-serif, sans-serif"
const INTER = "'Inter', ui-sans-serif, sans-serif"
const NUM: React.CSSProperties = { fontFamily: INTER, fontVariantNumeric: 'tabular-nums', fontFeatureSettings: "'tnum' 1, 'cv05' 1" }

// ── Theme tokens ──────────────────────────────────────────────────────────────
const LIGHT: React.CSSProperties = {
  // @ts-expect-error custom props
  '--bg': '#F5F6FA', '--sb': '#FFFFFF', '--sb-bdr': '#E8EBF2',
  '--grp': '#B8BFCF', '--nav-txt': '#9AA4B8', '--nav-act-txt': '#0F1623',
  '--nav-act-bg': '#EEF1F8', '--nav-dot': '#C00000', '--nav-hvr-bg': '#F5F6FA', '--nav-hvr-txt': '#0F1623',
  '--sub-txt': '#C0C8D8', '--sub-hvr': '#6B7590', '--sub-act': '#0F1623',
  '--card': '#FFFFFF', '--card-bdr': '#E8EBF2',
  '--card-shadow': '0 1px 2px rgba(0,0,0,0.04), 0 4px 18px rgba(0,0,0,0.05)',
  '--txt': '#0F1623', '--txt2': '#798094', '--txt3': '#C0C8D8',
  '--bdr': '#E8EBF2', '--row-hvr': '#F8F9FC', '--row-sel': '#FFF2F2',
  '--th-bg': '#F6F8FC', '--input-bg': '#F2F4F9', '--input-bdr': '#DDE0EA',
  '--chip-bg': '#EEF0F8', '--chip-txt': '#4A5270',
  '--chart-grid': '#E8EBF2', '--chart-lbl': '#9AA4B8',
  '--fp-bg': '#FFFFFF', '--fp-bdr': '#E8EBF2',
}
const DARK: React.CSSProperties = {
  // @ts-expect-error custom props
  '--bg': '#07090F', '--sb': '#04060C', '--sb-bdr': '#0F1626',
  '--grp': '#1C2438', '--nav-txt': '#242E44', '--nav-act-txt': '#E2E8F5',
  '--nav-act-bg': '#0F1A30', '--nav-dot': '#FF3333', '--nav-hvr-bg': '#0A0F1C', '--nav-hvr-txt': '#7888B0',
  '--sub-txt': '#161E30', '--sub-hvr': '#485870', '--sub-act': '#BAC6E0',
  '--card': '#0A0E1A', '--card-bdr': '#121C30',
  '--card-shadow': '0 1px 3px rgba(0,0,0,0.5), 0 8px 28px rgba(0,0,0,0.3)',
  '--txt': '#D5DDED', '--txt2': '#384A68', '--txt3': '#1C2438',
  '--bdr': '#121C30', '--row-hvr': '#0C1220', '--row-sel': '#180E1C',
  '--th-bg': '#060910', '--input-bg': '#0A0E1A', '--input-bdr': '#121C30',
  '--chip-bg': '#0F1A30', '--chip-txt': '#506898',
  '--chart-grid': '#0F1626', '--chart-lbl': '#242E44',
  '--fp-bg': '#0A0E1A', '--fp-bdr': '#121C30',
}

// ── Data ─────────────────────────────────────────────────────────────────────
interface Lead { id:number; company:string; sector:string; contact:string; role:string; product:string; assigned:string; score:number; status:string; value:number; color:string }

const LEADS: Lead[] = [
  { id:1, company:'Zenith Microfinance',  sector:'420 staff', contact:'Chidi Okonkwo',  role:'HR Director',     product:'Salary Loan',   assigned:'Freddy O.', score:88, status:'Hot',  value:84_000_000,  color:'#0E2841' },
  { id:2, company:'Lagoon Logistics',     sector:'85 staff',  contact:'Amaka Eze',      role:'CFO',             product:'Business Loan', assigned:'Sola B.',   score:62, status:'Warm', value:25_000_000,  color:'#16A34A' },
  { id:3, company:'SunRise Hotels',       sector:'200 staff', contact:'Ngozi Ibe',      role:'Finance Manager', product:'Fixed Deposit', assigned:'Tobi A.',   score:95, status:'Won',  value:120_000_000, color:'#D97706' },
  { id:4, company:'PrimePay FinCo',       sector:'60 staff',  contact:'Emeka Dike',     role:'MD',              product:'Credit Card',   assigned:'Freddy O.', score:41, status:'New',  value:6_000_000,   color:'#0369A1' },
  { id:5, company:'Aero Parts Nigeria',   sector:'38 staff',  contact:'Bola Adewale',   role:'CEO',             product:'Business Loan', assigned:'Sola B.',   score:55, status:'Warm', value:15_000_000,  color:'#4B5563' },
  { id:6, company:'GreenField Farms',     sector:'110 staff', contact:'Chisom Nwosu',   role:'Operations',      product:'Salary Loan',   assigned:'Freddy O.', score:20, status:'Lost', value:22_000_000,  color:'#374151' },
]

const INCOME_DATA = [
  {m:'Jan',v:12},{m:'Feb',v:14},{m:'Mar',v:11},{m:'Apr',v:16},{m:'May',v:18},
  {m:'Jun',v:15},{m:'Jul',v:19},{m:'Aug',v:21},{m:'Sep',v:18},{m:'Oct',v:23},{m:'Nov',v:22},{m:'Dec',v:26},
]
const PIPELINE_DATA = [
  {stage:'Draft',n:24,fill:'#C5CDD8'},{stage:'Doc Col.',n:18,fill:'#9BAFC4'},{stage:'Risk Rev.',n:12,fill:'#6D8FAF'},
  {stage:'Pending',n:8,fill:'#3E6F9A'},{stage:'Finance',n:6,fill:'#1E5285'},{stage:'Booking',n:4,fill:'#0D3A66'},{stage:'Active',n:14,fill:'#16A34A'},
]
const DONUT_DATA = [
  {name:'Salary Loans',pct:42,color:'#0E2841'},{name:'Business Loans',pct:26,color:'#C00000'},
  {name:'Credit Cards',pct:18,color:'#D97706'},{name:'Fixed Deposits',pct:10,color:'#16A34A'},{name:'Prepaid Cards',pct:4,color:'#7C3AED'},
]
const DPD_DATA = [
  {m:'Jan',d30:420,d90:180,dp:60},{m:'Feb',d30:380,d90:190,dp:65},
  {m:'Mar',d30:360,d90:170,dp:58},{m:'Apr',d30:340,d90:160,dp:52},
  {m:'May',d30:310,d90:155,dp:48},{m:'Jun',d30:290,d90:140,dp:44},
]
const FUNNEL_STAGES = [
  {label:'Bureau Leads',n:2400,pct:100,color:'#0E2841'},
  {label:'Campaign Engaged',n:960,pct:40,color:'#1B4A7A'},
  {label:'Telemarketing Called',n:480,pct:20,color:'#C00000'},
  {label:'Hot Leads (Sales)',n:144,pct:6,color:'#D97706'},
  {label:'Applications',n:72,pct:3,color:'#2563EB'},
  {label:'Customers Won',n:36,pct:1.5,color:'#16A34A'},
]
const TOP_SALES = [
  {name:'Freddy O.',val:284,color:'#C00000'},{name:'Tobi A.',val:240,color:'#0E2841'},
  {name:'Sola B.',val:195,color:'#D97706'},{name:'Kemi R.',val:160,color:'#16A34A'},{name:'Dare M.',val:98,color:'#7C3AED'},
]

// ── Sidebar ───────────────────────────────────────────────────────────────────
interface Sub  { id:string; label:string; badge?:number; red?:boolean }
interface Item { id:string; icon:string; label:string; badge?:number; red?:boolean; subs?:Sub[] }
interface Sec  { label:string|null; items:Item[] }

const SECTIONS: Sec[] = [
  { label:null, items:[{ id:'dash', icon:'space_dashboard', label:'Dashboard', badge:3, red:true }]},
  { label:'Business Development', items:[
    { id:'bd', icon:'corporate_fare', label:'BD Leads', badge:247, subs:[
      {id:'bd-all',label:'All Leads'},{id:'bd-mine',label:'My Pipeline',badge:12},
      {id:'bd-emp',label:'Employer Register'},{id:'bd-rep',label:'BD Analytics'},
    ]},
    { id:'camps', icon:'campaign', label:'Campaigns', badge:4, subs:[
      {id:'camps-all',label:'All Campaigns'},{id:'camps-new',label:'New Campaign'},{id:'camps-tpl',label:'Templates'},
    ]},
  ]},
  { label:'Telemarketing', items:[
    { id:'tele', icon:'headset_mic', label:'Call Centre', badge:18, red:true, subs:[
      {id:'tele-out',label:'Outbound Queue',badge:18,red:true},{id:'tele-in',label:'Inbound Queue'},
      {id:'tele-dis',label:'Dispositions'},{id:'tele-dnc',label:'DNC List'},{id:'tele-prf',label:'Performance'},
    ]},
  ]},
  { label:'Sales & CRM', items:[
    { id:'sales', icon:'trending_up', label:'Sales', subs:[
      {id:'sales-pip',label:'Pipeline'},{id:'sales-coh',label:'Cohort Analysis'},{id:'sales-rep',label:'Reports'},
    ]},
    { id:'crm', icon:'contacts', label:'CRM', subs:[
      {id:'crm-con',label:'Contacts'},{id:'crm-dls',label:'Deals'},{id:'crm-tsk',label:'Tasks'},
    ]},
  ]},
  { label:'Lending', items:[
    { id:'los', icon:'receipt_long', label:'Loan Origination', badge:7, red:true, subs:[
      {id:'los-all',label:'All Applications'},{id:'los-q',label:'My Queue',badge:7,red:true},
      {id:'los-book',label:'Active Loan Book'},{id:'los-rep',label:'Repayment Schedule'},{id:'los-dis',label:'Disbursements'},
    ]},
    { id:'cards', icon:'credit_card', label:'Cards', subs:[
      {id:'cards-ov',label:'Overview'},{id:'cards-ch',label:'Cardholders'},{id:'cards-tx',label:'Transactions'},{id:'cards-dp',label:'Disputes'},
    ]},
    { id:'fd', icon:'savings', label:'Fixed Deposits', subs:[
      {id:'fd-ov',label:'FD Overview'},{id:'fd-mat',label:'Maturity Calendar',badge:5,red:true},{id:'fd-rol',label:'Rollover Queue'},
    ]},
  ]},
  { label:'Collections & Recovery', items:[
    { id:'col', icon:'collections_bookmark', label:'Collections', badge:42, red:true, subs:[
      {id:'col-ov',label:'Overview'},{id:'col-q',label:'My Queue',badge:42,red:true},
      {id:'col-ptp',label:'Promises to Pay'},{id:'col-rp',label:'Repayment Plans'},{id:'col-wo',label:'Write-off Queue'},
    ]},
    { id:'rec', icon:'gavel', label:'Recovery', subs:[
      {id:'rec-ov',label:'Overview'},{id:'rec-cas',label:'Case List'},{id:'rec-leg',label:'Legal Tracker'},{id:'rec-tpa',label:'TPA Management'},
    ]},
  ]},
  { label:'Risk & Finance', items:[
    { id:'risk', icon:'shield', label:'Risk', subs:[
      {id:'risk-db',label:'Dashboard'},{id:'risk-ph',label:'Portfolio Health'},{id:'risk-eye',label:'Eye Credit Score'},
    ]},
    { id:'fin', icon:'account_balance', label:'Finance', subs:[
      {id:'fin-ov',label:'Overview'},{id:'fin-pl',label:'P&L'},{id:'fin-rec',label:'Reconciliation'},{id:'fin-eod',label:'EOD Settlement'},
    ]},
  ]},
  { label:'Governance', items:[
    { id:'comp', icon:'verified_user', label:'Compliance', badge:2, red:true, subs:[
      {id:'comp-aml',label:'AML / Watchlist',badge:2,red:true},{id:'comp-reg',label:'Regulatory Calendar'},
      {id:'comp-kyc',label:'KYC Queue'},{id:'comp-aud',label:'Audit Trail'},
    ]},
    { id:'hr', icon:'badge', label:'HR', subs:[
      {id:'hr-emp',label:'Employees'},{id:'hr-lv',label:'Leave Management'},{id:'hr-pay',label:'Payroll'},
    ]},
  ]},
  { label:'Intelligence', items:[
    { id:'bi', icon:'bar_chart', label:'Reports & BI', subs:[
      {id:'bi-xm',label:'Cross-Module Reports'},{id:'bi-kpi',label:'KPI Tracker'},{id:'bi-exp',label:'Data Export'},
    ]},
  ]},
]

// ── Reusable bits ─────────────────────────────────────────────────────────────

const PILL_S: Record<string,{bg:string;txt:string;dkBg:string;dkTxt:string}> = {
  Hot: {bg:'#FEE2E2',txt:'#991B1B',dkBg:'rgba(192,0,0,.18)',dkTxt:'#FF7070'},
  Warm:{bg:'#FEF3C7',txt:'#92400E',dkBg:'rgba(217,119,6,.18)',dkTxt:'#FBBF24'},
  New: {bg:'#DBEAFE',txt:'#1E40AF',dkBg:'rgba(37,99,235,.18)',dkTxt:'#93C5FD'},
  Won: {bg:'#DCFCE7',txt:'#14532D',dkBg:'rgba(22,163,74,.18)',dkTxt:'#86EFAC'},
  Lost:{bg:'#F3F4F6',txt:'#6B7280',dkBg:'rgba(75,85,99,.18)',dkTxt:'#9CA3AF'},
}
function Pill({s,dark}:{s:string;dark:boolean}) {
  const p=PILL_S[s]??PILL_S.Lost
  return <span style={{padding:'3px 9px',borderRadius:99,fontSize:10.5,fontWeight:700,letterSpacing:.2,whiteSpace:'nowrap',fontFamily:INTER,background:dark?p.dkBg:p.bg,color:dark?p.dkTxt:p.txt}}>{s}</span>
}

function Spark({data,color}:{data:number[];color:string}) {
  const W=80,H=24,pd=2,max=Math.max(...data),min=Math.min(...data),rng=max-min||1
  const pts=data.map((v,i)=>`${(i/(data.length-1))*W},${H-pd-((v-min)/rng)*(H-pd*2)}`).join(' ')
  return (
    <svg width={W} height={H} style={{display:'block',overflow:'visible'}}>
      <defs><linearGradient id={`g${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity={.2}/><stop offset="100%" stopColor={color} stopOpacity={0}/>
      </linearGradient></defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#g${color.slice(1)})`}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function Tip({active,payload,label,fmt}:{active?:boolean;payload?:{name:string;value:number;color:string}[];label?:string;fmt?:(v:number)=>string}) {
  if(!active||!payload?.length) return null
  const f=fmt??(v=>String(v))
  return (
    <div style={{background:'#0E2841',borderRadius:10,padding:'10px 14px',boxShadow:'0 8px 28px rgba(0,0,0,.4)',border:'1px solid rgba(255,255,255,.08)'}}>
      {label&&<div style={{fontSize:9.5,fontWeight:600,color:'rgba(255,255,255,.4)',fontFamily:INTER,marginBottom:7,letterSpacing:.5,textTransform:'uppercase'}}>{label}</div>}
      {payload.map((p,i)=>(
        <div key={i} style={{display:'flex',alignItems:'center',gap:8,marginTop:i>0?5:0}}>
          <div style={{width:7,height:7,borderRadius:'50%',background:p.color??'#fff',flexShrink:0}}/>
          <span style={{fontSize:13,fontWeight:700,color:'#fff',fontFamily:INTER,...NUM}}>{f(p.value)}</span>
          {p.name&&payload.length>1&&<span style={{fontSize:10.5,color:'rgba(255,255,255,.4)',fontFamily:SORA}}>{p.name}</span>}
        </div>
      ))}
    </div>
  )
}

function Card({children,style}:{children:React.ReactNode;style?:React.CSSProperties}) {
  return <div style={{background:'var(--card)',border:'1px solid var(--card-bdr)',borderRadius:14,boxShadow:'var(--card-shadow)',...style}}>{children}</div>
}

function ChartCard({title,sub,children}:{title:string;sub:string;children:React.ReactNode}) {
  return (
    <Card style={{padding:'18px 20px'}}>
      <div style={{marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:'var(--txt)',fontFamily:SORA}}>{title}</div>
        <div style={{fontSize:11,color:'var(--txt2)',marginTop:2,fontFamily:INTER}}>{sub}</div>
      </div>
      {children}
    </Card>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DesignDemo() {
  const [dark,       setDark]      = useState(false)
  const [tab,        setTab]       = useState<'pipeline'|'analytics'>('pipeline')
  const [openSec,    setOpenSec]   = useState<Set<string>>(new Set(['bd']))
  const [activeNav,  setNav]       = useState('bd-mine')
  const [sortCol,    setSortCol]   = useState<keyof Lead|''>('')
  const [sortDir,    setSortDir]   = useState<1|-1>(1)
  const [selected,   setSel]       = useState<Set<number>>(new Set())
  const [search,     setSearch]    = useState('')
  const [filterOpen, setFOpen]     = useState(false)
  const [fStatuses,  setFStatuses] = useState<Set<string>>(new Set())
  const [fProducts,  setFProducts] = useState<Set<string>>(new Set())
  const [fAssignees, setFAssigns]  = useState<Set<string>>(new Set())

  const t = dark ? DARK : LIGHT

  function tog<T>(set:Set<T>, item:T, fn:(s:Set<T>)=>void) {
    const n=new Set(set); n.has(item)?n.delete(item):n.add(item); fn(n)
  }

  const filtered = useMemo(()=>{
    let rows=LEADS.filter(l=>{
      if(search&&!l.company.toLowerCase().includes(search.toLowerCase())&&!l.contact.toLowerCase().includes(search.toLowerCase())) return false
      if(fStatuses.size>0&&!fStatuses.has(l.status))   return false
      if(fProducts.size>0&&!fProducts.has(l.product))  return false
      if(fAssignees.size>0&&!fAssignees.has(l.assigned)) return false
      return true
    })
    if(sortCol) rows=[...rows].sort((a,b)=>{
      const av=a[sortCol],bv=b[sortCol]
      return(typeof av==='number'?(av as number)-(bv as number):String(av).localeCompare(String(bv)))*sortDir
    })
    return rows
  },[search,fStatuses,fProducts,fAssignees,sortCol,sortDir])

  const chips:[string,()=>void][]=[
    ...[...fStatuses].map(s=>[`Status: ${s}`,()=>tog(fStatuses,s,setFStatuses)] as [string,()=>void]),
    ...[...fProducts].map(p=>[`Product: ${p}`,()=>tog(fProducts,p,setFProducts)] as [string,()=>void]),
    ...[...fAssignees].map(a=>[`Assignee: ${a}`,()=>tog(fAssignees,a,setFAssigns)] as [string,()=>void]),
  ]
  if(search) chips.push([`"${search}"`,()=>setSearch('')])

  function clearAll(){setFStatuses(new Set());setFProducts(new Set());setFAssigns(new Set());setSearch('')}

  function SortTh({col,label,right}:{col:keyof Lead;label:string;right?:boolean}) {
    const on=sortCol===col
    return (
      <th onClick={()=>{if(sortCol===col)setSortDir(d=>d===1?-1:1);else{setSortCol(col);setSortDir(1)}}} style={{
        background:'var(--th-bg)',color:on?'var(--txt)':'var(--txt2)',fontSize:10,fontWeight:700,
        padding:'11px 14px',letterSpacing:'.6px',textTransform:'uppercase',borderBottom:'1px solid var(--bdr)',
        textAlign:right?'right':'left',cursor:'pointer',userSelect:'none',whiteSpace:'nowrap',fontFamily:INTER,
      }}>
        {label}{' '}<span style={{color:'#C00000',opacity:on?1:.3}}>{on?(sortDir===1?'↑':'↓'):'↕'}</span>
      </th>
    )
  }

  const SB_BADGE = (badge:number, red:boolean) => (
    <span style={{minWidth:18,height:18,borderRadius:99,fontSize:9.5,fontWeight:700,display:'inline-flex',alignItems:'center',justifyContent:'center',padding:'0 4px',fontFamily:INTER,
      background:red?(dark?'rgba(192,0,0,.2)':'#FEE2E2'):(dark?'#0F1A30':'#EEF0F7'),
      color:red?(dark?'#FF6060':'#C00000'):'var(--txt2)'}}>
      {badge}
    </span>
  )

  // ── Count filter matches for filter panel labels ──────────────────────────
  const countForStatus  = (s:string)=>LEADS.filter(l=>l.status===s).length
  const countForProduct = (p:string)=>LEADS.filter(l=>l.product===p).length
  const countForAssign  = (a:string)=>LEADS.filter(l=>l.assigned===a).length

  return (
    <div style={{...t,position:'fixed',inset:0,zIndex:200,display:'flex',flexDirection:'column',background:'var(--bg)',color:'var(--txt)',fontFamily:SORA,WebkitFontSmoothing:'antialiased',transition:'background .25s,color .25s'}}>

      {/* ── Topbar ── */}
      <div style={{height:48,background:'var(--sb)',borderBottom:'1px solid var(--sb-bdr)',display:'flex',alignItems:'center',padding:'0 18px',gap:12,flexShrink:0}}>
        <span style={{fontSize:13,fontWeight:700,color:'var(--txt)'}}>O3 Capital Workspace</span>
        <span style={{fontSize:11,color:'var(--txt2)',fontFamily:INTER}}>Editorial design · Inter tabular nums · Full demo</span>
        <div style={{marginLeft:'auto',display:'flex',gap:8,alignItems:'center'}}>
          <button onClick={()=>setDark(d=>!d)} style={{display:'flex',alignItems:'center',gap:5,background:'var(--chip-bg)',border:'1px solid var(--bdr)',borderRadius:99,padding:'5px 12px',cursor:'pointer',fontSize:11,fontWeight:700,color:'var(--txt2)',fontFamily:SORA,letterSpacing:.3}}>
            <span className="material-symbols-rounded" style={{fontSize:15}}>{dark?'light_mode':'dark_mode'}</span>
            {dark?'Light Mode':'Dark Mode'}
          </button>
        </div>
      </div>

      <div style={{display:'flex',flex:1,overflow:'hidden'}}>

        {/* ── Sidebar ── */}
        <aside style={{width:236,flexShrink:0,background:'var(--sb)',borderRight:'1px solid var(--sb-bdr)',display:'flex',flexDirection:'column',overflow:'hidden'}}>

          {/* Logo row */}
          <div style={{height:50,display:'flex',alignItems:'center',gap:9,padding:'0 14px',borderBottom:'1px solid var(--sb-bdr)',flexShrink:0}}>
            <div style={{width:28,height:28,borderRadius:7,background:'#0E2841',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,color:'#fff',flexShrink:0,fontFamily:INTER}}>O3</div>
            <div style={{fontSize:13.5,fontWeight:800,color:'var(--txt)',letterSpacing:-.4,whiteSpace:'nowrap'}}>
              O3 <span style={{color:'#C00000'}}>Capital</span>
            </div>
            <div style={{marginLeft:'auto',fontSize:8.5,fontWeight:700,letterSpacing:.5,color:'var(--txt2)',background:'var(--chip-bg)',padding:'2px 6px',borderRadius:4,fontFamily:INTER,whiteSpace:'nowrap'}}>WORKSPACE</div>
          </div>

          {/* Nav scroll */}
          <div style={{flex:1,overflowY:'auto',overflowX:'hidden',padding:'6px 0 12px'}}>
            {SECTIONS.map((sec,si)=>(
              <div key={si} style={{marginBottom:4}}>
                {sec.label&&<div style={{fontSize:8.5,fontWeight:700,textTransform:'uppercase',letterSpacing:1.3,color:'var(--grp)',padding:'10px 14px 3px',fontFamily:INTER}}>{sec.label}</div>}
                {sec.items.map(item=>{
                  const isOpen=openSec.has(item.id)
                  const hasSubs=!!item.subs?.length
                  const subActive=item.subs?.some(s=>s.id===activeNav)
                  const isAct=activeNav===item.id||subActive
                  return (
                    <div key={item.id}>
                      {/* Nav item */}
                      <div onClick={()=>{if(hasSubs){const n=new Set(openSec);n.has(item.id)?n.delete(item.id):n.add(item.id);setOpenSec(n)}else setNav(item.id)}}
                        style={{position:'relative',display:'flex',alignItems:'center',gap:8,padding:'0 9px 0 11px',height:32,margin:'1px 7px',borderRadius:7,cursor:'pointer',
                          color:isAct?'var(--nav-act-txt)':'var(--nav-txt)',background:isAct?'var(--nav-act-bg)':'transparent',
                          fontSize:12.5,fontWeight:isAct?600:500,transition:'background .12s,color .12s',userSelect:'none'}}
                        onMouseEnter={e=>{if(!isAct){e.currentTarget.style.background='var(--nav-hvr-bg)';e.currentTarget.style.color='var(--nav-hvr-txt)'}}}
                        onMouseLeave={e=>{if(!isAct){e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--nav-txt)'}}}>
                        {/* Active indicator bar — matches HTML ::before at left:-7px */}
                        {isAct&&<div style={{position:'absolute',left:-7,top:'50%',transform:'translateY(-50%)',width:3,height:16,background:'var(--nav-dot)',borderRadius:'0 3px 3px 0'}}/>}
                        <span className="material-symbols-rounded" style={{fontSize:16,flexShrink:0}}>{item.icon}</span>
                        <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{item.label}</span>
                        {item.badge!=null&&SB_BADGE(item.badge,!!item.red)}
                        {hasSubs&&<span className="material-symbols-rounded" style={{fontSize:13,color:'var(--grp)',flexShrink:0,transform:isOpen?'rotate(180deg)':'none',transition:'transform .2s'}}>expand_more</span>}
                      </div>

                      {/* Sub-items */}
                      {hasSubs&&(
                        <div style={{overflow:'hidden',maxHeight:isOpen?`${item.subs!.length*30+8}px`:'0',transition:'max-height .22s ease',padding:'0 7px 0 14px'}}>
                          {item.subs!.map(sub=>{
                            const sa=activeNav===sub.id
                            return (
                              <div key={sub.id} onClick={()=>setNav(sub.id)}
                                style={{display:'flex',alignItems:'center',gap:7,height:28,padding:'0 8px 0 9px',borderRadius:5,cursor:'pointer',
                                  fontSize:12,fontWeight:sa?600:500,color:sa?'var(--sub-act)':'var(--sub-txt)',
                                  background:sa?(dark?'rgba(255,255,255,.04)':'rgba(0,0,0,.02)'):'transparent',
                                  margin:'1px 0',transition:'color .12s,background .12s'}}
                                onMouseEnter={e=>{if(!sa){e.currentTarget.style.background='var(--nav-hvr-bg)';e.currentTarget.style.color='var(--sub-hvr)'}}}
                                onMouseLeave={e=>{if(!sa){e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--sub-txt)'}}}>
                                {/* 1px line indicator — matches HTML .si::before flex child */}
                                <div style={{width:1,height:14,background:sa?'var(--nav-dot)':'var(--bdr)',flexShrink:0,borderRadius:1,transition:'background .12s'}}/>
                                <span style={{flex:1}}>{sub.label}</span>
                                {sub.badge!=null&&(
                                  <span style={{minWidth:15,height:15,borderRadius:99,fontSize:9,fontWeight:700,display:'inline-flex',alignItems:'center',justifyContent:'center',padding:'0 3px',fontFamily:INTER,
                                    background:sub.red?(dark?'rgba(192,0,0,.2)':'#FEE2E2'):(dark?'#0F1A30':'#EEF0F7'),
                                    color:sub.red?(dark?'#FF6060':'#C00000'):'var(--txt2)'}}>
                                    {sub.badge}
                                  </span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          {/* Footer utility items + user row */}
          <div style={{borderTop:'1px solid var(--sb-bdr)',padding:'8px 7px 6px',flexShrink:0}}>
            {/* Utility links */}
            {[{icon:'mail',label:'Mail'},{icon:'notifications',label:'Notifications',badge:3}].map(f=>(
              <div key={f.label} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 10px',borderRadius:7,color:'var(--nav-txt)',fontSize:12,fontWeight:500,cursor:'pointer',transition:'all .12s'}}
                onMouseEnter={e=>{e.currentTarget.style.background='var(--nav-hvr-bg)';e.currentTarget.style.color='var(--nav-hvr-txt)'}}
                onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--nav-txt)'}}>
                <span className="material-symbols-rounded" style={{fontSize:16}}>{f.icon}</span>
                <span style={{flex:1}}>{f.label}</span>
                {'badge' in f&&<span style={{minWidth:17,height:17,borderRadius:99,fontSize:9.5,fontWeight:700,display:'inline-flex',alignItems:'center',justifyContent:'center',padding:'0 4px',fontFamily:INTER,background:dark?'rgba(192,0,0,.2)':'#FEE2E2',color:dark?'#FF6060':'#C00000'}}>{f.badge}</span>}
              </div>
            ))}
            {/* User row */}
            <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 10px 2px',borderTop:'1px solid var(--sb-bdr)',marginTop:4}}>
              <div style={{width:26,height:26,borderRadius:'50%',background:'linear-gradient(135deg,#0E2841,#1a3a5c)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:700,color:'#fff',flexShrink:0,fontFamily:INTER}}>TO</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11.5,fontWeight:700,color:'var(--txt)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>Temitope</div>
                <div style={{fontSize:9.5,color:'var(--txt2)',fontFamily:INTER}}>BI Lead · Product</div>
              </div>
              <span className="material-symbols-rounded" style={{fontSize:17,color:'var(--txt3)',cursor:'pointer'}}>more_horiz</span>
            </div>
          </div>
        </aside>

        {/* ── Main ── */}
        <main style={{flex:1,overflowY:'auto',display:'flex',flexDirection:'column',minHeight:0}}>

          {/* Page header */}
          <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',padding:'18px 24px',borderBottom:'1px solid var(--bdr)',flexShrink:0}}>
            <div>
              <div style={{fontSize:24,fontWeight:800,color:'var(--txt)',letterSpacing:-.7,fontFamily:SORA}}>BD Lead Pipeline</div>
              <div style={{fontSize:11.5,color:'var(--txt2)',marginTop:4,fontFamily:INTER}}>247 prospects · Freddy O. · Last synced 2 minutes ago</div>
            </div>
            <div style={{display:'flex',gap:8}}>
              <button style={{display:'flex',alignItems:'center',gap:5,background:'transparent',border:'1.5px solid var(--bdr)',color:'var(--txt2)',padding:'7px 13px',borderRadius:8,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:SORA,transition:'all .14s'}}
                onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--txt2)';e.currentTarget.style.color='var(--txt)'}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr)';e.currentTarget.style.color='var(--txt2)'}}>
                <span className="material-symbols-rounded" style={{fontSize:14}}>filter_list</span>Filter
              </button>
              <button style={{display:'flex',alignItems:'center',gap:5,background:'transparent',border:'1.5px solid var(--bdr)',color:'var(--txt2)',padding:'7px 13px',borderRadius:8,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:SORA,transition:'all .14s'}}
                onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--txt2)';e.currentTarget.style.color='var(--txt)'}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr)';e.currentTarget.style.color='var(--txt2)'}}>
                <span className="material-symbols-rounded" style={{fontSize:14}}>download</span>Export
              </button>
              <button style={{display:'flex',alignItems:'center',gap:5,background:'#C00000',border:'none',color:'#fff',padding:'7px 14px',borderRadius:8,fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:SORA}}
                onMouseEnter={e=>e.currentTarget.style.opacity='.88'}
                onMouseLeave={e=>e.currentTarget.style.opacity='1'}>
                <span className="material-symbols-rounded" style={{fontSize:14}}>upload</span>Import Leads
              </button>
            </div>
          </div>

          {/* Tab bar */}
          <div style={{display:'flex',borderBottom:'1px solid var(--bdr)',padding:'0 24px',flexShrink:0,background:'var(--bg)'}}>
            {([['pipeline','Pipeline & Table'],['analytics','Analytics & Charts']] as const).map(([id,lbl])=>(
              <button key={id} onClick={()=>setTab(id)} style={{
                padding:'10px 18px',fontSize:13,fontWeight:tab===id?700:500,cursor:'pointer',border:'none',
                background:'transparent',fontFamily:SORA,color:tab===id?'var(--txt)':'var(--txt2)',
                borderBottom:tab===id?'2px solid #C00000':'2px solid transparent',
                marginBottom:-1,transition:'color .15s',
              }}>{lbl}</button>
            ))}
          </div>

          {/* ── PIPELINE TAB ── */}
          {tab==='pipeline'&&(
            <div style={{flex:1,overflowY:'auto',padding:'24px',display:'flex',flexDirection:'column',gap:20}}>

              {/* KPI strip */}
              <Card>
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)'}}>
                  {[
                    {lbl:'Total Leads',val:'247',sub:'+18 this week',up:true,icon:'group_add',col:'#2563EB',spark:[180,200,190,220,240,210,247]},
                    {lbl:'Hot Leads',val:'34',sub:'+6 this week',up:true,icon:'local_fire_department',col:'#C00000',spark:[20,22,25,28,30,32,34]},
                    {lbl:'Pipeline MTD',val:'₦284m',sub:'+12% vs last',up:true,icon:'monetization_on',col:'#16A34A',spark:[200,220,210,240,260,270,284]},
                    {lbl:'Days to Convert',val:'14.2',sub:'−2.1d improved',up:false,icon:'schedule',col:'#D97706',spark:[18,17.5,17,16.5,16,15,14.2]},
                  ].map((k,i,arr)=>(
                    <div key={k.lbl} style={{padding:'18px 20px',borderRight:i<arr.length-1?'1px solid var(--bdr)':undefined}}>
                      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                        <span style={{fontSize:10.5,fontWeight:600,color:'var(--txt2)',textTransform:'uppercase',letterSpacing:.5,fontFamily:INTER}}>{k.lbl}</span>
                        <span className="material-symbols-rounded" style={{fontSize:16,color:k.col,opacity:.7}}>{k.icon}</span>
                      </div>
                      <div style={{fontSize:28,fontWeight:800,color:'var(--txt)',letterSpacing:-1.2,fontFamily:INTER,...NUM,lineHeight:1}}>{k.val}</div>
                      <div style={{display:'flex',alignItems:'center',gap:4,marginTop:6,fontSize:11,fontWeight:600,color:k.up?'#16A34A':'#C00000',fontFamily:INTER}}>
                        <span className="material-symbols-rounded" style={{fontSize:12}}>{k.up?'arrow_upward':'arrow_downward'}</span>{k.sub}
                      </div>
                      <div style={{marginTop:10}}><Spark data={k.spark} color={k.col}/></div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* ── TABLE CARD ── */}
              <Card style={{overflow:'hidden'}}>

                {/* ── FILTER BAR ── */}
                <div style={{padding:'14px 18px',borderBottom:'1px solid var(--bdr)',display:'flex',alignItems:'center',gap:8}}>
                  {/* Search */}
                  <div style={{display:'flex',alignItems:'center',gap:7,background:'var(--input-bg)',border:'1.5px solid var(--input-bdr)',borderRadius:9,padding:'8px 11px',minWidth:220,maxWidth:280}}>
                    <span className="material-symbols-rounded" style={{fontSize:16,color:'var(--txt3)',flexShrink:0}}>search</span>
                    <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search company or contact…"
                      style={{border:'none',background:'transparent',fontSize:12.5,color:'var(--txt)',fontFamily:SORA,outline:'none',width:'100%'}}/>
                    {search&&<button onClick={()=>setSearch('')} style={{border:'none',background:'none',cursor:'pointer',color:'var(--txt3)',padding:0,display:'flex'}}>
                      <span className="material-symbols-rounded" style={{fontSize:14}}>close</span></button>}
                  </div>

                  {/* Filter panel toggle */}
                  <button onClick={()=>setFOpen(o=>!o)} style={{
                    display:'flex',alignItems:'center',gap:6,padding:'8px 13px',borderRadius:9,cursor:'pointer',fontFamily:SORA,fontSize:12.5,fontWeight:600,
                    background:filterOpen?(dark?'#0F1A30':'#F0F3FF'):'var(--input-bg)',
                    border:`1.5px solid ${filterOpen?'#C00000':'var(--input-bdr)'}`,
                    color:filterOpen?(dark?'#FF7070':'#C00000'):'var(--txt2)',
                  }}>
                    <span className="material-symbols-rounded" style={{fontSize:15}}>tune</span>
                    Filters
                    {(fStatuses.size+fProducts.size+fAssignees.size)>0&&(
                      <span style={{minWidth:17,height:17,borderRadius:99,background:'#C00000',color:'#fff',fontSize:10,fontWeight:700,display:'inline-flex',alignItems:'center',justifyContent:'center',fontFamily:INTER}}>
                        {fStatuses.size+fProducts.size+fAssignees.size}
                      </span>
                    )}
                  </button>

                  <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:8}}>
                    <span style={{fontSize:11.5,color:'var(--txt2)',fontFamily:INTER}}>{filtered.length} of {LEADS.length}</span>
                    {chips.length>0&&(
                      <button onClick={clearAll} style={{display:'flex',alignItems:'center',gap:4,border:'1.5px solid var(--input-bdr)',background:'transparent',borderRadius:8,padding:'6px 11px',fontSize:12,fontWeight:600,color:'var(--txt2)',cursor:'pointer',fontFamily:SORA}}>
                        <span className="material-symbols-rounded" style={{fontSize:14}}>filter_alt_off</span>Clear all
                      </button>
                    )}
                    <button style={{display:'flex',alignItems:'center',gap:5,background:'transparent',border:'1.5px solid var(--input-bdr)',color:'var(--txt2)',padding:'7px 11px',borderRadius:8,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:SORA}}>
                      <span className="material-symbols-rounded" style={{fontSize:14}}>view_column</span>Columns
                    </button>
                  </div>
                </div>

                {/* ── FILTER PANEL ── */}
                {filterOpen&&(
                  <div style={{borderBottom:'1px solid var(--bdr)',background:'var(--fp-bg)',padding:'18px 20px'}}>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:24}}>

                      {/* Status column */}
                      <div>
                        <div style={{fontSize:10,fontWeight:700,letterSpacing:.7,textTransform:'uppercase',color:'var(--txt2)',fontFamily:INTER,marginBottom:10}}>Status</div>
                        <div style={{display:'flex',flexDirection:'column',gap:6}}>
                          {['Hot','Warm','New','Won','Lost'].map(s=>{
                            const checked=fStatuses.has(s)
                            return (
                              <label key={s} style={{display:'flex',alignItems:'center',gap:10,cursor:'pointer',padding:'5px 8px',borderRadius:7,background:checked?(dark?'rgba(192,0,0,.1)':'#FFF5F5'):'transparent',transition:'background .12s'}}>
                                <div onClick={()=>tog(fStatuses,s,setFStatuses)} style={{
                                  width:16,height:16,borderRadius:4,border:`1.5px solid ${checked?'#C00000':'var(--input-bdr)'}`,
                                  background:checked?'#C00000':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,cursor:'pointer',transition:'all .12s',
                                }}>
                                  {checked&&<span className="material-symbols-rounded" style={{fontSize:12,color:'#fff',lineHeight:1}}>check</span>}
                                </div>
                                <span style={{flex:1,fontSize:13,fontWeight:checked?600:400,color:checked?(dark?'#FF7070':'#C00000'):'var(--txt)',fontFamily:SORA}}>{s}</span>
                                <span style={{fontSize:11,color:'var(--txt2)',fontFamily:INTER,...NUM}}>{countForStatus(s)}</span>
                                <Pill s={s} dark={dark}/>
                              </label>
                            )
                          })}
                        </div>
                      </div>

                      {/* Product column */}
                      <div>
                        <div style={{fontSize:10,fontWeight:700,letterSpacing:.7,textTransform:'uppercase',color:'var(--txt2)',fontFamily:INTER,marginBottom:10}}>Product</div>
                        <div style={{display:'flex',flexDirection:'column',gap:6}}>
                          {['Salary Loan','Business Loan','Fixed Deposit','Credit Card'].map(p=>{
                            const checked=fProducts.has(p)
                            return (
                              <label key={p} style={{display:'flex',alignItems:'center',gap:10,cursor:'pointer',padding:'5px 8px',borderRadius:7,background:checked?(dark?'rgba(14,40,65,.15)':'#F0F4FF'):'transparent',transition:'background .12s'}}>
                                <div onClick={()=>tog(fProducts,p,setFProducts)} style={{
                                  width:16,height:16,borderRadius:4,border:`1.5px solid ${checked?'#0E2841':'var(--input-bdr)'}`,
                                  background:checked?'#0E2841':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,cursor:'pointer',transition:'all .12s',
                                }}>
                                  {checked&&<span className="material-symbols-rounded" style={{fontSize:12,color:'#fff',lineHeight:1}}>check</span>}
                                </div>
                                <span style={{flex:1,fontSize:13,fontWeight:checked?600:400,color:'var(--txt)',fontFamily:SORA}}>{p}</span>
                                <span style={{fontSize:11,color:'var(--txt2)',fontFamily:INTER,...NUM}}>{countForProduct(p)}</span>
                              </label>
                            )
                          })}
                        </div>
                      </div>

                      {/* Assignee column */}
                      <div>
                        <div style={{fontSize:10,fontWeight:700,letterSpacing:.7,textTransform:'uppercase',color:'var(--txt2)',fontFamily:INTER,marginBottom:10}}>Assignee</div>
                        <div style={{display:'flex',flexDirection:'column',gap:6}}>
                          {['Freddy O.','Sola B.','Tobi A.'].map(a=>{
                            const checked=fAssignees.has(a)
                            return (
                              <label key={a} style={{display:'flex',alignItems:'center',gap:10,cursor:'pointer',padding:'5px 8px',borderRadius:7,background:checked?(dark?'rgba(22,163,74,.1)':'#F0FDF4'):'transparent',transition:'background .12s'}}>
                                <div onClick={()=>tog(fAssignees,a,setFAssigns)} style={{
                                  width:16,height:16,borderRadius:4,border:`1.5px solid ${checked?'#16A34A':'var(--input-bdr)'}`,
                                  background:checked?'#16A34A':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,cursor:'pointer',transition:'all .12s',
                                }}>
                                  {checked&&<span className="material-symbols-rounded" style={{fontSize:12,color:'#fff',lineHeight:1}}>check</span>}
                                </div>
                                <div style={{display:'flex',alignItems:'center',gap:6,flex:1}}>
                                  <div style={{width:22,height:22,borderRadius:'50%',background:'#C00000',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:700,color:'#fff',fontFamily:INTER,flexShrink:0}}>
                                    {a.split(' ').map(x=>x[0]).join('')}
                                  </div>
                                  <span style={{fontSize:13,fontWeight:checked?600:400,color:'var(--txt)',fontFamily:SORA}}>{a}</span>
                                </div>
                                <span style={{fontSize:11,color:'var(--txt2)',fontFamily:INTER,...NUM}}>{countForAssign(a)}</span>
                              </label>
                            )
                          })}
                        </div>

                        {/* Score range — visual only */}
                        <div style={{marginTop:16}}>
                          <div style={{fontSize:10,fontWeight:700,letterSpacing:.7,textTransform:'uppercase',color:'var(--txt2)',fontFamily:INTER,marginBottom:8}}>Score Range</div>
                          <div style={{padding:'0 4px'}}>
                            <div style={{position:'relative',height:4,background:'var(--bdr)',borderRadius:99,margin:'12px 0'}}>
                              <div style={{position:'absolute',left:'15%',right:'10%',top:0,bottom:0,background:'#0E2841',borderRadius:99}}/>
                              <div style={{position:'absolute',left:'calc(15% - 7px)',top:'50%',transform:'translateY(-50%)',width:14,height:14,borderRadius:'50%',background:'#fff',border:'2px solid #0E2841',boxShadow:'0 1px 4px rgba(0,0,0,.2)',cursor:'pointer'}}/>
                              <div style={{position:'absolute',right:'calc(10% - 7px)',top:'50%',transform:'translateY(-50%)',width:14,height:14,borderRadius:'50%',background:'#fff',border:'2px solid #0E2841',boxShadow:'0 1px 4px rgba(0,0,0,.2)',cursor:'pointer'}}/>
                            </div>
                            <div style={{display:'flex',justifyContent:'space-between'}}>
                              <span style={{fontSize:11,color:'var(--txt2)',fontFamily:INTER}}>20</span>
                              <span style={{fontSize:11,color:'var(--txt2)',fontFamily:INTER}}>90</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Filter panel footer */}
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:18,paddingTop:14,borderTop:'1px solid var(--bdr)'}}>
                      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                        {chips.map(([label,clear],i)=>(
                          <div key={i} style={{display:'inline-flex',alignItems:'center',gap:5,background:'var(--chip-bg)',color:'var(--chip-txt)',padding:'4px 10px',borderRadius:99,fontSize:11.5,fontWeight:600,fontFamily:INTER}}>
                            {label}
                            <button onClick={clear} style={{border:'none',background:'none',cursor:'pointer',color:'inherit',padding:0,display:'flex',lineHeight:1}}>
                              <span className="material-symbols-rounded" style={{fontSize:13}}>close</span>
                            </button>
                          </div>
                        ))}
                        {chips.length===0&&<span style={{fontSize:12,color:'var(--txt2)',fontFamily:INTER}}>No filters applied — showing all {LEADS.length} leads</span>}
                      </div>
                      <div style={{display:'flex',gap:8,flexShrink:0}}>
                        <button onClick={clearAll} style={{padding:'7px 14px',borderRadius:8,border:'1.5px solid var(--input-bdr)',background:'transparent',color:'var(--txt2)',fontSize:12.5,fontWeight:600,cursor:'pointer',fontFamily:SORA}}>Reset</button>
                        <button onClick={()=>setFOpen(false)} style={{padding:'7px 16px',borderRadius:8,border:'none',background:'#0E2841',color:'#fff',fontSize:12.5,fontWeight:700,cursor:'pointer',fontFamily:SORA}}>
                          Apply · {filtered.length} results
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Active chips row (when panel is closed) */}
                {!filterOpen&&chips.length>0&&(
                  <div style={{padding:'8px 18px 0',display:'flex',gap:6,flexWrap:'wrap'}}>
                    {chips.map(([label,clear],i)=>(
                      <div key={i} style={{display:'inline-flex',alignItems:'center',gap:5,background:'var(--chip-bg)',color:'var(--chip-txt)',padding:'4px 10px',borderRadius:99,fontSize:11.5,fontWeight:600,fontFamily:INTER}}>
                        {label}<button onClick={clear} style={{border:'none',background:'none',cursor:'pointer',color:'inherit',padding:0,display:'flex',lineHeight:1}}>
                          <span className="material-symbols-rounded" style={{fontSize:13}}>close</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Batch bar */}
                {selected.size>0&&(
                  <div style={{background:dark?'#0F1A30':'#F0F4FF',borderBottom:'1px solid var(--bdr)',padding:'10px 18px',display:'flex',alignItems:'center',gap:10}}>
                    <span style={{fontSize:12.5,fontWeight:700,color:'var(--txt)',fontFamily:INTER}}>{selected.size} selected</span>
                    <div style={{display:'flex',gap:7}}>
                      {[{l:'Assign to Sales',r:true},{l:'Export',r:false},{l:'Add to Campaign',r:false},{l:'Archive',r:false}].map(b=>(
                        <button key={b.l} style={{padding:'5px 12px',borderRadius:7,fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:SORA,border:b.r?'none':'1.5px solid var(--input-bdr)',background:b.r?'#C00000':'transparent',color:b.r?'#fff':'var(--txt2)'}}>{b.l}</button>
                      ))}
                    </div>
                    <button onClick={()=>setSel(new Set())} style={{marginLeft:'auto',border:'none',background:'none',cursor:'pointer',color:'var(--txt2)',display:'flex',alignItems:'center',gap:3,fontSize:12,fontFamily:SORA}}>
                      <span className="material-symbols-rounded" style={{fontSize:15}}>close</span>Clear
                    </button>
                  </div>
                )}

                {/* Table */}
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',minWidth:880}}>
                    <thead>
                      <tr>
                        <th style={{background:'var(--th-bg)',padding:'11px 14px',borderBottom:'1px solid var(--bdr)',width:38}}>
                          <input type="checkbox" checked={selected.size===filtered.length&&filtered.length>0} onChange={()=>setSel(prev=>prev.size===filtered.length?new Set():new Set(filtered.map(l=>l.id)))}
                            style={{width:15,height:15,cursor:'pointer',accentColor:'#C00000'}}/>
                        </th>
                        <SortTh col="company"  label="Company"/>
                        <SortTh col="contact"  label="Contact"/>
                        <SortTh col="product"  label="Product"/>
                        <SortTh col="assigned" label="Assigned"/>
                        <SortTh col="score"    label="Score"/>
                        <SortTh col="status"   label="Status"/>
                        <SortTh col="value"    label="Est. Value" right/>
                        <th style={{background:'var(--th-bg)',borderBottom:'1px solid var(--bdr)',width:96}}/>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(l=>{
                        const sel=selected.has(l.id)
                        const scoreCol=l.score>=75?'#16A34A':l.score>=45?'#D97706':'#C00000'
                        return (
                          <tr key={l.id} onClick={()=>setSel(p=>{const n=new Set(p);n.has(l.id)?n.delete(l.id):n.add(l.id);return n})}
                            style={{background:sel?'var(--row-sel)':undefined,cursor:'pointer',transition:'background .1s'}}
                            onMouseEnter={e=>{if(!sel)e.currentTarget.style.background='var(--row-hvr)'}}
                            onMouseLeave={e=>{if(!sel)e.currentTarget.style.background=''}}>
                            <td style={{padding:'12px 14px',borderBottom:'1px solid var(--bdr)',verticalAlign:'middle'}}>
                              <input type="checkbox" checked={sel} onChange={()=>{}} onClick={e=>{e.stopPropagation();setSel(p=>{const n=new Set(p);n.has(l.id)?n.delete(l.id):n.add(l.id);return n})}}
                                style={{width:15,height:15,cursor:'pointer',accentColor:'#C00000'}}/>
                            </td>
                            <td style={{padding:'12px 14px',borderBottom:'1px solid var(--bdr)',verticalAlign:'middle'}}>
                              <div style={{display:'flex',alignItems:'center',gap:10}}>
                                <div style={{width:30,height:30,borderRadius:'50%',background:l.color,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,color:'#fff',fontFamily:INTER}}>{l.company[0]}</div>
                                <div>
                                  <div style={{fontSize:13,fontWeight:600,color:'var(--txt)',lineHeight:1.3,fontFamily:SORA}}>{l.company}</div>
                                  <div style={{fontSize:10.5,color:'var(--txt2)',fontFamily:INTER}}>{l.sector}</div>
                                </div>
                              </div>
                            </td>
                            <td style={{padding:'12px 14px',borderBottom:'1px solid var(--bdr)',verticalAlign:'middle'}}>
                              <div style={{fontSize:13,fontWeight:500,color:'var(--txt)',fontFamily:SORA}}>{l.contact}</div>
                              <div style={{fontSize:10.5,color:'var(--txt2)',fontFamily:INTER}}>{l.role}</div>
                            </td>
                            <td style={{padding:'12px 14px',borderBottom:'1px solid var(--bdr)',fontSize:12.5,color:'var(--txt)',verticalAlign:'middle',fontFamily:SORA}}>{l.product}</td>
                            <td style={{padding:'12px 14px',borderBottom:'1px solid var(--bdr)',verticalAlign:'middle'}}>
                              <div style={{display:'flex',alignItems:'center',gap:6}}>
                                <div style={{width:22,height:22,borderRadius:'50%',background:'#C00000',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:700,color:'#fff',fontFamily:INTER,flexShrink:0}}>
                                  {l.assigned.split(' ').map(x=>x[0]).join('')}
                                </div>
                                <span style={{fontSize:12.5,color:'var(--txt)',fontFamily:SORA}}>{l.assigned}</span>
                              </div>
                            </td>
                            <td style={{padding:'12px 14px',borderBottom:'1px solid var(--bdr)',verticalAlign:'middle'}}>
                              <div style={{display:'flex',alignItems:'center',gap:7}}>
                                <div style={{width:56,height:4,background:'var(--bdr)',borderRadius:99,overflow:'hidden'}}>
                                  <div style={{width:`${l.score}%`,height:'100%',background:scoreCol,borderRadius:99}}/>
                                </div>
                                <span style={{fontSize:11.5,fontWeight:600,color:'var(--txt2)',fontFamily:INTER,...NUM,width:22}}>{l.score}</span>
                              </div>
                            </td>
                            <td style={{padding:'12px 14px',borderBottom:'1px solid var(--bdr)',verticalAlign:'middle'}}><Pill s={l.status} dark={dark}/></td>
                            <td style={{padding:'12px 14px',borderBottom:'1px solid var(--bdr)',textAlign:'right',verticalAlign:'middle'}}>
                              <span style={{fontSize:13,fontWeight:600,color:'var(--txt)',fontFamily:INTER,...NUM}}>₦{l.value.toLocaleString()}</span>
                            </td>
                            <td style={{padding:'12px 14px',borderBottom:'1px solid var(--bdr)',verticalAlign:'middle'}} onClick={e=>e.stopPropagation()}>
                              <div style={{display:'flex',gap:5}}>
                                {(['call','mail','swap_horiz'] as const).map(ic=>(
                                  <button key={ic} style={{width:28,height:28,borderRadius:7,border:'1.5px solid var(--input-bdr)',background:'transparent',display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',color:'var(--txt2)'}}
                                    onMouseEnter={e=>{e.currentTarget.style.borderColor=ic==='swap_horiz'?'#C00000':'var(--txt2)';e.currentTarget.style.color=ic==='swap_horiz'?'#C00000':'var(--txt)'}}
                                    onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--input-bdr)';e.currentTarget.style.color='var(--txt2)'}}>
                                    <span className="material-symbols-rounded" style={{fontSize:14}}>{ic}</span>
                                  </button>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                      {filtered.length===0&&(
                        <tr><td colSpan={9} style={{padding:'52px 14px',textAlign:'center',color:'var(--txt2)',fontSize:13,fontFamily:SORA}}>
                          No leads match the current filters.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 18px',borderTop:'1px solid var(--bdr)'}}>
                  <span style={{fontSize:12,color:'var(--txt2)',fontFamily:INTER}}>Showing 1–{filtered.length} of {LEADS.length} leads</span>
                  <div style={{display:'flex',gap:5}}>
                    {(['chevron_left','1','2','3','chevron_right'] as const).map((p,i)=>(
                      <button key={i} style={{width:30,height:30,borderRadius:7,border:'1.5px solid var(--input-bdr)',background:p==='1'?'#C00000':'transparent',color:p==='1'?'#fff':'var(--txt2)',fontSize:12.5,fontWeight:600,cursor:'pointer',fontFamily:INTER,display:'flex',alignItems:'center',justifyContent:'center'}}>
                        {p.length===1?p:<span className="material-symbols-rounded" style={{fontSize:16}}>{p}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* ── ANALYTICS TAB ── */}
          {tab==='analytics'&&(
            <div style={{flex:1,overflowY:'auto',padding:'24px',display:'flex',flexDirection:'column',gap:14}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
                <ChartCard title="Interest Income Trend" sub="Monthly income (₦m) · Finance Overview · Area Chart">
                  <ResponsiveContainer width="100%" height={148}>
                    <AreaChart data={INCOME_DATA} margin={{top:4,right:8,bottom:0,left:-18}}>
                      <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0E2841" stopOpacity={dark?.35:.18}/>
                        <stop offset="100%" stopColor="#0E2841" stopOpacity={0}/>
                      </linearGradient></defs>
                      <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1}/>
                      <XAxis dataKey="m" tick={{fontSize:10,fill:'var(--chart-lbl)',fontFamily:INTER}} axisLine={false} tickLine={false}/>
                      <YAxis tick={{fontSize:10,fill:'var(--chart-lbl)',fontFamily:INTER}} axisLine={false} tickLine={false}/>
                      <Tooltip content={(p:any)=><Tip {...p} fmt={(v:number)=>`₦${v}m`}/>}/>
                      <Area type="monotone" dataKey="v" stroke="#0E2841" strokeWidth={2.2} fill="url(#ag)"
                        dot={{r:3,fill:'#0E2841',strokeWidth:0}} activeDot={{r:5,fill:'#0E2841',stroke:'#fff',strokeWidth:2}} name="Income"/>
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="Pipeline by LOS Stage" sub="Applications per stage · Loan Origination · Bar Chart">
                  <ResponsiveContainer width="100%" height={148}>
                    <BarChart data={PIPELINE_DATA} margin={{top:4,right:8,bottom:0,left:-18}} barCategoryGap="30%">
                      <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1}/>
                      <XAxis dataKey="stage" tick={{fontSize:9,fill:'var(--chart-lbl)',fontFamily:INTER}} axisLine={false} tickLine={false}/>
                      <YAxis tick={{fontSize:10,fill:'var(--chart-lbl)',fontFamily:INTER}} axisLine={false} tickLine={false}/>
                      <Tooltip content={(p:any)=><Tip {...p} fmt={(v:number)=>`${v} apps`}/>}/>
                      <Bar dataKey="n" radius={[5,5,0,0]} name="Applications">
                        {PIPELINE_DATA.map((e,i)=><Cell key={i} fill={e.fill}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div style={{display:'flex',flexWrap:'wrap',gap:10,marginTop:10}}>
                    {PIPELINE_DATA.map(d=>(
                      <div key={d.stage} style={{display:'flex',alignItems:'center',gap:5,fontSize:10.5,color:'var(--txt2)',fontFamily:INTER}}>
                        <div style={{width:8,height:8,borderRadius:2,background:d.fill,flexShrink:0}}/>{d.stage}
                      </div>
                    ))}
                  </div>
                </ChartCard>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
                {/* Donut */}
                <ChartCard title="Portfolio Breakdown" sub="By product type · Risk & Finance · Donut Chart">
                  <div style={{display:'flex',alignItems:'center',gap:20}}>
                    <div style={{position:'relative',flexShrink:0}}>
                      <PieChart width={148} height={148}>
                        <Pie data={DONUT_DATA} cx={70} cy={70} innerRadius={42} outerRadius={66}
                          dataKey="pct" stroke="none" paddingAngle={3} startAngle={90} endAngle={-270}>
                          {DONUT_DATA.map((e,i)=><Cell key={i} fill={e.color}/>)}
                        </Pie>
                        <Tooltip content={(p:any)=><Tip {...p} fmt={(v:number)=>`${v}%`}/>}/>
                      </PieChart>
                      <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',textAlign:'center',pointerEvents:'none'}}>
                        <div style={{fontSize:22,fontWeight:800,color:'var(--txt)',fontFamily:INTER,...NUM,lineHeight:1}}>100</div>
                        <div style={{fontSize:9,color:'var(--txt2)',fontFamily:INTER,marginTop:2}}>accounts</div>
                      </div>
                    </div>
                    <div style={{flex:1,display:'flex',flexDirection:'column',gap:9}}>
                      {DONUT_DATA.map(d=>(
                        <div key={d.name} style={{display:'flex',alignItems:'center',gap:8}}>
                          <div style={{width:10,height:10,borderRadius:3,background:d.color,flexShrink:0}}/>
                          <span style={{flex:1,fontSize:12,color:'var(--txt)',fontFamily:SORA,fontWeight:500}}>{d.name}</span>
                          <span style={{fontSize:13,fontWeight:700,color:'var(--txt)',fontFamily:INTER,...NUM}}>{d.pct}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </ChartCard>

                {/* Funnel */}
                <ChartCard title="Lead → Customer Funnel" sub="BD to close conversion · BD & Sales">
                  <div style={{display:'flex',flexDirection:'column',gap:3,marginTop:4}}>
                    {FUNNEL_STAGES.map((s,i)=>{
                      const convRate=i>0?`${((s.n/FUNNEL_STAGES[i-1].n)*100).toFixed(0)}% converted`:null
                      return (
                        <div key={s.label}>
                          <div style={{display:'flex',alignItems:'center',gap:10}}>
                            <div style={{width:152,fontSize:11.5,fontWeight:500,color:'var(--txt2)',fontFamily:SORA,flexShrink:0,textAlign:'right',lineHeight:1.2}}>{s.label}</div>
                            <div style={{flex:1,height:24,background:'var(--bdr)',borderRadius:5,overflow:'hidden'}}>
                              <div style={{width:`${s.pct}%`,height:'100%',background:s.color,borderRadius:5,minWidth:4}}/>
                            </div>
                            <div style={{display:'flex',gap:6,width:90,flexShrink:0}}>
                              <span style={{fontSize:11.5,fontWeight:700,color:'var(--txt)',fontFamily:INTER,...NUM,minWidth:42,textAlign:'right'}}>{s.n.toLocaleString()}</span>
                              <span style={{fontSize:10.5,color:'var(--txt2)',fontFamily:INTER,minWidth:32}}>{s.pct}%</span>
                            </div>
                          </div>
                          {convRate&&(
                            <div style={{display:'flex',alignItems:'center',gap:10,margin:'1px 0'}}>
                              <div style={{width:152,flexShrink:0}}/>
                              <div style={{flex:1,paddingLeft:8,display:'flex',alignItems:'center',gap:3}}>
                                <span className="material-symbols-rounded" style={{fontSize:10,color:'var(--txt3)'}}>south</span>
                                <span style={{fontSize:9.5,color:'var(--txt3)',fontFamily:INTER}}>{convRate}</span>
                              </div>
                              <div style={{width:90,flexShrink:0}}/>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </ChartCard>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
                <ChartCard title="Collections DPD Trend" sub="Accounts by bucket over 6 months · Multi-Line">
                  <ResponsiveContainer width="100%" height={148}>
                    <LineChart data={DPD_DATA} margin={{top:4,right:8,bottom:0,left:-18}}>
                      <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1}/>
                      <XAxis dataKey="m" tick={{fontSize:10,fill:'var(--chart-lbl)',fontFamily:INTER}} axisLine={false} tickLine={false}/>
                      <YAxis tick={{fontSize:10,fill:'var(--chart-lbl)',fontFamily:INTER}} axisLine={false} tickLine={false}/>
                      <Tooltip content={(p:any)=><Tip {...p} fmt={(v:number)=>`${v} accounts`}/>}/>
                      <Line type="monotone" dataKey="d30" stroke="#D97706" strokeWidth={2.2} dot={{r:3,fill:'#D97706',strokeWidth:0}} activeDot={{r:5,stroke:'#fff',strokeWidth:2}} name="DPD 1–30"/>
                      <Line type="monotone" dataKey="d90" stroke="#C00000" strokeWidth={2.2} dot={{r:3,fill:'#C00000',strokeWidth:0}} activeDot={{r:5,stroke:'#fff',strokeWidth:2}} name="DPD 31–90"/>
                      <Line type="monotone" dataKey="dp"  stroke="#7C3AED" strokeWidth={2.2} dot={{r:3,fill:'#7C3AED',strokeWidth:0}} activeDot={{r:5,stroke:'#fff',strokeWidth:2}} name="DPD 90+"/>
                    </LineChart>
                  </ResponsiveContainer>
                  <div style={{display:'flex',gap:16,marginTop:10,justifyContent:'flex-end'}}>
                    {[['#D97706','DPD 1–30'],['#C00000','DPD 31–90'],['#7C3AED','DPD 90+']].map(([c,l])=>(
                      <div key={l} style={{display:'flex',alignItems:'center',gap:6,fontSize:10.5,color:'var(--txt2)',fontFamily:INTER}}>
                        <div style={{width:16,height:2.5,borderRadius:2,background:c}}/>{l}
                      </div>
                    ))}
                  </div>
                </ChartCard>

                <ChartCard title="Top Sales Officers" sub="Pipeline value closed MTD · Horizontal Bars">
                  <div style={{display:'flex',flexDirection:'column',gap:14,marginTop:4}}>
                    {TOP_SALES.map((p,i)=>(
                      <div key={p.name}>
                        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
                          <div style={{display:'flex',alignItems:'center',gap:8}}>
                            <span style={{fontSize:10,fontWeight:700,color:'var(--txt3)',fontFamily:INTER,width:14}}>#{i+1}</span>
                            <span style={{fontSize:12.5,fontWeight:600,color:'var(--txt)',fontFamily:SORA}}>{p.name}</span>
                          </div>
                          <span style={{fontSize:13,fontWeight:700,color:'var(--txt)',fontFamily:INTER,...NUM}}>₦{p.val}m</span>
                        </div>
                        <div style={{height:6,background:'var(--bdr)',borderRadius:99,overflow:'hidden'}}>
                          <div style={{width:`${(p.val/320)*100}%`,height:'100%',background:p.color,borderRadius:99}}/>
                        </div>
                      </div>
                    ))}
                  </div>
                </ChartCard>
              </div>

              <div style={{height:12}}/>
            </div>
          )}

        </main>
      </div>
    </div>
  )
}
