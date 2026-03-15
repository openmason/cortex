import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.html(demoHtml);
});

export default app;

// ---------------------------------------------------------------------------
// Inline HTML — self-contained demo page (Cognium design language)
// ---------------------------------------------------------------------------
const demoHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cortex Demo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,300;0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400;1,8..60,600&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* ======================================================================= */
/* DESIGN TOKENS — Cognium brand                                           */
/* ======================================================================= */
:root {
  --bg: #FAFAF8;
  --bg-alt: #F4F3F0;
  --surface: #FFFFFF;
  --navy: #0F1D2F;
  --navy-mid: #1E3350;
  --text: #1A2B3D;
  --text-sec: #4A5B6E;
  --text-tert: #8494A7;
  --border: #E4E2DD;
  --border-lt: #EEEDE9;
  --gold: #B8860B;
  --gold-warm: #D4A017;
  --gold-bg: rgba(184,134,11,0.06);
  --gold-bdr: rgba(184,134,11,0.18);
  --red: #C0392B;
  --green: #27844A;
  --green-bg: rgba(39,132,74,0.06);
  --green-bdr: rgba(39,132,74,0.18);
  --blue: #2E6BBF;
  --blue-bg: rgba(46,107,191,0.06);
  --purple: #6C47B8;
  --purple-bg: rgba(108,71,184,0.06);
  --orange: #C76A15;
  --orange-bg: rgba(199,106,21,0.06);
  --cyan: #0E7C86;
  --cyan-bg: rgba(14,124,134,0.06);

  --ff-display: 'Source Serif 4', Georgia, serif;
  --ff-body: 'DM Sans', -apple-system, sans-serif;
  --ff-mono: 'DM Mono', 'SF Mono', monospace;
  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 16px;
  --shadow: 0 1px 3px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.03);
  --shadow-lg: 0 4px 24px rgba(0,0,0,.06);
}

/* ======================================================================= */
/* RESET                                                                   */
/* ======================================================================= */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--ff-body);
  font-size: 15px;
  line-height: 1.6;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
::selection { background: rgba(184,134,11,0.15) }

/* ======================================================================= */
/* NAV HEADER                                                              */
/* ======================================================================= */
.hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 32px; height: 56px;
  background: rgba(250,250,248,0.88);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border-lt);
  flex-shrink: 0; z-index: 10;
}
.hdr-l { display: flex; align-items: center; gap: 16px }
.logo {
  display: flex; align-items: center; gap: 10px;
  font-family: var(--ff-mono); font-weight: 500;
  font-size: 14px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--navy);
}
.logo-dot { color: var(--gold) }
.ver {
  font-size: 11px; color: var(--text-tert); font-family: var(--ff-mono);
  padding: 3px 8px; background: var(--bg-alt); border-radius: 4px;
  border: 1px solid var(--border-lt);
}
.health { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-tert); font-weight: 500 }
.hdot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tert); transition: all .3s }
.hdot.ok { background: var(--green); box-shadow: 0 0 6px rgba(39,132,74,.3) }
.hdot.degraded { background: var(--gold); box-shadow: 0 0 6px rgba(184,134,11,.3) }
.hdot.down { background: var(--red); box-shadow: 0 0 6px rgba(192,57,43,.3) }
.hdr-r { display: flex; align-items: center; gap: 10px }
.key-in {
  width: 280px; padding: 8px 14px;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  font-family: var(--ff-mono); font-size: 13px;
  outline: none; transition: border .2s, box-shadow .2s;
}
.key-in:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(184,134,11,.08) }
.key-in::placeholder { color: var(--text-tert) }
.icon-btn {
  background: none; border: 1px solid transparent; color: var(--text-tert); cursor: pointer;
  padding: 6px; display: flex; align-items: center; border-radius: var(--r-sm);
  transition: all .15s;
}
.icon-btn:hover { color: var(--navy); background: var(--bg-alt); border-color: var(--border-lt) }

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
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 32px 32px 28px;
  box-shadow: var(--shadow);
  margin-bottom: 36px;
  position: relative;
  overflow: hidden;
}
.hero::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, transparent, var(--gold-bdr), transparent);
}
.hero-label {
  font-family: var(--ff-mono); font-size: 12px; font-weight: 500;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--gold); margin-bottom: 16px;
}
.hero textarea {
  width: 100%; resize: none;
  padding: 14px 18px;
  background: var(--bg-alt); color: var(--text);
  border: 1px solid var(--border-lt); border-radius: var(--r-sm);
  font-family: var(--ff-body); font-size: 15px; line-height: 1.6;
  outline: none; min-height: 56px; max-height: 160px;
  transition: border .2s, box-shadow .2s;
}
.hero textarea:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(184,134,11,.06) }
.hero textarea::placeholder { color: var(--text-tert) }
.hero-row {
  display: flex; align-items: center; gap: 12px;
  margin-top: 16px; flex-wrap: wrap;
}
.chip {
  padding: 7px 14px;
  background: var(--bg-alt); color: var(--text-sec);
  border: 1px solid var(--border); border-radius: 20px;
  font-size: 13px; font-weight: 500; font-family: var(--ff-body);
  outline: none; cursor: pointer; appearance: none;
  -webkit-appearance: none;
  transition: border .15s, color .15s;
}
.chip:hover { border-color: var(--gold); color: var(--navy) }
.chip:focus { border-color: var(--gold); box-shadow: 0 0 0 2px rgba(184,134,11,.08) }
.run-btn {
  margin-left: auto;
  padding: 10px 28px;
  background: var(--navy); color: #fff;
  border: 1px solid var(--navy); border-radius: var(--r-sm);
  font-size: 15px; font-weight: 600; font-family: var(--ff-body);
  cursor: pointer; letter-spacing: 0.2px;
  transition: all .25s;
}
.run-btn:hover:not(:disabled) { background: var(--navy-mid); border-color: var(--navy-mid) }
.run-btn:active:not(:disabled) { transform: scale(.98) }
.run-btn:disabled { opacity: .3; cursor: not-allowed }

/* ======================================================================= */
/* EMPTY STATE                                                             */
/* ======================================================================= */
.empty-state {
  display: flex; flex-direction: column; align-items: center;
  padding: 80px 20px; text-align: center;
}
.empty-state .glyph {
  width: 80px; height: 80px; margin-bottom: 28px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 50%; display: flex; align-items: center; justify-content: center;
  position: relative;
}
.empty-state .glyph::after {
  content: ''; position: absolute; inset: -6px;
  border: 1px solid var(--border-lt); border-radius: 50%;
}
.empty-state .glyph svg { width: 32px; height: 32px; color: var(--gold) }
.empty-state h2 {
  font-family: var(--ff-display); font-size: 22px; font-weight: 600;
  color: var(--navy); margin-bottom: 8px; letter-spacing: -0.01em;
}
.empty-state p { font-size: 15px; color: var(--text-tert); max-width: 380px; line-height: 1.7 }

/* ======================================================================= */
/* EVENT CARDS                                                             */
/* ======================================================================= */
@keyframes slideUp {
  from { opacity: 0; transform: translateY(12px) }
  to   { opacity: 1; transform: translateY(0) }
}
.timeline { display: flex; flex-direction: column; gap: 10px }

.ev {
  background: var(--surface);
  border: 1px solid var(--border-lt);
  border-radius: var(--r-md);
  padding: 16px 20px;
  animation: slideUp .3s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,.02);
  transition: all .15s;
  border-left: 3px solid var(--border);
}
.ev:hover { box-shadow: var(--shadow); border-color: var(--border) }
.ev-hdr {
  display: flex; align-items: center; gap: 10px;
  cursor: pointer; user-select: none;
}
.ev-icon {
  flex-shrink: 0; width: 28px; height: 28px;
  border-radius: 8px; display: flex; align-items: center; justify-content: center;
  font-size: 14px; background: var(--bg-alt);
}
.ev-title { font-weight: 600; font-size: 14px; color: var(--navy) }
.ev-time {
  margin-left: auto; font-size: 12px; font-weight: 500;
  color: var(--text-tert); font-family: var(--ff-mono);
}
.ev-chevron {
  color: var(--text-tert); font-size: 10px; transition: transform .2s;
  margin-left: 4px;
}
.ev.open .ev-chevron { transform: rotate(90deg) }
.ev-body { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-lt); display: none }
.ev.open .ev-body { display: block }

/* Event type accents */
.ev.conversation  { border-left-color: var(--text-tert) }
.ev.planning      { border-left-color: var(--cyan); background: var(--cyan-bg) }
.ev.tool_call     { border-left-color: var(--purple); background: var(--purple-bg) }
.ev.tool_result   { border-left-color: var(--purple) }
.ev.step_start    { border-left-color: var(--orange) }
.ev.step_complete { border-left-color: var(--green) }
.ev.step_complete.fail { border-left-color: var(--red) }
.ev.workflow_complete  { border-left-color: var(--green); background: var(--green-bg) }
.ev.error         { border-left-color: var(--red); background: rgba(192,57,43,0.04) }
.ev.done          { border-left-color: var(--gold) }

.ev.planning .ev-icon { background: var(--cyan-bg); color: var(--cyan) }
.ev.tool_call .ev-icon { background: var(--purple-bg); color: var(--purple) }
.ev.tool_result .ev-icon { background: var(--purple-bg); color: var(--purple) }
.ev.step_start .ev-icon { background: var(--orange-bg) }
.ev.step_complete .ev-icon { background: var(--green-bg); color: var(--green) }
.ev.workflow_complete .ev-icon { background: var(--green-bg); color: var(--green) }
.ev.error .ev-icon { background: rgba(192,57,43,0.06); color: var(--red) }

/* ======================================================================= */
/* RESULT CARD                                                             */
/* ======================================================================= */
.result-card {
  background: var(--surface);
  border: 1px solid var(--green-bdr);
  border-radius: var(--r-lg);
  padding: 28px 28px;
  margin-top: 4px;
  animation: slideUp .35s ease;
  box-shadow: 0 2px 12px rgba(39,132,74,.04);
  position: relative;
  overflow: hidden;
}
.result-card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, transparent, var(--green-bdr), transparent);
}
.result-card h3 {
  font-family: var(--ff-display); font-size: 18px; font-weight: 600;
  margin-bottom: 16px; display: flex; align-items: center; gap: 10px;
  color: var(--green); letter-spacing: -0.01em;
}
.result-text {
  font-size: 15px; line-height: 1.8; color: var(--text);
  white-space: pre-wrap; word-break: break-word;
}
.result-meta {
  display: flex; gap: 20px; margin-top: 20px;
  padding-top: 16px; border-top: 1px solid var(--border-lt); flex-wrap: wrap;
}
.result-meta-item {
  font-size: 12px; color: var(--text-tert); font-family: var(--ff-mono);
  display: flex; align-items: center; gap: 6px;
}
.result-meta-item .dot { width: 6px; height: 6px; border-radius: 50% }

/* ======================================================================= */
/* APPROVAL BAR                                                            */
/* ======================================================================= */
.approval {
  display: flex; align-items: center; gap: 16px;
  padding: 18px 24px; margin-top: 10px;
  background: var(--gold-bg);
  border: 1px solid var(--gold-bdr);
  border-radius: var(--r-md);
  animation: slideUp .3s ease;
}
.approval .txt { font-size: 14px; font-weight: 600; flex: 1; color: var(--navy) }
.btn {
  padding: 9px 24px; border: none; border-radius: var(--r-sm);
  font-size: 14px; font-weight: 600; font-family: var(--ff-body);
  cursor: pointer; transition: all .2s;
}
.btn:hover { opacity: .85 }
.btn-g { background: var(--green); color: #fff }
.btn-r { background: var(--red); color: #fff }

/* ======================================================================= */
/* BADGES                                                                  */
/* ======================================================================= */
.badge {
  display: inline-flex; align-items: center;
  padding: 3px 10px; border-radius: 20px;
  font-size: 11px; font-family: var(--ff-mono); font-weight: 500;
  white-space: nowrap; letter-spacing: 0.3px;
}
.b-trust-h { background: var(--green-bg); color: var(--green) }
.b-trust-m { background: var(--gold-bg); color: var(--gold) }
.b-trust-l { background: rgba(192,57,43,0.06); color: var(--red) }
.b-layer   { background: var(--blue-bg); color: var(--blue) }
.b-ver     { font-size: 10px; border: 1px solid; padding: 2px 8px; border-radius: 20px }
.b-certified, .b-verified { border-color: var(--green); color: var(--green) }
.b-scanned    { border-color: var(--gold); color: var(--gold) }
.b-unverified { border-color: var(--red); color: var(--red) }

/* ======================================================================= */
/* SKILL TABLE                                                             */
/* ======================================================================= */
.sk-tbl {
  width: 100%; border-collapse: collapse; font-size: 13px;
}
.sk-tbl th {
  text-align: left; padding: 10px 14px;
  color: var(--text-tert); font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-alt);
}
.sk-tbl td {
  padding: 10px 14px; border-top: 1px solid var(--border-lt);
  vertical-align: middle;
}
.sk-tbl tbody tr:first-child td { border-top: none }
.sk-tbl tbody tr:hover { background: var(--bg-alt) }
.sk-name { font-family: var(--ff-mono); font-weight: 500; color: var(--navy) }

/* ======================================================================= */
/* PLAN VISUALIZATION                                                      */
/* ======================================================================= */
.plan-viz {
  display: flex; align-items: center; gap: 0;
  padding: 16px 0; overflow-x: auto; flex-wrap: wrap;
}
.pstep {
  display: flex; flex-direction: column; align-items: center;
  padding: 14px 20px; background: var(--surface);
  border-radius: var(--r-md); border: 1px solid var(--border);
  min-width: 130px; text-align: center; transition: all .2s;
}
.pstep:hover { border-color: var(--gold); box-shadow: var(--shadow) }
.pstep .num {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--navy); color: #fff;
  font-size: 12px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 8px;
}
.pstep .name { font-family: var(--ff-mono); font-size: 12px; font-weight: 500; margin-bottom: 6px; color: var(--navy) }
.pstep .badges { display: flex; gap: 4px }
.parr { color: var(--text-tert); font-size: 22px; padding: 0 8px; display: flex; align-items: center }

/* ======================================================================= */
/* JSON BLOCK                                                              */
/* ======================================================================= */
.json-block {
  background: var(--bg-alt); border: 1px solid var(--border-lt);
  border-radius: var(--r-sm); padding: 14px 18px;
  font-family: var(--ff-mono); font-size: 12px; line-height: 1.8;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  max-height: 300px; overflow-y: auto; color: var(--text-sec);
}
.jk { color: var(--blue) } .js { color: var(--green) } .jn { color: var(--cyan) } .jl { color: var(--gold) }
.toggle-json {
  background: none; border: 1px solid var(--border); color: var(--text-tert);
  font-size: 11px; cursor: pointer; font-family: var(--ff-mono);
  padding: 4px 10px; letter-spacing: 0.3px; border-radius: 4px;
  transition: all .15s;
}
.toggle-json:hover { color: var(--gold); border-color: var(--gold) }

/* ======================================================================= */
/* ANIMATIONS                                                              */
/* ======================================================================= */
@keyframes pulse {
  0%, 100% { opacity: .3 } 50% { opacity: 1 }
}
.pulse-bar {
  height: 3px; margin-top: 12px; border-radius: 2px;
  background: linear-gradient(90deg, var(--gold), var(--gold-warm));
  animation: pulse 1.5s ease infinite;
}
@keyframes shimmerGold {
  0% { background-position: -200% 0 }
  100% { background-position: 200% 0 }
}
@keyframes spin { to { transform: rotate(360deg) } }
.spinner {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid var(--border); border-top-color: var(--gold);
  border-radius: 50%; animation: spin .6s linear infinite;
}

/* ======================================================================= */
/* DRAWER (models & sessions)                                              */
/* ======================================================================= */
.drawer-overlay {
  position: fixed; inset: 0; background: rgba(15,29,47,.3);
  z-index: 50; opacity: 0; pointer-events: none; transition: opacity .25s;
}
.drawer-overlay.open { opacity: 1; pointer-events: auto }
.drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: 380px; max-width: 90vw;
  background: var(--surface); border-left: 1px solid var(--border);
  z-index: 51; transform: translateX(100%); transition: transform .3s ease;
  display: flex; flex-direction: column;
}
.drawer-overlay.open .drawer { transform: translateX(0) }
.drawer-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px; border-bottom: 1px solid var(--border-lt);
}
.drawer-hdr h2 { font-family: var(--ff-display); font-size: 18px; font-weight: 600; color: var(--navy) }
.drawer-close {
  background: none; border: none; color: var(--text-tert); cursor: pointer;
  font-size: 20px; padding: 4px; display: flex; transition: color .15s;
}
.drawer-close:hover { color: var(--navy) }
.drawer-tabs {
  display: flex; border-bottom: 1px solid var(--border-lt);
}
.drawer-tab {
  flex: 1; padding: 12px; background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--text-tert); font-size: 13px; font-weight: 600; font-family: var(--ff-body);
  cursor: pointer; text-transform: uppercase; letter-spacing: 0.6px;
  transition: all .15s;
}
.drawer-tab:hover { color: var(--text-sec) }
.drawer-tab.active { color: var(--gold); border-bottom-color: var(--gold) }
.drawer-body { flex: 1; overflow-y: auto; padding: 16px 24px }

.mi { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; font-family: var(--ff-mono); color: var(--text-tert); border-bottom: 1px solid var(--border-lt); cursor: pointer; transition: color .15s, background .15s; border-radius: 4px; padding: 8px 6px }
.mi:last-child { border-bottom: none }
.mi:hover { background: var(--bg-alt); color: var(--text-sec) }
.mi.def { color: var(--green); font-weight: 500 }
.mi.selected { color: var(--gold); font-weight: 500 }
.mi.selected .mdot { background: var(--gold) }
.mi .def-tag { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--green); border: 1px solid var(--green); border-radius: 3px; padding: 1px 4px; margin-left: auto }
.mi .sel-tag { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--gold); border: 1px solid var(--gold); border-radius: 3px; padding: 1px 4px; margin-left: auto }
.mdot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-tert) }
.mi.def .mdot { background: var(--green) }
.model-sel { font-size: 11px; font-family: var(--ff-mono); color: var(--gold); margin-left: 8px; cursor: pointer; opacity: .8 }
.model-sel:hover { opacity: 1 }

.si {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 8px; border-radius: var(--r-sm);
  cursor: pointer; transition: background .15s;
  border-bottom: 1px solid var(--border-lt);
}
.si:hover { background: var(--bg-alt) }
.si:last-child { border-bottom: none }
.sdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0 }
.sdot.completed { background: var(--green) }
.sdot.paused_for_review, .sdot.paused_at_step { background: var(--gold) }
.sdot.failed { background: var(--red) }
.sdot.running, .sdot.planning { background: var(--cyan) }
.sdot.timed_out { background: var(--text-tert) }
.sinfo { flex: 1; min-width: 0 }
.sprompt { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-sec) }
.smeta { font-size: 11px; color: var(--text-tert); font-family: var(--ff-mono); margin-top: 3px }

.sd h3 { font-family: var(--ff-display); font-size: 16px; margin-bottom: 12px; font-weight: 600; color: var(--navy) }
.sd-back {
  background: none; border: none; color: var(--gold); font-size: 12px;
  cursor: pointer; padding: 0; margin-bottom: 12px; font-family: var(--ff-mono);
}
.sd-back:hover { text-decoration: underline }
.sd-f { margin-bottom: 10px; font-size: 13px }
.sd-f .lbl { color: var(--text-tert); font-size: 11px; text-transform: uppercase; margin-bottom: 3px; letter-spacing: 0.5px; font-weight: 600 }
.sd-steps { margin-top: 12px }
.sd-step {
  padding: 10px; background: var(--bg-alt); border: 1px solid var(--border-lt); border-radius: var(--r-sm);
  margin-bottom: 6px; font-size: 12px;
}
.sd-step .sh { display: flex; align-items: center; gap: 8px; font-weight: 500 }
.muted { color: var(--text-tert); font-size: 13px; padding: 8px 0 }

/* ======================================================================= */
/* READABLE CONTENT                                                        */
/* ======================================================================= */
.readable { font-size: 14px; color: var(--text-sec); line-height: 1.7 }
.readable strong { color: var(--navy); font-weight: 600 }

/* ======================================================================= */
/* HOW-IT-WORKS LINK                                                       */
/* ======================================================================= */
.how-link {
  font-size: 13px; font-weight: 600; color: var(--gold);
  text-decoration: none; cursor: pointer;
  display: flex; align-items: center; gap: 5px;
  padding: 5px 12px; border-radius: var(--r-sm);
  transition: all .15s;
  border: 1px solid transparent;
}
.how-link:hover { background: var(--gold-bg); border-color: var(--gold-bdr); color: var(--gold-warm) }
.how-link svg { width: 15px; height: 15px }

/* ======================================================================= */
/* EXPLAINER MODAL                                                         */
/* ======================================================================= */
.explainer-overlay {
  position: fixed; inset: 0; background: rgba(15,29,47,.4);
  z-index: 100; display: flex; align-items: center; justify-content: center;
  opacity: 0; pointer-events: none; transition: opacity .25s;
  padding: 24px;
}
.explainer-overlay.open { opacity: 1; pointer-events: auto }
.explainer {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg); max-width: 740px; width: 100%;
  max-height: 90vh; overflow-y: auto;
  box-shadow: 0 8px 48px rgba(15,29,47,.12);
  transform: scale(.95) translateY(12px); transition: transform .3s ease;
}
.explainer-overlay.open .explainer { transform: scale(1) translateY(0) }
.explainer-top {
  display: flex; align-items: center; justify-content: space-between;
  padding: 28px 32px 0;
}
.explainer-top h2 { font-family: var(--ff-display); font-size: 24px; font-weight: 600; color: var(--navy); letter-spacing: -0.01em }
.explainer-close {
  background: none; border: none; color: var(--text-tert); cursor: pointer;
  font-size: 22px; padding: 4px 8px; border-radius: var(--r-sm); transition: all .15s;
}
.explainer-close:hover { color: var(--navy); background: var(--bg-alt) }
.explainer-sub {
  padding: 8px 32px 0; font-size: 15px; color: var(--text-sec); line-height: 1.7;
}

/* Pipeline */
.pipeline { padding: 28px 32px; display: flex; flex-direction: column; gap: 0 }
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
  width: 2px; background: var(--border); z-index: 1;
}
.pipe-content { flex: 1; padding: 4px 0 20px }
.pipe-content h3 { font-size: 15px; font-weight: 600; color: var(--navy); margin-bottom: 3px }
.pipe-content p { font-size: 13px; color: var(--text-tert); line-height: 1.6 }
.pipe-tag {
  display: inline-block; font-size: 10px; font-family: var(--ff-mono);
  font-weight: 500; padding: 2px 8px; border-radius: 4px; margin-top: 6px;
  letter-spacing: 0.3px;
}

/* Pipeline step colors */
.pipe-step.s-prompt .pipe-node  { background: var(--blue-bg); color: var(--blue) }
.pipe-step.s-skill .pipe-node   { background: var(--purple-bg); color: var(--purple) }
.pipe-step.s-policy .pipe-node  { background: var(--gold-bg); color: var(--gold) }
.pipe-step.s-plan .pipe-node    { background: var(--cyan-bg); color: var(--cyan) }
.pipe-step.s-execute .pipe-node { background: var(--orange-bg); color: var(--orange) }
.pipe-step.s-result .pipe-node  { background: var(--green-bg); color: var(--green) }

.pipe-step.s-prompt .pipe-tag  { background: var(--blue-bg); color: var(--blue) }
.pipe-step.s-skill .pipe-tag   { background: var(--purple-bg); color: var(--purple) }
.pipe-step.s-policy .pipe-tag  { background: var(--gold-bg); color: var(--gold) }
.pipe-step.s-plan .pipe-tag    { background: var(--cyan-bg); color: var(--cyan) }
.pipe-step.s-execute .pipe-tag { background: var(--orange-bg); color: var(--orange) }
.pipe-step.s-result .pipe-tag  { background: var(--green-bg); color: var(--green) }

/* Comparison */
.compare {
  margin: 0 32px 32px; padding: 24px;
  background: var(--bg-alt); border-radius: var(--r-md);
  border: 1px solid var(--border-lt);
}
.compare h3 {
  font-family: var(--ff-mono); font-size: 12px; font-weight: 500;
  color: var(--text-tert); text-transform: uppercase; letter-spacing: 0.18em;
  margin-bottom: 16px;
}
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px }
@media (max-width: 500px) { .compare-grid { grid-template-columns: 1fr } }
.compare-col h4 {
  font-size: 14px; font-weight: 600; margin-bottom: 10px;
  display: flex; align-items: center; gap: 6px; color: var(--navy);
}
.compare-col ul { list-style: none; padding: 0 }
.compare-col li {
  font-size: 13px; color: var(--text-tert); line-height: 1.8;
  padding-left: 16px; position: relative;
}
.compare-col li::before {
  content: ''; position: absolute; left: 0; top: 9px;
  width: 6px; height: 6px; border-radius: 50%;
}
.compare-col.llm li::before { background: var(--text-tert) }
.compare-col.ctx li::before { background: var(--gold) }
.compare-col.ctx li { color: var(--text-sec) }
</style>
</head>
<body>

<!-- ===== HEADER ======================================================== -->
<header class="hdr">
  <div class="hdr-l">
    <div class="logo">
      Cortex<span class="logo-dot">.</span>
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
    <span class="model-sel" id="model-indicator" style="display:none" title="Click to change model"></span>
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
        <button id="go" class="run-btn" disabled>Run &rarr;</button>
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
      Cortex is not an LLM. It is an <strong style="color:var(--navy)">orchestration runtime</strong> that uses an LLM as its brain to discover, plan, and execute real actions through verified skills.
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
          <p>Cortex searches a registry of verified skills &mdash; each with a trust score, verification tier, and execution layer.</p>
          <span class="pipe-tag">findSkill</span>
        </div>
      </div>

      <div class="pipe-step s-policy">
        <div class="pipe-node">&#128737;</div>
        <div class="pipe-line"></div>
        <div class="pipe-content">
          <h3>3. Policy Check</h3>
          <p>Tenant policies gate what can run. Trust thresholds, blocked skills, sensitive categories &mdash; governance before execution.</p>
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
          <h4><span style="color:var(--text-tert)">&#9679;</span> Raw LLM</h4>
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
          <h4><span style="color:var(--gold)">&#9679;</span> Cortex</h4>
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
      const lines = buf.split('\\n'); buf = lines.pop();
      for(const line of lines){
        if(!line.startsWith('data: ')) continue;
        const json = line.slice(6);
        if(json==='[DONE]') return;
        try{ yield JSON.parse(json) }catch(e){}
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

  add(part){
    const em=document.getElementById('empty'); if(em) em.remove();
    const t = part.type.replace(/-/g,'_');
    const fn=this['_'+t]; if(fn) fn.call(this,part);
    // Handle custom data parts (e.g. conversation, workflow-complete, approval-required)
    if(part.type==='data' && Array.isArray(part.data)){
      for(const d of part.data){
        if(d && d.type){ const dfn=this['_data_'+d.type.replace(/-/g,'_')]; if(dfn) dfn.call(this,d) }
      }
    }
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

  _data_conversation(d){
    const lbl = d.isNew ? 'New conversation' : 'Continuing conversation';
    this._mk('conversation','&#128172;',lbl, d.conversationId?d.conversationId.slice(0,20):'', null);
  }

  _text_start(d){
    this._mk('planning','&#9889;','Thinking...', this._elapsed(),
      '<div class="pulse-bar"></div>', true);
  }

  _text_delta(d){
    // Append text delta to the last planning card or create a text card
    const cards = this.el.querySelectorAll('.ev.planning');
    if(cards.length){
      const last = cards[cards.length-1];
      const body = last.querySelector('.ev-body');
      if(body){
        let readable = body.querySelector('.readable');
        if(!readable){ readable = document.createElement('div'); readable.className='readable'; body.insertBefore(readable, body.firstChild) }
        readable.textContent += (d.delta||'');
      }
    }
  }

  _tool_call(d){
    const n = d.toolName||'?';
    let args = d.args||{};
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
    const n = d.toolName||'';
    const r = d.result||{};
    let body = this._readableToolResult(n, r);
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
        s+='<div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden">'
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
      if(r.reasoning) s+='<div class="readable" style="margin-top:10px;font-style:italic;color:var(--text-tert)">"'+h(r.reasoning)+'"</div>';
      return s;
    }
    if(name==='checkPolicy' && r){
      const ok=r.allowed!==false;
      return '<div class="readable">'
        +(ok?'<span style="color:var(--green)">&#10003; Allowed</span>':'<span style="color:var(--red)">&#10007; Blocked</span>')
        +(r.requiresReview?' &mdash; <span style="color:var(--gold)">requires review</span>':'')
      +'</div>';
    }
    if(name==='invokeSkill' && r){
      const ok=r.success!==false;
      return '<div class="readable">'
        +(ok?'<span style="color:var(--green)">&#10003; Success</span>':'<span style="color:var(--red)">&#10007; Failed</span>')
        +(r.durationMs?' &nbsp;<span style="color:var(--text-tert);font-family:var(--ff-mono);font-size:12px">'+r.durationMs+'ms</span>':'')
      +'</div>';
    }
    return '<pre class="json-block">'+fj(r)+'</pre>';
  }

  _step_start(d){
    this._mk('step_start','<span class="spinner"></span>',
      'Step '+((d.stepIndex??0)+1)+': '+h(d.skillSlug||''), this._elapsed(), null);
  }

  _step_finish(d){
    const ok=d.success!==false;
    this._mk('step_complete'+(ok?'':' fail'),
      ok?'&#10003;':'&#10007;',
      'Step '+((d.stepIndex??0)+1)+': '+h(d.skillSlug||''),
      d.durationMs?d.durationMs+'ms':'',
      d.error?'<div style="color:var(--red);font-size:13px;line-height:1.6">'+h(d.error)+'</div>':null,
      !!d.error);
  }

  _data_workflow_complete(d){
    this._mk('workflow_complete','&#10003;','Workflow Complete', d.status||'completed', null);
  }

  _error(d){
    this._mk('error','&#9888;','Error','',
      '<div style="color:var(--red);font-size:14px;line-height:1.7">'+h(d.errorText||JSON.stringify(d))+'</div>', true);
  }

  _finish(d){
    // Show usage info if available
    if(d.usage && d.usage.totalTokens){
      this._mk('done','&#10003;','Done', d.usage.totalTokens+' tokens', null);
    }
  }

  _text_end(d){
    // When text ends, show the accumulated text as a result card
    const cards = this.el.querySelectorAll('.ev.planning');
    if(cards.length){
      const last = cards[cards.length-1];
      const body = last.querySelector('.ev-body');
      if(body){
        const readable = body.querySelector('.readable');
        if(readable && readable.textContent){
          this.lastSummary = readable.textContent;
          // Remove pulse bar
          const pulse = body.querySelector('.pulse-bar');
          if(pulse) pulse.remove();
          // Show result card
          const card = document.createElement('div');
          card.className = 'result-card';
          let html='<h3>&#10003; Result</h3>';
          html+='<div class="result-text">'+this._fmtSummary(readable.textContent)+'</div>';
          html+='<div class="result-meta">';
          if(this.startTime) html+='<div class="result-meta-item"><div class="dot" style="background:var(--gold)"></div>'+((Date.now()-this.startTime)/1000).toFixed(1)+'s</div>';
          html+='</div>';
          card.innerHTML = html;
          this.el.appendChild(card);
        }
      }
    }
  }

  _data_approval_required(d){
    if(d.workflowId){
      this.wfId = d.workflowId;
      const bar = document.createElement('div');
      bar.className = 'approval';
      bar.innerHTML = '<span class="txt">Plan ready for review</span><button class="btn btn-g">Approve &rarr;</button><button class="btn btn-r">Reject</button>';
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
    this.selectedModel = null;
    this.defaultModel = null;
    this.modelList = [];
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

  getSelectedModel(){ return this.selectedModel }

  open(){ this.overlay.classList.add('open'); this.load() }
  close(){ this.overlay.classList.remove('open') }

  async load(){
    if(this.tab==='models') await this.models();
    else await this.sessions();
  }

  _updateModelIndicator(){
    const el=document.getElementById('model-indicator');
    if(!el) return;
    if(this.selectedModel){
      const short = this.selectedModel.replace('cognium/','');
      el.textContent = short;
      el.style.display = 'inline';
    } else {
      el.style.display = 'none';
    }
  }

  _renderModels(){
    const el=this.body;
    el.innerHTML=this.modelList.map(m=>{
      const isDef = m.id===this.defaultModel;
      const isSel = m.id===this.selectedModel;
      let cls = 'mi';
      if(isSel) cls += ' selected';
      else if(isDef && !this.selectedModel) cls += ' def';
      let tags = '';
      if(isDef) tags += '<span class="def-tag">default</span>';
      if(isSel) tags += '<span class="sel-tag">selected</span>';
      return '<div class="'+cls+'" data-model="'+h(m.id)+'"><span class="mdot"></span>'+h(m.id)+tags+'</div>';
    }).join('');
    el.querySelectorAll('.mi').forEach(item=>{
      item.addEventListener('click',()=>{
        const mid = item.dataset.model;
        if(mid === this.selectedModel){
          this.selectedModel = null;
        } else {
          this.selectedModel = mid;
        }
        this._renderModels();
        this._updateModelIndicator();
      });
    });
  }

  async models(){
    const el=this.body;
    if(!this.api.key){ el.innerHTML='<div class="muted">Enter API key first</div>'; return }
    if(this.modelList.length){ this._renderModels(); return }
    el.innerHTML='<div class="muted">Loading models...</div>';
    try{
      const{s,d}=await this.api.get('/v1/models');
      if(s!==200||!d.models){ el.innerHTML='<div class="muted">Failed to load</div>'; return }
      this.modelList = d.models;
      this.defaultModel = d.default;
      this._renderModels();
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
            +(st.durationMs?'<span style="color:var(--text-tert);font-size:11px">'+st.durationMs+'ms</span>':'')
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

    document.getElementById('model-indicator').addEventListener('click',()=>this.drawer.open());

    this.loadMeta(); this.loadHealth();
    this.updateBtn();
  }

  updateBtn(){
    const b=document.getElementById('go');
    b.disabled = !this.api.key || this.running;
    b.textContent = this.running ? 'Running...' : 'Run \\u2192';
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
    const opts = {
      mode: document.getElementById('mode').value,
      appetite: document.getElementById('appetite').value
    };
    const selModel = this.drawer.getSelectedModel();
    if(selModel) opts.model = selModel;
    try{
      for await(const part of this.api.stream(p, opts)){
        this.tl.add(part);
      }
    }catch(e){ this.tl.add({type:'error',errorText:e.message}) }
    finally{ this.running=false; this.updateBtn() }
  }

  async approve(wf){
    try{
      const{d}=await this.api.post('/v1/run/'+wf+'/resume',{approved:true});
      const tid='text_approve';
      this.tl.add({type:'text-start',id:tid});
      this.tl.add({type:'text-delta',id:tid,delta:'Approved. '+(d.summary||'')});
      this.tl.add({type:'text-end',id:tid});
    }catch(e){ this.tl.add({type:'error',errorText:'Approve failed: '+e.message}) }
  }

  async reject(wf){
    try{
      const{d}=await this.api.post('/v1/run/'+wf+'/resume',{approved:false});
      const tid='text_reject';
      this.tl.add({type:'text-start',id:tid});
      this.tl.add({type:'text-delta',id:tid,delta:'Rejected.'});
      this.tl.add({type:'text-end',id:tid});
    }catch(e){ this.tl.add({type:'error',errorText:'Reject failed: '+e.message}) }
  }
}

window._app = new App();
})();
</script>
</body>
</html>`;
