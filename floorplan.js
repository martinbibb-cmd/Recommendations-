/* floorplan.js – Survey Brain Floor Planner
 * Magicplan-style PWA canvas floor planner for heating surveys.
 * Supports: LiDAR ingestion, wall drawing with thickness & openings,
 *           wall-mounted boilers/rads, free-standing cylinders, full
 *           pipework routing (on-wall or under-floor), SVG export.
 */
'use strict';
(function () {

// ─────────────────────────── CONSTANTS ───────────────────────────────────────
const PX_PER_M   = 60;   // canvas pixels per metre at zoom 1
const GRID_M     = 0.1;  // grid snap spacing (metres)
const SNAP_R_M   = 0.25; // snap-to-endpoint/wall radius (metres)

const T = { SELECT:'select', WALL:'wall', DOOR:'door', WINDOW:'window',
            PIPE:'pipe', MEASURE:'measure', ERASE:'erase' };

// Component definitions
const COMP = {
  boiler:     { label:'Boiler',      wallMounted:true,  w:0.6,  h:0.4,  color:'#1e40af', icon:'🔥' },
  back_boiler:{ label:'Back Boiler', wallMounted:true,  w:0.5,  h:0.35, color:'#1e3a8a', icon:'🔥' },
  radiator:   { label:'Radiator',    wallMounted:true,  w:0.8,  h:0.14, color:'#b91c1c', icon:'♨'  },
  towel_rail: { label:'Towel Rail',  wallMounted:true,  w:0.5,  h:0.1,  color:'#9f1239', icon:'🌡'  },
  cylinder:   { label:'Cylinder',    wallMounted:false, w:0.5,  h:0.5,  color:'#065f46', icon:'🛢'  },
  pump:       { label:'Pump',        wallMounted:false, w:0.22, h:0.18, color:'#5b21b6', icon:'⚙'  },
  manifold:   { label:'Manifold',    wallMounted:false, w:0.45, h:0.14, color:'#0e7490', icon:'⊞'  },
  trv:        { label:'TRV/Valve',   wallMounted:false, w:0.1,  h:0.1,  color:'#92400e', icon:'🔧'  },
  bath:       { label:'Bath',        wallMounted:false, w:1.7,  h:0.75, color:'#1e3a5f', icon:'🛁'  },
  shower:     { label:'Shower',      wallMounted:true,  w:0.9,  h:0.9,  color:'#1e3a5f', icon:'🚿'  },
  wc:         { label:'WC',          wallMounted:true,  w:0.55, h:0.7,  color:'#1e3a5f', icon:'🚽'  },
  sink:       { label:'Sink/Basin',  wallMounted:true,  w:0.55, h:0.45, color:'#1e3a5f', icon:'🪣'  },
};

// Pipe definitions
const PIPE = {
  flow:       { label:'Flow (Hot)',  color:'#ef4444', dash:[],            uf:false },
  return:     { label:'Return',      color:'#3b82f6', dash:[],            uf:false },
  cold:       { label:'Cold Water',  color:'#06b6d4', dash:[8,4],         uf:false },
  gas:        { label:'Gas',         color:'#eab308', dash:[4,4],         uf:false },
  ufh_flow:   { label:'UFH Flow',    color:'#f97316', dash:[10,3,3,3],    uf:true  },
  ufh_return: { label:'UFH Return',  color:'#fb923c', dash:[6,3,3,3],     uf:true  },
};

// ─────────────────────────── VECTOR UTILS ────────────────────────────────────
const v2   = (x, y)    => ({ x, y });
const vadd = (a, b)    => ({ x: a.x + b.x, y: a.y + b.y });
const vsub = (a, b)    => ({ x: a.x - b.x, y: a.y - b.y });
const vmul = (v, s)    => ({ x: v.x * s,   y: v.y * s   });
const vlen = v          => Math.sqrt(v.x * v.x + v.y * v.y);
const vnorm= v          => { const l = vlen(v); return l ? { x:v.x/l, y:v.y/l } : { x:1, y:0 }; };
const vperp= v          => ({ x: -v.y, y: v.x });          // 90° CCW
const vdot = (a, b)    => a.x * b.x + a.y * b.y;

function projectOnSegment(p, a, b) {
  const ab = vsub(b, a), ap = vsub(p, a);
  const len2 = vdot(ab, ab);
  if (len2 < 1e-12) return { t:0, closest:a, dist:vlen(ap) };
  const t = Math.max(0, Math.min(1, vdot(ap, ab) / len2));
  const closest = vadd(a, vmul(ab, t));
  return { t, closest, dist: vlen(vsub(p, closest)) };
}

function snapGrid(p) {
  return { x: Math.round(p.x / GRID_M) * GRID_M, y: Math.round(p.y / GRID_M) * GRID_M };
}

function uid() { return Math.random().toString(36).slice(2, 10); }

// ─────────────────────────── STATE ───────────────────────────────────────────
class State {
  constructor() {
    this.walls      = [];  // {id, a, b, thickness, openings:[{id,t,width,type}]}
    this.components = [];  // {id, type, x, y, angle, wallId}
    this.pipes      = [];  // {id, pipeType, route, points:[]}
    this.floorName  = 'Ground Floor';
    this._cb        = null;
  }

  onChange(fn) { this._cb = fn; }
  _fire()      { this._cb && this._cb(); }

  // ── Walls ──────────────────────────────────────────────────────────────────
  addWall(a, b, thickness = 0.15) {
    const w = { id:uid(), a:{...a}, b:{...b}, thickness, openings:[] };
    this.walls.push(w);
    this._fire();
    return w;
  }
  updateWall(id, props) {
    const w = this.walls.find(w => w.id === id);
    if (w) { Object.assign(w, props); this._fire(); }
  }
  removeWall(id) {
    this.walls      = this.walls.filter(w => w.id !== id);
    this.components = this.components.filter(c => c.wallId !== id);
    this._fire();
  }

  // ── Openings ───────────────────────────────────────────────────────────────
  addOpening(wallId, t, width, type) {
    const w = this.walls.find(w => w.id === wallId);
    if (!w) return null;
    const op = { id:uid(), t, width, type };
    w.openings.push(op);
    this._fire();
    return op;
  }
  removeOpening(wallId, opId) {
    const w = this.walls.find(w => w.id === wallId);
    if (w) { w.openings = w.openings.filter(o => o.id !== opId); this._fire(); }
  }

  // ── Components ─────────────────────────────────────────────────────────────
  addComponent(type, x, y, angle = 0, wallId = null) {
    if (!COMP[type]) return null;
    const c = { id:uid(), type, x, y, angle, wallId };
    this.components.push(c);
    this._fire();
    return c;
  }
  removeComponent(id) {
    this.components = this.components.filter(c => c.id !== id);
    this._fire();
  }

  // ── Pipes ──────────────────────────────────────────────────────────────────
  startPipe(pipeType, route, pt) {
    const p = { id:uid(), pipeType, route, points:[{...pt}] };
    this.pipes.push(p);
    this._fire();
    return p;
  }
  addPipePoint(id, pt) {
    const p = this.pipes.find(p => p.id === id);
    if (p) { p.points.push({...pt}); this._fire(); }
  }
  removePipe(id) {
    this.pipes = this.pipes.filter(p => p.id !== id);
    this._fire();
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  toJSON() {
    return JSON.stringify({
      v: 1,
      walls:      this.walls,
      components: this.components,
      pipes:      this.pipes,
      floorName:  this.floorName,
    });
  }
  fromJSON(json) {
    try {
      const d = JSON.parse(json);
      this.walls      = d.walls      || [];
      this.components = d.components || [];
      this.pipes      = d.pipes      || [];
      this.floorName  = d.floorName  || 'Ground Floor';
      this._fire();
    } catch (e) { console.error('fromJSON', e); }
  }

  async save() {
    const json = this.toJSON();
    try { localStorage.setItem('sb_fp', json); } catch (_) {}
    try { await idbSet('sb_fp', json); } catch (_) {}
  }
  async load() {
    try { const j = await idbGet('sb_fp'); if (j) { this.fromJSON(j); return true; } } catch (_) {}
    try { const j = localStorage.getItem('sb_fp'); if (j) { this.fromJSON(j); return true; } } catch (_) {}
    return false;
  }
}

// Tiny IDB wrapper – no external dependency
function _idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sb_fp_db', 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}
async function idbSet(k, v) {
  const db = await _idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
  });
}
async function idbGet(k) {
  const db = await _idbOpen();
  return new Promise((res, rej) => {
    const tx  = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(k);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

// ─────────────────────────── SNAP ENGINE ─────────────────────────────────────
class SnapEngine {
  constructor(state) { this.state = state; }

  // Snap a raw world point → nearest grid/endpoint/wall
  snap(p) {
    // 1. Endpoint snap (highest priority)
    for (const w of this.state.walls) {
      for (const ep of [w.a, w.b]) {
        if (vlen(vsub(p, ep)) < SNAP_R_M * 0.6) return { p:ep, type:'endpoint' };
      }
    }
    // 2. Wall midpoint snap
    for (const w of this.state.walls) {
      const proj = projectOnSegment(p, w.a, w.b);
      if (proj.dist < SNAP_R_M * 0.3) {
        return { p: snapGrid(proj.closest), type:'wall' };
      }
    }
    // 3. Grid
    return { p: snapGrid(p), type:'grid' };
  }

  // Find nearest wall within snap radius
  nearestWall(p) {
    let best = null, bestDist = Infinity;
    for (const w of this.state.walls) {
      const proj = projectOnSegment(p, w.a, w.b);
      if (proj.dist < bestDist) { bestDist = proj.dist; best = { wall:w, ...proj }; }
    }
    return (best && best.dist < SNAP_R_M) ? best : null;
  }

  // Compute snapped position + angle for a component
  componentSnap(p, type) {
    const def = COMP[type];
    if (!def || !def.wallMounted) return { x:p.x, y:p.y, angle:0, wallId:null, snapped:false };
    const hit = this.nearestWall(p);
    if (!hit) return { x:p.x, y:p.y, angle:0, wallId:null, snapped:false };
    const { wall, closest } = hit;
    const dir    = vnorm(vsub(wall.b, wall.a));
    const perp   = vperp(dir);
    // Place on whichever face the cursor is on
    const side   = Math.sign(vdot(vsub(p, closest), perp)) || 1;
    const offset = wall.thickness / 2 + def.h / 2 + 0.01;
    return {
      x:      closest.x + perp.x * offset * side,
      y:      closest.y + perp.y * offset * side,
      angle:  Math.atan2(dir.y, dir.x),
      wallId: wall.id,
      snapped:true,
    };
  }
}

// ─────────────────────────── RENDERER ────────────────────────────────────────
class Renderer {
  constructor(canvas, state) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.state    = state;
    this.zoom     = 1;
    this.panX     = 0;
    this.panY     = 0;
    this.dpr      = window.devicePixelRatio || 1;
    this.selected = null;   // {type, id}
    this.preview  = null;   // current tool ghost
    this.showDims = true;
  }

  resize() {
    const wrap = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width  = wrap.width  * this.dpr;
    this.canvas.height = wrap.height * this.dpr;
    this.canvas.style.width  = wrap.width  + 'px';
    this.canvas.style.height = wrap.height + 'px';
    this.render();
  }

  // World ↔ screen
  wx(x) { return (x * PX_PER_M * this.zoom + this.panX) * this.dpr; }
  wy(y) { return (y * PX_PER_M * this.zoom + this.panY) * this.dpr; }
  ws(s) { return s * PX_PER_M * this.zoom * this.dpr; }
  sx(px){ return px / this.dpr / (PX_PER_M * this.zoom) - this.panX / (PX_PER_M * this.zoom); }
  sy(py){ return py / this.dpr / (PX_PER_M * this.zoom) - this.panY / (PX_PER_M * this.zoom); }

  render() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, W, H);

    this._drawGrid();
    this._drawPipes();
    this._drawWalls();
    this._drawComponents();
    this._drawPreview();
    if (this.showDims) this._drawDimensions();
  }

  // ── Grid ───────────────────────────────────────────────────────────────────
  _drawGrid() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const minor = GRID_M * PX_PER_M * this.zoom * this.dpr;
    if (minor < 4) return;
    const major = minor * 10;

    const offX = ((this.panX * this.dpr % major) + major) % major;
    const offY = ((this.panY * this.dpr % major) + major) % major;

    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = offX; x < W + minor; x += minor) { ctx.moveTo(x,0); ctx.lineTo(x,H); }
    for (let y = offY; y < H + minor; y += minor) { ctx.moveTo(0,y); ctx.lineTo(W,y); }
    ctx.stroke();

    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = offX; x < W + major; x += major) { ctx.moveTo(x,0); ctx.lineTo(x,H); }
    for (let y = offY; y < H + major; y += major) { ctx.moveTo(0,y); ctx.lineTo(W,y); }
    ctx.stroke();
  }

  // ── Walls ──────────────────────────────────────────────────────────────────
  _drawWalls() {
    for (const wall of this.state.walls) this._drawWall(wall);
  }

  _wallCorners(wall) {
    const dir = vnorm(vsub(wall.b, wall.a));
    const perp = vperp(dir);
    const t2 = wall.thickness / 2;
    return [
      vadd(wall.a, vmul(perp, -t2)),
      vadd(wall.a, vmul(perp,  t2)),
      vadd(wall.b, vmul(perp,  t2)),
      vadd(wall.b, vmul(perp, -t2)),
    ];
  }

  _drawWall(wall) {
    const ctx = this.ctx;
    const sel = this.selected?.type === 'wall' && this.selected?.id === wall.id;
    const corners = this._wallCorners(wall);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(this.wx(corners[0].x), this.wy(corners[0].y));
    for (let i = 1; i < 4; i++) ctx.lineTo(this.wx(corners[i].x), this.wy(corners[i].y));
    ctx.closePath();
    ctx.fillStyle   = sel ? '#bfdbfe' : '#94a3b8';
    ctx.strokeStyle = sel ? '#3b82f6' : '#475569';
    ctx.lineWidth   = (sel ? 2 : 1) * this.dpr;
    ctx.fill(); ctx.stroke();

    // Openings
    for (const op of wall.openings) this._drawOpening(wall, op);
    ctx.restore();
  }

  _drawOpening(wall, op) {
    const ctx = this.ctx;
    const len  = vlen(vsub(wall.b, wall.a));
    const dir  = vnorm(vsub(wall.b, wall.a));
    const perp = vperp(dir);
    const t2   = wall.thickness / 2;
    const os   = vadd(wall.a, vmul(dir, op.t * len));
    const oe   = vadd(wall.a, vmul(dir, op.t * len + op.width));

    // Cut-out (draw background colour to "erase" wall)
    const q = [
      vadd(os, vmul(perp, -t2 - 0.01)),
      vadd(os, vmul(perp,  t2 + 0.01)),
      vadd(oe, vmul(perp,  t2 + 0.01)),
      vadd(oe, vmul(perp, -t2 - 0.01)),
    ];
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(this.wx(q[0].x), this.wy(q[0].y));
    for (let i = 1; i < 4; i++) ctx.lineTo(this.wx(q[i].x), this.wy(q[i].y));
    ctx.closePath();
    ctx.fillStyle = '#f8fafc'; ctx.fill();

    // Symbol
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 1.5 * this.dpr; ctx.setLineDash([]);
    if (op.type === 'door') {
      // Door swing arc from hinge (os) swinging open through 90°
      const osx = this.wx(os.x), osy = this.wy(os.y);
      const swR  = this.ws(op.width);
      const baseAngle = Math.atan2(dir.y, dir.x);
      ctx.beginPath();
      ctx.moveTo(osx, osy);
      ctx.arc(osx, osy, swR, baseAngle, baseAngle - Math.PI / 2, true);
      ctx.stroke();
      // Door leaf line
      ctx.beginPath();
      ctx.moveTo(osx, osy);
      ctx.lineTo(this.wx(oe.x), this.wy(oe.y));
      ctx.stroke();
    } else {
      // Window: two parallel lines across opening
      const [q0x,q0y] = [this.wx(q[0].x), this.wy(q[0].y)];
      const [q1x,q1y] = [this.wx(q[1].x), this.wy(q[1].y)];
      const [q2x,q2y] = [this.wx(q[2].x), this.wy(q[2].y)];
      const [q3x,q3y] = [this.wx(q[3].x), this.wy(q[3].y)];
      ctx.strokeStyle = '#93c5fd'; ctx.lineWidth = 3 * this.dpr;
      ctx.beginPath(); ctx.moveTo(q0x,q0y); ctx.lineTo(q3x,q3y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(q1x,q1y); ctx.lineTo(q2x,q2y); ctx.stroke();
      ctx.strokeStyle = '#bfdbfe'; ctx.lineWidth = 1 * this.dpr;
      ctx.beginPath(); ctx.moveTo(q0x,q0y); ctx.lineTo(q1x,q1y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(q3x,q3y); ctx.lineTo(q2x,q2y); ctx.stroke();
    }
    ctx.restore();
  }

  // ── Components ─────────────────────────────────────────────────────────────
  _drawComponents() {
    for (const comp of this.state.components) this._drawComponent(comp);
  }

  _drawComponent(comp) {
    const def = COMP[comp.type]; if (!def) return;
    const ctx = this.ctx;
    const sel = this.selected?.type === 'component' && this.selected?.id === comp.id;
    const cw  = this.ws(def.w), ch = this.ws(def.h);

    ctx.save();
    ctx.translate(this.wx(comp.x), this.wy(comp.y));
    ctx.rotate(comp.angle);

    // Body
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-cw/2, -ch/2, cw, ch, 4 * this.dpr);
    else { ctx.rect(-cw/2, -ch/2, cw, ch); }
    ctx.fillStyle   = sel ? '#eff6ff' : def.color + '30';
    ctx.strokeStyle = sel ? '#3b82f6' : def.color;
    ctx.lineWidth   = (sel ? 2.5 : 1.5) * this.dpr;
    ctx.fill(); ctx.stroke();

    // Label
    const fs = Math.max(8, Math.min(11, ch * 0.38)) * this.dpr;
    ctx.fillStyle = def.color;
    ctx.font = `bold ${fs}px system-ui,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(def.label, 0, 0);

    // Icon (when large enough)
    if (cw > 30 * this.dpr) {
      const iSize = Math.min(16, ch * 0.4) * this.dpr;
      ctx.font = `${iSize}px sans-serif`;
      ctx.fillText(def.icon, 0, -fs * 0.8);
    }

    // Selection handles
    if (sel) {
      ctx.fillStyle = '#3b82f6';
      const hs = 5 * this.dpr;
      [[-cw/2,-ch/2],[cw/2,-ch/2],[cw/2,ch/2],[-cw/2,ch/2]].forEach(([hx,hy]) => {
        ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs);
      });
    }
    ctx.restore();
  }

  // ── Pipes ──────────────────────────────────────────────────────────────────
  _drawPipes() {
    for (const pipe of this.state.pipes) this._drawPipe(pipe);
  }

  _drawPipe(pipe) {
    if (pipe.points.length < 2) return;
    const def = PIPE[pipe.pipeType] || PIPE.flow;
    const ctx = this.ctx;
    const sel = this.selected?.type === 'pipe' && this.selected?.id === pipe.id;
    const isUF = pipe.route === 'underfloor';

    ctx.save();
    ctx.strokeStyle = sel ? '#3b82f6' : def.color;
    ctx.lineWidth   = (sel ? 4 : isUF ? 3 : 2) * this.dpr;
    ctx.setLineDash(def.dash.map(d => d * this.dpr));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(this.wx(pipe.points[0].x), this.wy(pipe.points[0].y));
    for (let i = 1; i < pipe.points.length; i++) {
      ctx.lineTo(this.wx(pipe.points[i].x), this.wy(pipe.points[i].y));
    }
    ctx.stroke();

    // Underfloor: wide semi-transparent hatch overlay
    if (isUF) {
      ctx.setLineDash([2 * this.dpr, 8 * this.dpr]);
      ctx.strokeStyle = def.color + '55';
      ctx.lineWidth   = 10 * this.dpr;
      ctx.stroke();
    }

    // Direction arrows for flow/return
    if (['flow','return','ufh_flow','ufh_return'].includes(pipe.pipeType)) {
      ctx.setLineDash([]);
      ctx.fillStyle = def.color;
      for (let i = 1; i < pipe.points.length; i++) {
        const a = pipe.points[i-1], b = pipe.points[i];
        const mid = vadd(a, vmul(vsub(b,a), 0.5));
        const dir = vnorm(vsub(b,a));
        const as  = 6 * this.dpr;
        ctx.save();
        ctx.translate(this.wx(mid.x), this.wy(mid.y));
        ctx.rotate(Math.atan2(dir.y, dir.x));
        ctx.beginPath();
        ctx.moveTo(as, 0); ctx.lineTo(-as/2, -as/2); ctx.lineTo(-as/2, as/2);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }

    // Label at midpoint
    ctx.setLineDash([]);
    const midIdx = Math.floor(pipe.points.length / 2);
    const mp = pipe.points[midIdx];
    const labelFs = 8 * this.dpr;
    ctx.font = `${labelFs}px system-ui,sans-serif`;
    ctx.fillStyle = def.color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const routeTag = isUF ? ' (UF)' : pipe.route === 'overhead' ? ' (OH)' : '';
    ctx.fillText(def.label + routeTag, this.wx(mp.x), this.wy(mp.y) - 3 * this.dpr);

    ctx.restore();
  }

  // ── Tool preview / ghost ───────────────────────────────────────────────────
  _drawPreview() {
    if (!this.preview) return;
    const ctx = this.ctx;
    ctx.save(); ctx.globalAlpha = 0.75;
    const p = this.preview;

    if (p.type === 'wall') {
      if (!p.start || !p.end) { ctx.restore(); return; }
      const dir = vnorm(vsub(p.end, p.start));
      const perp = vperp(dir);
      const t2 = p.thickness / 2;
      const corners = [
        vadd(p.start, vmul(perp,-t2)), vadd(p.start, vmul(perp, t2)),
        vadd(p.end,   vmul(perp, t2)), vadd(p.end,   vmul(perp,-t2)),
      ];
      ctx.beginPath();
      ctx.moveTo(this.wx(corners[0].x), this.wy(corners[0].y));
      for (let i = 1; i < 4; i++) ctx.lineTo(this.wx(corners[i].x), this.wy(corners[i].y));
      ctx.closePath();
      ctx.fillStyle = '#94a3b880'; ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2 * this.dpr; ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
      ctx.fill(); ctx.stroke();
      // Length label
      const len = vlen(vsub(p.end, p.start));
      if (len > 0.05) {
        const mid = vadd(p.start, vmul(vsub(p.end, p.start), 0.5));
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        ctx.fillStyle = '#1d4ed8';
        ctx.font = `bold ${11 * this.dpr}px system-ui,sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(`${len.toFixed(2)} m`, this.wx(mid.x), this.wy(mid.y) - 5 * this.dpr);
      }
    }

    if (p.type === 'component') {
      ctx.setLineDash([]);
      this._drawComponent({ id:'_pre', type:p.compType, x:p.x, y:p.y, angle:p.angle || 0, wallId:null });
      if (p.snapped) {
        ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 2 * this.dpr;
        ctx.beginPath();
        ctx.arc(this.wx(p.x), this.wy(p.y), 7 * this.dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (p.type === 'pipe') {
      const pts = p.points && p.currentEnd ? [...p.points, p.currentEnd] : null;
      if (pts && pts.length >= 2) {
        const def = PIPE[p.pipeType] || PIPE.flow;
        ctx.strokeStyle = def.color; ctx.lineWidth = 2 * this.dpr;
        ctx.setLineDash(def.dash.map(d => d * this.dpr));
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(this.wx(pts[0].x), this.wy(pts[0].y));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(this.wx(pts[i].x), this.wy(pts[i].y));
        ctx.stroke();
      }
    }

    if (p.type === 'measure' && p.start && p.end) {
      ctx.setLineDash([5 * this.dpr, 4 * this.dpr]);
      ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath();
      ctx.moveTo(this.wx(p.start.x), this.wy(p.start.y));
      ctx.lineTo(this.wx(p.end.x),   this.wy(p.end.y));
      ctx.stroke();
      const dist = vlen(vsub(p.end, p.start));
      const mid  = vadd(p.start, vmul(vsub(p.end, p.start), 0.5));
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = '#7c3aed';
      ctx.font = `bold ${11 * this.dpr}px system-ui,sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(`${dist.toFixed(3)} m`, this.wx(mid.x), this.wy(mid.y) - 5 * this.dpr);
    }

    if (p.type === 'opening') {
      const wall = this.state.walls.find(w => w.id === p.wallId);
      if (wall) {
        const fakeOp = { id:'_pre', t:p.t, width:p.width, type:p.openingType };
        this._drawOpening(wall, fakeOp);
      }
    }

    ctx.restore();
  }

  // ── Wall dimension labels ──────────────────────────────────────────────────
  _drawDimensions() {
    const ctx = this.ctx;
    for (const wall of this.state.walls) {
      const len = vlen(vsub(wall.b, wall.a));
      if (len < 0.15) continue;
      const mid  = vadd(wall.a, vmul(vsub(wall.b, wall.a), 0.5));
      const dir  = vnorm(vsub(wall.b, wall.a));
      const perp = vperp(dir);
      const lp   = vadd(mid, vmul(perp, wall.thickness / 2 + 0.12));
      const angle= Math.atan2(dir.y, dir.x);
      ctx.save();
      ctx.translate(this.wx(lp.x), this.wy(lp.y));
      ctx.rotate(angle > Math.PI/2 || angle < -Math.PI/2 ? angle + Math.PI : angle);
      ctx.font = `${9 * this.dpr}px system-ui,sans-serif`;
      ctx.fillStyle = '#64748b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`${len.toFixed(2)} m`, 0, 0);
      ctx.restore();
    }
  }

  // ── Fit view ───────────────────────────────────────────────────────────────
  fitView() {
    const pts = [];
    for (const w of this.state.walls) { pts.push(w.a, w.b); }
    for (const c of this.state.components) { pts.push({ x:c.x, y:c.y }); }
    const W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr;
    if (!pts.length) { this.panX = W/2; this.panY = H/2; this.zoom = 1; this.render(); return; }
    const pad = 60;
    const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
    const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
    const scX  = (W - pad*2) / ((maxX - minX) * PX_PER_M || 1);
    const scY  = (H - pad*2) / ((maxY - minY) * PX_PER_M || 1);
    this.zoom  = Math.max(0.1, Math.min(scX, scY, 4));
    this.panX  = W/2 - ((minX+maxX)/2) * PX_PER_M * this.zoom;
    this.panY  = H/2 - ((minY+maxY)/2) * PX_PER_M * this.zoom;
    this.render();
  }
}

// ─────────────────────────── INPUT HANDLER ───────────────────────────────────
class InputHandler {
  constructor(canvas, renderer, state, snap, onAction) {
    this.canvas    = canvas;
    this.renderer  = renderer;
    this.state     = state;
    this.snap      = snap;
    this.onAction  = onAction;
    this.tool      = T.SELECT;
    this.active    = null;    // per-tool transient state
    this.isPan     = false;
    this.lastPan   = null;
    this.touchDist = null;
    this._placingComp = null;
    this._placingPipe = null;

    canvas.addEventListener('mousedown',   e => this._down(e));
    canvas.addEventListener('mousemove',   e => this._move(e));
    canvas.addEventListener('mouseup',     e => this._up(e));
    canvas.addEventListener('dblclick',    e => this._dbl(e));
    canvas.addEventListener('wheel',       e => this._wheel(e), { passive:false });
    canvas.addEventListener('contextmenu', e => { e.preventDefault(); this._cancel(); });
    canvas.addEventListener('touchstart',  e => this._tStart(e), { passive:false });
    canvas.addEventListener('touchmove',   e => this._tMove(e),  { passive:false });
    canvas.addEventListener('touchend',    e => this._tEnd(e));
  }

  setTool(t) {
    this.tool = t; this.active = null;
    this.renderer.preview = null; this.renderer.render();
  }
  setPlacingComp(type) { this._placingComp = type; this.setTool('_comp'); }
  setPlacingPipe(pipeType, route) { this._placingPipe = { pipeType, route }; this.setTool(T.PIPE); }

  // ── World pos helpers ──────────────────────────────────────────────────────
  _wp(e) {
    const r  = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    return { x: this.renderer.sx(px), y: this.renderer.sy(py) };
  }
  _snapped(e) { return this.snap.snap(this._wp(e)); }

  _wallThick() { return parseFloat(document.getElementById('wall-thickness')?.value || '0.15'); }
  _openWidth() { return parseFloat(document.getElementById('opening-width')?.value  || '0.9');  }

  // ── Down ───────────────────────────────────────────────────────────────────
  _down(e) {
    if (e.button === 1 || e.button === 2) {
      this.isPan = true; this.lastPan = { x:e.clientX, y:e.clientY }; return;
    }
    const raw = this._wp(e);
    const sn  = this.snap.snap(raw);
    const sp  = sn.p;

    switch (this.tool) {

      case T.SELECT: {
        const hit = this._hit(raw);
        this.renderer.selected = hit;
        if (hit) {
          this.active = { drag:true, hit, startRaw:raw, origPos:this._origPos(hit) };
        }
        this.renderer.render();
        this.onAction?.({ type:'select', hit });
        break;
      }

      case T.WALL: {
        if (!this.active) {
          this.active = { start:sp };
        } else {
          if (vlen(vsub(sp, this.active.start)) > 0.05) {
            this.state.addWall(this.active.start, sp, this._wallThick());
          }
          this.active = { start:sp };  // chain next wall
        }
        break;
      }

      case T.DOOR:
      case T.WINDOW: {
        const hit = this._wallHit(raw);
        if (hit) {
          this.state.addOpening(hit.wallId, hit.t, this._openWidth(), this.tool);
          this.renderer.preview = null;
          this.renderer.render();
        }
        break;
      }

      case '_comp': {
        const s = this.snap.componentSnap(raw, this._placingComp);
        const def = COMP[this._placingComp];
        if (def?.wallMounted && !s.snapped) {
          this.onAction?.({ type:'warn', msg:'This component must be placed against a wall.' });
          break;
        }
        this.state.addComponent(this._placingComp, s.x, s.y, s.angle, s.wallId);
        this.renderer.preview = null;
        this.renderer.render();
        break;
      }

      case T.PIPE: {
        if (!this.active) {
          const pipe = this.state.startPipe(
            this._placingPipe?.pipeType || 'flow',
            this._placingPipe?.route    || 'onwall',
            sp
          );
          this.active = { pipeId:pipe.id, points:[{...sp}] };
        } else {
          this.state.addPipePoint(this.active.pipeId, sp);
          this.active.points.push({...sp});
        }
        this.renderer.render();
        break;
      }

      case T.MEASURE: {
        if (!this.active) {
          this.active = { start:sp };
        } else {
          const dist = vlen(vsub(sp, this.active.start));
          this.onAction?.({ type:'measure', dist });
          this.active = null; this.renderer.preview = null; this.renderer.render();
        }
        break;
      }

      case T.ERASE: {
        const hit = this._hit(raw);
        if (hit) {
          if (hit.type === 'wall')      this.state.removeWall(hit.id);
          if (hit.type === 'component') this.state.removeComponent(hit.id);
          if (hit.type === 'pipe')      this.state.removePipe(hit.id);
          this.renderer.selected = null; this.renderer.render();
        }
        break;
      }
    }
  }

  // ── Move ───────────────────────────────────────────────────────────────────
  _move(e) {
    if (this.isPan) {
      const dx = e.clientX - this.lastPan.x, dy = e.clientY - this.lastPan.y;
      this.renderer.panX += dx; this.renderer.panY += dy;
      this.lastPan = { x:e.clientX, y:e.clientY };
      this.renderer.render(); return;
    }
    if (this.active?.drag) { this._drag(this._wp(e)); return; }

    const raw = this._wp(e);
    const sp  = this.snap.snap(raw).p;

    switch (this.tool) {
      case T.WALL:
        if (this.active?.start) {
          this.renderer.preview = { type:'wall', start:this.active.start, end:sp, thickness:this._wallThick() };
          this.renderer.render();
        }
        break;

      case '_comp': {
        const s = this.snap.componentSnap(raw, this._placingComp);
        this.renderer.preview = { type:'component', compType:this._placingComp, x:s.x, y:s.y, angle:s.angle, snapped:s.snapped };
        this.renderer.render();
        break;
      }

      case T.PIPE:
        if (this.active?.pipeId) {
          this.renderer.preview = {
            type:'pipe', points:this.active.points, currentEnd:sp,
            pipeType: this._placingPipe?.pipeType || 'flow',
            route:    this._placingPipe?.route    || 'onwall',
          };
          this.renderer.render();
        }
        break;

      case T.DOOR:
      case T.WINDOW: {
        const hit = this._wallHit(raw);
        if (hit) {
          this.renderer.preview = { type:'opening', wallId:hit.wallId, t:hit.t, width:this._openWidth(), openingType:this.tool };
        } else {
          this.renderer.preview = null;
        }
        this.renderer.render();
        break;
      }

      case T.MEASURE:
        if (this.active?.start) {
          this.renderer.preview = { type:'measure', start:this.active.start, end:sp };
          this.renderer.render();
        }
        break;
    }
  }

  // ── Up ─────────────────────────────────────────────────────────────────────
  _up(e) {
    if (this.isPan) { this.isPan = false; return; }
    if (this.active?.drag) { this.active.drag = false; this.state._fire(); }
  }

  // ── Double-click: end chaining ─────────────────────────────────────────────
  _dbl(e) {
    if (this.tool === T.PIPE && this.active?.pipeId) {
      // Trim last duplicate point added by the single-click that preceded dblclick
      const pipe = this.state.pipes.find(p => p.id === this.active.pipeId);
      if (pipe && pipe.points.length > 2) pipe.points.pop();
      this.active = null; this.renderer.preview = null; this.renderer.render();
    }
    if (this.tool === T.WALL && this.active) {
      this.active = null; this.renderer.preview = null; this.renderer.render();
    }
  }

  // ── Scroll / pinch zoom ────────────────────────────────────────────────────
  _wheel(e) {
    e.preventDefault();
    const r  = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const f  = e.deltaY < 0 ? 1.1 : 1/1.1;
    const oz = this.renderer.zoom;
    this.renderer.zoom = Math.max(0.08, Math.min(12, oz * f));
    this.renderer.panX = px - (px - this.renderer.panX) * (this.renderer.zoom / oz);
    this.renderer.panY = py - (py - this.renderer.panY) * (this.renderer.zoom / oz);
    this.renderer.render();
  }

  _cancel() {
    if (this.active?.pipeId) {
      const pipe = this.state.pipes.find(p => p.id === this.active.pipeId);
      if (pipe && pipe.points.length < 2) this.state.removePipe(this.active.pipeId);
    }
    this.active = null; this.renderer.preview = null; this.renderer.render();
  }

  // ── Touch ──────────────────────────────────────────────────────────────────
  _tStart(e) {
    e.preventDefault();
    if (e.touches.length === 2) { this.touchDist = this._dist2(e.touches); this.isPan = false; return; }
    this._down({ button:0, clientX:e.touches[0].clientX, clientY:e.touches[0].clientY });
  }
  _tMove(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
      const d = this._dist2(e.touches);
      if (this.touchDist) {
        const sc = d / this.touchDist;
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const r  = this.canvas.getBoundingClientRect();
        const px = mx - r.left, py = my - r.top;
        const oz = this.renderer.zoom;
        this.renderer.zoom = Math.max(0.08, Math.min(12, oz * sc));
        this.renderer.panX = px - (px - this.renderer.panX) * (this.renderer.zoom / oz);
        this.renderer.panY = py - (py - this.renderer.panY) * (this.renderer.zoom / oz);
        this.renderer.render();
      }
      this.touchDist = d; return;
    }
    this._move({ clientX:e.touches[0].clientX, clientY:e.touches[0].clientY });
  }
  _tEnd() { this.touchDist = null; this._up({}); }
  _dist2(ts) {
    const dx = ts[0].clientX - ts[1].clientX, dy = ts[0].clientY - ts[1].clientY;
    return Math.sqrt(dx*dx + dy*dy);
  }

  // ── Hit testing ───────────────────────────────────────────────────────────
  _hit(p) {
    for (let i = this.state.components.length - 1; i >= 0; i--) {
      const c = this.state.components[i];
      const def = COMP[c.type]; if (!def) continue;
      const dx = p.x - c.x, dy = p.y - c.y;
      const cs = Math.cos(-c.angle), sn = Math.sin(-c.angle);
      const lx = dx*cs - dy*sn, ly = dx*sn + dy*cs;
      if (Math.abs(lx) < def.w/2 + 0.05 && Math.abs(ly) < def.h/2 + 0.05)
        return { type:'component', id:c.id };
    }
    for (let i = this.state.pipes.length - 1; i >= 0; i--) {
      const pipe = this.state.pipes[i];
      for (let j = 1; j < pipe.points.length; j++) {
        if (projectOnSegment(p, pipe.points[j-1], pipe.points[j]).dist < 0.12)
          return { type:'pipe', id:pipe.id };
      }
    }
    for (let i = this.state.walls.length - 1; i >= 0; i--) {
      const w = this.state.walls[i];
      if (projectOnSegment(p, w.a, w.b).dist < w.thickness/2 + 0.05)
        return { type:'wall', id:w.id };
    }
    return null;
  }

  _wallHit(p) {
    for (const w of this.state.walls) {
      const proj = projectOnSegment(p, w.a, w.b);
      if (proj.dist < w.thickness) return { wallId:w.id, t:proj.t };
    }
    return null;
  }

  _origPos(hit) {
    if (hit.type === 'component') {
      const c = this.state.components.find(c => c.id === hit.id);
      return c ? { x:c.x, y:c.y } : null;
    }
    if (hit.type === 'wall') {
      const w = this.state.walls.find(w => w.id === hit.id);
      return w ? { ax:w.a.x, ay:w.a.y, bx:w.b.x, by:w.b.y } : null;
    }
    return null;
  }

  _drag(raw) {
    const { hit, startRaw, origPos } = this.active;
    if (!origPos) return;
    const dx = raw.x - startRaw.x, dy = raw.y - startRaw.y;

    if (hit.type === 'component') {
      const c = this.state.components.find(c => c.id === hit.id); if (!c) return;
      const np = snapGrid({ x: origPos.x + dx, y: origPos.y + dy });
      if (COMP[c.type]?.wallMounted) {
        const s = this.snap.componentSnap(np, c.type);
        c.x = s.x; c.y = s.y; c.angle = s.angle; c.wallId = s.wallId;
      } else { c.x = np.x; c.y = np.y; }
    }

    if (hit.type === 'wall') {
      const w = this.state.walls.find(w => w.id === hit.id); if (!w) return;
      w.a = snapGrid({ x: origPos.ax + dx, y: origPos.ay + dy });
      w.b = snapGrid({ x: origPos.bx + dx, y: origPos.by + dy });
    }
    this.renderer.render();
  }
}

// ─────────────────────────── PROPERTIES PANEL ────────────────────────────────
class PropsPanel {
  constructor(id, state, renderer) {
    this.el = document.getElementById(id);
    this.state = state;
    this.renderer = renderer;
  }

  show(hit) {
    if (!hit) {
      this.el.innerHTML = '<p style="color:#475569;font-size:.78rem;margin:0">Select an element to edit its properties.</p>';
      return;
    }
    if (hit.type === 'wall')      this._wall(hit.id);
    if (hit.type === 'component') this._comp(hit.id);
    if (hit.type === 'pipe')      this._pipe(hit.id);
  }

  _wall(id) {
    const w = this.state.walls.find(w => w.id === id); if (!w) return;
    const len = vlen(vsub(w.b, w.a));
    this.el.innerHTML = `
      <h4 style="margin:0 0 8px;font-size:.82rem;color:#94a3b8">Wall</h4>
      <label>Length<input readonly value="${len.toFixed(3)} m"/></label>
      <label>Thickness (m)<input type="number" id="pp-thick" step="0.025" min="0.05" max="0.6" value="${w.thickness}"/></label>
      <hr class="pp-sep"/>
      <h4 style="margin:4px 0;font-size:.78rem;color:#64748b">Openings (${w.openings.length})</h4>
      <ul>${w.openings.map(o => `
        <li>${o.type === 'door' ? '🚪' : '🪟'} ${o.type} ${o.width.toFixed(2)} m
          <button data-del-op="${o.id}" data-wall-id="${id}">✕</button></li>
      `).join('')}</ul>
      <button id="pp-del-wall" style="margin-top:6px">Delete Wall</button>`;
    this.el.querySelector('#pp-thick')?.addEventListener('change', e => {
      w.thickness = parseFloat(e.target.value) || 0.1; this.renderer.render();
    });
    this.el.querySelector('#pp-del-wall')?.addEventListener('click', () => {
      this.state.removeWall(id); this.renderer.selected = null; this.renderer.render(); this.show(null);
    });
    this.el.querySelectorAll('[data-del-op]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.state.removeOpening(btn.dataset.wallId, btn.dataset.delOp);
        this._wall(id); this.renderer.render();
      });
    });
  }

  _comp(id) {
    const c = this.state.components.find(c => c.id === id); if (!c) return;
    const def = COMP[c.type];
    const wallOk = c.wallId && this.state.walls.find(w => w.id === c.wallId);
    this.el.innerHTML = `
      <h4 style="margin:0 0 8px;font-size:.82rem;color:#94a3b8">${def?.icon || ''} ${def?.label || c.type}</h4>
      ${def?.wallMounted ? `<p class="${wallOk ? 'status-ok' : 'status-warn'}">${wallOk ? '✅ Wall mounted' : '⚠️ Not on a wall'}</p>` : ''}
      <label>X (m)<input type="number" id="pp-cx" step="0.05" value="${c.x.toFixed(3)}"/></label>
      <label>Y (m)<input type="number" id="pp-cy" step="0.05" value="${c.y.toFixed(3)}"/></label>
      <label>Rotation (°)<input type="number" id="pp-ca" step="5" value="${(c.angle*180/Math.PI).toFixed(1)}"/></label>
      <button id="pp-del-comp" style="margin-top:6px">Delete</button>`;
    this.el.querySelector('#pp-cx')?.addEventListener('change', e => { c.x = parseFloat(e.target.value); this.renderer.render(); });
    this.el.querySelector('#pp-cy')?.addEventListener('change', e => { c.y = parseFloat(e.target.value); this.renderer.render(); });
    this.el.querySelector('#pp-ca')?.addEventListener('change', e => { c.angle = parseFloat(e.target.value) * Math.PI/180; this.renderer.render(); });
    this.el.querySelector('#pp-del-comp')?.addEventListener('click', () => {
      this.state.removeComponent(id); this.renderer.selected = null; this.renderer.render(); this.show(null);
    });
  }

  _pipe(id) {
    const p = this.state.pipes.find(p => p.id === id); if (!p) return;
    const def = PIPE[p.pipeType];
    const totalLen = p.points.reduce((acc, pt, i) => i === 0 ? 0 : acc + vlen(vsub(pt, p.points[i-1])), 0);
    this.el.innerHTML = `
      <h4 style="margin:0 0 8px;font-size:.82rem;color:#94a3b8">⌇ ${def?.label || p.pipeType}</h4>
      <label>Total length<input readonly value="${totalLen.toFixed(2)} m"/></label>
      <label>Pipe type<select id="pp-ptype">${Object.entries(PIPE).map(([k,v]) =>
        `<option value="${k}" ${p.pipeType===k?'selected':''}>${v.label}</option>`).join('')}</select></label>
      <label>Route<select id="pp-route">
        <option value="onwall"     ${p.route==='onwall'?'selected':''}>On wall / surface</option>
        <option value="underfloor" ${p.route==='underfloor'?'selected':''}>Under floor</option>
        <option value="overhead"   ${p.route==='overhead'?'selected':''}>Overhead</option>
      </select></label>
      <button id="pp-del-pipe" style="margin-top:6px">Delete</button>`;
    this.el.querySelector('#pp-ptype')?.addEventListener('change', e => { p.pipeType = e.target.value; this.renderer.render(); });
    this.el.querySelector('#pp-route')?.addEventListener('change', e => { p.route    = e.target.value; this.renderer.render(); });
    this.el.querySelector('#pp-del-pipe')?.addEventListener('click', () => {
      this.state.removePipe(id); this.renderer.selected = null; this.renderer.render(); this.show(null);
    });
  }
}

// ─────────────────────────── LIDAR MANAGER ───────────────────────────────────
class LidarManager {
  constructor(containerId, state, onMsg) {
    this.container = document.getElementById(containerId);
    this.state     = state;
    this.onMsg     = onMsg;
    this.scene     = null; this.camera = null; this.rnd3 = null;
    this.rawPts    = null;  // Float32Array [x,y,z, ...]
    this._theta    = 0; this._phi = 0.5; this._radius = 10;
  }

  init() {
    if (!window.THREE || !this.container) return;
    const W = this.container.clientWidth || 640, H = this.container.clientHeight || 280;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f172a);
    this.camera = new THREE.PerspectiveCamera(55, W/H, 0.01, 500);
    this._updateCamera();
    this.rnd3 = new THREE.WebGLRenderer({ antialias:true });
    this.rnd3.setSize(W, H); this.rnd3.setPixelRatio(window.devicePixelRatio);
    this.container.appendChild(this.rnd3.domElement);
    this._orbit();
    this._animate();
  }

  _updateCamera() {
    if (!this.camera) return;
    this.camera.position.set(
      this._radius * Math.sin(this._theta) * Math.cos(this._phi),
      this._radius * Math.sin(this._phi),
      this._radius * Math.cos(this._theta) * Math.cos(this._phi)
    );
    this.camera.lookAt(0, 0, 0);
  }

  _orbit() {
    const el = this.rnd3.domElement;
    let drag = false, lx = 0, ly = 0;
    el.addEventListener('mousedown', e => { drag=true; lx=e.clientX; ly=e.clientY; });
    el.addEventListener('mousemove', e => {
      if (!drag) return;
      this._theta -= (e.clientX - lx) * 0.01;
      this._phi = Math.max(0.05, Math.min(Math.PI/2 - 0.05, this._phi - (e.clientY - ly) * 0.01));
      lx=e.clientX; ly=e.clientY; this._updateCamera();
    });
    el.addEventListener('mouseup', () => drag=false);
    el.addEventListener('wheel', e => {
      this._radius = Math.max(1, Math.min(60, this._radius + e.deltaY * 0.02));
      this._updateCamera();
    }, { passive:true });
  }

  _animate() { requestAnimationFrame(() => this._animate()); this.rnd3?.render(this.scene, this.camera); }

  async loadFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const buf = await file.arrayBuffer();
    this.onMsg('Parsing file…');
    try {
      if (ext === 'ply')        this._parsePLY(buf);
      else if (ext === 'obj')   this._parseOBJ(new TextDecoder().decode(buf));
      else                      this._parseXYZ(new TextDecoder().decode(buf));
    } catch (e) { this.onMsg('Error: ' + e.message); }
  }

  _parseXYZ(text) {
    const coords = [];
    for (const line of text.trim().split('\n')) {
      const p = line.trim().split(/[\s,]+/);
      if (p.length >= 3) { const [x,y,z] = p.map(Number); if (!isNaN(x)) coords.push(x,y,z); }
    }
    this.rawPts = new Float32Array(coords);
    this._buildCloud();
  }

  _parseOBJ(text) {
    const coords = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('v ')) continue;
      const p = line.slice(2).trim().split(/\s+/).map(Number);
      if (p.length >= 3 && !isNaN(p[0])) coords.push(p[0], p[1], p[2]);
    }
    this.rawPts = new Float32Array(coords);
    this._buildCloud();
  }

  _parsePLY(buf) {
    const head = new TextDecoder('ascii').decode(buf.slice(0, 2048));
    const endH = head.indexOf('end_header');
    if (endH === -1) { this.onMsg('Invalid PLY'); return; }
    const header    = head.slice(0, endH);
    const numVerts  = parseInt((header.match(/element vertex (\d+)/)||[])[1] || '0');
    if (!numVerts)  { this.onMsg('No vertices in PLY'); return; }
    const isBinary  = header.includes('binary');
    const bodyText  = new TextDecoder().decode(buf);
    const lines     = bodyText.split('\n');
    const startLine = lines.findIndex(l => l.startsWith('end_header')) + 1;

    if (!isBinary) {
      const coords = [];
      for (let i = startLine; i < startLine + numVerts && i < lines.length; i++) {
        const p = lines[i].trim().split(/\s+/);
        if (p.length >= 3) { const [x,y,z] = p.map(Number); if (!isNaN(x)) coords.push(x,y,z); }
      }
      this.rawPts = new Float32Array(coords);
    } else {
      // Binary PLY: detect property order and extract x/y/z float32
      const props = [...header.matchAll(/property\s+(\S+)\s+(\S+)/g)].map(m => ({ type:m[1], name:m[2] }));
      const stride = props.length; // assuming all float32 for simplicity
      const headerBytes = new TextEncoder().encode(head.slice(0, endH) + 'end_header\n').length;
      const dv = new DataView(buf, headerBytes);
      const coords = [];
      const xI = props.findIndex(p => p.name === 'x');
      const yI = props.findIndex(p => p.name === 'y');
      const zI = props.findIndex(p => p.name === 'z');
      if (xI < 0 || yI < 0 || zI < 0) { this.onMsg('PLY missing x/y/z properties'); return; }
      for (let i = 0; i < numVerts; i++) {
        const base = i * stride * 4;
        if (base + zI * 4 + 4 > dv.byteLength) break;
        coords.push(dv.getFloat32(base + xI*4, true), dv.getFloat32(base + yI*4, true), dv.getFloat32(base + zI*4, true));
      }
      this.rawPts = new Float32Array(coords);
    }
    this._buildCloud();
  }

  _buildCloud() {
    if (!this.rawPts || !this.scene) return;
    // Remove previous cloud objects
    this.scene.children.slice().filter(c => c.userData.isScan).forEach(c => this.scene.remove(c));
    const n = this.rawPts.length / 3;
    const MAX = 300000;
    const step = Math.max(1, Math.ceil(n / MAX));

    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { const y = this.rawPts[i*3+1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }

    const geom = new THREE.BufferGeometry();
    const cnt  = Math.ceil(n / step);
    const pos  = new Float32Array(cnt * 3);
    const col  = new Float32Array(cnt * 3);
    let j = 0;
    for (let i = 0; i < n; i += step) {
      const x = this.rawPts[i*3], y = this.rawPts[i*3+1], z = this.rawPts[i*3+2];
      pos[j*3] = x; pos[j*3+1] = y; pos[j*3+2] = z;
      const t = (y - minY) / (maxY - minY || 1);
      col[j*3] = t; col[j*3+1] = 1-t; col[j*3+2] = 0.4;
      j++;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, j*3), 3));
    geom.setAttribute('color',    new THREE.BufferAttribute(col.slice(0, j*3), 3));
    geom.computeBoundingBox();
    const center = new THREE.Vector3();
    geom.boundingBox.getCenter(center);

    const cloud = new THREE.Points(geom, new THREE.PointsMaterial({ size:0.04, vertexColors:true, sizeAttenuation:true }));
    cloud.position.sub(center);
    cloud.userData.isScan = true;
    cloud.userData.centerY = center.y;
    this.scene.add(cloud);

    // Slice plane indicator
    const sliceY = 1.2 - center.y;
    const planeMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshBasicMaterial({ color:0x00e5ff, opacity:0.12, transparent:true, side:THREE.DoubleSide })
    );
    planeMesh.rotation.x = -Math.PI/2; planeMesh.position.y = sliceY;
    planeMesh.userData.isScan = true;
    this.scene.add(planeMesh);

    const sz = geom.boundingBox.getSize(new THREE.Vector3()).length();
    this._radius = sz * 1.2; this._updateCamera();
    this.onMsg(`Loaded ${n.toLocaleString()} points. Adjust slice height then click Extract.`);
  }

  extractFloorPlan(sliceH = 1.2, tol = 0.06) {
    if (!this.rawPts) { this.onMsg('No scan loaded'); return; }
    const n = this.rawPts.length / 3;
    let minY = Infinity;
    for (let i = 0; i < n; i++) { const y = this.rawPts[i*3+1]; if (y < minY) minY = y; }
    const targetY = minY + sliceH;

    const slice = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(this.rawPts[i*3+1] - targetY) < tol)
        slice.push({ x: this.rawPts[i*3], z: this.rawPts[i*3+2] });
    }
    if (slice.length < 8) { this.onMsg(`Too few slice points (${slice.length}) – try adjusting slice height.`); return; }

    // Grid-rasterise the slice
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of slice) {
      if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x;
      if (p.z<minZ) minZ=p.z; if (p.z>maxZ) maxZ=p.z;
    }
    const RES = 0.06;  // 6 cm cells
    const gW = Math.ceil((maxX-minX)/RES) + 2;
    const gH = Math.ceil((maxZ-minZ)/RES) + 2;
    if (gW * gH > 1200000) { this.onMsg('Scan area too large for auto-extract.'); return; }

    const grid = new Uint8Array(gW * gH);
    for (const p of slice) {
      const gx = Math.round((p.x - minX) / RES);
      const gz = Math.round((p.z - minZ) / RES);
      if (gx >= 0 && gx < gW && gz >= 0 && gz < gH) grid[gz * gW + gx] = 1;
    }

    const MIN_LEN = 0.5;  // minimum wall length in metres
    const rawWalls = [];

    // Horizontal runs (varying gx, fixed gz)
    for (let gz = 0; gz < gH; gz++) {
      let runStart = -1;
      for (let gx = 0; gx <= gW; gx++) {
        const occ = gx < gW && grid[gz * gW + gx];
        if (occ && runStart === -1) runStart = gx;
        if (!occ && runStart !== -1) {
          if ((gx - runStart) * RES >= MIN_LEN)
            rawWalls.push({ ax: minX + runStart*RES, ay: minZ + gz*RES, bx: minX + gx*RES, by: minZ + gz*RES });
          runStart = -1;
        }
      }
    }
    // Vertical runs (fixed gx, varying gz)
    for (let gx = 0; gx < gW; gx++) {
      let runStart = -1;
      for (let gz = 0; gz <= gH; gz++) {
        const occ = gz < gH && grid[gz * gW + gx];
        if (occ && runStart === -1) runStart = gz;
        if (!occ && runStart !== -1) {
          if ((gz - runStart) * RES >= MIN_LEN)
            rawWalls.push({ ax: minX + gx*RES, ay: minZ + runStart*RES, bx: minX + gx*RES, by: minZ + gz*RES });
          runStart = -1;
        }
      }
    }

    // Merge duplicate/adjacent parallel walls
    const merged = this._mergeParallel(rawWalls, RES * 4);
    let added = 0;
    for (const w of merged) {
      this.state.addWall({ x: w.ax, y: w.ay }, { x: w.bx, y: w.by }, 0.15);
      added++;
    }
    this.onMsg(`Extracted ${added} walls from scan. Review and adjust as needed.`);
  }

  _mergeParallel(walls, tol) {
    const used = new Set(), out = [];
    for (let i = 0; i < walls.length; i++) {
      if (used.has(i)) continue;
      const w = walls[i];
      const horiz = Math.abs(w.ay - w.by) < 0.001;
      let count = 1;
      for (let j = i+1; j < walls.length; j++) {
        if (used.has(j)) continue;
        const w2 = walls[j];
        const horiz2 = Math.abs(w2.ay - w2.by) < 0.001;
        if (horiz !== horiz2) continue;
        const parallel = horiz
          ? Math.abs(w.ay - w2.ay) < tol
          : Math.abs(w.ax - w2.ax) < tol;
        if (parallel) { used.add(j); count++; }
      }
      if (count >= 2) { out.push(w); used.add(i); }
    }
    // Include isolated long walls
    for (let i = 0; i < walls.length; i++) {
      if (!used.has(i)) out.push(walls[i]);
    }
    return out;
  }
}

// ─────────────────────────── SVG EXPORT ──────────────────────────────────────
function exportSVG(state) {
  const pts = [];
  for (const w of state.walls) { pts.push(w.a, w.b); }
  for (const c of state.components) { pts.push({ x:c.x, y:c.y }); }
  if (!pts.length) { alert('Nothing to export'); return; }

  const pad = 0.5;
  const minX = Math.min(...pts.map(p => p.x)) - pad;
  const maxX = Math.max(...pts.map(p => p.x)) + pad;
  const minY = Math.min(...pts.map(p => p.y)) - pad;
  const maxY = Math.max(...pts.map(p => p.y)) + pad;
  const S  = 100; // SVG units / metre
  const W  = (maxX - minX) * S, H = (maxY - minY) * S;
  const tx = x => ((x - minX) * S).toFixed(2);
  const ty = y => ((y - minY) * S).toFixed(2);

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}mm" height="${H.toFixed(0)}mm" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}">
<title>${state.floorName}</title>
<defs>
  <pattern id="g" width="${S*0.1}" height="${S*0.1}" patternUnits="userSpaceOnUse">
    <path d="M ${(S*0.1).toFixed(1)} 0 L 0 0 0 ${(S*0.1).toFixed(1)}" fill="none" stroke="#e2e8f0" stroke-width="0.4"/>
  </pattern>
</defs>
<rect width="100%" height="100%" fill="url(#g)"/>
`;

  // Walls
  for (const wall of state.walls) {
    const dir = vnorm(vsub(wall.b, wall.a));
    const perp = vperp(dir);
    const t2   = wall.thickness / 2;
    const cs   = [
      vadd(wall.a, vmul(perp,-t2)), vadd(wall.a, vmul(perp, t2)),
      vadd(wall.b, vmul(perp, t2)), vadd(wall.b, vmul(perp,-t2)),
    ];
    svg += `<polygon points="${cs.map(c=>`${tx(c.x)},${ty(c.y)}`).join(' ')}" fill="#94a3b8" stroke="#475569" stroke-width="0.5"/>\n`;

    // Openings
    for (const op of wall.openings) {
      const len = vlen(vsub(wall.b, wall.a));
      const os  = vadd(wall.a, vmul(dir, op.t * len));
      const oe  = vadd(wall.a, vmul(dir, op.t * len + op.width));
      const q   = [
        vadd(os, vmul(perp,-t2-0.01)), vadd(os, vmul(perp, t2+0.01)),
        vadd(oe, vmul(perp, t2+0.01)), vadd(oe, vmul(perp,-t2-0.01)),
      ];
      svg += `<polygon points="${q.map(c=>`${tx(c.x)},${ty(c.y)}`).join(' ')}" fill="white" stroke="none"/>\n`;
      if (op.type === 'door') {
        const r = (op.width * S).toFixed(2);
        svg += `<path d="M ${tx(os.x)} ${ty(os.y)} A ${r} ${r} 0 0 1 ${tx(oe.x)} ${ty(oe.y)}" fill="none" stroke="#475569" stroke-width="1"/>\n`;
        svg += `<line x1="${tx(os.x)}" y1="${ty(os.y)}" x2="${tx(oe.x)}" y2="${ty(oe.y)}" stroke="#475569" stroke-width="1"/>\n`;
      } else {
        svg += `<line x1="${tx(q[0].x)}" y1="${ty(q[0].y)}" x2="${tx(q[3].x)}" y2="${ty(q[3].y)}" stroke="#93c5fd" stroke-width="2.5"/>\n`;
        svg += `<line x1="${tx(q[1].x)}" y1="${ty(q[1].y)}" x2="${tx(q[2].x)}" y2="${ty(q[2].y)}" stroke="#93c5fd" stroke-width="2.5"/>\n`;
      }
    }

    // Dimension
    const len = vlen(vsub(wall.b, wall.a));
    if (len > 0.2) {
      const mid = vadd(wall.a, vmul(vsub(wall.b,wall.a), 0.5));
      const lp  = vadd(mid, vmul(perp, t2 + 0.15));
      const deg = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
      svg += `<text x="${tx(lp.x)}" y="${ty(lp.y)}" font-size="5" fill="#475569" text-anchor="middle" transform="rotate(${deg.toFixed(1)},${tx(lp.x)},${ty(lp.y)})">${len.toFixed(2)}m</text>\n`;
    }
  }

  // Pipes
  for (const pipe of state.pipes) {
    if (pipe.points.length < 2) continue;
    const def   = PIPE[pipe.pipeType] || PIPE.flow;
    const isUF  = pipe.route === 'underfloor';
    const pts   = pipe.points.map(p => `${tx(p.x)},${ty(p.y)}`).join(' ');
    const dash  = def.dash.length ? `stroke-dasharray="${def.dash.join(' ')}"` : '';
    svg += `<polyline points="${pts}" fill="none" stroke="${def.color}" stroke-width="${isUF?3:2}" ${dash} stroke-linecap="round" stroke-linejoin="round" opacity="${isUF?0.7:1}"/>\n`;
    svg += `<text font-size="4" fill="${def.color}" text-anchor="middle"><textPath href="#_p${pipe.id}" startOffset="50%">${def.label}${isUF?' (UF)':''}</textPath></text>\n`;
  }

  // Components
  for (const comp of state.components) {
    const def = COMP[comp.type]; if (!def) continue;
    const cw = def.w * S, ch = def.h * S;
    const deg = (comp.angle * 180 / Math.PI).toFixed(2);
    svg += `<g transform="translate(${tx(comp.x)},${ty(comp.y)}) rotate(${deg})">
  <rect x="${(-cw/2).toFixed(2)}" y="${(-ch/2).toFixed(2)}" width="${cw.toFixed(2)}" height="${ch.toFixed(2)}" fill="${def.color}30" stroke="${def.color}" stroke-width="1.5" rx="2"/>
  <text x="0" y="0" font-size="5.5" fill="${def.color}" text-anchor="middle" dominant-baseline="middle">${def.label}</text>
</g>\n`;
  }

  svg += '</svg>';
  const blob = new Blob([svg], { type:'image/svg+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href:url, download:`${state.floorName.replace(/\s+/g,'_')}.svg` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ─────────────────────────── TOAST ───────────────────────────────────────────
function toast(msg, type = 'info') {
  const div = document.createElement('div');
  div.textContent = msg;
  const bg = type === 'warn' ? '#92400e' : type === 'error' ? '#7f1d1d' : '#065f46';
  Object.assign(div.style, {
    position:'fixed', top:'58px', left:'50%', transform:'translateX(-50%)',
    background:bg, color:'#fff', padding:'8px 18px', borderRadius:'8px',
    zIndex:9999, fontSize:'.85rem', boxShadow:'0 2px 8px rgba(0,0,0,.4)',
    opacity:'0', transition:'opacity .25s', pointerEvents:'none',
  });
  document.body.appendChild(div);
  requestAnimationFrame(() => div.style.opacity = '1');
  setTimeout(() => { div.style.opacity='0'; setTimeout(()=>div.remove(), 300); }, 3500);
}

// ─────────────────────────── MAIN APP ────────────────────────────────────────
class FloorPlanApp {
  constructor() {
    this.state    = new State();
    this.canvas   = document.getElementById('fp-canvas');
    this.renderer = new Renderer(this.canvas, this.state);
    this.snap     = new SnapEngine(this.state);
    this.input    = new InputHandler(this.canvas, this.renderer, this.state, this.snap,
      a => this._handleAction(a));
    this.props    = new PropsPanel('props-panel', this.state, this.renderer);
    this.lidar    = new LidarManager('lidar-viewer', this.state, msg => {
      const el = document.getElementById('lidar-status');
      if (el) el.textContent = msg;
    });

    this._bindUI();
    this._resize();
    window.addEventListener('resize', () => this._resize());

    this.state.onChange(() => {
      this.renderer.render();
      this.state.save().catch(() => {});
    });

    // Load persisted state then check URL params
    this.state.load().then(loaded => {
      if (new URLSearchParams(location.search).has('new')) {
        this.state.walls = []; this.state.components = []; this.state.pipes = [];
        this.state._fire();
      }
      if (loaded && this.state.walls.length) this.renderer.fitView();
      else this._centerView();
      // Check for shared file via service worker
      if (new URLSearchParams(location.search).has('shared')) this._loadSharedScan();
    });

    // Default tool hint
    this._hint('select');
  }

  _resize() { this.renderer.resize(); }

  _centerView() {
    const W = this.canvas.width / this.renderer.dpr;
    const H = this.canvas.height / this.renderer.dpr;
    this.renderer.panX = W / 2; this.renderer.panY = H / 2; this.renderer.zoom = 1;
    this.renderer.render();
  }

  _handleAction(a) {
    if (a.type === 'select') { this.props.show(a.hit); }
    if (a.type === 'measure') {
      const el = document.getElementById('measure-result');
      if (el) {
        el.textContent = `📏 ${a.dist.toFixed(3)} m  (${(a.dist*1000).toFixed(0)} mm)`;
        el.style.display = 'inline';
        setTimeout(() => { el.style.display = 'none'; }, 6000);
      }
    }
    if (a.type === 'warn') { toast(a.msg, 'warn'); }
  }

  _bindUI() {
    // ── Tool buttons ──────────────────────────────────────────────────────────
    document.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.input.setTool(btn.dataset.tool);
        this._activateTool(btn.dataset.tool);
      });
    });

    // ── Component library ─────────────────────────────────────────────────────
    document.querySelectorAll('[data-comp]').forEach(el => {
      el.addEventListener('click', () => {
        this.input.setPlacingComp(el.dataset.comp);
        document.querySelectorAll('.xtool').forEach(b => b.classList.remove('active'));
        toast(`Click ${COMP[el.dataset.comp]?.wallMounted ? 'on a wall' : 'the canvas'} to place ${COMP[el.dataset.comp]?.label || el.dataset.comp}`, 'info');
        this._hint('_comp');
      });
    });

    // ── Pipe library ──────────────────────────────────────────────────────────
    document.querySelectorAll('[data-pipe]').forEach(el => {
      el.addEventListener('click', () => {
        const [pipeType, route] = el.dataset.pipe.split(':');
        this.input.setPlacingPipe(pipeType, route || 'onwall');
        document.querySelectorAll('.xtool').forEach(b => b.classList.remove('active'));
        toast(`Click waypoints to draw ${PIPE[pipeType]?.label || pipeType} pipe. Dbl-click to finish.`);
        this._hint('pipe');
      });
    });

    // ── Toolbar buttons ───────────────────────────────────────────────────────
    document.getElementById('btn-new')?.addEventListener('click', () => {
      if (!confirm('Start a new floor plan? Unsaved changes will be lost.')) return;
      this.state.walls = []; this.state.components = []; this.state.pipes = [];
      this.state.floorName = 'Ground Floor';
      document.getElementById('floor-name-input').value = 'Ground Floor';
      this.state._fire();
      this._centerView();
      this.props.show(null);
      this.renderer.selected = null;
    });

    document.getElementById('btn-save')?.addEventListener('click', async () => {
      await this.state.save();
      toast('Plan saved ✓');
    });

    document.getElementById('btn-fit')?.addEventListener('click', () => this.renderer.fitView());

    document.getElementById('btn-dims')?.addEventListener('click', e => {
      this.renderer.showDims = !this.renderer.showDims;
      e.currentTarget.classList.toggle('active', this.renderer.showDims);
      this.renderer.render();
    });

    document.getElementById('btn-export')?.addEventListener('click', () => exportSVG(this.state));

    document.getElementById('floor-name-input')?.addEventListener('change', e => {
      this.state.floorName = e.target.value;
    });

    // ── LiDAR dialog ──────────────────────────────────────────────────────────
    document.getElementById('btn-load-lidar')?.addEventListener('click', () => {
      document.getElementById('lidar-dialog').showModal();
      if (!this.lidar.rnd3) this.lidar.init();
    });

    ['close-lidar', 'close-lidar-2'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => {
        document.getElementById('lidar-dialog').close();
      });
    });

    document.getElementById('lidar-file')?.addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      document.getElementById('lidar-status').textContent = 'Loading…';
      await this.lidar.loadFile(file);
    });

    document.getElementById('btn-extract-plan')?.addEventListener('click', () => {
      const h = parseFloat(document.getElementById('slice-height')?.value || '1.2');
      this.lidar.extractFloorPlan(h);
      document.getElementById('lidar-dialog').close();
      this.renderer.fitView();
    });

    // ── Keyboard shortcuts ────────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
      if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'escape')                  { this._activateTool('select'); this.input.setTool(T.SELECT); }
      else if (k === 'w')                  { this._activateTool('wall');    this.input.setTool(T.WALL);    }
      else if (k === 'd')                  { this._activateTool('door');    this.input.setTool(T.DOOR);    }
      else if (k === 'n')                  { this._activateTool('window');  this.input.setTool(T.WINDOW);  }
      else if (k === 'm')                  { this._activateTool('measure'); this.input.setTool(T.MEASURE); }
      else if (k === 'e')                  { this._activateTool('erase');   this.input.setTool(T.ERASE);   }
      else if (k === 'f')                  { this.renderer.fitView(); }
      else if ((k === 'delete' || k === 'backspace') && this.renderer.selected) {
        const h = this.renderer.selected;
        if (h.type === 'wall')      this.state.removeWall(h.id);
        if (h.type === 'component') this.state.removeComponent(h.id);
        if (h.type === 'pipe')      this.state.removePipe(h.id);
        this.renderer.selected = null;
        this.renderer.render();
        this.props.show(null);
      }
    });
  }

  _activateTool(toolId) {
    document.querySelectorAll('.xtool').forEach(b => b.classList.remove('active'));
    document.querySelector(`.xtool[data-tool="${toolId}"]`)?.classList.add('active');
    this._hint(toolId);
  }

  _hint(toolId) {
    const hints = {
      select:   '↖ Select/Move — click to select, drag to move, Del to delete',
      wall:     '▦ Wall — click start point, click end point (chains). Dbl-click or Esc to stop.',
      door:     '🚪 Door — click anywhere on a wall to insert a door opening',
      window:   '🪟 Window — click anywhere on a wall to insert a window',
      pipe:     '⌇ Pipe — click waypoints to route; dbl-click to finish. Right-click to cancel.',
      measure:  '📏 Measure — click two points to measure distance',
      erase:    '✕ Erase — click any element to delete it',
      _comp:    '📌 Place — click on a wall to snap (wall-mounted) or anywhere (free-standing)',
    };
    const el = document.getElementById('tool-hint');
    if (el) el.textContent = hints[toolId] || '';
  }

  // Retrieve a scan file shared to the app via the Web Share Target API
  async _loadSharedScan() {
    try {
      const cache = await caches.open('sb-fp-v1');
      const resp  = await cache.match('/shared-scan');
      if (!resp) return;
      const buf  = await resp.arrayBuffer();
      const name = resp.headers.get('X-File-Name') || 'scan.ply';
      const file = new File([buf], name);
      document.getElementById('btn-load-lidar')?.click();
      await new Promise(r => setTimeout(r, 400));
      await this.lidar.loadFile(file);
      toast('Shared scan loaded – click "Extract Floor Plan" to convert to 2D.');
      await cache.delete('/shared-scan');
    } catch (e) { console.warn('Shared scan load failed', e); }
  }
}

// ─────────────────────────── BOOT ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window.FPA = new FloorPlanApp();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW register:', e));
  }
});

})(); // end IIFE
