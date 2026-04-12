/**
 * CircleWaveModel.js — TASK-FM Circle Wave · Production Embeddable Module
 *
 * Drop-in interactive component. No dashboard. No UI. Just the model + API.
 *
 * ── Quick start ───────────────────────────────────────────────────────────────
 *
 *   import { CircleWaveModel } from './CircleWaveModel.js';
 *
 *   const model = new CircleWaveModel(document.getElementById('wave-container'));
 *
 *   window.addEventListener('scroll', () => {
 *     const p = window.scrollY / (document.body.scrollHeight - window.innerHeight);
 *     model.setScrollProgress(p);
 *   });
 *
 * ── Public API ────────────────────────────────────────────────────────────────
 *
 *   model.setScrollProgress(0..1)      drive scroll-linked motion + speech
 *   model.setScrollVelocity(delta)     inject velocity directly (scroll libs)
 *   model.triggerEmotion(amount)       add tension directly (0..1 delta)
 *   model.resetEmotion()               reset tension to calm
 *   model.setTheme('dark'|'light')     switch background theme
 *   model.setAccentColor(hue)          circle accent hue (0..1)
 *   model.setWaveColor(hue)            wave strand hue (0..1)
 *   model.setWaveParams(params)        update visual params (see below)
 *   model.enableInteraction()          allow mouse hover interaction
 *   model.disableInteraction()         disable mouse hover interaction
 *   model.destroy()                    stop loop + clean up all resources
 *
 *   model.tension           (get)      current tension 0..1
 *   model.scrollProgress    (get)      current scroll position 0..1
 *   model.emotionalState    (get)      'CALM'|'ALERT'|'IRRITATED'|'ANGRY'|'RAGE'
 *
 * ── setWaveParams keys ────────────────────────────────────────────────────────
 *
 *   waveCount      4..20  number of wave strands
 *   waveScale      0..1   wave amplitude reach inside circle
 *   glowStrength   0..1   atmospheric blur glow intensity
 *   circleWeight   0..1   circle border thickness
 */

import { CircleWaveStyle } from './styles/circleWaveStyle.js'; // tick-landing copy

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  // Theme
  theme: 'dark',
  transparent: false,   // when true: clearRect instead of fillRect (transparent bg)

  // Visual
  colorHue:     0.11,
  accentHue:    0.11,
  circleWeight: 0.6,
  waveCount:    9,
  glowStrength: 0.1,
  waveScale:    0.23,

  // Motion — scroll-mapped ranges
  scrollSpeedMin: 0.10,
  scrollSpeedMax: 1.20,
  scrollAmpMin:   0.50,
  scrollAmpMax:   2.00,
  baseFreq:       3.0,
  breathDepth:    1.95,   // 1 = no breathing, higher = more depth

  // Mouse interaction
  interactionEnabled: true,
  interactStrength:   1.0,
  interactRadius:     0.72,
  interactRecovery:   0.175,
  interactSoftness:   1.0,

  // Emotion system
  buildupRate:    0.12,
  cooldownRate:   0.185,
  aggressionMult: 0.80,
  edgeReaction:   1.0,
  waveTension:    1.0,
};

// ── Theme palettes ────────────────────────────────────────────────────────────

const THEMES = {
  dark:  { bg: '#080808' },
  light: { bg: '#f0efeb' },
};

// ── State names ───────────────────────────────────────────────────────────────

const STATE_NAMES = ['CALM', 'ALERT', 'IRRITATED', 'ANGRY', 'RAGE'];

function getStateName(t) {
  if (t < 0.18) return STATE_NAMES[0];
  if (t < 0.40) return STATE_NAMES[1];
  if (t < 0.62) return STATE_NAMES[2];
  if (t < 0.82) return STATE_NAMES[3];
  return STATE_NAMES[4];
}

// ── Private lerp helper ───────────────────────────────────────────────────────

const _lerp = (a, b, t) => a + (b - a) * t;

// ── CircleWaveModel ───────────────────────────────────────────────────────────

export class CircleWaveModel {

  /**
   * @param {HTMLElement} container  Element to mount the canvas into.
   *                                 Should have a defined width + height.
   * @param {object}      options    Override any key from DEFAULTS.
   */
  constructor(container, options = {}) {
    this._cfg       = { ...DEFAULTS, ...options };
    this._container = container;

    this._buildCanvas();
    this._initStyle();
    this._initMotionState();
    this._initEmotionState();
    this._initMouseState();
    this._bindMouseEvents();
    this._bindResize();
    this._startLoop();
  }

  // ── Canvas ──────────────────────────────────────────────────────────────────

  _buildCanvas() {
    // Canvas fills the container, DPR-aware for sharp rendering.
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';

    // Container must be a positioned element for canvas to fill correctly.
    if (getComputedStyle(this._container).position === 'static') {
      this._container.style.position = 'relative';
    }

    this._container.appendChild(canvas);
    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');
    this._W      = 0;
    this._H      = 0;
    this._dpr    = window.devicePixelRatio || 1;
    this._syncCanvasSize();
  }

  _syncCanvasSize() {
    const r   = this._container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;

    // Physical pixels
    this._canvas.width  = Math.round(r.width  * dpr);
    this._canvas.height = Math.round(r.height * dpr);

    // CSS size (logical pixels)
    this._canvas.style.width  = r.width  + 'px';
    this._canvas.style.height = r.height + 'px';

    // Scale context so all drawing is in logical pixels
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._W = r.width;
    this._H = r.height;
  }

  _bindResize() {
    this._resizeObserver = new ResizeObserver(() => this._syncCanvasSize());
    this._resizeObserver.observe(this._container);
  }

  // ── Style ───────────────────────────────────────────────────────────────────

  _initStyle() {
    const c = this._cfg;
    const s = new CircleWaveStyle();
    s.colorHue     = c.colorHue;
    s.accentHue    = c.accentHue;
    s.circleWeight = c.circleWeight;
    s.waveCount    = c.waveCount;
    s.glowStrength = c.glowStrength;
    s.waveScale    = c.waveScale;
    s.scrollSpeed  = 0;
    this._style    = s;
    this._theme    = c.theme;
  }

  // ── Motion state ─────────────────────────────────────────────────────────────

  _initMotionState() {
    const c = this._cfg;

    // Live state passed to renderer each frame
    this._ls   = { amplitude: 1.0, frequency: c.baseFreq };
    this._mood = { amplitudeMultiplier: 1.0, speed: c.scrollSpeedMin };

    // Scroll state — controlled externally via setScrollProgress / setScrollVelocity
    this._scroll = {
      progress:     0,
      velocity:     0,   // smoothed normalized velocity
      prevProgress: 0,
    };

    // Scroll-mapped motion ranges
    this._speedMin  = c.scrollSpeedMin;
    this._speedMax  = c.scrollSpeedMax;
    this._ampMin    = c.scrollAmpMin;
    this._ampMax    = c.scrollAmpMax;
    this._freq      = c.baseFreq;
    this._breathDpt = (c.breathDepth - 1) * 0.5;

    // Time
    this._startTs = null;
    this._prevTs  = null;
    this._time    = 0;
  }

  // ── Emotion state ────────────────────────────────────────────────────────────

  _initEmotionState() {
    const c = this._cfg;
    this._anger = {
      tension:        0,
      buildupRate:    c.buildupRate,
      cooldownRate:   c.cooldownRate,
      aggressionMult: c.aggressionMult,
      edgeReaction:   c.edgeReaction,
      waveTension:    c.waveTension,
    };
  }

  // ── Mouse state ──────────────────────────────────────────────────────────────

  _initMouseState() {
    const c = this._cfg;
    this._interact = {
      enabled:  c.interactionEnabled,
      strength: c.interactStrength,
      radius:   c.interactRadius,
      recovery: c.interactRecovery,
      softness: c.interactSoftness,
    };
    this._mouse = {
      rawX: 0, rawY: 0,
      smoothX: 0, smoothY: 0,
      inside: false,
      activeStrength: 0,
      velocity: 0,
      prevX: 0, prevY: 0,
    };
  }

  _bindMouseEvents() {
    this._onMouseMove = (e) => {
      const rect = this._canvas.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const my   = e.clientY - rect.top;
      this._mouse.rawX = mx;
      this._mouse.rawY = my;

      if (!this._interact.enabled) { this._mouse.inside = false; return; }

      const cx = this._W / 2;
      const cy = this._H / 2;
      const R  = Math.min(this._W, this._H) * 0.38;
      const dx = mx - cx, dy = my - cy;
      this._mouse.inside = (dx * dx + dy * dy) <= R * R;
    };

    this._onMouseLeave = () => { this._mouse.inside = false; };

    this._canvas.addEventListener('mousemove',  this._onMouseMove);
    this._canvas.addEventListener('mouseleave', this._onMouseLeave);
  }

  // ── Render loop ───────────────────────────────────────────────────────────────

  _startLoop() {
    this._running = true;
    this._raf     = requestAnimationFrame(ts => this._frame(ts));
  }

  _frame(ts) {
    if (!this._running) return;

    // Time
    if (!this._startTs) this._startTs = ts;
    const dt     = this._prevTs ? Math.min(50, ts - this._prevTs) : 16;
    this._prevTs = ts;
    this._time   = (ts - this._startTs) / 1000;
    const dtSec  = dt / 1000;

    const m  = this._mouse;
    const a  = this._anger;
    const it = this._interact;

    // ── Mouse velocity ─────────────────────────────────────────────────────
    const dvx = m.rawX - m.prevX;
    const dvy = m.rawY - m.prevY;
    m.prevX   = m.rawX;
    m.prevY   = m.rawY;
    m.velocity = _lerp(m.velocity, Math.sqrt(dvx * dvx + dvy * dvy), 0.22);

    // ── Emotion — movement-only, not presence ──────────────────────────────
    // Resting inside the circle with no movement → no buildup.
    // Only active cursor movement inside builds tension.
    const SPEED_REF   = 15;   // px/frame = "moderate" movement
    const MOVE_THRESH = 0.8;  // noise floor
    const movementRate = (it.enabled && m.inside && m.velocity > MOVE_THRESH)
      ? Math.min(2.0, m.velocity / SPEED_REF) * a.buildupRate * a.aggressionMult
      : 0;

    if (movementRate > 0) {
      a.tension = Math.min(1.0, a.tension + movementRate * dtSec);
    } else {
      a.tension = Math.max(0.0, a.tension - a.cooldownRate * dtSec);
    }

    // Push emotion into style
    this._style.tension      = a.tension;
    this._style.edgeReaction = a.edgeReaction;
    this._style.waveTension  = a.waveTension;

    // ── Mouse strength (smooth) ────────────────────────────────────────────
    m.smoothX = _lerp(m.smoothX, m.rawX, 0.11);
    m.smoothY = _lerp(m.smoothY, m.rawY, 0.11);
    const targetStr     = (it.enabled && m.inside) ? it.strength : 0;
    const strengthRate  = m.inside ? 0.18 : it.recovery;
    m.activeStrength    = _lerp(m.activeStrength, targetStr, strengthRate);

    this._style.mouseX            = m.smoothX;
    this._style.mouseY            = m.smoothY;
    this._style.mouseStrength     = m.activeStrength;
    this._style.interactionRadius = it.radius;
    this._style.responseSoftness  = it.softness;

    // ── Motion — scroll-driven ─────────────────────────────────────────────
    const sp    = this._scroll.progress;
    const vel   = this._scroll.velocity;
    const speed = _lerp(this._speedMin, this._speedMax, sp);
    const amp   = _lerp(this._ampMin,   this._ampMax,   sp);

    // Breathing envelope (slow global pulse, independent of scroll)
    const breath = 1 + this._breathDpt * (Math.sin(this._time * 0.4) * 0.5 + 0.5);

    this._ls.amplitude = amp * breath;
    this._ls.frequency = this._freq;
    this._mood.speed   = speed;

    // Speech/narration breathing — ONLY active during scroll movement.
    // Velocity-driven: still scroll → frozen envelope (no speech feel).
    // Actively scrolling → traveling envelope → narration feel.
    const velMag      = Math.abs(vel);
    const speechFactor = Math.min(1, velMag * 80);
    this._style.scrollSpeed = speed * speechFactor;

    // ── Draw ───────────────────────────────────────────────────────────────
    const W  = this._W;
    const H  = this._H;

    if (this._cfg.transparent) {
      this._ctx.clearRect(0, 0, W, H);
    } else {
      const bg = (THEMES[this._theme] ?? THEMES.dark).bg;
      this._ctx.fillStyle = bg;
      this._ctx.fillRect(0, 0, W, H);
    }
    this._style.draw(this._ctx, this._ls, this._mood, 'linear', W, H, this._time);

    this._raf = requestAnimationFrame(ts => this._frame(ts));
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Drive scroll-linked motion and speech behavior.
   * Call from your page scroll handler every frame.
   *
   * @param {number} progress  0 = page top, 1 = page bottom
   */
  setScrollProgress(progress) {
    const p       = Math.max(0, Math.min(1, +progress || 0));
    const raw     = p - this._scroll.prevProgress;
    this._scroll.velocity     = _lerp(this._scroll.velocity, raw, 0.25);
    this._scroll.prevProgress = this._scroll.progress;
    this._scroll.progress     = p;
  }

  /**
   * Inject scroll velocity directly.
   * Use when you have velocity from a scroll library (Lenis, GSAP ScrollTrigger, etc.)
   *
   * @param {number} velocity  Normalized delta, e.g. 0.005 per frame = gentle scroll
   */
  setScrollVelocity(velocity) {
    this._scroll.velocity = +velocity || 0;
  }

  /**
   * Manually add emotional tension.
   * Useful for programmatic effects (e.g. trigger on a section enter).
   *
   * @param {number} amount  Added to current tension, clamped to 0..1
   */
  triggerEmotion(amount) {
    this._anger.tension = Math.min(1.0, this._anger.tension + (+amount || 0));
  }

  /** Reset emotional tension to calm immediately. */
  resetEmotion() {
    this._anger.tension = 0;
  }

  /**
   * Switch the background theme.
   * @param {'dark'|'light'} mode
   */
  setTheme(mode) {
    if (THEMES[mode]) this._theme = mode;
  }

  /**
   * Set the circle accent/border color.
   * @param {number} hue  0..1  (0 = red · 0.11 = gold · 0.33 = green · 0.67 = blue)
   */
  setAccentColor(hue) {
    this._style.accentHue = Math.max(0, Math.min(1, +hue || 0));
  }

  /**
   * Set the wave strand fill color.
   * @param {number} hue  0..1
   */
  setWaveColor(hue) {
    this._style.colorHue = Math.max(0, Math.min(1, +hue || 0));
  }

  /**
   * Toggle dark-strand mode (for light page backgrounds).
   * Strands render dark; circle border keeps its accent hue (yellow).
   * @param {boolean} dark
   */
  setDarkStrands(dark) {
    this._style.darkStrands = !!dark;
  }

  /**
   * Update visual wave parameters.
   *
   * @param {object} params
   * @param {number} [params.waveCount]     4..20
   * @param {number} [params.waveScale]     0..1
   * @param {number} [params.glowStrength]  0..1
   * @param {number} [params.circleWeight]  0..1
   */
  setWaveParams(params = {}) {
    const s = this._style;
    if (params.waveCount    != null) s.waveCount    = Math.round(Math.max(4,   Math.min(20,  +params.waveCount)));
    if (params.waveScale    != null) s.waveScale    = Math.max(0.05, Math.min(1,   +params.waveScale));
    if (params.glowStrength != null) s.glowStrength = Math.max(0,    Math.min(1,   +params.glowStrength));
    if (params.circleWeight != null) s.circleWeight = Math.max(0,    Math.min(1,   +params.circleWeight));
  }

  /**
   * Update scroll motion ranges.
   *
   * @param {object} params
   * @param {number} [params.speedMin]
   * @param {number} [params.speedMax]
   * @param {number} [params.ampMin]
   * @param {number} [params.ampMax]
   */
  setMotionRange(params = {}) {
    if (params.speedMin != null) this._speedMin = +params.speedMin;
    if (params.speedMax != null) this._speedMax = +params.speedMax;
    if (params.ampMin   != null) this._ampMin   = +params.ampMin;
    if (params.ampMax   != null) this._ampMax   = +params.ampMax;
  }

  /** Enable mouse hover / movement interaction. */
  enableInteraction() {
    this._interact.enabled = true;
  }

  /** Disable mouse hover / movement interaction. */
  disableInteraction() {
    this._interact.enabled       = false;
    this._mouse.inside           = false;
    this._mouse.activeStrength   = 0;
  }

  /**
   * Stop the animation loop and remove all event listeners.
   * Call when unmounting (React useEffect cleanup, etc.)
   */
  destroy() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    this._canvas.removeEventListener('mousemove',  this._onMouseMove);
    this._canvas.removeEventListener('mouseleave', this._onMouseLeave);
    this._resizeObserver.disconnect();
    if (this._canvas.parentNode === this._container) {
      this._container.removeChild(this._canvas);
    }
  }

  // ── Read-only state ───────────────────────────────────────────────────────────

  /** Current emotional tension (0 = calm, 1 = rage). */
  get tension()        { return this._anger.tension; }

  /** Current scroll position (0 = top, 1 = bottom). */
  get scrollProgress() { return this._scroll.progress; }

  /** Human-readable emotional state string. */
  get emotionalState() { return getStateName(this._anger.tension); }
}
