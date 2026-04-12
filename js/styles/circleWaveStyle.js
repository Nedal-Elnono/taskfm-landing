/**
 * circleWaveStyle.js — Circle + Wave Composition
 *
 * STRUCTURE (adapted from dialed.gg/sound):
 *   N independent horizontal strands, each an oscillator with its own phase.
 *   Dual-frequency sine per strand (primary + slow modulator), plus a
 *   spatial-temporal breathing envelope that creates wave-packet pulsing.
 *   Gaussian amplitude envelope: center strands are full-amplitude,
 *   edge strands taper to near-zero — matching the reference's visual density.
 *
 * MOUSE INTERACTION:
 *   Per-point Gaussian influence in X from cursor position.
 *   Influence magnitude: mouseStrength (lerped externally, 0 when cursor outside).
 *   responseSoftness controls Gaussian sharpness (low=tight, high=diffuse).
 *   Recovery is handled by the caller lerping mouseStrength to 0.
 *
 * TWO-PASS RENDERING:
 *   Pass 1: All strands, blur(18px), thick stroke → atmospheric glow
 *   Pass 2: All strands, no blur, thin stroke (1.1px) → crisp detail
 *
 * SVG EXPORT (toSVG):
 *   Generates real editable SVG with <path> elements using identical
 *   bezier math as the canvas draw path. No rasterization. Illustrator-ready.
 *
 * COLOR:
 *   colorHue  → wave strands
 *   accentHue → circle stroke (independent, default red)
 */

export class CircleWaveStyle {
  constructor() {
    // Visual
    this.colorHue     = 0.116;   // 42° = gold
    this.accentHue    = 0.0;     // 0°  = red (circle stroke)
    this.circleWeight = 0.35;
    this.waveCount    = 12;
    this.glowStrength = 0.65;
    this.waveScale    = 0.72;

    // Mouse interaction — set externally by the animation loop
    this.mouseX            = 0;
    this.mouseY            = 0;
    this.mouseStrength     = 0;    // 0..1, lerped by caller
    this.interactionRadius = 0.25; // fraction of R → σ
    this.responseSoftness  = 0.5;  // 0=sharp gaussian, 1=diffuse

    // Tension / anger state — 0 = calm, 1 = rage
    // Set externally every frame by the anger accumulation system.
    this.tension      = 0;
    this.edgeReaction = 0.6;   // circle edge vibration strength at full tension
    this.waveTension  = 0.7;   // wave frequency / speed boost at full tension

    // Scroll-only speech speed — drives the traveling breathing envelope.
    // Set externally to motionDriver.currentSpeed when scroll mode is active,
    // 0 otherwise. Hover must NOT set this — that's what keeps them separated.
    this.scrollSpeed  = 0;

    // Light-mode flag: when true, strands render dark (source-over + low lightness)
    // Circle border is unaffected and stays at its accent hue.
    this.darkStrands  = false;
  }

  get id()         { return 'circle-wave'; }
  get label()      { return 'Circle Wave'; }
  get category()   { return 'composed'; }
  get defaultGeo() { return 'linear'; }

  get controls() {
    return [
      { id: 'colorHue',     label: 'Wave Color',  min: 0,   max: 1,  step: 0.005, defaultVal: 0.116, fmt: fDeg  },
      { id: 'accentHue',    label: 'Accent',      min: 0,   max: 1,  step: 0.005, defaultVal: 0.0,   fmt: fDeg  },
      { id: 'circleWeight', label: 'Circle Wt',   min: 0,   max: 1,  step: 0.01,  defaultVal: 0.35,  fmt: f2    },
      { id: 'waveCount',    label: 'Strands',     min: 4,   max: 20, step: 1,     defaultVal: 12,    fmt: fRound },
      { id: 'glowStrength', label: 'Glow',        min: 0,   max: 1,  step: 0.01,  defaultVal: 0.65,  fmt: f2    },
      { id: 'waveScale',    label: 'Wave Reach',  min: 0.2, max: 1,  step: 0.01,  defaultVal: 0.72,  fmt: f2    },
    ];
  }

  setParam(id, v) {
    this[id] = id === 'waveCount' ? Math.round(+v) : +v;
  }

  // ── Shared scene params (used by draw + toSVG) ───────────────────────────────

  _sceneParams(W, H, ls, mood) {
    const cx = W / 2;
    const cy = H / 2;
    const R  = Math.min(W, H) * 0.38;

    // Tension modifies wave character: stretch (flatten + widen), NOT speech-like acceleration.
    // Lower freq  = wider wave periods = "pulled horizontally" look.
    // Lower amp   = flatter waves = compressed under pressure.
    // Speed stays the same — no narration / speech acceleration.
    const t  = Math.max(0, Math.min(1, this.tension ?? 0));
    const wt = (this.waveTension ?? 0.7) * t;

    const ampMax = (ls?.amplitude ?? 1.0) * (mood?.amplitudeMultiplier ?? 1.0)
                 * R * this.waveScale * (1 - wt * 0.62);  // strong flatten — waves compress
    const freq   = (ls?.frequency  ?? 3)  * (1 - wt * 0.28);  // lower → stretched periods
    const mSpeed = (mood?.speed    ?? 1.0);                    // wave oscillation (always on)
    // breathSpeed drives the traveling amplitude envelope — the "speech" feel.
    // ONLY set from scroll. Hover must not contribute here.
    const breathSpeed = this.scrollSpeed ?? 0;
    const N      = Math.min(20, Math.max(4, this.waveCount));
    const GOLDEN = Math.PI * 1.6180339;
    const DRIVE  = 2.4;

    const softClamp = (raw, limit) => {
      if (limit <= 0) return 0;
      return limit * Math.tanh((raw / limit) * DRIVE);
    };

    const strandData = [];
    for (let li = 0; li < N; li++) {
      const norm     = N === 1 ? 0 : (2 * li / (N - 1)) - 1;
      const yBase    = norm * R * 0.88;
      const envelope = Math.exp(-norm * norm * 2.8);
      const phase    = li * GOLDEN;
      strandData.push({ norm, yBase, envelope, phase });
    }

    return { cx, cy, R, ampMax, freq, mSpeed, breathSpeed, N, softClamp, strandData };
  }

  // ── Build point array for one strand ─────────────────────────────────────────

  _buildPts(sd, STEPS, scene, time) {
    const { cx, cy, R, ampMax, freq, mSpeed, breathSpeed, softClamp } = scene;
    const { yBase, phase, norm } = sd;

    // Tension state (read from instance, consistent with _sceneParams)
    const t = Math.max(0, Math.min(1, this.tension ?? 0));

    // Tension-aware Gaussian envelope:
    // Calm  → exp = 2.8 (center-heavy, Gaussian shape)
    // Angry → exp = 1.9 (wider, more uniform → all strands visible = "stretched" look)
    const envExp  = 2.8 - t * 0.9;
    const envelope = Math.exp(-norm * norm * envExp);

    // Mouse influence params (read from instance)
    const mStr    = this.mouseStrength ?? 0;
    const sigma   = Math.max(1, (this.interactionRadius ?? 0.25) * R);
    const mX      = this.mouseX ?? cx;
    const mY      = this.mouseY ?? cy;
    const mDY     = mY - cy;
    // softPow: low softness → high exponent → tighter gaussian; high → wider
    const softPow = Math.max(0.15, 2.2 - (this.responseSoftness ?? 0.5) * 1.8);

    // Phase glitch (controlled instability at high tension, NOT per-pixel noise).
    // Smooth sine at high frequency — elegant tremor, not chaotic random.
    // Starts at tension 0.60, max at 1.0. Per-strand (phase-seeded) for organic feel.
    const glitchT    = Math.max(0, (t - 0.60) / 0.40);
    const phaseGlitch = glitchT * 0.24 * (
      Math.sin(time * 38.7 + phase * 2.1) * 0.65 +
      Math.sin(time * 71.3 + phase * 1.4) * 0.35
    );

    const pts = [];

    for (let i = 0; i <= STEPS; i++) {
      const t_     = i / STEPS;
      const x      = (cx - R) + t_ * (R * 2);
      const dx     = x - cx;
      const availY = Math.sqrt(Math.max(0, R * R - dx * dx)) * 0.97;

      // Dual-frequency oscillation (with glitch phase added)
      const ph = phase + phaseGlitch;
      const w1 = Math.sin(freq * Math.PI * 2 * t_         + time * mSpeed * 0.40 + ph);
      const w2 = Math.sin(freq * Math.PI * 2 * t_ * 0.618 + time * mSpeed * 0.22 + ph * 0.5 + 1.0) * 0.55;
      const rawNorm = (w1 + w2) / 1.55;

      // Breathing: compressed under tension — removes speech-like pulsing.
      // At full anger, range → 0.16 (near-uniform). At calm, range = 0.65 (expressive).
      // breathSpeed (scroll-only) drives the traveling term — when 0, the envelope is
      // spatially frozen (ambient/idle). Only scroll makes it travel → speech feel.
      const breathRange = 0.65 * (1 - t * 0.75);
      const breathe = (0.35 + breathRange) + breathRange * (Math.pow(
        Math.max(0, 0.5 + 0.5 * Math.sin(t_ * Math.PI * 3.2 + time * breathSpeed * 0.15 + norm * 0.38)),
        1.4
      ) - 0.5);

      const strandAmp = ampMax * envelope * Math.max(0.1, breathe);

      // Mouse influence — computed before wave to allow amplitude boost
      let mInfluence = 0;
      if (mStr > 0.001 && sigma > 0) {
        const dxm  = x - mX;
        mInfluence = Math.pow(
          Math.max(0, Math.exp(-dxm * dxm / (2 * sigma * sigma))),
          softPow
        ) * mStr;
      }

      // Local amplitude boost near cursor: always visible regardless of mouse Y.
      // Waves swell larger near the cursor, creating clear visible reaction.
      const localAmp  = strandAmp * (1 + mInfluence * 0.55);
      let   totalRaw  = yBase + rawNorm * localAmp;

      // Directional push toward cursor Y: adds bending when cursor is off-center.
      totalRaw += mInfluence * (mDY / R) * R * 0.42 * envelope;

      const constrained = softClamp(totalRaw, availY);
      pts.push({ x, y: cy + constrained });
    }

    return pts;
  }

  // ── Canvas draw ───────────────────────────────────────────────────────────────

  draw(ctx, ls, mood, geoMode, W, H, time) {
    const scene = this._sceneParams(W, H, ls, mood);
    const { cx, cy, R, N, strandData } = scene;

    // Anger color shift: lerp base hues → red (0°) as tension rises
    const t   = Math.max(0, Math.min(1, this.tension ?? 0));
    const h   = Math.round(_lerp(this.colorHue * 360, 4, t));
    const ha  = Math.round(_lerp((this.accentHue ?? this.colorHue) * 360, 0, t));
    // Saturation increases slightly with tension for more intensity
    const sat = Math.round(85 + t * 10);
    const col = (hue, l, a = 1) => `hsla(${hue},${sat}%,${l}%,${a})`;

    const STEPS_G = 100;
    const STEPS_C = 300;

    // Clip ALL wave content inside the circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.97, 0, Math.PI * 2);
    ctx.clip();

    // ── PASS 1: Glow ────────────────────────────────────────────────────────────
    if (this.glowStrength > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = this.darkStrands ? 'source-over' : 'screen';
      ctx.filter  = 'blur(18px)';
      ctx.lineCap = 'round';

      for (let li = 0; li < N; li++) {
        const sd  = strandData[li];
        const pts = this._buildPts(sd, STEPS_G, scene, time);
        ctx.globalAlpha = sd.envelope * 0.18 * this.glowStrength;
        ctx.strokeStyle = this.darkStrands ? col(h, 18) : col(h, 72);
        ctx.lineWidth   = 5;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) * 0.5;
          const my = (pts[i].y + pts[i + 1].y) * 0.5;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── PASS 2: Crisp ───────────────────────────────────────────────────────────
    {
      ctx.save();
      ctx.globalCompositeOperation = this.darkStrands ? 'source-over' : 'screen';
      ctx.lineCap = 'round';

      for (let li = 0; li < N; li++) {
        const sd  = strandData[li];
        const pts = this._buildPts(sd, STEPS_C, scene, time);
        ctx.globalAlpha = sd.envelope * 0.88;
        ctx.strokeStyle = this.darkStrands ? col(h, 22) : col(h, 75);
        ctx.lineWidth   = 1.1;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) * 0.5;
          const my = (pts[i].y + pts[i + 1].y) * 0.5;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore(); // end clip — circle drawn clean below

    // ── Circle border — outside clip, tension-reactive ─────────────────────────
    // Circle shake: nervous vibration of the ring itself at high tension.
    // Waves stay at the original (cx, cy) — only the ring center shifts.
    // Quadratic onset from tension=0.35 → feels natural, not sudden.
    // Incommensurate frequencies → aperiodic, never loops into a regular pattern.
    const shakeT   = Math.max(0, (t - 0.35) / 0.65);
    const shakeAmp = shakeT * shakeT * 2.8;  // max ~2.8px at full rage
    const sX = shakeAmp * (
      Math.sin(time * 27.3) * 0.60 +
      Math.sin(time * 41.7) * 0.30 +
      Math.sin(time * 67.1) * 0.10
    );
    const sY = shakeAmp * (
      Math.sin(time * 31.9) * 0.50 +
      Math.sin(time * 53.3) * 0.35 +
      Math.sin(time * 79.7) * 0.15
    );

    const cw = 0.5 + this.circleWeight * 2.4;
    ctx.save();
    ctx.globalAlpha = 0.90;
    ctx.strokeStyle = col(ha, 68);
    ctx.lineWidth   = cw;
    this._drawReactiveCircle(ctx, cx + sX, cy + sY, R, time, t);
    ctx.stroke();
    ctx.restore();
  }

  // ── Tension-reactive circle path ─────────────────────────────────────────────
  //
  // At tension=0: perfect circle (180-segment polygon ≈ arc).
  // At tension>0: subtle multi-harmonic vibration near cursor and globally.
  // The form stays recognizably circular — contained emotional pressure, not chaos.

  _drawReactiveCircle(ctx, cx, cy, R, time, tension) {
    const edgeStr = (this.edgeReaction ?? 0.6) * tension;
    const sigma   = R * 0.55;              // spread of cursor influence along edge
    const mX      = this.mouseX ?? cx;
    const mY      = this.mouseY ?? cy;
    const vibAmp  = R * 0.024 * edgeStr;  // max vibration in pixels

    const SEGS = 180;
    ctx.beginPath();

    for (let i = 0; i <= SEGS; i++) {
      const angle = (i / SEGS) * Math.PI * 2;
      const ex    = cx + R * Math.cos(angle);
      const ey    = cy + R * Math.sin(angle);

      // Cursor-proximity influence: strongest nearest the cursor
      const dxm       = ex - mX;
      const dym       = ey - mY;
      const cursorI   = Math.exp(-(dxm * dxm + dym * dym) / (2 * sigma * sigma));

      // Global influence: whole circle vibrates at high tension
      const globalI   = tension * 0.28;
      const totalI    = Math.min(1, cursorI + globalI);

      // Multi-harmonic vibration — controlled, organic, not chaotic
      const vib = vibAmp * totalI * (
        Math.sin(angle * 4  + time * 8.2)  * 1.00 +
        Math.sin(angle * 7  + time * 13.5) * 0.38 +
        Math.sin(angle * 11 + time * 19.8) * 0.14
      );

      const r = R + vib;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);

      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // ── SVG export — true vector, Illustrator-ready ───────────────────────────────

  toSVG(W, H, ls, mood, time, bgColor = '#0b0b0b') {
    const scene = this._sceneParams(W, H, ls, mood);
    const { cx, cy, R, strandData } = scene;

    const h   = Math.round(this.colorHue * 360);
    const ha  = Math.round((this.accentHue ?? this.colorHue) * 360);
    const col = (hue, l, a = 1) => `hsla(${hue},85%,${l}%,${a.toFixed(3)})`;

    // Round to 1 decimal for compact but precise paths
    const p = n => Math.round(n * 10) / 10;

    // Convert point array → SVG path d attribute (quadratic bezier smoothing,
    // identical algorithm to the canvas draw path)
    const ptsToD = (pts) => {
      let d = `M${p(pts[0].x)} ${p(pts[0].y)}`;
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) * 0.5;
        const my = (pts[i].y + pts[i + 1].y) * 0.5;
        d += ` Q${p(pts[i].x)} ${p(pts[i].y)} ${p(mx)} ${p(my)}`;
      }
      return d;
    };

    // High-resolution snapshot (more steps = smoother curves in Illustrator)
    const STEPS = 500;

    let glowPaths  = '';
    let crispPaths = '';

    for (const sd of strandData) {
      const pts = this._buildPts(sd, STEPS, scene, time);
      const d   = ptsToD(pts);

      if (this.glowStrength > 0.02) {
        const op = (sd.envelope * 0.25 * this.glowStrength).toFixed(3);
        glowPaths += `    <path d="${d}"\n`
                   + `          stroke="${col(h, 72)}" stroke-width="5"\n`
                   + `          fill="none" opacity="${op}" stroke-linecap="round"/>\n`;
      }

      const op2 = (sd.envelope * 0.88).toFixed(3);
      crispPaths += `    <path d="${d}"\n`
                 + `          stroke="${col(h, 75)}" stroke-width="1.1"\n`
                 + `          fill="none" opacity="${op2}" stroke-linecap="round"/>\n`;
    }

    const cw     = (0.5 + this.circleWeight * 2.4).toFixed(2);
    const clipR  = (R * 0.97).toFixed(1);
    const cxf    = cx.toFixed(1);
    const cyf    = cy.toFixed(1);
    const Rf     = R.toFixed(1);

    return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Circle Wave — TASK-FM
  Generated by TASK-FM Waveform Identity Engine
  Open and edit in Adobe Illustrator or any SVG editor.

  Layer structure:
    #background  → fill rect
    #wave-glow   → blurred atmospheric strands (glow pass)
    #wave-crisp  → fine detail strands (crisp pass)
    #circle-ring → outer circle stroke
-->
<svg xmlns="http://www.w3.org/2000/svg"
     width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">

  <title>Circle Wave — TASK-FM</title>

  <defs>
    <!-- Clip: all wave content stays inside this circle -->
    <clipPath id="wave-clip">
      <circle cx="${cxf}" cy="${cyf}" r="${clipR}"/>
    </clipPath>

    <!-- Glow blur filter (editable as Gaussian blur in Illustrator) -->
    <filter id="strand-glow" x="-60%" y="-60%" width="220%" height="220%"
            color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="18" result="blur"/>
    </filter>
  </defs>

  <!-- Background -->
  <rect id="background" width="${W}" height="${H}" fill="${bgColor}"/>

  <!-- Wave content — clipped to circle interior -->
  <g id="wave-content" clip-path="url(#wave-clip)">

    <!-- Glow layer: blurred, atmospheric.
         Each <path> is an independent editable strand. -->
    <g id="wave-glow"
       filter="url(#strand-glow)"
       style="mix-blend-mode:screen">
${glowPaths}    </g>

    <!-- Crisp layer: fine detail strands.
         These are the primary editable wave paths. -->
    <g id="wave-crisp"
       style="mix-blend-mode:screen">
${crispPaths}    </g>

  </g>

  <!-- Circle border — clean stroke, outside the wave clip -->
  <circle id="circle-ring"
          cx="${cxf}" cy="${cyf}" r="${Rf}"
          stroke="${col(ha, 68)}" stroke-width="${cw}"
          fill="none" opacity="0.9"/>

</svg>`;
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

const _lerp  = (a, b, t) => a + (b - a) * t;
const f2     = v => (+v).toFixed(2);
const fRound = v => String(Math.round(v));
const fDeg   = v => Math.round(+v * 360) + '°';
