/* ============================================================================
   The One Ring — the scenery.

   One canvas behind the page. The painting (one-ring.webp) is the stage: an
   elf-lord on a white horse and two hobbits in a blue wood, an orc warband
   pressing in out of the dark, and a face half-seen in the boughs above.
   Five things move on it:

     the light     the rider's glow, breathing; the wood is lit by it
     the shadow    the warband leans in, and a darkness gathers at its back
     the vision    the face in the trees comes and goes, never quite there
     the mallorn   gold leaves drifting down out of the canopy, snow on the wind
     the phial     a little starlight that follows the cursor; a click is a
                   burst of it

   And it listens to the app (scene-kit's ctx.mode):

     empty  a held breath: the wood is still and the light is steady
     busy   the shadow presses: the host surges, the dark deepens, the wind
            drives the snow, blades glint
     done   the light breaks: a white front sweeps out from the rider and
            drives the dark back, the gold falls thick, the vision looks on
     idle   a quiet watch

   The painting is cut into sprites once, on load: the warband is lifted out
   with a feathered edge and redrawn a few pixels off its painted place, and
   the face is lifted so it can be brightened on its own.
   ========================================================================== */

import { createScene } from '../drivers/scene-kit.js';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;

/* The painting, in its own pixels (1920x1080). Every region is measured
   against it. */
const IMG = { w: 1920, h: 1080 };
// Where the frame centres when the window is narrower than the painting: the
// rider on a phone (the host's front rank still in view), the whole clash on a
// laptop. Eased between the two by the window's aspect.
const FOCUS = { phone: 0.26, wide: 0.42, y: 0.55 };
const HOST = { x: 760, y: 250, w: 1160, h: 760 };
const FACE = { x: 1110, y: 0, w: 300, h: 240 };
const RIDER = { x: 400, y: 610 };
const CANOPY = { x0: 0, x1: 1050, y0: 0, y1: 430 };
// Raised blades, where a glint can catch.
const BLADES = [
  { x: 1193, y: 318 }, { x: 1350, y: 228 }, { x: 1672, y: 166 },
  { x: 1832, y: 152 }, { x: 1866, y: 206 }, { x: 760, y: 690 },
];

/** A region of the painting with a soft elliptical edge, ready to redraw. */
function lift(img, r, feather) {
  const c = document.createElement('canvas');
  c.width = r.w; c.height = r.h;
  const g = c.getContext('2d');
  g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  g.globalCompositeOperation = 'destination-in';
  g.save();
  g.translate(r.w / 2, r.h / 2);
  g.scale(r.w / 2, r.h / 2);
  const m = g.createRadialGradient(0, 0, 0, 0, 0, 1);
  m.addColorStop(0, '#000');
  m.addColorStop(feather, '#000');
  m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m;
  g.fillRect(-1, -1, 2, 2);
  g.restore();
  return c;
}

export function mount() {
  const img = new Image();
  let ready = false;
  let host = null, face = null;
  let leaves = [], snow = [], stars = [], glints = [];
  let light = 0;            // the light breaking, 1 → 0
  let press = 0;            // the shadow pressing, eased toward the mode's target
  let wind = 1;
  let vision = 0;           // extra brightness on the face after an answer
  let par = { x: 0, y: 0 }; // pointer parallax, eased
  let view = { s: 1, ox: 0, oy: 0 };
  let ctxRef = null;
  let listening = false;

  img.decoding = 'async';
  img.onload = () => {
    host = lift(img, HOST, 0.7);
    face = lift(img, FACE, 0.45);
    ready = true;
    // Reduced motion paints one frame on demand; the painting arriving is one.
    if (ctxRef?.reduced) { ctxRef.dt = 0; draw(ctxRef); }
  };
  img.src = new URL('./one-ring.webp', import.meta.url).href;

  /** Painting pixels → screen pixels, for the current frame's framing. */
  const sx = (x) => view.ox + x * view.s;
  const sy = (y) => view.oy + y * view.s;

  function frame(ctx) {
    // Cover the window, with a little to spare for the drift and the parallax.
    const s = Math.max(ctx.w / IMG.w, ctx.h / IMG.h) * 1.06;
    const drift = ctx.reduced ? 0 : 1;
    const dx = Math.sin(ctx.t * 0.027) * 0.01 * IMG.w * s * drift;
    const dy = Math.sin(ctx.t * 0.019 + 1) * 0.007 * IMG.h * s * drift;
    const fx = lerp(FOCUS.phone, FOCUS.wide, clamp((ctx.w / ctx.h - 0.5) / 1.1, 0, 1));
    view = {
      s,
      ox: ctx.w / 2 - fx * IMG.w * s + dx + par.x,
      oy: ctx.h / 2 - FOCUS.y * IMG.h * s + dy + par.y,
    };
    view.ox = clamp(view.ox, ctx.w - IMG.w * s, 0);
    view.oy = clamp(view.oy, ctx.h - IMG.h * s, 0);
  }

  function newLeaf(ctx, y) {
    // Gold out of the canopy, top-left, drifting down and left on the wind.
    return {
      x: sx(rand(CANOPY.x0, CANOPY.x1)),
      y: y ?? sy(rand(CANOPY.y0, CANOPY.y1 * 0.4)),
      vy: rand(10, 26), vx: rand(-14, 4),
      size: rand(1.4, 3.2),
      spin: rand(0, TAU), vspin: rand(1, 3),
      sway: rand(0.6, 1.4), ph: rand(0, TAU),
      life: rand(9, 18), age: 0,
    };
  }
  function newFlake(ctx, x, y) {
    return {
      x: x ?? rand(-0.05, 1.15) * ctx.w,
      y: y ?? rand(-20, ctx.h),
      v: rand(14, 34),
      size: rand(0.5, 1.6),
      a: rand(0.25, 0.7),
      ph: rand(0, TAU),
    };
  }
  function seed(ctx) {
    const small = ctx.w < 700;
    snow = Array.from({ length: small ? 50 : 110 }, () => newFlake(ctx));
    leaves = Array.from({ length: small ? 8 : 16 }, () => newLeaf(ctx, rand(0, ctx.h * 0.8)));
  }
  function burst(x, y, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), v = rand(0.3, 1) * speed;
      stars.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.8, 1.8), age: 0, size: rand(0.8, 2) });
    }
  }

  function update(ctx, dt) {
    ctxRef = ctx;
    const busy = ctx.mode === 'busy';
    const pTarget = busy ? 1 : ctx.mode === 'empty' ? 0.15 : 0.3;
    press = lerp(press, light > 0 ? 0 : pTarget, Math.min(dt * (busy ? 0.35 : 0.9), 1));
    wind = lerp(wind, busy ? 2.6 : ctx.mode === 'empty' ? 0.7 : 1, Math.min(dt * 0.8, 1));
    light = Math.max(0, light - dt * 0.33);
    vision = Math.max(0, vision - dt * 0.12);

    // The pointer leans the frame a touch: depth, not a steering wheel.
    const p = ctx.pointer;
    const tx = p.inside ? (0.5 - p.x / ctx.w) * 16 : 0;
    const ty = p.inside ? (0.5 - p.y / ctx.h) * 9 : 0;
    par.x = lerp(par.x, tx, Math.min(dt * 1.5, 1));
    par.y = lerp(par.y, ty, Math.min(dt * 1.5, 1));
    frame(ctx);

    // Snow on a wind out of the dark: the host charges left, so it blows left.
    for (const f of snow) {
      f.x -= f.v * 0.7 * wind * dt;
      f.y += f.v * dt;
      if (f.y > ctx.h + 10 || f.x < -10) Object.assign(f, newFlake(ctx, rand(0, 1.15) * ctx.w, -10));
    }

    const want = ctx.reduced ? 0 : (ctx.w < 700 ? 8 : 16) + (light > 0 ? 18 : 0);
    while (leaves.length < want) leaves.push(newLeaf(ctx));
    for (let i = leaves.length - 1; i >= 0; i--) {
      const l = leaves[i];
      l.age += dt;
      l.spin += l.vspin * dt;
      l.x += (l.vx - 6 * (wind - 1) + Math.sin(ctx.t * l.sway + l.ph) * 14) * dt;
      l.y += l.vy * dt;
      if (l.age > l.life || l.y > ctx.h + 10 || leaves.length > want) leaves.splice(i, 1);
    }

    for (let i = stars.length - 1; i >= 0; i--) {
      const s = stars[i];
      s.age += dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.vx *= 1 - dt * 1.6; s.vy *= 1 - dt * 1.6;
      if (s.age > s.life) stars.splice(i, 1);
    }

    // Glints: a blade catches the elf-light now and then, more often in a fight.
    if (!ctx.reduced && Math.random() < dt * (busy ? 1.4 : 0.25)) {
      glints.push({ b: BLADES[Math.floor(Math.random() * BLADES.length)], age: 0, life: rand(0.5, 0.9) });
    }
    for (let i = glints.length - 1; i >= 0; i--) {
      glints[i].age += dt;
      if (glints[i].age > glints[i].life) glints.splice(i, 1);
    }
  }

  function draw(ctx) {
    const c = ctx.layer('bg');
    if (!c) return;
    const { w, h } = ctx;
    const pal = ctx.pal;
    const night = clamp(parseFloat(pal.night) || 0, 0, 1);
    const t = ctx.t;
    c.clearRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;

    if (!ready) {
      const g = c.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, pal.wood);
      g.addColorStop(1, pal.shadow);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      return;
    }

    // The painting.
    c.drawImage(img, view.ox, view.oy, IMG.w * view.s, IMG.h * view.s);

    // The host leans in: a slow heave, and a surge toward the rider when the
    // shadow presses. A few painted pixels either way is all it takes.
    const surge = -(Math.sin(t * 0.5) * 0.5 + 0.5) * (3 + press * 9) + Math.sin(t * 2.1) * press * 1.5;
    const heave = Math.sin(t * 0.7 + 0.4) * 2.5 + Math.sin(t * 3.3) * press * 1.2;
    drawLifted(c, host, HOST, surge, heave, 0);

    // The dark at the host's back. It gathers from the right, and the light
    // breaking pushes it off the edge.
    const front = light > 0 ? lerp(w * 1.3, sx(RIDER.x), Math.pow(light, 1.6)) : null;
    const dark = (0.18 + press * 0.32 + 0.04 * Math.sin(t * 0.4)) * (light > 0 ? 1 - light : 1);
    if (dark > 0.01) {
      const g = c.createLinearGradient(w, 0, sx(RIDER.x + 260), 0);
      g.addColorStop(0, pal.shadow);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = dark;
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.globalAlpha = 1;
    }

    c.globalCompositeOperation = 'lighter';

    // The vision in the boughs: breathing in and out on a long slow beat.
    if (face) {
      const breathe = Math.pow(0.5 + 0.5 * Math.sin(t * 0.21 - 1.2), 3);
      c.globalAlpha = clamp(0.05 + breathe * 0.22 + vision * 0.45, 0, 0.7) * (1 - night * 0.3);
      drawLifted(c, face, FACE, 0, Math.sin(t * 0.15) * 3, 0);
    }

    // The rider's light, breathing; it flickers harder while the dark presses.
    const r0 = { x: sx(RIDER.x), y: sy(RIDER.y) };
    const flick = press * 0.05 * Math.sin(t * 7.3) * Math.sin(t * 2.9);
    const glow = 0.16 + 0.05 * Math.sin(t * 0.6) + flick + light * 0.6;
    const gr = c.createRadialGradient(r0.x, r0.y, 0, r0.x, r0.y, 420 * view.s * (1 + light * 0.8));
    gr.addColorStop(0, pal.light);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    c.globalAlpha = clamp(glow, 0, 1);
    c.fillStyle = gr;
    c.fillRect(0, 0, w, h);

    // The light breaking: a white front sweeping out from the rider.
    if (front != null) {
      const band = Math.max(w, h) * 0.35;
      const g = c.createLinearGradient(front - band, 0, front + band * 0.3, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.75, pal.light);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = light * 0.6;
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }

    // Blades catching it.
    for (const gl of glints) {
      const k = Math.sin(Math.PI * gl.age / gl.life);
      const x = sx(gl.b.x + surge), y = sy(gl.b.y + heave);
      const r = (6 + k * 10) * Math.max(view.s, 0.6);
      c.globalAlpha = k * 0.85;
      c.strokeStyle = pal.star;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x - r, y); c.lineTo(x + r, y);
      c.moveTo(x, y - r); c.lineTo(x, y + r);
      c.stroke();
      c.globalAlpha = k * 0.5;
      c.fillStyle = pal.star;
      c.beginPath(); c.arc(x, y, 1.6, 0, TAU); c.fill();
    }

    // Snow.
    c.fillStyle = pal.snow;
    for (const f of snow) {
      c.globalAlpha = f.a * (0.7 + 0.3 * Math.sin(t * 2 + f.ph));
      c.fillRect(f.x, f.y, f.size, f.size);
    }

    // Gold out of the mallorn.
    c.fillStyle = pal.gold;
    for (const l of leaves) {
      const life = Math.sin(Math.PI * clamp(l.age / l.life, 0, 1));
      c.globalAlpha = life * 0.85;
      c.save();
      c.translate(l.x, l.y);
      c.rotate(l.spin);
      c.scale(1, 0.35 + 0.65 * Math.abs(Math.sin(l.spin * 1.3)));
      c.beginPath();
      c.ellipse(0, 0, l.size * 1.6, l.size, 0, 0, TAU);
      c.fill();
      c.restore();
    }

    // The phial: a little starlight at the cursor, brighter after dark.
    const p = ctx.pointer;
    if (p.inside && !ctx.reduced) {
      const pr = 70 + 8 * Math.sin(t * 2.4);
      const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, pr);
      g.addColorStop(0, pal.star);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.08 + night * 0.1;
      c.fillStyle = g;
      c.fillRect(p.x - pr, p.y - pr, pr * 2, pr * 2);
    }
    c.fillStyle = pal.star;
    for (const s of stars) {
      c.globalAlpha = (1 - s.age / s.life) * 0.9;
      c.beginPath();
      c.arc(s.x, s.y, s.size, 0, TAU);
      c.fill();
    }

    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;

    // Night: the same wood, deeper. Multiply keeps the rider and the snow
    // brighter than the trees, so the light still carries.
    if (night > 0) {
      c.globalCompositeOperation = 'multiply';
      c.globalAlpha = 0.4 * night;
      c.fillStyle = pal.dusk;
      c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
    }
  }

  /** A lifted sprite back on the painting, offset in painting pixels. */
  function drawLifted(c, sprite, r, ox, oy, rot) {
    if (!sprite) return;
    const cx = sx(r.x + r.w / 2 + ox);
    const cy = sy(r.y + r.h / 2 + oy);
    c.save();
    c.translate(cx, cy);
    c.rotate(rot);
    c.drawImage(sprite, -r.w / 2 * view.s, -r.h / 2 * view.s, r.w * view.s, r.h * view.s);
    c.restore();
  }

  return createScene({
    layers: [{ name: 'bg', z: -1 }],
    vars: {
      wood: '--or-wood', shadow: '--or-shadow', light: '--or-light', star: '--or-star',
      gold: '--or-gold', snow: '--or-snow', dusk: '--or-dusk', night: '--or-night',
    },
    // Drawn until the stylesheet applies (scene-kit re-reads until it has).
    fallbacks: {
      wood: '#4a6ea8', shadow: '#06080f', light: '#dfeaff', star: '#f4f8ff',
      gold: '#e8b54a', snow: '#c9d8f2', dusk: '#0a1022', night: '0',
    },
    setup(ctx) {
      ctxRef = ctx;
      frame(ctx);
      if (!snow.length) seed(ctx);
      // setup runs again on every resize and palette change; listen once.
      if (!listening) {
        listening = true;
        ctx.on('mode', onMode);
        ctx.on('pointerdown', (c, at) => { if (!c.reduced) burst(at.x, at.y, 22, 160); });
      }
    },
    update,
    draw,
  });

  function onMode(ctx) {
    if (ctx.mode === 'done' && !ctx.reduced) {
      light = 1;
      vision = 1;
      for (let i = 0; i < 20; i++) leaves.push(newLeaf(ctx));
      burst(sx(RIDER.x), sy(RIDER.y - 80), 30, 220);
    }
  }
}
