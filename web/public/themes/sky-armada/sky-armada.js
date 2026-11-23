/* ============================================================================
   Sky Armada — the scenery.

   One canvas behind the page. The painting (sky-armada.webp) is the stage, and
   five things move on it:

     the fleet     the big ships ride the air, a slow swell, never quite still
     the scout     the little ship far off to the left, bobbing on its own beat
     the cloud sea soft wisps drifting past, lit apricot, coral and lavender
     the sun       beams breathing in the top-right corner, dust in the light
     the gulls     wheeling round the pier; a fast cursor scatters them

   And it listens to the app (scene-kit's ctx.mode):

     empty  the sky is clear, the log steps back, the painting has the window
     busy   the wind gets up: wisps race, the fleet heels, beams brighten
     done   the sun breaks through, a flare and a gust of motes
     idle   a calm afternoon

   The painting is cut into sprites once, on load: the fleet and the scout are
   lifted out with a feathered edge and redrawn a few pixels off their painted
   place, so the original under them never shows as a seam.
   ========================================================================== */

import { createScene } from '../drivers/scene-kit.js';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;

/* The painting, in its own pixels (1920x1032; the source is cropped above
   the corner watermark). Every region below is measured against it. */
const IMG = { w: 1920, h: 1032 };
// Where the frame centres when the window is narrower than the painting:
// the fleet on a phone, the fleet and the pier on a laptop.
const FOCUS = { x: 0.48, y: 0.45 };
const FLEET = { x: 110, y: 0, w: 1140, h: 770 };
const SCOUT = { x: 80, y: 325, w: 220, h: 150 };
const SUN = { x: 1760, y: -60 };
const PIER = { x: 1365, y: 785 };

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

/** A soft cloud puff, pre-rendered once per colour and drawn scaled. */
function puff(color) {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, color);
  gr.addColorStop(0.45, color);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.globalAlpha = 1;
  g.fillRect(0, 0, s, s);
  // The gradient's last stop fades to transparent black; re-tint the fringe
  // so the edge of a wisp is never grey.
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, s, s);
  return c;
}

export function mount() {
  const img = new Image();
  let ready = false;
  let fleet = null, scout = null;
  let puffs = [];
  let wisps = [], motes = [], gulls = [];
  let flare = 0;            // the sun breaking through, 1 → 0
  let wind = 1;             // eased toward the mode's target
  let par = { x: 0, y: 0 }; // pointer parallax, eased
  let view = { s: 1, ox: 0, oy: 0 };
  let ctxRef = null;
  let listening = false;

  img.decoding = 'async';
  img.onload = () => {
    fleet = lift(img, FLEET, 0.72);
    scout = lift(img, SCOUT, 0.55);
    ready = true;
    // Reduced motion paints one frame on demand; the painting arriving is one.
    if (ctxRef?.reduced) { ctxRef.dt = 0; draw(ctxRef); }
  };
  img.src = new URL('./sky-armada.webp', import.meta.url).href;

  /** Painting pixels → screen pixels, for the current frame's framing. */
  const sx = (x) => view.ox + x * view.s;
  const sy = (y) => view.oy + y * view.s;

  function frame(ctx) {
    // Cover the window, with a little to spare for the swell and the parallax.
    const s = Math.max(ctx.w / IMG.w, ctx.h / IMG.h) * 1.07;
    const drift = ctx.reduced ? 0 : 1;
    const dx = Math.sin(ctx.t * 0.031) * 0.012 * IMG.w * s * drift;
    const dy = Math.sin(ctx.t * 0.023 + 1) * 0.008 * IMG.h * s * drift;
    view = {
      s,
      ox: ctx.w / 2 - FOCUS.x * IMG.w * s + dx + par.x,
      oy: ctx.h / 2 - FOCUS.y * IMG.h * s + dy + par.y,
    };
    view.ox = clamp(view.ox, ctx.w - IMG.w * s, 0);
    view.oy = clamp(view.oy, ctx.h - IMG.h * s, 0);
  }

  function seedWisps(ctx) {
    const n = ctx.w < 700 ? 9 : 16;
    wisps = Array.from({ length: n }, () => newWisp(ctx, rand(-0.1, 1.1) * ctx.w));
  }
  function newWisp(ctx, x) {
    // Mostly the cloud sea below the fleet; a few high streamers.
    const low = Math.random() < 0.75;
    return {
      x,
      y: low ? rand(0.55, 0.98) * ctx.h : rand(0.08, 0.4) * ctx.h,
      w: rand(160, 420) * (ctx.w < 700 ? 0.6 : 1),
      h: rand(26, 70),
      v: rand(8, 22) * (low ? 1 : 0.6),
      a: rand(0.10, 0.24),
      c: Math.floor(Math.random() * 3),
      ph: rand(0, TAU),
    };
  }
  function newMote(ctx) {
    // Dust in the beams: born near the sun, drifting down-left along the light.
    const r = rand(0, 1);
    return {
      x: lerp(ctx.w * 0.62, ctx.w * 1.02, r) + rand(-40, 40),
      y: rand(-10, ctx.h * 0.45),
      v: rand(6, 18),
      life: rand(4, 10), age: 0,
      size: rand(0.6, 1.8),
      ph: rand(0, TAU),
    };
  }
  function seedGulls() {
    gulls = Array.from({ length: 5 }, (_, i) => ({
      ang: rand(0, TAU),
      rad: rand(60, 150),
      lift: rand(-90, -20),
      spd: rand(0.18, 0.32) * (i % 2 ? 1 : -1),
      flap: rand(0, TAU),
      size: rand(5, 8),
      scatter: 0, sx: 0, sy: 0,
    }));
  }

  function update(ctx, dt) {
    ctxRef = ctx;
    const target = ctx.mode === 'busy' ? 3.2 : ctx.mode === 'done' ? 2 : ctx.mode === 'empty' ? 0.8 : 1;
    wind = lerp(wind, target, Math.min(dt * 0.8, 1));
    flare = Math.max(0, flare - dt * 0.45);

    // The pointer leans the frame a touch: depth, not a steering wheel.
    const p = ctx.pointer;
    const tx = p.inside ? (0.5 - p.x / ctx.w) * 18 : 0;
    const ty = p.inside ? (0.5 - p.y / ctx.h) * 10 : 0;
    par.x = lerp(par.x, tx, Math.min(dt * 1.5, 1));
    par.y = lerp(par.y, ty, Math.min(dt * 1.5, 1));
    frame(ctx);

    // Ships sail bow-left, so the wind comes from the right.
    for (const w of wisps) {
      w.x -= w.v * wind * dt;
      if (w.x + w.w < -40) Object.assign(w, newWisp(ctx, ctx.w + rand(20, 200)));
    }

    const want = ctx.reduced ? 0 : (ctx.w < 700 ? 24 : 46) + (ctx.mode === 'busy' ? 20 : 0);
    while (motes.length < want) motes.push(newMote(ctx));
    for (let i = motes.length - 1; i >= 0; i--) {
      const m = motes[i];
      m.age += dt;
      m.x -= m.v * 0.8 * wind * dt;
      m.y += m.v * 0.5 * dt;
      if (m.age > m.life || motes.length > want) motes.splice(i, 1);
    }

    // Gulls: a lazy orbit over the pier. A fast cursor close by, or a click,
    // sends them off; they drift back to the orbit on their own.
    const home = { x: sx(PIER.x), y: sy(PIER.y) };
    for (const g of gulls) {
      g.ang += g.spd * dt * (ctx.mode === 'busy' ? 1.6 : 1);
      g.flap += dt * (g.scatter > 0 ? 16 : 7);
      const gx = home.x + Math.cos(g.ang) * g.rad * view.s * 1.4 + g.sx;
      const gy = home.y + g.lift * view.s * 1.4 + Math.sin(g.ang) * g.rad * 0.35 * view.s + g.sy;
      if (p.inside && p.speed > 900 && Math.hypot(p.x - gx, p.y - gy) < 90) startle(g, gx - p.x, gy - p.y);
      if (g.scatter > 0) {
        g.scatter -= dt;
      } else {
        g.sx = lerp(g.sx, 0, Math.min(dt * 0.6, 1));
        g.sy = lerp(g.sy, 0, Math.min(dt * 0.6, 1));
      }
      g.x = gx; g.y = gy;
    }
  }

  function startle(g, ax, ay) {
    const d = Math.hypot(ax, ay) || 1;
    g.sx += (ax / d) * 140;
    g.sy += (ay / d) * 110 - 40;
    g.scatter = 1.2;
  }

  function draw(ctx) {
    const c = ctx.layer('bg');
    if (!c) return;
    const { w, h } = ctx;
    const pal = ctx.pal;
    const night = clamp(parseFloat(pal.night) || 0, 0, 1);
    c.clearRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;

    if (!ready) {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, pal.sky);
      g.addColorStop(1, pal.skyLo);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      return;
    }

    // The painting.
    c.drawImage(img, view.ox, view.oy, IMG.w * view.s, IMG.h * view.s);

    // The fleet on the swell. Heeling more in a wind; a few painted pixels
    // either way is all it takes to read as afloat.
    const t = ctx.t;
    const heave = Math.sin(t * 0.55) * 5 + Math.sin(t * 0.21) * 2.5;
    const surge = Math.sin(t * 0.33 + 0.7) * 3 * wind;
    const roll = (Math.sin(t * 0.42 + 1.3) * 0.25 + (wind - 1) * 0.12) * Math.PI / 180;
    drawLifted(c, fleet, FLEET, surge, heave, roll);

    const sh = Math.sin(t * 0.8 + 2) * 3.5;
    const ss = Math.sin(t * 0.17) * 6 - (wind - 1) * 4;
    drawLifted(c, scout, SCOUT, ss, sh, Math.sin(t * 0.6) * 0.5 * Math.PI / 180);

    // The cloud sea, drifting.
    if (puffs.length) {
      for (const wsp of wisps) {
        const bob = Math.sin(t * 0.3 + wsp.ph) * 4;
        c.globalAlpha = wsp.a * (ctx.mode === 'empty' ? 0.7 : 1);
        c.drawImage(puffs[wsp.c], wsp.x, wsp.y - wsp.h / 2 + bob, wsp.w, wsp.h);
        c.drawImage(puffs[(wsp.c + 1) % 3], wsp.x + wsp.w * 0.25, wsp.y - wsp.h * 0.8 + bob, wsp.w * 0.55, wsp.h * 0.8);
      }
      c.globalAlpha = 1;
    }

    // Sunbeams from the top-right, breathing; brighter in a wind, flaring
    // when an answer lands.
    const sun = { x: sx(SUN.x), y: sy(SUN.y) };
    const beam = (0.07 + 0.03 * Math.sin(t * 0.5)) * (1 + (wind - 1) * 0.25) + flare * 0.22;
    c.globalCompositeOperation = 'lighter';
    // Beams fade out with distance from the sun, so on a narrow window, where
    // the sun is far off-frame, they never arrive as hard-edged bands.
    const len = Math.max(w, h) * 1.3;
    const reach = Math.max(IMG.w, IMG.h) * view.s * 0.75;
    const fade = c.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, reach);
    fade.addColorStop(0, pal.ray);
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = fade;
    for (let i = 0; i < 6; i++) {
      const a0 = Math.PI * (0.58 + i * 0.065) + Math.sin(t * 0.13 + i) * 0.012;
      const spread = 0.018 + (i % 3) * 0.008;
      c.globalAlpha = beam * (0.6 + 0.4 * Math.sin(t * 0.37 + i * 1.7)) * (1 - night * 0.5);
      c.beginPath();
      c.moveTo(sun.x, sun.y);
      c.lineTo(sun.x + Math.cos(a0 - spread) * len, sun.y + Math.sin(a0 - spread) * len);
      c.lineTo(sun.x + Math.cos(a0 + spread) * len, sun.y + Math.sin(a0 + spread) * len);
      c.closePath();
      c.fill();
    }
    if (flare > 0) {
      const r = Math.max(w, h) * (0.25 + (1 - flare) * 0.25);
      const g = c.createRadialGradient(sun.x, sun.y + 60, 0, sun.x, sun.y + 60, r);
      g.addColorStop(0, pal.ray);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = flare * 0.55;
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
    // Dust in the light.
    c.fillStyle = pal.ray;
    for (const m of motes) {
      const life = Math.sin(Math.PI * clamp(m.age / m.life, 0, 1));
      c.globalAlpha = life * (0.45 + 0.35 * Math.sin(t * 3 + m.ph));
      c.beginPath();
      c.arc(m.x, m.y, m.size, 0, TAU);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;

    // Gulls.
    c.strokeStyle = pal.gull;
    c.lineCap = 'round';
    c.lineWidth = Math.max(1.2, view.s * 1.8);
    for (const g of gulls) {
      if (g.x == null) continue;
      const k = g.size * Math.max(view.s, 0.6) * 1.6;
      const f = Math.sin(g.flap) * 0.6;
      c.globalAlpha = 0.9;
      c.beginPath();
      c.moveTo(g.x - k, g.y - k * f);
      c.quadraticCurveTo(g.x - k * 0.4, g.y - k * 0.5, g.x, g.y);
      c.quadraticCurveTo(g.x + k * 0.4, g.y - k * 0.5, g.x + k, g.y - k * f);
      c.stroke();
    }
    c.globalAlpha = 1;

    // Night: the same painting, under a dusk wash. Multiply keeps the sails
    // and the sunlit cloud tops brighter than the sky, so it still reads.
    if (night > 0) {
      c.globalCompositeOperation = 'multiply';
      c.globalAlpha = 0.62 * night;
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
      sky: '--sa-sky', skyLo: '--sa-sky-lo',
      cloud: ['--sa-cloud-a', '--sa-cloud-b', '--sa-cloud-c'],
      ray: '--sa-ray', gull: '--sa-gull', dusk: '--sa-dusk', night: '--sa-night',
    },
    // Drawn until the stylesheet applies (scene-kit re-reads until it has).
    fallbacks: {
      sky: '#4c79b9', skyLo: '#9db6dc',
      cloud: ['#fff1d6', '#f0a77c', '#8f94c9'],
      ray: '#fff0c4', gull: '#ffffff', dusk: '#1a2350', night: '0',
    },
    setup(ctx) {
      ctxRef = ctx;
      puffs = ctx.pal.cloud.map(puff);
      if (!wisps.length) seedWisps(ctx);
      if (!gulls.length) seedGulls();
      frame(ctx);
      // setup runs again on every resize and palette change; listen once.
      if (!listening) {
        listening = true;
        ctx.on('mode', onMode);
        ctx.on('pointerdown', (c, at) => {
          for (const g of gulls) if (Math.hypot(at.x - g.x, at.y - g.y) < 120) startle(g, g.x - at.x, g.y - at.y);
        });
      }
    },
    update,
    draw,
  });

  function onMode(ctx) {
    if (ctx.mode === 'done' && !ctx.reduced) {
      flare = 1;
      for (let i = 0; i < 24; i++) motes.push(newMote(ctx));
    }
    if (ctx.mode === 'busy') for (const g of gulls) startle(g, rand(-1, 1), -1);
  }
}
