import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.html(demoHtml);
});

export default app;

// ---------------------------------------------------------------------------
// Inline HTML — self-contained demo page
// ---------------------------------------------------------------------------
const demoHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cortex Demo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
/* ======================================================================= */
/* DESIGN TOKENS                                                           */
/* ======================================================================= */
:root {
  --bg:      #0a0e17;
  --surface: #111827;
  --card:    #1a2235;
  --raised:  #212d45;
  --hover:   #273352;
  --border:  rgba(255,255,255,0.06);
  --border-b:rgba(255,255,255,0.1);

  --t1: #f1f5f9;
  --t2: #94a3b8;
  --t3: #64748b;
  --t4: #475569;

  --accent:  #6366f1;
  --accent2: #818cf8;
  --blue:    #60a5fa;
  --green:   #34d399;
  --yellow:  #fbbf24;
  --red:     #f87171;
  --purple:  #a78bfa;
  --cyan:    #22d3ee;
  --orange:  #fb923c;

  --green-s: rgba(52,211,153,0.12);
  --yellow-s:rgba(251,191,36,0.12);
  --red-s:   rgba(248,113,113,0.12);
  --blue-s:  rgba(96,165,250,0.10);
  --purple-s:rgba(167,139,250,0.08);
  --cyan-s:  rgba(34,211,238,0.08);

  --sans: 'Inter', system-ui, -apple-system, sans-serif;
  --mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 1px 3px rgba(0,0,0,.3), 0 4px 16px rgba(0,0,0,.2);
  --shadow-lg: 0 4px 24px rgba(0,0,0,.4);
}

/* ======================================================================= */
/* RESET                                                                   */
/* ======================================================================= */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
body {
  background: var(--bg);
  color: var(--t1);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.6;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
::selection { background: rgba(99,102,241,0.3) }

/* ======================================================================= */
/* HEADER                                                                  */
/* ======================================================================= */
.hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 32px; height: 56px;
  background: var(--surface); border-bottom: 1px solid var(--border);
  flex-shrink: 0; z-index: 10;
}
.hdr-l { display: flex; align-items: center; gap: 16px }
.logo {
  display: flex; align-items: center; gap: 10px;
  font-weight: 800; font-size: 18px; letter-spacing: -0.4px;
}
.logo svg { width: 24px; height: 24px; color: var(--accent) }
.ver {
  font-size: 11px; color: var(--t3); font-family: var(--mono);
  padding: 3px 8px; background: var(--card); border-radius: 6px;
}
.health { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--t3); font-weight: 500 }
.hdot { width: 8px; height: 8px; border-radius: 50%; background: var(--t4); transition: all .3s }
.hdot.ok { background: var(--green); box-shadow: 0 0 8px rgba(52,211,153,.5) }
.hdot.degraded { background: var(--yellow); box-shadow: 0 0 8px rgba(251,191,36,.5) }
.hdot.down { background: var(--red); box-shadow: 0 0 8px rgba(248,113,113,.5) }
.hdr-r { display: flex; align-items: center; gap: 10px }
.key-in {
  width: 280px; padding: 8px 14px;
  background: var(--card); color: var(--t1);
  border: 1px solid var(--border-b); border-radius: var(--radius-sm);
  font-family: var(--mono); font-size: 13px;
  outline: none; transition: border .2s, box-shadow .2s;
}
.key-in:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.15) }
.key-in::placeholder { color: var(--t4) }
.icon-btn {
  background: none; border: none; color: var(--t4); cursor: pointer;
  padding: 6px; display: flex; align-items: center; border-radius: 6px;
  transition: color .15s, background .15s;
}
.icon-btn:hover { color: var(--t1); background: var(--card) }

/* ======================================================================= */
/* LAYOUT                                                                  */
/* ======================================================================= */
.page { flex: 1; overflow-y: auto; scroll-behavior: smooth }
.page-inner {
  max-width: 820px; margin: 0 auto;
  padding: 40px 32px 80px;
}
@media (max-width: 640px) { .page-inner { padding: 24px 16px 60px } }

/* ======================================================================= */
/* PROMPT HERO                                                             */
/* ======================================================================= */
.hero {
  background: var(--surface);
  border: 1px solid var(--border-b);
  border-radius: var(--radius);
  padding: 28px 28px 24px;
  box-shadow: var(--shadow);
  margin-bottom: 32px;
}
.hero-label {
  font-size: 13px; font-weight: 600; color: var(--t3);
  text-transform: uppercase; letter-spacing: 0.8px;
  margin-bottom: 14px;
}
.hero textarea {
  width: 100%; resize: none;
  padding: 14px 18px;
  background: var(--card); color: var(--t1);
  border: 1px solid var(--border-b); border-radius: var(--radius-sm);
  font-family: var(--sans); font-size: 15px; line-height: 1.6;
  outline: none; min-height: 56px; max-height: 160px;
  transition: border .2s, box-shadow .2s;
}
.hero textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.12) }
.hero textarea::placeholder { color: var(--t4) }
.hero-row {
  display: flex; align-items: center; gap: 12px;
  margin-top: 16px; flex-wrap: wrap;
}
.chip {
  padding: 7px 14px;
  background: var(--card); color: var(--t2);
  border: 1px solid var(--border-b); border-radius: 20px;
  font-size: 13px; font-weight: 500; font-family: var(--sans);
  outline: none; cursor: pointer; appearance: none;
  -webkit-appearance: none;
  transition: border .15s, color .15s;
}
.chip:hover { border-color: var(--accent); color: var(--t1) }
.chip:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(99,102,241,.15) }
.run-btn {
  margin-left: auto;
  padding: 10px 32px;
  background: var(--accent); color: #fff;
  border: none; border-radius: var(--radius-sm);
  font-size: 15px; font-weight: 700; font-family: var(--sans);
  cursor: pointer; letter-spacing: 0.2px;
  transition: all .2s;
  box-shadow: 0 2px 8px rgba(99,102,241,.3);
}
.run-btn:hover:not(:disabled) { background: #5558e6; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(99,102,241,.4) }
.run-btn:active:not(:disabled) { transform: translateY(0) }
.run-btn:disabled { opacity: .35; cursor: not-allowed; box-shadow: none }

/* ======================================================================= */
/* EMPTY STATE                                                             */
/* ======================================================================= */
.empty-state {
  display: flex; flex-direction: column; align-items: center;
  padding: 80px 20px; text-align: center;
}
.empty-state .glyph {
  width: 72px; height: 72px; margin-bottom: 28px;
  background: var(--surface); border: 1px solid var(--border-b);
  border-radius: 50%; display: flex; align-items: center; justify-content: center;
}
.empty-state .glyph svg { width: 32px; height: 32px; color: var(--t4) }
.empty-state h2 { font-size: 18px; font-weight: 700; color: var(--t2); margin-bottom: 8px }
.empty-state p { font-size: 14px; color: var(--t4); max-width: 380px; line-height: 1.7 }

/* ======================================================================= */
/* EVENT CARDS                                                             */
/* ======================================================================= */
@keyframes slideUp {
  from { opacity: 0; transform: translateY(12px) }
  to   { opacity: 1; transform: translateY(0) }
}
.timeline { display: flex; flex-direction: column; gap: 12px }

.ev {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
  animation: slideUp .3s ease;
  box-shadow: 0 1px 4px rgba(0,0,0,.15);
  transition: background .15s;
  border-left: 4px solid var(--border-b);
}
.ev:hover { background: var(--card) }
.ev-hdr {
  display: flex; align-items: center; gap: 10px;
  cursor: pointer; user-select: none;
}
.ev-icon {
  flex-shrink: 0; width: 28px; height: 28px;
  border-radius: 8px; display: flex; align-items: center; justify-content: center;
  font-size: 14px; background: var(--card);
}
.ev-title { font-weight: 700; font-size: 14px; color: var(--t1) }
.ev-time {
  margin-left: auto; font-size: 12px; font-weight: 500;
  color: var(--t4); font-family: var(--mono);
}
.ev-chevron {
  color: var(--t4); font-size: 10px; transition: transform .2s;
  margin-left: 4px;
}
.ev.open .ev-chevron { transform: rotate(90deg) }
.ev-body { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); display: none }
.ev.open .ev-body { display: block }

/* Event type accents */
.ev.conversation  { border-left-color: var(--t4) }
.ev.planning      { border-left-color: var(--cyan); background: var(--cyan-s) }
.ev.tool_call     { border-left-color: var(--purple); background: var(--purple-s) }
.ev.tool_result   { border-left-color: var(--purple) }
.ev.step_start    { border-left-color: var(--orange) }
.ev.step_complete { border-left-color: var(--green) }
.ev.step_complete.fail { border-left-color: var(--red) }
.ev.workflow_complete  { border-left-color: var(--green); background: var(--green-s) }
.ev.error         { border-left-color: var(--red); background: var(--red-s) }
.ev.done          { border-left-color: var(--accent) }

.ev.planning .ev-icon { background: var(--cyan-s); color: var(--cyan) }
.ev.tool_call .ev-icon { background: var(--purple-s); color: var(--purple) }
.ev.tool_result .ev-icon { background: var(--purple-s); color: var(--purple) }
.ev.step_start .ev-icon { background: rgba(251,146,60,.12) }
.ev.step_complete .ev-icon { background: var(--green-s); color: var(--green) }
.ev.workflow_complete .ev-icon { background: var(--green-s); color: var(--green) }
.ev.error .ev-icon { background: var(--red-s); color: var(--red) }

/* ======================================================================= */
/* RESULT CARD                                                             */
/* ======================================================================= */
.result-card {
  background: var(--surface);
  border: 1px solid rgba(52,211,153,.2);
  border-radius: var(--radius);
  padding: 24px 28px;
  margin-top: 4px;
  animation: slideUp .35s ease;
  box-shadow: 0 2px 12px rgba(52,211,153,.06);
}
.result-card h3 {
  font-size: 16px; font-weight: 700;
  margin-bottom: 16px; display: flex; align-items: center; gap: 10px;
  color: var(--green);
}
.result-text {
  font-size: 15px; line-height: 1.8; color: var(--t1);
  white-space: pre-wrap; word-break: break-word;
}
.result-meta {
  display: flex; gap: 20px; margin-top: 20px;
  padding-top: 16px; border-top: 1px solid var(--border); flex-wrap: wrap;
}
.result-meta-item {
  font-size: 12px; color: var(--t4); font-family: var(--mono);
  display: flex; align-items: center; gap: 6px;
}
.result-meta-item .dot { width: 6px; height: 6px; border-radius: 50% }

/* ======================================================================= */
/* APPROVAL BAR                                                            */
/* ======================================================================= */
.approval {
  display: flex; align-items: center; gap: 16px;
  padding: 18px 24px; margin-top: 12px;
  background: rgba(99,102,241,.06);
  border: 1px solid rgba(99,102,241,.2);
  border-radius: var(--radius);
  animation: slideUp .3s ease;
}
.approval .txt { font-size: 14px; font-weight: 700; flex: 1 }
.btn {
  padding: 9px 24px; border: none; border-radius: var(--radius-sm);
  font-size: 14px; font-weight: 700; font-family: var(--sans);
  cursor: pointer; transition: all .15s;
}
.btn:hover { opacity: .85; transform: translateY(-1px) }
.btn-g { background: var(--green); color: #fff; box-shadow: 0 2px 8px rgba(52,211,153,.25) }
.btn-r { background: var(--red); color: #fff; box-shadow: 0 2px 8px rgba(248,113,113,.25) }

/* ======================================================================= */
/* BADGES                                                                  */
/* ======================================================================= */
.badge {
  display: inline-flex; align-items: center;
  padding: 3px 10px; border-radius: 20px;
  font-size: 11px; font-family: var(--mono); font-weight: 600;
  white-space: nowrap; letter-spacing: 0.3px;
}
.b-trust-h { background: var(--green-s); color: var(--green) }
.b-trust-m { background: var(--yellow-s); color: var(--yellow) }
.b-trust-l { background: var(--red-s); color: var(--red) }
.b-layer   { background: var(--blue-s); color: var(--blue) }
.b-ver     { font-size: 10px; border: 1px solid; padding: 2px 8px; border-radius: 20px }
.b-certified, .b-verified { border-color: var(--green); color: var(--green) }
.b-scanned    { border-color: var(--yellow); color: var(--yellow) }
.b-unverified { border-color: var(--red); color: var(--red) }

/* ======================================================================= */
/* SKILL TABLE                                                             */
/* ======================================================================= */
.sk-tbl {
  width: 100%; border-collapse: collapse; font-size: 13px;
}
.sk-tbl th {
  text-align: left; padding: 10px 14px;
  color: var(--t4); font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.6px;
  border-bottom: 1px solid var(--border-b);
  background: rgba(0,0,0,.15);
}
.sk-tbl td {
  padding: 10px 14px; border-top: 1px solid var(--border);
  vertical-align: middle;
}
.sk-tbl tbody tr:first-child td { border-top: none }
.sk-tbl tbody tr:hover { background: var(--hover) }
.sk-name { font-family: var(--mono); font-weight: 600; color: var(--t1) }

/* ======================================================================= */
/* PLAN VISUALIZATION                                                      */
/* ======================================================================= */
.plan-viz {
  display: flex; align-items: center; gap: 0;
  padding: 16px 0; overflow-x: auto; flex-wrap: wrap;
}
.pstep {
  display: flex; flex-direction: column; align-items: center;
  padding: 14px 20px; background: var(--card);
  border-radius: var(--radius); border: 1px solid var(--border-b);
  min-width: 130px; text-align: center; transition: all .2s;
}
.pstep:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow) }
.pstep .num {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--accent); color: #fff;
  font-size: 12px; font-weight: 800;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 8px;
}
.pstep .name { font-family: var(--mono); font-size: 12px; font-weight: 600; margin-bottom: 6px }
.pstep .badges { display: flex; gap: 4px }
.parr { color: var(--t4); font-size: 22px; padding: 0 8px; display: flex; align-items: center }

/* ======================================================================= */
/* JSON BLOCK                                                              */
/* ======================================================================= */
.json-block {
  background: rgba(0,0,0,.3); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 14px 18px;
  font-family: var(--mono); font-size: 12px; line-height: 1.8;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  max-height: 300px; overflow-y: auto; color: var(--t2);
}
.jk { color: #93c5fd } .js { color: #86efac } .jn { color: #67e8f9 } .jl { color: #fcd34d }
.toggle-json {
  background: none; border: 1px solid var(--border); color: var(--t4);
  font-size: 11px; cursor: pointer; font-family: var(--mono);
  padding: 4px 10px; letter-spacing: 0.3px; border-radius: 4px;
  transition: all .15s;
}
.toggle-json:hover { color: var(--accent); border-color: var(--accent) }

/* ======================================================================= */
/* ANIMATIONS                                                              */
/* ======================================================================= */
@keyframes pulse {
  0%, 100% { opacity: .3 } 50% { opacity: 1 }
}
.pulse-bar {
  height: 3px; margin-top: 12px; border-radius: 2px;
  background: linear-gradient(90deg, var(--cyan), var(--accent));
  animation: pulse 1.5s ease infinite;
}
@keyframes spin { to { transform: rotate(360deg) } }
.spinner {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid var(--card); border-top-color: var(--orange);
  border-radius: 50%; animation: spin .6s linear infinite;
}

/* ======================================================================= */
/* DRAWER (models & sessions)                                              */
/* ======================================================================= */
.drawer-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.5);
  z-index: 50; opacity: 0; pointer-events: none; transition: opacity .25s;
}
.drawer-overlay.open { opacity: 1; pointer-events: auto }
.drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: 380px; max-width: 90vw;
  background: var(--surface); border-left: 1px solid var(--border-b);
  z-index: 51; transform: translateX(100%); transition: transform .3s ease;
  display: flex; flex-direction: column;
}
.drawer-overlay.open .drawer { transform: translateX(0) }
.drawer-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px; border-bottom: 1px solid var(--border);
}
.drawer-hdr h2 { font-size: 16px; font-weight: 700 }
.drawer-close {
  background: none; border: none; color: var(--t3); cursor: pointer;
  font-size: 20px; padding: 4px; display: flex; transition: color .15s;
}
.drawer-close:hover { color: var(--t1) }
.drawer-tabs {
  display: flex; border-bottom: 1px solid var(--border);
}
.drawer-tab {
  flex: 1; padding: 12px; background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--t3); font-size: 13px; font-weight: 600; font-family: var(--sans);
  cursor: pointer; text-transform: uppercase; letter-spacing: 0.6px;
  transition: all .15s;
}
.drawer-tab:hover { color: var(--t2) }
.drawer-tab.active { color: var(--accent); border-bottom-color: var(--accent) }
.drawer-body { flex: 1; overflow-y: auto; padding: 16px 24px }

.mi { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; font-family: var(--mono); color: var(--t3) }
.mi.def { color: var(--green); font-weight: 600 }
.mdot { width: 5px; height: 5px; border-radius: 50%; background: var(--t4) }
.mi.def .mdot { background: var(--green) }

.si {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 8px; border-radius: var(--radius-sm);
  cursor: pointer; transition: background .15s;
  border-bottom: 1px solid var(--border);
}
.si:hover { background: var(--hover) }
.si:last-child { border-bottom: none }
.sdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0 }
.sdot.completed { background: var(--green) }
.sdot.paused_for_review, .sdot.paused_at_step { background: var(--yellow) }
.sdot.failed { background: var(--red) }
.sdot.running, .sdot.planning { background: var(--cyan) }
.sdot.timed_out { background: var(--t4) }
.sinfo { flex: 1; min-width: 0 }
.sprompt { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--t2) }
.smeta { font-size: 11px; color: var(--t4); font-family: var(--mono); margin-top: 3px }

.sd h3 { font-size: 14px; margin-bottom: 12px; font-weight: 700 }
.sd-back {
  background: none; border: none; color: var(--accent); font-size: 12px;
  cursor: pointer; padding: 0; margin-bottom: 12px; font-family: var(--mono);
}
.sd-back:hover { text-decoration: underline }
.sd-f { margin-bottom: 10px; font-size: 13px }
.sd-f .lbl { color: var(--t4); font-size: 11px; text-transform: uppercase; margin-bottom: 3px; letter-spacing: 0.5px; font-weight: 600 }
.sd-steps { margin-top: 12px }
.sd-step {
  padding: 10px; background: var(--card); border-radius: var(--radius-sm);
  margin-bottom: 6px; font-size: 12px;
}
.sd-step .sh { display: flex; align-items: center; gap: 8px; font-weight: 600 }
.muted { color: var(--t4); font-size: 13px; padding: 8px 0 }

/* ======================================================================= */
/* READABLE CONTENT                                                        */
/* ======================================================================= */
.readable { font-size: 14px; color: var(--t2); line-height: 1.7 }
.readable strong { color: var(--t1); font-weight: 600 }

/* ======================================================================= */
/* HOW-IT-WORKS LINK                                                       */
/* ======================================================================= */
.how-link {
  font-size: 13px; font-weight: 600; color: var(--accent2);
  text-decoration: none; cursor: pointer;
  display: flex; align-items: center; gap: 5px;
  padding: 5px 12px; border-radius: 6px;
  transition: all .15s;
  border: 1px solid transparent;
}
.how-link:hover { background: rgba(99,102,241,.08); border-color: rgba(99,102,241,.2); color: #a5b4fc }
.how-link svg { width: 15px; height: 15px }

/* ======================================================================= */
/* EXPLAINER MODAL                                                         */
/* ======================================================================= */
.explainer-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.65);
  z-index: 100; display: flex; align-items: center; justify-content: center;
  opacity: 0; pointer-events: none; transition: opacity .25s;
  padding: 24px;
}
.explainer-overlay.open { opacity: 1; pointer-events: auto }
.explainer {
  background: var(--surface); border: 1px solid var(--border-b);
  border-radius: 16px; max-width: 740px; width: 100%;
  max-height: 90vh; overflow-y: auto;
  box-shadow: 0 8px 48px rgba(0,0,0,.5);
  transform: scale(.95) translateY(12px); transition: transform .3s ease;
}
.explainer-overlay.open .explainer { transform: scale(1) translateY(0) }
.explainer-top {
  display: flex; align-items: center; justify-content: space-between;
  padding: 24px 28px 0;
}
.explainer-top h2 { font-size: 20px; font-weight: 800; letter-spacing: -0.3px }
.explainer-close {
  background: none; border: none; color: var(--t3); cursor: pointer;
  font-size: 22px; padding: 4px 8px; border-radius: 6px; transition: all .15s;
}
.explainer-close:hover { color: var(--t1); background: var(--card) }
.explainer-sub {
  padding: 8px 28px 0; font-size: 14px; color: var(--t3); line-height: 1.6;
}

/* Pipeline */
.pipeline { padding: 28px; display: flex; flex-direction: column; gap: 0 }
.pipe-step {
  display: flex; gap: 20px; align-items: flex-start;
  position: relative; padding-bottom: 8px;
}
.pipe-step:last-child { padding-bottom: 0 }
.pipe-step:last-child .pipe-line { display: none }
.pipe-node {
  width: 44px; height: 44px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; flex-shrink: 0; position: relative; z-index: 2;
}
.pipe-line {
  position: absolute; left: 21px; top: 44px; bottom: 0;
  width: 2px; background: var(--border-b); z-index: 1;
}
.pipe-content { flex: 1; padding: 4px 0 20px }
.pipe-content h3 { font-size: 15px; font-weight: 700; margin-bottom: 3px }
.pipe-content p { font-size: 13px; color: var(--t3); line-height: 1.6 }
.pipe-tag {
  display: inline-block; font-size: 10px; font-family: var(--mono);
  font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-top: 6px;
  letter-spacing: 0.3px;
}

/* Pipeline step colors */
.pipe-step.s-prompt .pipe-node  { background: var(--blue-s); color: var(--blue) }
.pipe-step.s-skill .pipe-node   { background: var(--purple-s); color: var(--purple) }
.pipe-step.s-policy .pipe-node  { background: var(--yellow-s); color: var(--yellow) }
.pipe-step.s-plan .pipe-node    { background: var(--cyan-s); color: var(--cyan) }
.pipe-step.s-execute .pipe-node { background: rgba(251,146,60,.12); color: var(--orange) }
.pipe-step.s-result .pipe-node  { background: var(--green-s); color: var(--green) }

.pipe-step.s-prompt .pipe-tag  { background: var(--blue-s); color: var(--blue) }
.pipe-step.s-skill .pipe-tag   { background: var(--purple-s); color: var(--purple) }
.pipe-step.s-policy .pipe-tag  { background: var(--yellow-s); color: var(--yellow) }
.pipe-step.s-plan .pipe-tag    { background: var(--cyan-s); color: var(--cyan) }
.pipe-step.s-execute .pipe-tag { background: rgba(251,146,60,.12); color: var(--orange) }
.pipe-step.s-result .pipe-tag  { background: var(--green-s); color: var(--green) }

/* Comparison */
.compare {
  margin: 0 28px 28px; padding: 20px 24px;
  background: var(--card); border-radius: var(--radius);
  border: 1px solid var(--border-b);
}
.compare h3 { font-size: 13px; font-weight: 700; color: var(--t3); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 14px }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px }
@media (max-width: 500px) { .compare-grid { grid-template-columns: 1fr } }
.compare-col h4 {
  font-size: 13px; font-weight: 700; margin-bottom: 10px;
  display: flex; align-items: center; gap: 6px;
}
.compare-col ul { list-style: none; padding: 0 }
.compare-col li {
  font-size: 12px; color: var(--t3); line-height: 1.8;
  padding-left: 16px; position: relative;
}
.compare-col li::before {
  content: ''; position: absolute; left: 0; top: 9px;
  width: 6px; height: 6px; border-radius: 50%;
}
.compare-col.llm li::before { background: var(--t4) }
.compare-col.ctx li::before { background: var(--green) }
.compare-col.ctx li { color: var(--t2) }
</style>
</head>
<body>

<!-- ===== HEADER ======================================================== -->
<header class="hdr">
  <div class="hdr-l">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
        <line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>
        <line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>
      </svg>
      Cortex
      <span class="ver" id="ver"></span>
    </div>
    <div class="health"><span class="hdot" id="hdot"></span><span id="htxt">connecting...</span></div>
    <a class="how-link" id="how-link">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      How it works
    </a>
  </div>
  <div class="hdr-r">
    <input type="password" id="key" class="key-in" placeholder="API key (ctx_...)" autocomplete="off" spellcheck="false"/>
    <button class="icon-btn" id="eye" title="Show/hide key">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
    </button>
    <button class="icon-btn" id="drawer-toggle" title="Models & Sessions">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
  </div>
</header>

<!-- ===== MAIN CONTENT ================================================== -->
<div class="page">
  <div class="page-inner">

    <!-- PROMPT HERO -->
    <div class="hero">
      <div class="hero-label">What should Cortex do?</div>
      <textarea id="prompt" rows="2" placeholder="Describe a task... e.g. &quot;Generate a product description for a new sneaker line&quot;"></textarea>
      <div class="hero-row">
        <select id="mode" class="chip">
          <option value="full_auto">Full Auto</option>
          <option value="review_before_run">Review First</option>
          <option value="step_by_step">Step by Step</option>
        </select>
        <select id="appetite" class="chip">
          <option value="balanced">Balanced</option>
          <option value="strict">Strict</option>
          <option value="cautious">Cautious</option>
          <option value="adventurous">Adventurous</option>
        </select>
        <button id="go" class="run-btn" disabled>Run</button>
      </div>
    </div>

    <!-- TIMELINE -->
    <div id="tl" class="timeline">
      <div class="empty-state" id="empty">
        <div class="glyph">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
            <line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>
            <line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>
          </svg>
        </div>
        <h2>Ready to go</h2>
        <p>Enter your API key above, type a prompt, and watch the agentic loop unfold &mdash; skill discovery, planning, execution, all in real time.</p>
      </div>
    </div>

  </div>
</div>

<!-- ===== DRAWER (slide-out panel) ====================================== -->
<div class="drawer-overlay" id="drawer-overlay">
  <div class="drawer" id="drawer">
    <div class="drawer-hdr">
      <h2>Inspector</h2>
      <button class="drawer-close" id="drawer-close">&times;</button>
    </div>
    <div class="drawer-tabs">
      <button class="drawer-tab active" data-tab="models">Models</button>
      <button class="drawer-tab" data-tab="sessions">Sessions</button>
    </div>
    <div class="drawer-body" id="drawer-body">
      <div class="muted">Enter API key to load data</div>
    </div>
  </div>
</div>

<!-- ===== EXPLAINER MODAL ================================================ -->
<div class="explainer-overlay" id="explainer-overlay">
  <div class="explainer">
    <div class="explainer-top">
      <h2>How Cortex Works</h2>
      <button class="explainer-close" id="explainer-close">&times;</button>
    </div>
    <div class="explainer-sub">
      Cortex is not an LLM. It is an <strong style="color:var(--t1)">orchestration runtime</strong> that uses an LLM as its brain to discover, plan, and execute real actions through verified skills.
    </div>

    <div class="pipeline">
      <div class="pipe-step s-prompt">
        <div class="pipe-node">&#128172;</div>
        <div class="pipe-line"></div>
        <div class="pipe-content">
          <h3>1. Your Prompt</h3>
          <p>You describe what you need in plain language. The LLM interprets intent, not just keywords.</p>
          <span class="pipe-tag">SUPERVISOR AGENT</span>
        </div>
      </div>

      <div class="pipe-step s-skill">
        <div class="pipe-node">&#128270;</div>
        <div class="pipe-line"></div>
        <div class="pipe-content">
          <h3>2. Skill Discovery</h3>
          <p>Cortex searches a registry of verified skills &mdash; each with a trust score, verification tier, and execution layer. Not static function lists.</p>
          <span class="pipe-tag">findSkill</span>
        </div>
      </div>

      <div class="pipe-step s-policy">
        <div class="pipe-node">&#128737;</div>
        <div class="pipe-line"></div>
        <div class="pipe-content">
          <h3>3. Policy Check</h3>
          <p>Tenant policies gate what can run. Trust thresholds, blocked skills, sensitive categories, appetite levels &mdash; governance before execution.</p>
          <span class="pipe-tag">checkPolicy</span>
        </div>
      </div>

      <div class="pipe-step s-plan">
        <div class="pipe-node">&#128736;</div>
        <div class="pipe-line"></div>
        <div class="pipe-content">
          <h3>4. Plan &amp; Review</h3>
          <p>A multi-step execution plan is built. In review mode, you see the plan and approve or reject before anything runs.</p>
          <span class="pipe-tag">buildPlan</span>
        </div>
      </div>

      <div class="pipe-step s-execute">
        <div class="pipe-node">&#9654;</div>
        <div class="pipe-line"></div>
        <div class="pipe-content">
          <h3>5. Execute</h3>
          <p>Steps execute across 5 infrastructure layers: MCP servers, instruction-following, Cloudflare Workers, containers, or composite chains.</p>
          <span class="pipe-tag">invokeSkill</span>
        </div>
      </div>

      <div class="pipe-step s-result">
        <div class="pipe-node">&#10003;</div>
        <div class="pipe-content">
          <h3>6. Result &amp; Trace</h3>
          <p>Results are returned with full execution traces &mdash; which skills ran, durations, success/fail. Traces feed back into auto-distillation.</p>
          <span class="pipe-tag">DURABLE STATE</span>
        </div>
      </div>
    </div>

    <div class="compare">
      <h3>What's different from a raw LLM?</h3>
      <div class="compare-grid">
        <div class="compare-col llm">
          <h4><span style="color:var(--t4)">&#9679;</span> Raw LLM</h4>
          <ul>
            <li>Prompt in, text out</li>
            <li>Static tool definitions</li>
            <li>No trust or verification</li>
            <li>No governance or policies</li>
            <li>Single environment</li>
            <li>Stateless</li>
          </ul>
        </div>
        <div class="compare-col ctx">
          <h4><span style="color:var(--green)">&#9679;</span> Cortex</h4>
          <ul>
            <li>Prompt in, executed actions out</li>
            <li>Dynamic skill discovery from registry</li>
            <li>Trust scores + verification tiers</li>
            <li>Tenant policy engine with guardrails</li>
            <li>5 execution layers (MCP, containers, etc.)</li>
            <li>Durable state, traces, auto-distillation</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ===== JAVASCRIPT ==================================================== -->
<script>
(function(){
'use strict';
const B = location.origin;

/* -- Helpers ------------------------------------------------------------ */
function h(s){ const d=document.createElement('div'); d.textContent=String(s??''); return d.innerHTML }
function fj(o){
  const s=JSON.stringify(o,null,2);
  return h(s)
    .replace(/&quot;([^&]+?)&quot;\\s*:/g,'<span class="jk">"$1"</span>:')
    .replace(/: &quot;(.*?)&quot;/g,': <span class="js">"$1"</span>')
    .replace(/: (\\d+\\.?\\d*)/g,': <span class="jn">$1</span>')
    .replace(/: (true|false|null)/g,': <span class="jl">$1</span>');
}
function trustClass(v){ return v>=0.8?'b-trust-h':v>=0.6?'b-trust-m':'b-trust-l' }
function verClass(t){ return 'b-'+(t||'unverified') }
function ago(t){ const m=Date.now()-new Date(t).getTime(); if(m<60000)return 'just now'; if(m<3.6e6)return Math.floor(m/60000)+'m ago'; if(m<8.64e7)return Math.floor(m/3.6e6)+'h ago'; return Math.floor(m/8.64e7)+'d ago' }

/* ======================================================================= */
/* API CLIENT                                                              */
/* ======================================================================= */
class Api {
  constructor(){ this.key = localStorage.getItem('cortex_key') || '' }
  setKey(k){ this.key = k; localStorage.setItem('cortex_key', k) }
  hd(){ return { Authorization:'Bearer '+this.key, 'Content-Type':'application/json' } }
  async get(p){ const r=await fetch(B+p,{headers:this.hd()}); return {s:r.status, d:await r.json().catch(()=>null)} }
  async post(p,b){ const r=await fetch(B+p,{method:'POST',headers:this.hd(),body:JSON.stringify(b)}); return {s:r.status, d:await r.json().catch(()=>null)} }
  async meta(){ return (await fetch(B+'/')).json() }
  async health(){ return (await fetch(B+'/health')).json() }
  async *stream(prompt, opts){
    const r = await fetch(B+'/v1/run/stream', { method:'POST', headers:this.hd(), body:JSON.stringify({prompt,...opts}) });
    if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||'HTTP '+r.status) }
    const rd=r.body.getReader(), dc=new TextDecoder(); let buf='';
    while(true){
      const{done,value}=await rd.read(); if(done) break;
      buf += dc.decode(value,{stream:true});
      const frames = buf.split('\\n\\n'); buf = frames.pop();
      for(const f of frames){
        if(!f.trim()) continue; let ev='message', da='';
        for(const l of f.split('\\n')){ if(l.startsWith('event: '))ev=l.slice(7); else if(l.startsWith('data: '))da=l.slice(6) }
        if(da) try{ yield {event:ev, data:JSON.parse(da)} }catch(e){}
      }
    }
  }
}

/* ======================================================================= */
/* TIMELINE                                                                */
/* ======================================================================= */
class Timeline {
  constructor(el){ this.el=el; this.wfId=null; this.startTime=null; this.lastSummary=null }
  clear(){ this.el.innerHTML=''; this.wfId=null; this.startTime=Date.now(); this.lastSummary=null }
  scroll(){ requestAnimationFrame(()=>{ const p=this.el.closest('.page'); if(p) p.scrollTop=p.scrollHeight }) }

  add(ev, d){
    const em=document.getElementById('empty'); if(em) em.remove();
    const fn=this['_'+ev]; if(fn) fn.call(this,d);
    this.scroll();
  }

  _mk(type, ico, lbl, meta, body, open){
    const d=document.createElement('div');
    d.className='ev '+type+(open?' open':'');
    const hasBody=!!body;
    d.innerHTML=
      '<div class="ev-hdr">'
        +'<div class="ev-icon">'+ico+'</div>'
        +'<span class="ev-title">'+h(lbl)+'</span>'
        +'<span class="ev-time">'+h(meta||'')+'</span>'
        +(hasBody?'<span class="ev-chevron">&#9654;</span>':'')
      +'</div>'
      +(hasBody?'<div class="ev-body">'+body+'</div>':'');
    if(hasBody) d.querySelector('.ev-hdr').addEventListener('click',()=>d.classList.toggle('open'));
    this.el.appendChild(d);
    return d;
  }

  _conversation(d){
    const lbl = d.isNew ? 'New conversation' : 'Continuing conversation';
    this._mk('conversation','&#128172;',lbl, d.conversationId?d.conversationId.slice(0,20):'', null);
  }

  _planning(d){
    this._mk('planning','&#9889;','Thinking...', this._elapsed(),
      '<div class="readable">'+h(d.prompt||'')+'</div><div class="pulse-bar"></div>', true);
  }

  _tool_call(d){
    const n = d.name||d.toolName||'?';
    let args = d.arguments||d.args||'{}';
    if(typeof args==='string') try{args=JSON.parse(args)}catch(e){}
    const icons = {findSkill:'&#128270;', checkPolicy:'&#128737;', buildPlan:'&#128736;', invokeSkill:'&#9654;'};
    const ico = icons[n]||'&#128295;';
    const readable = this._readableToolCall(n, args);
    const body = readable
      +'<div style="margin-top:10px">'
        +'<button class="toggle-json" onclick="const p=this.nextElementSibling;p.style.display=p.style.display===\\'none\\'?\\'block\\':\\'none\\'">show json</button>'
        +'<pre class="json-block" style="display:none;margin-top:8px">'+fj(args)+'</pre>'
      +'</div>';
    this._mk('tool_call', ico, n, this._elapsed(), body, true);
  }

  _readableToolCall(name, args){
    if(name==='findSkill')
      return '<div class="readable">Searching for: <strong>"'+h(args.query||'')+'"</strong></div>';
    if(name==='buildPlan'){
      const steps=args.steps||[];
      if(!steps.length) return '<div class="readable">Building execution plan...</div>';
      return '<div class="readable">Building plan with <strong>'+steps.length+'</strong> step(s): '
        +steps.map(s=>'<strong>'+h(s.skillSlug||s.slug||'?')+'</strong>').join(' &#8594; ')+'</div>';
    }
    if(name==='checkPolicy')
      return '<div class="readable">Checking policy for <strong>'+h(args.skillSlug||args.slug||'?')+'</strong></div>';
    if(name==='invokeSkill')
      return '<div class="readable">Executing <strong>'+h(args.skillSlug||args.slug||'?')+'</strong></div>';
    return '';
  }

  _tool_result(d){
    const n = d.name||d.toolName||'';
    let body = this._readableToolResult(n, d.result||d);
    body += '<div style="margin-top:12px">'
      +'<button class="toggle-json" onclick="const p=this.nextElementSibling;p.style.display=p.style.display===\\'none\\'?\\'block\\':\\'none\\'">show json</button>'
      +'<pre class="json-block" style="display:none;margin-top:8px">'+fj(d.result||d)+'</pre>'
    +'</div>';
    this._mk('tool_result','&#10003;', n+' result', this._elapsed(), body, true);
  }

  _readableToolResult(name, r){
    if(name==='findSkill' && r && r.results){
      let s='<div style="margin-bottom:12px" class="readable">Found <strong>'+r.results.length+'</strong> skill(s) &mdash; confidence: <span class="badge '+(r.confidence==='high'?'b-trust-h':r.confidence==='medium'?'b-trust-m':'b-trust-l')+'">'+h(r.confidence||'?')+'</span></div>';
      if(r.results.length){
        s+='<div style="border:1px solid var(--border-b);border-radius:var(--radius);overflow:hidden">'
          +'<table class="sk-tbl"><thead><tr><th>Skill</th><th>Trust</th><th>Verification</th><th>Layer</th></tr></thead><tbody>';
        r.results.forEach(sk=>{
          s+='<tr>'
            +'<td class="sk-name">'+h(sk.slug||sk.name||sk.id)+'</td>'
            +'<td><span class="badge '+trustClass(sk.trustScore)+'">'+((sk.trustScore??0)*1).toFixed(2)+'</span></td>'
            +'<td><span class="badge b-ver '+verClass(sk.verificationTier)+'">'+h(sk.verificationTier||'unverified')+'</span></td>'
            +'<td><span class="badge b-layer">'+h(sk.executionLayer||'?')+'</span></td>'
          +'</tr>';
        });
        s+='</tbody></table></div>';
      }
      return s;
    }
    if(name==='buildPlan' && r && r.steps){
      let s='<div class="plan-viz">';
      r.steps.forEach((st,i)=>{
        if(i) s+='<div class="parr">&#8594;</div>';
        const ts=st.trustScore??0;
        s+='<div class="pstep"><div class="num">'+(i+1)+'</div><div class="name">'+h(st.skillSlug||st.slug||'?')+'</div><div class="badges"><span class="badge '+trustClass(ts)+'">'+ts+'</span><span class="badge b-layer">'+h(st.executionLayer||'')+'</span></div></div>';
      });
      s+='</div>';
      if(r.reasoning) s+='<div class="readable" style="margin-top:10px;font-style:italic;color:var(--t3)">"'+h(r.reasoning)+'"</div>';
      return s;
    }
    if(name==='checkPolicy' && r){
      const ok=r.allowed!==false;
      return '<div class="readable">'
        +(ok?'<span style="color:var(--green)">&#10003; Allowed</span>':'<span style="color:var(--red)">&#10007; Blocked</span>')
        +(r.requiresReview?' &mdash; <span style="color:var(--yellow)">requires review</span>':'')
      +'</div>';
    }
    if(name==='invokeSkill' && r){
      const ok=r.success!==false;
      return '<div class="readable">'
        +(ok?'<span style="color:var(--green)">&#10003; Success</span>':'<span style="color:var(--red)">&#10007; Failed</span>')
        +(r.durationMs?' &nbsp;<span style="color:var(--t4);font-family:var(--mono);font-size:12px">'+r.durationMs+'ms</span>':'')
      +'</div>';
    }
    return '<pre class="json-block">'+fj(r)+'</pre>';
  }

  _step_start(d){
    this._mk('step_start','<span class="spinner"></span>',
      'Step '+((d.stepIndex??0)+1)+': '+h(d.skillSlug||''), this._elapsed(), null);
  }

  _step_complete(d){
    const ok=d.success!==false;
    this._mk('step_complete'+(ok?'':' fail'),
      ok?'&#10003;':'&#10007;',
      'Step '+((d.stepIndex??0)+1)+': '+h(d.skillSlug||''),
      d.durationMs?d.durationMs+'ms':'',
      d.error?'<div style="color:var(--red);font-size:13px;line-height:1.6">'+h(d.error)+'</div>':null,
      !!d.error);
  }

  _workflow_complete(d){
    this._mk('workflow_complete','&#10003;','Workflow Complete', d.status||'completed', null);
  }

  _error(d){
    this._mk('error','&#9888;','Error','',
      '<div style="color:var(--red);font-size:14px;line-height:1.7">'+h(d.message||JSON.stringify(d))+'</div>', true);
  }

  _done(d){
    if(d.workflowId) this.wfId=d.workflowId;
    this.lastSummary = d.summary||null;

    if(d.summary){
      const card = document.createElement('div');
      card.className = 'result-card';
      let html='<h3>&#10003; Result</h3>';
      html+='<div class="result-text">'+this._fmtSummary(d.summary)+'</div>';
      html+='<div class="result-meta">';
      if(d.workflowId) html+='<div class="result-meta-item"><div class="dot" style="background:var(--accent)"></div>'+h(d.workflowId.slice(0,12))+'...</div>';
      if(d.conversationId) html+='<div class="result-meta-item"><div class="dot" style="background:var(--purple)"></div>'+h(d.conversationId.slice(0,16))+'</div>';
      if(d.status) html+='<div class="result-meta-item"><div class="dot" style="background:var(--green)"></div>'+h(d.status)+'</div>';
      if(this.startTime) html+='<div class="result-meta-item"><div class="dot" style="background:var(--cyan)"></div>'+((Date.now()-this.startTime)/1000).toFixed(1)+'s</div>';
      html+='</div>';
      card.innerHTML = html;
      this.el.appendChild(card);
    }

    if(d.status==='paused_for_review' && d.workflowId){
      const bar = document.createElement('div');
      bar.className = 'approval';
      bar.innerHTML = '<span class="txt">Plan ready for review</span><button class="btn btn-g">Approve</button><button class="btn btn-r">Reject</button>';
      bar.querySelector('.btn-g').addEventListener('click',()=>window._app.approve(d.workflowId));
      bar.querySelector('.btn-r').addEventListener('click',()=>window._app.reject(d.workflowId));
      this.el.appendChild(bar);
    }
  }

  _fmtSummary(s){ return h(s).replace(/\\n/g,'<br>') }
  _elapsed(){ if(!this.startTime) return ''; return ((Date.now()-this.startTime)/1000).toFixed(1)+'s' }
}

/* ======================================================================= */
/* DRAWER (side panel)                                                     */
/* ======================================================================= */
class Drawer {
  constructor(api){
    this.api = api;
    this.tab = 'models';
    this.overlay = document.getElementById('drawer-overlay');
    this.body = document.getElementById('drawer-body');

    document.getElementById('drawer-toggle').addEventListener('click',()=>this.open());
    document.getElementById('drawer-close').addEventListener('click',()=>this.close());
    this.overlay.addEventListener('click',(e)=>{ if(e.target===this.overlay) this.close() });

    document.querySelectorAll('.drawer-tab').forEach(t=>{
      t.addEventListener('click',()=>{
        document.querySelectorAll('.drawer-tab').forEach(x=>x.classList.remove('active'));
        t.classList.add('active');
        this.tab = t.dataset.tab;
        this.load();
      });
    });
  }

  open(){ this.overlay.classList.add('open'); this.load() }
  close(){ this.overlay.classList.remove('open') }

  async load(){
    if(this.tab==='models') await this.models();
    else await this.sessions();
  }

  async models(){
    const el=this.body;
    if(!this.api.key){ el.innerHTML='<div class="muted">Enter API key first</div>'; return }
    el.innerHTML='<div class="muted">Loading models...</div>';
    try{
      const{s,d}=await this.api.get('/v1/models');
      if(s!==200||!d.models){ el.innerHTML='<div class="muted">Failed to load</div>'; return }
      el.innerHTML=d.models.map(m=>'<div class="mi'+(m.id===d.default?' def':'')+'"><span class="mdot"></span>'+h(m.id)+'</div>').join('');
    }catch(e){ el.innerHTML='<div class="muted">'+h(e.message)+'</div>' }
  }

  async sessions(){
    const el=this.body;
    if(!this.api.key){ el.innerHTML='<div class="muted">Enter API key first</div>'; return }
    el.innerHTML='<div class="muted">Loading sessions...</div>';
    try{
      const{s,d}=await this.api.get('/v1/sessions?limit=20');
      if(s!==200||!d.sessions){ el.innerHTML='<div class="muted">'+(s===500?'DB unavailable':'Failed')+'</div>'; return }
      if(!d.sessions.length){ el.innerHTML='<div class="muted">No sessions yet</div>'; return }
      el.innerHTML = d.sessions.map(sess=>
        '<div class="si" data-id="'+h(sess.id)+'">'
          +'<span class="sdot '+h(sess.status||'')+'"></span>'
          +'<div class="sinfo">'
            +'<div class="sprompt">'+h((sess.prompt||'').slice(0,60))+'</div>'
            +'<div class="smeta">'+h(sess.status||'')+' &middot; '+(sess.createdAt?ago(sess.createdAt):'')+'</div>'
          +'</div>'
        +'</div>'
      ).join('');
      el.querySelectorAll('.si').forEach(i=>i.addEventListener('click',()=>this.detail(i.dataset.id)));
    }catch(e){ el.innerHTML='<div class="muted">'+h(e.message)+'</div>' }
  }

  async detail(id){
    const el=this.body;
    el.innerHTML='<div class="muted">Loading...</div>';
    try{
      const{s,d}=await this.api.get('/v1/sessions/'+id);
      if(s!==200||!d){ el.innerHTML='<div class="muted">Not found</div>'; return }
      let x='<button class="sd-back" id="sd-bk">&#8592; Back to sessions</button><h3>Session Detail</h3>';
      x+='<div class="sd-f"><div class="lbl">Status</div>'+h(d.status)+'</div>';
      x+='<div class="sd-f"><div class="lbl">Prompt</div>'+h(d.prompt||'')+'</div>';
      if(d.steps && d.steps.length){
        x+='<div class="sd-steps"><div class="lbl" style="margin-bottom:8px">Steps</div>';
        d.steps.forEach(st=>{
          x+='<div class="sd-step"><div class="sh">'
            +'<span>'+h(st.skillSlug||st.skillId||'?')+'</span>'
            +'<span class="badge '+(st.status==='completed'?'b-trust-h':st.status==='failed'?'b-trust-l':'b-trust-m')+'">'+h(st.status)+'</span>'
            +(st.durationMs?'<span style="color:var(--t4);font-size:11px">'+st.durationMs+'ms</span>':'')
          +'</div></div>';
        });
        x+='</div>';
      }
      el.innerHTML=x;
      document.getElementById('sd-bk').addEventListener('click',()=>this.sessions());
    }catch(e){ el.innerHTML='<div class="muted">'+h(e.message)+'</div>' }
  }
}

/* ======================================================================= */
/* APP                                                                     */
/* ======================================================================= */
class App {
  constructor(){
    this.api = new Api();
    this.tl = new Timeline(document.getElementById('tl'));
    this.drawer = new Drawer(this.api);
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
    document.getElementById('go').addEventListener('click',()=>this.run());
    document.getElementById('prompt').addEventListener('keydown',e=>{
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); this.run() }
    });

    // Explainer modal
    const exOverlay = document.getElementById('explainer-overlay');
    document.getElementById('how-link').addEventListener('click',()=>exOverlay.classList.add('open'));
    document.getElementById('explainer-close').addEventListener('click',()=>exOverlay.classList.remove('open'));
    exOverlay.addEventListener('click',(e)=>{ if(e.target===exOverlay) exOverlay.classList.remove('open') });

    this.loadMeta(); this.loadHealth();
    this.updateBtn();
  }

  updateBtn(){
    const b=document.getElementById('go');
    b.disabled = !this.api.key || this.running;
    b.textContent = this.running ? 'Running...' : 'Run';
  }

  async loadMeta(){
    try{ const m=await this.api.meta(); document.getElementById('ver').textContent='v'+(m.version||'?') }catch(e){}
  }

  async loadHealth(){
    try{
      const h=await this.api.health();
      document.getElementById('hdot').className='hdot '+(h.status==='healthy'?'ok':h.status==='degraded'?'degraded':'down');
      document.getElementById('htxt').textContent=h.status||'?';
    }catch(e){
      document.getElementById('hdot').className='hdot down';
      document.getElementById('htxt').textContent='offline';
    }
  }

  async run(){
    const p=document.getElementById('prompt').value.trim();
    if(!p || !this.api.key || this.running) return;
    this.running=true; this.updateBtn(); this.tl.clear();
    try{
      for await(const{event,data} of this.api.stream(p, {
        mode: document.getElementById('mode').value,
        appetite: document.getElementById('appetite').value
      })){
        this.tl.add(event, data);
      }
    }catch(e){ this.tl.add('error',{message:e.message}) }
    finally{ this.running=false; this.updateBtn() }
  }

  async approve(wf){
    try{
      const{d}=await this.api.post('/v1/run/'+wf+'/resume',{approved:true});
      this.tl.add('done',{summary:'Approved. '+(d.summary||''), status:d.status, workflowId:wf});
    }catch(e){ this.tl.add('error',{message:'Approve failed: '+e.message}) }
  }

  async reject(wf){
    try{
      const{d}=await this.api.post('/v1/run/'+wf+'/resume',{approved:false});
      this.tl.add('done',{summary:'Rejected.', status:d.status||'cancelled', workflowId:wf});
    }catch(e){ this.tl.add('error',{message:'Reject failed: '+e.message}) }
  }
}

window._app = new App();
})();
</script>
</body>
</html>`;
