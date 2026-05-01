import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.html(demoHtml);
});

export default app;

// ---------------------------------------------------------------------------
// Inline HTML — self-contained demo page (shadcn/ui + Tailwind CDN)
// ---------------------------------------------------------------------------
const demoHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cortex Demo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,300;0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400;1,8..60,600&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'hsl(40 20% 98%)',
        foreground: 'hsl(210 30% 17%)',
        card: 'hsl(0 0% 100%)',
        'card-foreground': 'hsl(210 30% 17%)',
        primary: 'hsl(210 30% 17%)',
        'primary-foreground': 'hsl(0 0% 100%)',
        secondary: 'hsl(40 10% 95%)',
        'secondary-foreground': 'hsl(210 20% 30%)',
        muted: 'hsl(40 10% 95%)',
        'muted-foreground': 'hsl(210 10% 55%)',
        accent: 'hsl(40 10% 95%)',
        'accent-foreground': 'hsl(210 30% 17%)',
        destructive: 'hsl(0 72% 51%)',
        border: 'hsl(40 10% 90%)',
        input: 'hsl(40 10% 90%)',
        ring: 'hsl(43 100% 38%)',
        cx: {
          gold: '#B8860B',
          'gold-warm': '#D4A017',
          green: '#27844A',
          blue: '#2E6BBF',
          purple: '#6C47B8',
          orange: '#C76A15',
          cyan: '#0E7C86',
          red: '#C0392B',
        },
      },
      fontFamily: {
        display: ["'Source Serif 4'", 'Georgia', 'serif'],
        body: ["'DM Sans'", '-apple-system', 'sans-serif'],
        mono: ["'DM Mono'", "'SF Mono'", 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '16px',
      },
    },
  },
}
</script>
<style>
@keyframes fadeIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
@keyframes cursorBlink { 0%, 100% { opacity: 1 } 50% { opacity: 0 } }
@keyframes spin { to { transform: rotate(360deg) } }
.fade-in { animation: fadeIn .3s ease }
.cursor-blink::after { content: '\\2588'; animation: cursorBlink .8s step-end infinite; color: var(--tw-ring-color, #B8860B); margin-left: 1px }
.spinner-sm { display: inline-block; width: 14px; height: 14px; border: 2px solid hsl(40 10% 90%); border-top-color: #B8860B; border-radius: 50%; animation: spin .6s linear infinite }
.chip-select { appearance: none; -webkit-appearance: none; cursor: pointer; background-image: none }
.chip-select:focus { box-shadow: 0 0 0 2px rgba(184,134,11,.15) }
/* Tab active state */
.tab-active { color: #B8860B !important; border-bottom-color: #B8860B !important }
/* JSON highlighting */
.jk { color: #2E6BBF } .js { color: #27844A } .jn { color: #0E7C86 } .jl { color: #B8860B }
/* Scrollbar */
.chat-scroll::-webkit-scrollbar { width: 6px }
.chat-scroll::-webkit-scrollbar-thumb { background: hsl(40 10% 85%); border-radius: 3px }
.chat-scroll::-webkit-scrollbar-track { background: transparent }
/* Inspector slide */
.inspector-panel { transform: translateX(100%); transition: transform .3s ease }
.inspector-panel.open { transform: translateX(0) }
/* Tool card toggle */
.tool-body { display: none } .tool-card.open .tool-body { display: block }
.tool-card.open .tool-chevron { transform: rotate(90deg) }
</style>
</head>
<body class="bg-background text-foreground font-body text-[15px] leading-relaxed h-screen flex flex-col overflow-hidden antialiased">

<!-- ===== HEADER ========================================================= -->
<header class="flex items-center justify-between px-8 h-14 bg-background/90 backdrop-blur-md border-b border-border flex-shrink-0 z-10">
  <div class="flex items-center gap-4">
    <div class="flex items-center gap-2.5 font-mono font-medium text-sm tracking-[0.22em] uppercase text-primary">
      Cortex<span class="text-cx-gold">.</span>
      <span id="ver" class="text-[11px] text-muted-foreground font-mono px-2 py-0.5 bg-secondary rounded border border-border"></span>
    </div>
    <div class="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
      <span id="hdot" class="w-2 h-2 rounded-full bg-muted-foreground transition-all duration-300"></span>
      <span id="htxt">connecting...</span>
    </div>
  </div>
  <div class="flex items-center gap-2.5">
    <input type="password" id="key" class="w-64 px-3.5 py-2 bg-card text-foreground border border-input rounded-sm font-mono text-[13px] outline-none transition-all focus:border-cx-gold focus:ring-2 focus:ring-cx-gold/10 placeholder:text-muted-foreground" placeholder="API key (ctx_...)" autocomplete="off" spellcheck="false"/>
    <button id="eye" class="p-1.5 text-muted-foreground hover:text-primary hover:bg-secondary border border-transparent hover:border-border rounded-sm transition-all cursor-pointer" title="Show/hide key">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
    </button>
    <span id="model-indicator" class="hidden text-[11px] font-mono text-cx-gold cursor-pointer hover:opacity-80" title="Click to change model"></span>
    <button id="inspector-toggle" class="p-1.5 text-muted-foreground hover:text-primary hover:bg-secondary border border-transparent hover:border-border rounded-sm transition-all cursor-pointer" title="Inspector">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
  </div>
</header>

<!-- ===== CHAT CONTAINER ================================================= -->
<div id="chat-container" class="flex-1 overflow-y-auto chat-scroll scroll-smooth">
  <div class="max-w-[820px] mx-auto px-8 py-10 pb-6 flex flex-col gap-4" id="chat-messages">
    <!-- Empty state -->
    <div id="empty-state" class="flex flex-col items-center py-20 text-center">
      <div class="w-20 h-20 mb-7 bg-card border border-border rounded-full flex items-center justify-center relative">
        <div class="absolute inset-[-6px] border border-border/50 rounded-full"></div>
        <svg class="w-8 h-8 text-cx-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
          <line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>
          <line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>
        </svg>
      </div>
      <h2 class="font-display text-[22px] font-semibold text-primary mb-2 tracking-tight">Ready to go</h2>
      <p class="text-[15px] text-muted-foreground max-w-[380px] leading-relaxed">Enter your API key above, type a message, and watch the agentic loop unfold &mdash; skill discovery, planning, execution, all in real time.</p>
    </div>
  </div>
</div>

<!-- ===== INPUT BAR ====================================================== -->
<div class="flex-shrink-0 border-t border-border bg-card px-8 py-4">
  <div class="max-w-[820px] mx-auto">
    <div class="flex items-end gap-3">
      <textarea id="prompt" rows="1" class="flex-1 resize-none px-4 py-3 bg-secondary text-foreground border border-input rounded-md font-body text-[15px] leading-relaxed outline-none min-h-[48px] max-h-[160px] transition-all focus:border-cx-gold focus:ring-2 focus:ring-cx-gold/8 placeholder:text-muted-foreground" placeholder="What should Cortex do?"></textarea>
      <button id="send" class="px-6 py-3 bg-primary text-primary-foreground rounded-sm text-[15px] font-semibold cursor-pointer transition-all hover:opacity-90 active:scale-[.98] disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap" disabled>
        Send &rarr;
      </button>
    </div>
    <div class="flex items-center gap-3 mt-3">
      <select id="mode" class="chip-select px-3.5 py-1.5 bg-secondary text-secondary-foreground border border-border rounded-full text-[13px] font-medium font-body outline-none transition-all hover:border-cx-gold">
        <option value="full_auto">Full Auto</option>
        <option value="review_before_run">Review First</option>
        <option value="step_by_step">Step by Step</option>
      </select>
      <select id="appetite" class="chip-select px-3.5 py-1.5 bg-secondary text-secondary-foreground border border-border rounded-full text-[13px] font-medium font-body outline-none transition-all hover:border-cx-gold">
        <option value="balanced">Balanced</option>
        <option value="strict">Strict</option>
        <option value="cautious">Cautious</option>
        <option value="adventurous">Adventurous</option>
      </select>
      <select id="product" class="chip-select px-3.5 py-1.5 bg-secondary text-secondary-foreground border border-border rounded-full text-[13px] font-medium font-body outline-none transition-all hover:border-cx-gold">
        <option value="bombastic">Bombastic</option>
        <option value="costaff">CoStaff</option>
        <option value="controlcenter">ControlCenter</option>
      </select>
    </div>
  </div>
</div>

<!-- ===== INSPECTOR (slide-out) ========================================== -->
<div id="inspector-overlay" class="fixed inset-0 bg-primary/20 z-50 opacity-0 pointer-events-none transition-opacity duration-300">
  <div id="inspector" class="inspector-panel fixed top-0 right-0 bottom-0 w-[420px] max-w-[90vw] bg-card border-l border-border z-[51] flex flex-col">
    <div class="flex items-center justify-between px-6 py-5 border-b border-border">
      <h2 class="font-display text-lg font-semibold text-primary">Inspector</h2>
      <button id="inspector-close" class="text-muted-foreground hover:text-primary text-xl cursor-pointer p-1 transition-colors">&times;</button>
    </div>
    <div class="flex border-b border-border" id="inspector-tabs">
      <button class="inspector-tab tab-active flex-1 py-3 bg-transparent border-b-2 border-transparent text-muted-foreground text-[13px] font-semibold font-body cursor-pointer uppercase tracking-wider transition-all hover:text-secondary-foreground" data-tab="timeline">Timeline</button>
      <button class="inspector-tab flex-1 py-3 bg-transparent border-b-2 border-transparent text-muted-foreground text-[13px] font-semibold font-body cursor-pointer uppercase tracking-wider transition-all hover:text-secondary-foreground" data-tab="models">Models</button>
      <button class="inspector-tab flex-1 py-3 bg-transparent border-b-2 border-transparent text-muted-foreground text-[13px] font-semibold font-body cursor-pointer uppercase tracking-wider transition-all hover:text-secondary-foreground" data-tab="sessions">Sessions</button>
    </div>
    <div class="flex-1 overflow-y-auto p-6" id="inspector-body">
      <div class="text-muted-foreground text-[13px] py-2">No events yet</div>
    </div>
  </div>
</div>

<!-- ===== JAVASCRIPT ===================================================== -->
<script>
(function(){
'use strict';
const B = location.origin;

/* -- Helpers -------------------------------------------------------------- */
function esc(s){ const d=document.createElement('div'); d.textContent=String(s??''); return d.innerHTML }
function fj(o){
  const s=JSON.stringify(o,null,2);
  return esc(s)
    .replace(/&quot;([^&]+?)&quot;\\s*:/g,'<span class="jk">"$1"</span>:')
    .replace(/: &quot;(.*?)&quot;/g,': <span class="js">"$1"</span>')
    .replace(/: (\\d+\\.?\\d*)/g,': <span class="jn">$1</span>')
    .replace(/: (true|false|null)/g,': <span class="jl">$1</span>');
}
function trustBadge(v){ const c=v>=0.8?'bg-cx-green/10 text-cx-green':v>=0.6?'bg-cx-gold/10 text-cx-gold':'bg-cx-red/10 text-cx-red'; return '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-mono font-medium '+c+'">'+v.toFixed(2)+'</span>' }
function verBadge(t){ const c=t==='certified'||t==='verified'?'border-cx-green text-cx-green':t==='scanned'?'border-cx-gold text-cx-gold':'border-cx-red text-cx-red'; return '<span class="text-[10px] border px-2 py-0.5 rounded-full font-mono font-medium '+c+'">'+esc(t||'unverified')+'</span>' }
function layerBadge(l){ return '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-mono font-medium bg-cx-blue/10 text-cx-blue">'+esc(l||'?')+'</span>' }
function ago(t){ const m=Date.now()-new Date(t).getTime(); if(m<60000)return 'just now'; if(m<3.6e6)return Math.floor(m/60000)+'m ago'; if(m<8.64e7)return Math.floor(m/3.6e6)+'h ago'; return Math.floor(m/8.64e7)+'d ago' }
function md(s){
  if(!s) return '';
  return esc(s)
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong class="font-semibold text-primary">$1</strong>')
    .replace(/\`([^\`]+)\`/g,'<code class="px-1.5 py-0.5 bg-secondary rounded text-[13px] font-mono">$1</code>')
    .replace(/\\n/g,'<br>');
}

/* ========================================================================= */
/* ChatApi — calls /v1/chat and yields stream parts                          */
/* ========================================================================= */
class ChatApi {
  constructor(){ this.key=localStorage.getItem('cortex_key')||''; this.conversationId=null }
  setKey(k){ this.key=k; localStorage.setItem('cortex_key',k) }
  hd(){ return { Authorization:'Bearer '+this.key, 'Content-Type':'application/json' } }
  newConversation(){ this.conversationId=null }

  async get(p){ const r=await fetch(B+p,{headers:this.hd()}); return {s:r.status, d:await r.json().catch(()=>null)} }
  async post(p,b){ const r=await fetch(B+p,{method:'POST',headers:this.hd(),body:JSON.stringify(b)}); return {s:r.status, d:await r.json().catch(()=>null)} }
  async meta(){ return (await fetch(B+'/')).json() }
  async health(){ return (await fetch(B+'/health')).json() }

  async *chat(message, opts){
    const body = {
      productId: opts.product||'bombastic',
      messages: [{ role:'user', content:message }],
      ...(this.conversationId ? { conversationId:this.conversationId } : {}),
      ...(opts.model ? { model:opts.model } : {}),
      ...(opts.context ? { context:opts.context } : {}),
    };
    const r = await fetch(B+'/v1/chat', {
      method:'POST',
      headers:this.hd(),
      body:JSON.stringify(body),
    });
    if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||'HTTP '+r.status) }
    const rd=r.body.getReader(), dc=new TextDecoder(); let buf='';
    while(true){
      const{done,value}=await rd.read(); if(done) break;
      buf += dc.decode(value,{stream:true});
      const lines = buf.split('\\n'); buf = lines.pop();
      for(const line of lines){
        if(!line.startsWith('data: ')) continue;
        const json = line.slice(6);
        if(json==='[DONE]') return;
        try{
          const part = JSON.parse(json);
          // Capture conversationId from data parts
          if(part.type==='data' && Array.isArray(part.data)){
            for(const d of part.data){
              if(d && d.type==='conversation' && d.conversationId){
                this.conversationId = d.conversationId;
              }
            }
          }
          yield part;
        }catch(e){}
      }
    }
  }
}

/* ========================================================================= */
/* ChatUI — renders chat bubbles and handles stream parts                    */
/* ========================================================================= */
class ChatUI {
  constructor(container, messagesEl, inspectorCallback){
    this.container = container;
    this.messages = messagesEl;
    this.onInspector = inspectorCallback;
    this.currentBubble = null;
    this.currentProse = null;
    this.startTime = null;
  }

  clearEmpty(){
    const em = document.getElementById('empty-state');
    if(em) em.remove();
  }

  addUserBubble(text){
    this.clearEmpty();
    const div = document.createElement('div');
    div.className = 'flex justify-end fade-in';
    div.innerHTML = '<div class="max-w-[75%] px-5 py-3.5 bg-primary text-primary-foreground rounded-lg rounded-br-sm text-[15px] leading-relaxed whitespace-pre-wrap break-words">'+esc(text)+'</div>';
    this.messages.appendChild(div);
    this.scroll();
  }

  startAssistantBubble(){
    this.startTime = Date.now();
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-start fade-in';
    const bubble = document.createElement('div');
    bubble.className = 'max-w-[85%] flex flex-col gap-3';
    wrap.appendChild(bubble);
    this.messages.appendChild(wrap);
    this.currentBubble = bubble;
    this.currentProse = null;
    this.scroll();
  }

  handlePart(part){
    if(!this.currentBubble) this.startAssistantBubble();
    const t = part.type?.replace(/-/g,'_');
    const fn = this['_'+t];
    if(fn) fn.call(this, part);
    // Handle data sub-parts
    if(part.type==='data' && Array.isArray(part.data)){
      for(const d of part.data){
        if(d && d.type){ const dfn=this['_data_'+d.type.replace(/-/g,'_')]; if(dfn) dfn.call(this,d) }
      }
    }
    // Forward to inspector
    if(this.onInspector) this.onInspector(part);
    this.scroll();
  }

  _text_start(d){
    const prose = document.createElement('div');
    prose.className = 'px-5 py-3.5 bg-card border border-border rounded-lg text-[15px] leading-relaxed cursor-blink';
    this.currentBubble.appendChild(prose);
    this.currentProse = prose;
  }

  _text_delta(d){
    if(!this.currentProse) this._text_start(d);
    // Append text, remove blink class temporarily
    const txt = d.delta || d.textDelta || '';
    this.currentProse.classList.add('cursor-blink');
    // Use a text node approach to avoid HTML injection
    const existing = this.currentProse.getAttribute('data-raw') || '';
    const updated = existing + txt;
    this.currentProse.setAttribute('data-raw', updated);
    this.currentProse.innerHTML = md(updated);
    this.currentProse.classList.add('cursor-blink');
  }

  _text_end(d){
    if(this.currentProse){
      this.currentProse.classList.remove('cursor-blink');
      const raw = this.currentProse.getAttribute('data-raw') || '';
      this.currentProse.innerHTML = md(raw);
    }
  }

  _tool_call(d){
    const n = d.toolName||'?';
    const args = d.args||{};
    const icons = {findSkill:'\\u{1F50D}', checkPolicy:'\\u{1F6E1}', buildPlan:'\\u{1F6E0}', invokeSkill:'\\u25B6', emitDecomposition:'\\u{1F4CB}'};
    const ico = icons[n]||'\\u{1F527}';
    const readable = this._readableToolCall(n, args);

    const card = document.createElement('div');
    card.className = 'tool-card border border-border rounded-md bg-card overflow-hidden fade-in';
    card.setAttribute('data-tool-call-id', d.toolCallId||'');
    card.innerHTML =
      '<div class="tool-hdr flex items-center gap-2.5 px-4 py-3 cursor-pointer select-none hover:bg-secondary/50 transition-colors">'
        +'<span class="text-base">'+ico+'</span>'
        +'<span class="font-semibold text-[13px] text-primary font-mono">'+esc(n)+'</span>'
        +'<span class="tool-chevron text-muted-foreground text-[10px] transition-transform duration-200 ml-auto">\\u25B6</span>'
      +'</div>'
      +'<div class="tool-body border-t border-border px-4 py-3">'
        +readable
        +'<div class="mt-3">'
          +'<button class="toggle-json text-[11px] font-mono text-muted-foreground border border-border px-2.5 py-1 rounded cursor-pointer hover:text-cx-gold hover:border-cx-gold transition-all">show json</button>'
          +'<pre class="hidden mt-2 bg-secondary border border-border rounded-sm p-3.5 font-mono text-[12px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto text-secondary-foreground">'+fj(args)+'</pre>'
        +'</div>'
      +'</div>';

    card.querySelector('.tool-hdr').addEventListener('click',()=>card.classList.toggle('open'));
    card.querySelector('.toggle-json').addEventListener('click',(e)=>{
      e.stopPropagation();
      const pre=e.target.nextElementSibling; pre.classList.toggle('hidden');
    });
    this.currentBubble.appendChild(card);
  }

  _readableToolCall(name, args){
    if(name==='findSkill')
      return '<div class="text-[13px] text-secondary-foreground leading-relaxed">Searching for: <strong class="text-primary">'+esc(args.query||'')+'</strong></div>';
    if(name==='buildPlan'){
      const steps=args.steps||[];
      if(!steps.length) return '<div class="text-[13px] text-secondary-foreground">Building execution plan...</div>';
      return '<div class="text-[13px] text-secondary-foreground">Building plan with <strong class="text-primary">'+steps.length+'</strong> step(s): '
        +steps.map(s=>'<strong class="text-primary">'+esc(s.skillSlug||s.slug||'?')+'</strong>').join(' \\u2192 ')+'</div>';
    }
    if(name==='checkPolicy')
      return '<div class="text-[13px] text-secondary-foreground">Checking policy for <strong class="text-primary">'+esc(args.skillSlug||args.slug||'?')+'</strong></div>';
    if(name==='invokeSkill')
      return '<div class="text-[13px] text-secondary-foreground">Executing <strong class="text-primary">'+esc(args.skillSlug||args.slug||'?')+'</strong></div>';
    if(name==='emitDecomposition')
      return '<div class="text-[13px] text-secondary-foreground">Breaking down into <strong class="text-primary">'+(args.steps?.length||0)+'</strong> steps</div>';
    return '';
  }

  _tool_result(d){
    const n = d.toolName||'';
    const r = d.result||{};
    // Find matching tool card and update it
    const card = this.currentBubble?.querySelector('[data-tool-call-id="'+(d.toolCallId||'')+'"]');
    if(card){
      const body = card.querySelector('.tool-body');
      if(body){
        const resultDiv = document.createElement('div');
        resultDiv.className = 'mt-3 pt-3 border-t border-border';
        resultDiv.innerHTML = this._readableToolResult(n, r);
        body.appendChild(resultDiv);
      }
      return;
    }
    // Fallback: standalone result card
    const standalone = document.createElement('div');
    standalone.className = 'border border-border rounded-md bg-card px-4 py-3 fade-in';
    standalone.innerHTML = '<div class="text-[12px] font-mono font-medium text-muted-foreground mb-2">'+esc(n)+' result</div>'+this._readableToolResult(n, r);
    this.currentBubble.appendChild(standalone);
  }

  _readableToolResult(name, r){
    if(name==='findSkill' && r && r.results){
      let s='<div class="text-[13px] text-secondary-foreground mb-2">Found <strong class="text-primary">'+r.results.length+'</strong> skill(s)</div>';
      if(r.results.length){
        s+='<div class="border border-border rounded-md overflow-hidden"><table class="w-full text-[12px] border-collapse"><thead><tr class="bg-secondary">';
        s+='<th class="text-left px-3 py-2 text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">Skill</th>';
        s+='<th class="text-left px-3 py-2 text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">Trust</th>';
        s+='<th class="text-left px-3 py-2 text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">Tier</th>';
        s+='<th class="text-left px-3 py-2 text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">Layer</th>';
        s+='</tr></thead><tbody>';
        r.results.forEach(sk=>{
          s+='<tr class="hover:bg-secondary/50"><td class="px-3 py-2 font-mono font-medium text-primary">'+esc(sk.slug||sk.name||sk.id)+'</td>';
          s+='<td class="px-3 py-2">'+trustBadge(sk.trustScore??0)+'</td>';
          s+='<td class="px-3 py-2">'+verBadge(sk.verificationTier)+'</td>';
          s+='<td class="px-3 py-2">'+layerBadge(sk.executionLayer)+'</td></tr>';
        });
        s+='</tbody></table></div>';
      }
      return s;
    }
    if(name==='buildPlan' && r && r.steps){
      let s='<div class="flex items-center gap-0 py-3 overflow-x-auto flex-wrap">';
      r.steps.forEach((st,i)=>{
        if(i) s+='<div class="text-muted-foreground text-lg px-2">\\u2192</div>';
        s+='<div class="flex flex-col items-center px-4 py-3 bg-secondary rounded-md border border-border min-w-[120px] text-center">';
        s+='<div class="w-7 h-7 rounded-full bg-primary text-primary-foreground text-[12px] font-bold flex items-center justify-center mb-2">'+(i+1)+'</div>';
        s+='<div class="font-mono text-[12px] font-medium text-primary mb-1.5">'+esc(st.skillSlug||st.slug||'?')+'</div>';
        s+='<div class="flex gap-1">'+trustBadge(st.trustScore??0)+layerBadge(st.executionLayer)+'</div></div>';
      });
      s+='</div>';
      if(r.reasoning) s+='<div class="text-[13px] italic text-muted-foreground mt-2">"'+esc(r.reasoning)+'"</div>';
      return s;
    }
    if(name==='checkPolicy' && r){
      const ok=r.allowed!==false;
      return '<div class="text-[13px]">'
        +(ok?'<span class="text-cx-green">\\u2713 Allowed</span>':'<span class="text-cx-red">\\u2717 Blocked</span>')
        +(r.requiresReview?' &mdash; <span class="text-cx-gold">requires review</span>':'')
      +'</div>';
    }
    if(name==='invokeSkill' && r){
      const ok=r.success!==false;
      return '<div class="text-[13px]">'
        +(ok?'<span class="text-cx-green">\\u2713 Success</span>':'<span class="text-cx-red">\\u2717 Failed</span>')
        +(r.durationMs?' <span class="text-muted-foreground font-mono text-[12px] ml-1">'+r.durationMs+'ms</span>':'')
      +'</div>';
    }
    return '<pre class="bg-secondary border border-border rounded-sm p-3 font-mono text-[12px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">'+fj(r)+'</pre>';
  }

  _data_conversation(d){
    // No visible element in chat, just informational
  }

  _data_decomposition(d){
    const steps = d.steps||[];
    const list = document.createElement('div');
    list.className = 'border border-border rounded-md bg-card overflow-hidden fade-in';
    list.setAttribute('data-decomposition', 'true');
    let html = '<div class="px-4 py-2.5 bg-secondary border-b border-border text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Plan Steps</div>';
    html += '<div class="divide-y divide-border">';
    steps.forEach((s,i)=>{
      const needsApproval = s.requires_approval ? '<span class="ml-auto text-[10px] font-mono text-cx-gold border border-cx-gold rounded px-1.5 py-0.5">approval</span>' : '';
      html += '<div class="flex items-center gap-3 px-4 py-3" data-step-index="'+i+'">'
        +'<span class="w-5 h-5 rounded-full border-2 border-border flex items-center justify-center text-[11px] text-muted-foreground flex-shrink-0" data-step-circle>'+( i+1)+'</span>'
        +'<span class="text-[13px] text-secondary-foreground">'+esc(s.title)+'</span>'
        +needsApproval
      +'</div>';
    });
    html += '</div>';
    list.innerHTML = html;
    this.currentBubble.appendChild(list);
  }

  _data_approval_required(d){
    if(!d.workflowId) return;
    const bar = document.createElement('div');
    bar.className = 'flex items-center gap-4 px-5 py-4 bg-cx-gold/5 border border-cx-gold/20 rounded-md fade-in';
    bar.innerHTML = '<span class="text-[14px] font-semibold flex-1 text-primary">Plan ready for review</span>'
      +'<button class="approve-btn px-5 py-2 bg-cx-green text-white rounded-sm text-[14px] font-semibold cursor-pointer transition-all hover:opacity-85">Approve</button>'
      +'<button class="reject-btn px-5 py-2 bg-cx-red text-white rounded-sm text-[14px] font-semibold cursor-pointer transition-all hover:opacity-85">Reject</button>';
    bar.querySelector('.approve-btn').addEventListener('click',()=>window._app.approve(d.workflowId));
    bar.querySelector('.reject-btn').addEventListener('click',()=>window._app.reject(d.workflowId));
    this.currentBubble.appendChild(bar);
  }

  _data_workflow_complete(d){
    const badge = document.createElement('div');
    badge.className = 'inline-flex items-center gap-2 px-4 py-2.5 bg-cx-green/5 border border-cx-green/20 rounded-md text-cx-green text-[14px] font-semibold fade-in';
    badge.innerHTML = '<span>\\u2713</span> Workflow Complete'
      +(this.startTime?' <span class="text-muted-foreground font-mono text-[12px] font-normal ml-2">'+((Date.now()-this.startTime)/1000).toFixed(1)+'s</span>':'');
    this.currentBubble.appendChild(badge);
  }

  _step_start(d){
    // Update decomposition item if present
    const decom = this.currentBubble?.querySelector('[data-decomposition]');
    if(decom){
      const item = decom.querySelector('[data-step-index="'+(d.stepIndex??0)+'"]');
      if(item){
        const circle = item.querySelector('[data-step-circle]');
        if(circle){ circle.innerHTML = '<span class="spinner-sm"></span>'; circle.className='flex-shrink-0' }
      }
    }
  }

  _step_finish(d){
    const decom = this.currentBubble?.querySelector('[data-decomposition]');
    if(decom){
      const item = decom.querySelector('[data-step-index="'+(d.stepIndex??0)+'"]');
      if(item){
        const ok = d.success!==false;
        const circle = item.querySelector('[data-step-circle]');
        if(circle){
          circle.innerHTML = ok?'\\u2713':'\\u2717';
          circle.className = 'w-5 h-5 rounded-full flex items-center justify-center text-[11px] flex-shrink-0 '+(ok?'bg-cx-green/10 text-cx-green border-2 border-cx-green/30':'bg-cx-red/10 text-cx-red border-2 border-cx-red/30');
        }
        if(d.durationMs){
          const dur = document.createElement('span');
          dur.className = 'text-muted-foreground font-mono text-[11px] ml-auto';
          dur.textContent = d.durationMs+'ms';
          item.appendChild(dur);
        }
      }
    }
  }

  _error(d){
    const err = document.createElement('div');
    err.className = 'px-4 py-3 bg-cx-red/5 border border-cx-red/20 rounded-md text-cx-red text-[14px] leading-relaxed fade-in';
    err.textContent = d.errorText||JSON.stringify(d);
    if(this.currentBubble) this.currentBubble.appendChild(err);
    else this.messages.appendChild(err);
  }

  _finish(d){
    // Stream complete — no visual needed
    this.currentBubble = null;
    this.currentProse = null;
  }

  scroll(){
    requestAnimationFrame(()=>{ this.container.scrollTop = this.container.scrollHeight });
  }
}

/* ========================================================================= */
/* Inspector — slide-out drawer with Timeline, Models, Sessions              */
/* ========================================================================= */
class Inspector {
  constructor(api){
    this.api = api;
    this.tab = 'timeline';
    this.events = [];
    this.selectedModel = null;
    this.defaultModel = null;
    this.modelList = [];

    this.overlay = document.getElementById('inspector-overlay');
    this.panel = document.getElementById('inspector');
    this.body = document.getElementById('inspector-body');

    document.getElementById('inspector-toggle').addEventListener('click',()=>this.open());
    document.getElementById('inspector-close').addEventListener('click',()=>this.close());
    this.overlay.addEventListener('click',(e)=>{ if(e.target===this.overlay) this.close() });

    document.querySelectorAll('.inspector-tab').forEach(t=>{
      t.addEventListener('click',()=>{
        document.querySelectorAll('.inspector-tab').forEach(x=>x.classList.remove('tab-active'));
        t.classList.add('tab-active');
        this.tab = t.dataset.tab;
        this.render();
      });
    });
  }

  getSelectedModel(){ return this.selectedModel }

  open(){ this.overlay.classList.add('opacity-100','pointer-events-auto'); this.overlay.classList.remove('opacity-0','pointer-events-none'); this.panel.classList.add('open'); this.render() }
  close(){ this.overlay.classList.remove('opacity-100','pointer-events-auto'); this.overlay.classList.add('opacity-0','pointer-events-none'); this.panel.classList.remove('open') }

  addEvent(part){
    this.events.push({ ...part, _ts: Date.now() });
    if(this.tab==='timeline' && this.overlay.classList.contains('opacity-100')) this.renderTimeline();
  }

  clearEvents(){ this.events=[]; if(this.tab==='timeline') this.renderTimeline() }

  render(){
    if(this.tab==='timeline') this.renderTimeline();
    else if(this.tab==='models') this.renderModels();
    else this.renderSessions();
  }

  renderTimeline(){
    if(!this.events.length){ this.body.innerHTML='<div class="text-muted-foreground text-[13px] py-2">No events yet</div>'; return }
    let html='<div class="flex flex-col gap-2">';
    this.events.forEach((ev,i)=>{
      const t=ev.type||'?';
      const colors={
        'text-start':'border-l-cx-cyan bg-cx-cyan/5','text-delta':'border-l-cx-cyan','text-end':'border-l-cx-cyan',
        'tool-call':'border-l-cx-purple bg-cx-purple/5','tool-result':'border-l-cx-purple',
        'step-start':'border-l-cx-orange','step-finish':'border-l-cx-green',
        'data':'border-l-muted-foreground','error':'border-l-cx-red bg-cx-red/5','finish':'border-l-cx-gold'
      };
      const c = colors[t]||'border-l-border';
      html+='<div class="border border-border border-l-[3px] '+c+' rounded-md px-3 py-2 text-[12px]">';
      html+='<div class="flex items-center gap-2"><span class="font-mono font-semibold text-primary">'+esc(t)+'</span>';
      html+='<span class="ml-auto text-muted-foreground font-mono text-[10px]">'+((ev._ts - (this.events[0]?._ts||ev._ts))/1000).toFixed(1)+'s</span></div>';
      // Brief content preview
      if(t==='text-delta' && ev.delta) html+='<div class="mt-1 text-muted-foreground truncate">'+esc((ev.delta||'').slice(0,80))+'</div>';
      if(t==='tool-call') html+='<div class="mt-1 text-cx-purple font-mono">'+esc(ev.toolName||'')+'</div>';
      if(t==='tool-result') html+='<div class="mt-1 text-cx-purple font-mono">'+esc(ev.toolName||'')+' result</div>';
      if(t==='error') html+='<div class="mt-1 text-cx-red">'+esc(ev.errorText||'')+'</div>';
      if(t==='data' && Array.isArray(ev.data)) ev.data.forEach(d=>{ if(d&&d.type) html+='<div class="mt-1 text-muted-foreground">'+esc(d.type)+'</div>' });
      html+='</div>';
    });
    html+='</div>';
    this.body.innerHTML=html;
    this.body.scrollTop=this.body.scrollHeight;
  }

  async renderModels(){
    const el=this.body;
    if(!this.api.key){ el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">Enter API key first</div>'; return }
    if(this.modelList.length){ this._drawModels(); return }
    el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">Loading models...</div>';
    try{
      const{s,d}=await this.api.get('/v1/models');
      if(s!==200||!d.models){ el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">Failed to load</div>'; return }
      this.modelList=d.models; this.defaultModel=d.default;
      this._drawModels();
    }catch(e){ el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">'+esc(e.message)+'</div>' }
  }

  _drawModels(){
    const el=this.body;
    el.innerHTML=this.modelList.map(m=>{
      const isDef=m.id===this.defaultModel;
      const isSel=m.id===this.selectedModel;
      let cls='flex items-center gap-2 px-2 py-2 text-[13px] font-mono text-muted-foreground border-b border-border cursor-pointer rounded hover:bg-secondary transition-colors';
      if(isSel) cls+=' text-cx-gold font-medium';
      else if(isDef && !this.selectedModel) cls+=' text-cx-green font-medium';
      let tags='';
      if(isDef) tags+='<span class="text-[9px] uppercase tracking-wider text-cx-green border border-cx-green rounded px-1 py-px ml-auto">default</span>';
      if(isSel) tags+='<span class="text-[9px] uppercase tracking-wider text-cx-gold border border-cx-gold rounded px-1 py-px ml-auto">selected</span>';
      return '<div class="model-item" data-model="'+esc(m.id)+'" style="cursor:pointer"><div class="'+cls+'"><span class="w-1.5 h-1.5 rounded-full '+(isSel?'bg-cx-gold':isDef&&!this.selectedModel?'bg-cx-green':'bg-muted-foreground')+'"></span>'+esc(m.id)+tags+'</div></div>';
    }).join('');
    el.querySelectorAll('.model-item').forEach(item=>{
      item.addEventListener('click',()=>{
        const mid=item.dataset.model;
        this.selectedModel = mid===this.selectedModel ? null : mid;
        this._drawModels();
        this._updateModelIndicator();
      });
    });
  }

  _updateModelIndicator(){
    const el=document.getElementById('model-indicator');
    if(!el) return;
    if(this.selectedModel){
      el.textContent = this.selectedModel.replace('cognium/','');
      el.classList.remove('hidden'); el.classList.add('inline');
    } else {
      el.classList.add('hidden'); el.classList.remove('inline');
    }
  }

  async renderSessions(){
    const el=this.body;
    if(!this.api.key){ el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">Enter API key first</div>'; return }
    el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">Loading sessions...</div>';
    try{
      const{s,d}=await this.api.get('/v1/sessions?limit=20');
      if(s!==200||!d.sessions){ el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">'+(s===500?'DB unavailable':'Failed')+'</div>'; return }
      if(!d.sessions.length){ el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">No sessions yet</div>'; return }
      el.innerHTML=d.sessions.map(sess=>{
        const dotColor={completed:'bg-cx-green',paused_for_review:'bg-cx-gold',paused_at_step:'bg-cx-gold',failed:'bg-cx-red',running:'bg-cx-cyan',planning:'bg-cx-cyan',timed_out:'bg-muted-foreground'}[sess.status]||'bg-muted-foreground';
        return '<div class="flex items-center gap-3 px-2 py-3 rounded-sm cursor-pointer transition-colors hover:bg-secondary border-b border-border" data-session-id="'+esc(sess.id)+'">'
          +'<span class="w-2 h-2 rounded-full flex-shrink-0 '+dotColor+'"></span>'
          +'<div class="flex-1 min-w-0">'
            +'<div class="text-[13px] text-secondary-foreground truncate">'+esc((sess.prompt||'').slice(0,60))+'</div>'
            +'<div class="text-[11px] text-muted-foreground font-mono mt-0.5">'+esc(sess.status||'')+' \\u00B7 '+(sess.createdAt?ago(sess.createdAt):'')+'</div>'
          +'</div></div>';
      }).join('');
      el.querySelectorAll('[data-session-id]').forEach(i=>i.addEventListener('click',()=>this.sessionDetail(i.dataset.sessionId)));
    }catch(e){ el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">'+esc(e.message)+'</div>' }
  }

  async sessionDetail(id){
    const el=this.body;
    el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">Loading...</div>';
    try{
      const{s,d}=await this.api.get('/v1/sessions/'+id);
      if(s!==200||!d){ el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">Not found</div>'; return }
      let x='<button class="text-cx-gold text-[12px] font-mono cursor-pointer mb-3 hover:underline" id="sess-back">\\u2190 Back</button>';
      x+='<h3 class="font-display text-base font-semibold text-primary mb-3">Session Detail</h3>';
      x+='<div class="mb-2 text-[13px]"><div class="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Status</div>'+esc(d.status)+'</div>';
      x+='<div class="mb-2 text-[13px]"><div class="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Prompt</div>'+esc(d.prompt||'')+'</div>';
      if(d.steps && d.steps.length){
        x+='<div class="mt-3"><div class="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Steps</div>';
        d.steps.forEach(st=>{
          const sc=st.status==='completed'?'text-cx-green':st.status==='failed'?'text-cx-red':'text-cx-gold';
          x+='<div class="p-2.5 bg-secondary border border-border rounded-sm mb-1.5 text-[12px]">'
            +'<div class="flex items-center gap-2 font-medium">'
            +'<span>'+esc(st.skillSlug||st.skillId||'?')+'</span>'
            +'<span class="'+sc+'">'+esc(st.status)+'</span>'
            +(st.durationMs?'<span class="text-muted-foreground text-[11px] ml-auto">'+st.durationMs+'ms</span>':'')
            +'</div></div>';
        });
        x+='</div>';
      }
      el.innerHTML=x;
      document.getElementById('sess-back').addEventListener('click',()=>this.renderSessions());
    }catch(e){ el.innerHTML='<div class="text-muted-foreground text-[13px] py-2">'+esc(e.message)+'</div>' }
  }
}

/* ========================================================================= */
/* App — orchestrates ChatApi + ChatUI + Inspector                           */
/* ========================================================================= */
class App {
  constructor(){
    this.api = new ChatApi();
    this.inspector = new Inspector(this.api);
    this.chat = new ChatUI(
      document.getElementById('chat-container'),
      document.getElementById('chat-messages'),
      (part)=>this.inspector.addEvent(part)
    );
    this.running = false;
    this.init();
  }

  async init(){
    const ki = document.getElementById('key');
    ki.value = this.api.key;
    let debounce;
    ki.addEventListener('input',()=>{
      clearTimeout(debounce);
      debounce = setTimeout(()=>{
        this.api.setKey(ki.value.trim());
        this.updateBtn();
      }, 400);
    });
    document.getElementById('eye').addEventListener('click',()=>{ ki.type=ki.type==='password'?'text':'password' });
    document.getElementById('send').addEventListener('click',()=>this.send());
    document.getElementById('prompt').addEventListener('keydown',e=>{
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); this.send() }
    });
    // Auto-resize textarea + update button state
    const self = this;
    document.getElementById('prompt').addEventListener('input',function(){
      this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,160)+'px';
      self.updateBtn();
    });

    document.getElementById('model-indicator').addEventListener('click',()=>this.inspector.open());

    this.loadMeta(); this.loadHealth();
    this.updateBtn();
  }

  updateBtn(){
    const b=document.getElementById('send');
    const hasKey = !!this.api.key;
    const hasPrompt = !!document.getElementById('prompt').value.trim();
    b.disabled = !hasKey || !hasPrompt || this.running;
    b.textContent = this.running ? 'Sending...' : 'Send \\u2192';
    // Hint: pulse key input if user types prompt without key
    const ki=document.getElementById('key');
    if(!hasKey && hasPrompt){
      ki.classList.add('border-cx-gold','ring-2','ring-cx-gold/20');
      ki.placeholder='\\u2190 Enter API key first';
    } else {
      ki.classList.remove('border-cx-gold','ring-2','ring-cx-gold/20');
      ki.placeholder='API key (ctx_...)';
    }
  }

  async loadMeta(){
    try{ const m=await this.api.meta(); document.getElementById('ver').textContent='v'+(m.version||'?') }catch(e){}
  }

  async loadHealth(){
    try{
      const h=await this.api.health();
      const dot=document.getElementById('hdot');
      dot.className='w-2 h-2 rounded-full transition-all duration-300 '+(h.status==='healthy'?'bg-cx-green shadow-[0_0_6px_rgba(39,132,74,.3)]':h.status==='degraded'?'bg-cx-gold shadow-[0_0_6px_rgba(184,134,11,.3)]':'bg-cx-red shadow-[0_0_6px_rgba(192,57,43,.3)]');
      document.getElementById('htxt').textContent=h.status||'?';
    }catch(e){
      document.getElementById('hdot').className='w-2 h-2 rounded-full bg-cx-red shadow-[0_0_6px_rgba(192,57,43,.3)]';
      document.getElementById('htxt').textContent='offline';
    }
  }

  async send(){
    const ta=document.getElementById('prompt');
    const text=ta.value.trim();
    if(!text || !this.api.key || this.running) return;

    this.running=true; this.updateBtn();
    ta.value=''; ta.style.height='auto';

    this.chat.addUserBubble(text);
    this.chat.startAssistantBubble();
    this.inspector.clearEvents();

    const opts = {
      product: document.getElementById('product').value,
      mode: document.getElementById('mode').value,
      appetite: document.getElementById('appetite').value,
    };
    const selModel = this.inspector.getSelectedModel();
    if(selModel) opts.model = selModel;

    try{
      for await(const part of this.api.chat(text, opts)){
        this.chat.handlePart(part);
      }
    }catch(e){
      this.chat.handlePart({type:'error',errorText:e.message});
    }finally{
      this.running=false; this.updateBtn();
    }
  }

  async approve(wf){
    try{
      const{d}=await this.api.post('/v1/workflows/'+wf+'/resume',{approved:true});
      this.chat.handlePart({type:'text-start'});
      this.chat.handlePart({type:'text-delta',delta:'Approved. '+(d?.summary||'')});
      this.chat.handlePart({type:'text-end'});
    }catch(e){ this.chat.handlePart({type:'error',errorText:'Approve failed: '+e.message}) }
  }

  async reject(wf){
    try{
      const{d}=await this.api.post('/v1/workflows/'+wf+'/resume',{approved:false});
      this.chat.handlePart({type:'text-start'});
      this.chat.handlePart({type:'text-delta',delta:'Rejected.'});
      this.chat.handlePart({type:'text-end'});
    }catch(e){ this.chat.handlePart({type:'error',errorText:'Reject failed: '+e.message}) }
  }
}

window._app = new App();
})();
</script>
</body>
</html>`;
