import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  corridorAttenuation,
  effectiveBackdropPreset,
  ensureBackdropImageLoaded,
  isProceduralBackdropPreset,
  resolveBackdropRgb,
  useBackdropSnapshot,
  type ChatBackdropPreset,
  type RgbTriplet,
} from "@/features/settings/backdrop";
import { cx } from "@/utils/cx";

const FRAME_STEP_MS = 32; // ~30fps ceiling to keep typing and streaming headroom ample.
const STATIC_PHASE = 1.15;
const PARALLAX_FACTOR = 0.065;

const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

const CAN_DRAW_CANVAS = () =>
  typeof navigator === "undefined" ||
  !/jsdom/i.test(navigator.userAgent) ||
  Boolean(
    typeof HTMLCanvasElement !== "undefined" &&
      (HTMLCanvasElement.prototype.getContext as unknown as { mock?: unknown })?.mock,
  );

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function positiveMod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

function rgba([r, g, b]: RgbTriplet, a: number): string {
  return `rgba(${r},${g},${b},${clamp(a, 0, 1).toFixed(3)})`;
}

function mixRgba(c1: RgbTriplet, c2: RgbTriplet, t: number, a: number): string {
  const k = clamp(t, 0, 1);
  const r = Math.round(lerp(c1[0], c2[0], k));
  const g = Math.round(lerp(c1[1], c2[1], k));
  const b = Math.round(lerp(c1[2], c2[2], k));
  return `rgba(${r},${g},${b},${clamp(a, 0, 1).toFixed(3)})`;
}

function isTimelineScrollTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.hasAttribute("data-backdrop-scroll-source") ||
    Boolean(target.firstElementChild?.hasAttribute("data-sentinel"))
  );
}

function findTimelineScroller(scope: HTMLElement | null): HTMLElement | null {
  if (!scope) return null;
  return (
    scope.querySelector<HTMLElement>("[data-backdrop-scroll-source]") ??
    scope.querySelector<HTMLElement>("[data-sentinel]")?.parentElement ??
    null
  );
}

interface DrawParams {
  width: number;
  height: number;
  phase: number;
  scrollY: number;
  baseAlpha: number;
  scaleNorm: number;
  scrim: number;
  preview: boolean;
  isDark: boolean;
  primary: RgbTriplet;
  secondary: RgbTriplet;
}

interface RectBucket {
  fillStyle: string;
  rects: number[];
}

function flushRectBuckets(ctx: CanvasRenderingContext2D, buckets: RectBucket[]): void {
  for (let i = 0; i < buckets.length; i += 1) {
    const rects = buckets[i].rects;
    if (rects.length === 0) continue;
    ctx.fillStyle = buckets[i].fillStyle;
    ctx.beginPath();
    for (let j = 0; j < rects.length; j += 4) {
      ctx.rect(rects[j], rects[j + 1], rects[j + 2], rects[j + 3]);
    }
    ctx.fill();
  }
}

/** Smooth horizontal corridor gradient stroke so horizontal grid/contour/silk lines
 *  fade gracefully behind the centered message column. */
function makeCorridorGradient(
  ctx: CanvasRenderingContext2D,
  params: DrawParams,
  rgb: RgbTriplet,
  alphaScale: number,
  colorShiftRgb?: RgbTriplet,
): CanvasGradient {
  const grad = ctx.createLinearGradient(0, 0, params.width, 0);
  const stops = 10;
  for (let i = 0; i <= stops; i += 1) {
    const t = i / stops;
    const x = t * params.width;
    const att = corridorAttenuation(x, params.width, params.scrim, params.preview);
    const tone = colorShiftRgb
      ? mixRgba(rgb, colorShiftRgb, t, params.baseAlpha * alphaScale * att)
      : rgba(rgb, params.baseAlpha * alphaScale * att);
    grad.addColorStop(t, tone);
  }
  return grad;
}

function drawPixelWave(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, baseAlpha, scaleNorm, scrim, preview, primary, secondary } =
    params;
  const step = Math.round(lerp(28, 15, scaleNorm) * (preview ? 0.78 : 1));
  const baseSize = lerp(3.4, 5.4, scaleNorm) * (preview ? 0.85 : 1);
  const halfW = width * 0.5;
  const halfH = height * 0.52 + Math.sin(scrollY * 0.004) * 36;
  const firstRow = Math.floor((scrollY - step * 0.5) / step);

  for (let gx = step * 0.5; gx < width; gx += step) {
    const att = corridorAttenuation(gx, width, scrim, preview);
    if (att <= 0.02) continue;
    for (let row = firstRow; ; row += 1) {
      const gy = (row + 0.5) * step - scrollY;
      if (gy >= height + step) break;
      const wy = (row + 0.5) * step;
      const w1 = Math.sin(gx * 0.011 - wy * 0.0085 - phase * 1.35);
      const w2 = Math.sin(gx * 0.0065 + wy * 0.013 - phase * 0.9 + 1.4);
      const w3 = Math.cos(Math.hypot(gx - halfW, gy - halfH) * 0.014 - phase * 1.1);
      const combined = w1 * 0.48 + w2 * 0.32 + w3 * 0.2;
      const crest = clamp((combined + 1) * 0.5, 0, 1);
      const ridge = Math.pow(crest, 1.75);
      const alpha = baseAlpha * (0.28 + 1.05 * ridge) * att;
      if (alpha < 0.012) continue;

      const size = Math.max(1.5, baseSize * (0.38 + 0.72 * ridge));
      const dx = w2 * 0.5 * (preview ? 2.5 : 4.5);
      const dy = -(crest - 0.5) * (preview ? 5 : 9);
      const py = Math.round((gy + dy - size * 0.5) * 2) / 2;
      if (py + size < 0 || py > height) continue;
      const px = Math.round((gx + dx - size * 0.5) * 2) / 2;

      if (ridge > 0.72) {
        ctx.fillStyle = rgba(secondary, alpha * 0.22);
        ctx.fillRect(px - 1, py - 1, size + 2, size + 2);
      }
      ctx.fillStyle = mixRgba(primary, secondary, ridge, alpha);
      ctx.fillRect(px, py, size, size);
    }
  }
}

function drawBayerDither(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, baseAlpha, scaleNorm, scrim, preview, primary, secondary } =
    params;
  const step = Math.round(lerp(13, 7, scaleNorm) * (preview ? 0.85 : 1));
  const dot = Math.max(2, Math.round(step * 0.46));
  const halfDot = dot * 0.5;
  const halfW = width * 0.5;
  const firstRow = Math.floor(scrollY / step);

  const buckets: RectBucket[] = [
    { fillStyle: rgba(primary, baseAlpha * 0.26), rects: [] },
    { fillStyle: mixRgba(primary, secondary, 0.28, baseAlpha * 0.5), rects: [] },
    { fillStyle: mixRgba(primary, secondary, 0.6, baseAlpha * 0.78), rects: [] },
    { fillStyle: rgba(secondary, baseAlpha * 1.04), rects: [] },
  ];

  for (let col = 0, gx = step * 0.5; gx < width; col += 1, gx += step) {
    const att = corridorAttenuation(gx, width, scrim, preview);
    if (att <= 0.02) continue;
    const bRowModBase = positiveMod(col, 4);
    const corridorBoost = 0.28 + 0.72 * att;
    const px = Math.round(gx - halfDot);

    for (let row = firstRow; ; row += 1) {
      const gy = (row + 0.5) * step - scrollY;
      if (gy >= height + step) break;
      const py = Math.round(gy - halfDot);
      if (py + dot < 0 || py > height) continue;

      const wy = (row + 0.5) * step;
      const w1 = Math.sin(gx * 0.0085 - wy * 0.0065 - phase * 1.15);
      const w2 = Math.cos(gx * 0.0055 + wy * 0.0095 + phase * 0.85);
      const w3 = Math.sin((gx - halfW) * 0.006 + Math.cos(wy * 0.005) * 1.4 - phase * 0.7);
      const raw = clamp((w1 * 0.48 + w2 * 0.34 + w3 * 0.18 + 1) * 0.5, 0, 1);
      const density = clamp(Math.pow(raw, 1.12) * corridorBoost, 0, 1);

      const threshold = (BAYER_4X4[positiveMod(row, 4)][bRowModBase] + 0.5) / 16;
      if (density <= threshold) continue;

      const strength = clamp((density - threshold) * 1.9, 0, 1) * (0.38 + 0.62 * att);
      const bIdx = Math.min(3, Math.floor(strength * 4));
      buckets[bIdx].rects.push(px, py, dot, dot);
    }
  }

  flushRectBuckets(ctx, buckets);
}

function drawFlickeringGrid(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, baseAlpha, scaleNorm, scrim, preview, primary, secondary } =
    params;
  const step = Math.round(lerp(22, 13, scaleNorm) * (preview ? 0.82 : 1));
  const box = Math.max(2, lerp(3.4, 5.8, scaleNorm) * (preview ? 0.85 : 1));
  const halfBox = box * 0.5;
  const firstRow = Math.floor(scrollY / step);

  const buckets: RectBucket[] = [
    { fillStyle: rgba(primary, baseAlpha * 0.16), rects: [] },
    { fillStyle: rgba(primary, baseAlpha * 0.32), rects: [] },
    { fillStyle: mixRgba(primary, secondary, 0.3, baseAlpha * 0.52), rects: [] },
    { fillStyle: mixRgba(primary, secondary, 0.55, baseAlpha * 0.74), rects: [] },
    { fillStyle: mixRgba(primary, secondary, 0.8, baseAlpha * 0.94), rects: [] },
    { fillStyle: rgba(secondary, baseAlpha * 1.12), rects: [] },
  ];

  for (let col = 0, gx = step * 0.5; gx < width; col += 1, gx += step) {
    const att = corridorAttenuation(gx, width, scrim, preview);
    if (att <= 0.02) continue;
    const px = Math.round((gx - halfBox) * 2) / 2;

    for (let row = firstRow; ; row += 1) {
      const gy = (row + 0.5) * step - scrollY;
      if (gy >= height + step) break;
      const py = Math.round((gy - halfBox) * 2) / 2;
      if (py + box < 0 || py > height) continue;

      const seed1 = fract(Math.sin(col * 12.9898 + row * 78.233) * 43758.5453);
      const seed2 = fract(Math.cos(col * 39.346 + row * 11.135) * 24634.6345);
      const twinkle = 0.5 + 0.5 * Math.sin(phase * (0.7 + seed1 * 0.9) + seed2 * Math.PI * 2);
      const ripple = 0.5 + 0.5 * Math.sin(col * 0.24 - row * 0.18 - phase * 0.85);
      const level = twinkle * 0.68 + ripple * 0.32;
      const strength = clamp(level * att, 0, 1);
      if (strength < 0.08) continue;

      const bIdx = Math.min(buckets.length - 1, Math.floor(((strength - 0.08) / 0.92) * buckets.length));
      buckets[bIdx].rects.push(px, py, box, box);
    }
  }

  flushRectBuckets(ctx, buckets);
}

function drawSilkRibbons(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, scaleNorm, preview, primary, secondary } = params;
  const ribbonCount = Math.round(lerp(13, 22, scaleNorm) * (preview ? 0.72 : 1));
  const segments = preview ? 24 : 42;

  const strokes = [
    { stroke: makeCorridorGradient(ctx, params, primary, 0.22, secondary), lineWidth: 0.9 },
    { stroke: makeCorridorGradient(ctx, params, primary, 0.38, secondary), lineWidth: 1.05 },
    { stroke: makeCorridorGradient(ctx, params, secondary, 0.54, primary), lineWidth: 1.2 },
  ];

  const scrollDrift = Math.sin(scrollY * 0.0045) * 0.06;

  for (let tier = 0; tier < strokes.length; tier += 1) {
    ctx.strokeStyle = strokes[tier].stroke;
    ctx.lineWidth = strokes[tier].lineWidth;
    ctx.beginPath();

    for (let i = 0; i < ribbonCount; i += 1) {
      const u = ribbonCount > 1 ? (i / (ribbonCount - 1)) * 2 - 1 : 0;
      const absU = Math.abs(u);
      const ribbonTier = absU <= 0.3 ? 2 : absU <= 0.68 ? 1 : 0;
      if (ribbonTier !== tier) continue;

      for (let s = 0; s <= segments; s += 1) {
        const t = s / segments;
        const x = t * width;
        const spine =
          height *
          (0.5 +
            scrollDrift +
            0.12 * Math.sin(t * 4.2 - phase * 0.8 + scrollY * 0.0025) +
            0.07 * Math.cos(t * 2.5 + phase * 0.55));
        const pinch =
          0.32 +
          0.68 * Math.pow(0.5 + 0.5 * Math.sin(t * 3.1 + phase * 0.95 + i * 0.14), 1.4);
        const fold =
          Math.sin(t * 6.0 + i * 0.45 - phase * 1.1) * (preview ? 8 : 18) * (1 - absU * 0.35);
        const y = spine + u * height * 0.42 * pinch + fold;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  }
}

function drawKomorebi(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, baseAlpha, scaleNorm, scrim, preview, isDark, primary, secondary } =
    params;
  const beamPositions = [0.06, 0.2, 0.48, 0.76, 0.92];
  const beamScale = baseAlpha * (isDark ? 0.34 : 0.28);

  for (let i = 0; i < beamPositions.length; i += 1) {
    const bp = beamPositions[i];
    const xTop =
      (bp + Math.sin(phase * 0.3 + i * 1.2) * 0.025) * width +
      Math.sin(scrollY * 0.002 + i) * (preview ? 6 : 14);
    const slant = width * 0.13 + Math.cos(phase * 0.25 + i) * (preview ? 8 : 18);
    const wTop = lerp(48, 96, scaleNorm) * (preview ? 0.45 : 1) * (0.8 + (i % 3) * 0.22);
    const wBot = wTop * 1.65;
    const att = corridorAttenuation(xTop + slant * 0.4, width, scrim, preview);
    const peak = beamScale * att;
    if (peak < 0.006) continue;

    const rgb = i % 2 === 0 ? primary : secondary;
    const grad = ctx.createLinearGradient(xTop, 0, xTop + slant, height);
    grad.addColorStop(0, rgba(rgb, 0));
    grad.addColorStop(0.32, rgba(rgb, peak));
    grad.addColorStop(0.76, rgba(rgb, peak * 0.65));
    grad.addColorStop(1, rgba(rgb, 0));

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(xTop - wTop * 0.5, 0);
    ctx.lineTo(xTop + wTop * 0.5, 0);
    ctx.lineTo(xTop + slant + wBot * 0.5, height);
    ctx.lineTo(xTop + slant - wBot * 0.5, height);
    ctx.closePath();
    ctx.fill();
  }

  const bokehCount = Math.round(lerp(10, 18, scaleNorm) * (preview ? 0.65 : 1));
  const bokehScale = baseAlpha * (isDark ? 0.42 : 0.36);
  const edgeSpan = preview ? 18 : 48;

  for (let i = 0; i < bokehCount; i += 1) {
    const hx = fract(0.61803398875 * (i + 1) + 0.09);
    const hy = fract(0.38196601125 * (i + 1) + 0.31);
    const cx = hx * width + Math.sin(phase * 0.32 + i * 1.7) * (preview ? 10 : 24);
    const cy = positiveMod(
      hy * height - scrollY * 0.8 + Math.cos(phase * 0.28 + i * 1.3) * (preview ? 8 : 20),
      height,
    );
    const edgeFade = clamp(Math.min(cy, height - cy) / edgeSpan, 0, 1);
    const att = corridorAttenuation(cx, width, scrim, preview);
    const spotAlpha = bokehScale * att * edgeFade;
    if (spotAlpha < 0.008) continue;

    const r = Math.max(
      14,
      lerp(38, 86, scaleNorm) * (preview ? 0.42 : 1) * (0.7 + 0.5 * fract(i * 0.71)),
    );
    const rgb = i % 3 === 0 ? primary : secondary;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, rgba(rgb, spotAlpha));
    grad.addColorStop(0.5, rgba(rgb, spotAlpha * 0.4));
    grad.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
}

function drawSwissCross(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, baseAlpha, scaleNorm, scrim, preview, primary, secondary } =
    params;
  const step = Math.round(lerp(46, 28, scaleNorm) * (preview ? 0.76 : 1));
  const firstRow = Math.floor((scrollY - step * 0.5) / step);

  const crossBatches: { strokeStyle: string; segs: number[] }[] = [
    { strokeStyle: rgba(primary, baseAlpha * 0.24), segs: [] },
    { strokeStyle: rgba(primary, baseAlpha * 0.46), segs: [] },
    { strokeStyle: rgba(primary, baseAlpha * 0.72), segs: [] },
    { strokeStyle: rgba(secondary, baseAlpha * 1.02), segs: [] },
  ];
  const dotBuckets: RectBucket[] = [
    { fillStyle: rgba(primary, baseAlpha * 0.22), rects: [] },
    { fillStyle: rgba(primary, baseAlpha * 0.52), rects: [] },
  ];

  for (let gx = step * 0.5; gx < width; gx += step) {
    const att = corridorAttenuation(gx, width, scrim, preview);
    if (att <= 0.02) continue;
    const px = Math.round(gx) + 0.5;
    const midX = Math.round(gx + step * 0.5) - 0.75;
    const midAtt = corridorAttenuation(gx + step * 0.5, width, scrim, preview);
    const dotBucketIdx = midAtt > 0.6 ? 1 : 0;

    for (let row = firstRow; ; row += 1) {
      const gy = (row + 0.5) * step - scrollY;
      if (gy >= height + step) break;
      const py = Math.round(gy) + 0.5;
      if (py + 5 < 0 || py - 5 > height) continue;

      const wy = (row + 0.5) * step;
      const crest = Math.pow(
        clamp((Math.sin(gx * 0.007 + wy * 0.005 - phase * 0.95) + 1) * 0.5, 0, 1),
        2.2,
      );
      const isHighlight = crest > 0.58 && att > 0.45;
      const arm = isHighlight ? 4 : 2.5;
      const batchIdx = isHighlight ? 3 : att < 0.35 ? 0 : att < 0.72 ? 1 : 2;
      crossBatches[batchIdx].segs.push(px, py, arm);

      const midY = Math.round(gy + step * 0.5) - 0.75;
      if (midX < width && midY >= 0 && midY < height && midAtt > 0.04) {
        dotBuckets[dotBucketIdx].rects.push(midX, midY, 1.5, 1.5);
      }
    }
  }

  ctx.lineWidth = 1;
  for (let i = 0; i < crossBatches.length; i += 1) {
    const { strokeStyle, segs } = crossBatches[i];
    if (segs.length === 0) continue;
    ctx.strokeStyle = strokeStyle;
    ctx.beginPath();
    for (let j = 0; j < segs.length; j += 3) {
      const x = segs[j];
      const y = segs[j + 1];
      const arm = segs[j + 2];
      ctx.moveTo(x - arm, y);
      ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm);
      ctx.lineTo(x, y + arm);
    }
    ctx.stroke();
  }

  flushRectBuckets(ctx, dotBuckets);
}

function drawBlueprintGrid(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, baseAlpha, scaleNorm, scrim, preview, primary, secondary } =
    params;
  const step = Math.round(lerp(44, 22, scaleNorm) * (preview ? 0.75 : 1));
  const majorEvery = 4;
  const firstRow = Math.floor((scrollY - step * 0.5) / step);

  // Vertical grid lines (individual column attenuation)
  let col = 0;
  for (let x = step * 0.5; x < width; x += step, col += 1) {
    const att = corridorAttenuation(x, width, scrim, preview);
    const isMajor = col % majorEvery === 0;
    ctx.strokeStyle = rgba(primary, baseAlpha * (isMajor ? 0.62 : 0.26) * att);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const px = Math.round(x) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
  }

  // Horizontal grid lines (smooth gradient across corridor)
  const minorRowStroke = makeCorridorGradient(ctx, params, primary, 0.26);
  const majorRowStroke = makeCorridorGradient(ctx, params, primary, 0.58);
  for (let row = firstRow; ; row += 1) {
    const y = (row + 0.5) * step - scrollY;
    if (y >= height + step) break;
    if (y < -1) continue;
    const isMajor = positiveMod(row, majorEvery) === 0;
    ctx.strokeStyle = isMajor ? majorRowStroke : minorRowStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const py = Math.round(y) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(width, py);
    ctx.stroke();
  }

  // Major crosshairs and diagonal scan wave pulses
  col = 0;
  for (let x = step * 0.5; x < width; x += step, col += 1) {
    if (col % majorEvery !== 0) continue;
    const att = corridorAttenuation(x, width, scrim, preview);
    if (att <= 0.02) continue;
    for (let row = firstRow; ; row += 1) {
      if (positiveMod(row, majorEvery) !== 0) continue;
      const y = (row + 0.5) * step - scrollY;
      if (y >= height + step) break;
      if (y < -4) continue;
      const wy = (row + 0.5) * step;
      const pulse = Math.pow(
        Math.max(0, Math.sin((x + wy) * 0.008 - phase * 1.4)),
        6,
      );
      const px = Math.round(x) + 0.5;
      const py = Math.round(y) + 0.5;
      ctx.strokeStyle = mixRgba(primary, secondary, pulse, baseAlpha * (0.75 + 0.6 * pulse) * att);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px - 3, py);
      ctx.lineTo(px + 3, py);
      ctx.moveTo(px, py - 3);
      ctx.lineTo(px, py + 3);
      ctx.stroke();

      if (pulse > 0.2) {
        const box = 2.5 + pulse * 2.5;
        ctx.fillStyle = rgba(secondary, baseAlpha * 0.85 * pulse * att);
        ctx.fillRect(px - box * 0.5, py - box * 0.5, box, box);
      }
    }
  }
}

function drawDotConstellation(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, baseAlpha, scaleNorm, scrim, preview, primary, secondary } =
    params;
  const densityDiv = lerp(22000, 9500, scaleNorm) * (preview ? 0.5 : 1);
  const count = clamp(Math.round((width * height) / densityDiv), 18, 84);
  const maxDist = lerp(138, 92, scaleNorm) * (preview ? 0.72 : 1);
  const edgeSpan = preview ? Math.min(20, height * 0.18) : 28;

  const nodes: { x: number; y: number; att: number; size: number; accentMix: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    // Low-discrepancy golden-ratio sequence keeps particle coverage balanced.
    const hx = fract(0.61803398875 * (i + 1) + 0.13);
    const hy = fract(0.38196601125 * (i + 1) + 0.27);
    const rx = (preview ? 10 : 22) * (0.4 + fract(i * 0.73) * 0.6);
    const ry = (preview ? 8 : 18) * (0.4 + fract(i * 0.59) * 0.6);
    const fx = 0.45 + fract(i * 0.37) * 0.65;
    const fy = 0.4 + fract(i * 0.43) * 0.65;
    const off = i * 1.17;
    const px = hx * width + Math.sin(phase * fx + off) * rx;
    const py = positiveMod(hy * height - scrollY + Math.cos(phase * fy + off * 1.3) * ry, height);
    const edgeFade = clamp(Math.min(py, height - py) / edgeSpan, 0, 1);
    const att = corridorAttenuation(px, width, scrim, preview) * edgeFade;
    const size = lerp(2.6, 4.2, scaleNorm) * (0.7 + 0.45 * fract(i * 0.89)) * (preview ? 0.85 : 1);
    nodes.push({ x: px, y: py, att, size, accentMix: fract(i * 0.53) });
  }

  ctx.lineWidth = 1;
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= maxDist) continue;
      const strength = Math.pow(1 - dist / maxDist, 1.4);
      const lineAlpha = baseAlpha * 0.72 * strength * Math.min(a.att, b.att);
      if (lineAlpha < 0.012) continue;
      ctx.strokeStyle = mixRgba(primary, secondary, (a.accentMix + b.accentMix) * 0.5, lineAlpha);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    const alpha = baseAlpha * 1.15 * n.att;
    if (alpha < 0.015) continue;
    ctx.fillStyle = mixRgba(primary, secondary, n.accentMix, alpha);
    ctx.fillRect(n.x - n.size * 0.5, n.y - n.size * 0.5, n.size, n.size);
    if (i % 6 === 0) {
      ctx.strokeStyle = rgba(secondary, alpha * 0.45);
      ctx.strokeRect(n.x - n.size - 1.5, n.y - n.size - 1.5, n.size * 2 + 3, n.size * 2 + 3);
    }
  }
}

function drawAuroraMesh(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, baseAlpha, scaleNorm, scrim, preview, primary, secondary } =
    params;
  const radiusBase = Math.max(width, height) * lerp(0.32, 0.48, scaleNorm);
  const orbs: {
    bx: number;
    by: number;
    ax: number;
    ay: number;
    fx: number;
    fy: number;
    rScale: number;
    rgb: RgbTriplet;
  }[] = [
    { bx: 0.14, by: 0.24, ax: 0.07, ay: 0.08, fx: 0.45, fy: 0.37, rScale: 1.0, rgb: primary },
    { bx: 0.86, by: 0.28, ax: 0.08, ay: 0.09, fx: 0.39, fy: 0.51, rScale: 0.95, rgb: secondary },
    { bx: 0.18, by: 0.78, ax: 0.07, ay: 0.07, fx: 0.53, fy: 0.33, rScale: 0.9, rgb: secondary },
    { bx: 0.84, by: 0.76, ax: 0.06, ay: 0.08, fx: 0.41, fy: 0.47, rScale: 1.05, rgb: primary },
  ];

  for (let i = 0; i < orbs.length; i += 1) {
    const o = orbs[i];
    const scrollShift = Math.sin(scrollY * 0.0032 + i * 1.7) * 0.045;
    const cx = (o.bx + Math.sin(phase * o.fx + i * 1.4) * o.ax) * width;
    const cy = (o.by + scrollShift + Math.cos(phase * o.fy + i * 2.1) * o.ay) * height;
    const r = Math.max(24, radiusBase * o.rScale);
    const att = corridorAttenuation(cx, width, scrim, preview);
    const peakAlpha = baseAlpha * 0.85 * (0.45 + 0.55 * att);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, rgba(o.rgb, peakAlpha));
    grad.addColorStop(0.55, rgba(o.rgb, peakAlpha * 0.38));
    grad.addColorStop(1, rgba(o.rgb, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }
}

function drawTopographic(ctx: CanvasRenderingContext2D, params: DrawParams): void {
  const { width, height, phase, scrollY, scaleNorm, primary, secondary } = params;
  const cell = Math.round(lerp(26, 15, scaleNorm) * (params.preview ? 0.8 : 1));
  const cols = Math.max(2, Math.ceil(width / cell));
  const rows = Math.max(2, Math.ceil(height / cell));
  const stride = cols + 1;
  const field = new Float32Array((cols + 1) * (rows + 1));

  const halfW = width * 0.5;
  const halfH = height * 0.5 + Math.sin(scrollY * 0.0028) * 60;
  for (let r = 0; r <= rows; r += 1) {
    const y = r * cell;
    const wy = y + scrollY;
    for (let c = 0; c <= cols; c += 1) {
      const x = c * cell;
      const v =
        Math.sin(x * 0.0085 + phase * 0.7) * Math.cos(wy * 0.0095 - phase * 0.55) +
        0.55 * Math.sin((x - wy) * 0.006 + phase * 0.85) +
        0.35 * Math.cos(Math.hypot(x - halfW, y - halfH) * 0.011 - phase);
      field[r * stride + c] = v;
    }
  }

  const levels = [-0.55, -0.18, 0.18, 0.55];
  for (let li = 0; li < levels.length; li += 1) {
    const level = levels[li];
    const major = li === 1 || li === 2;
    ctx.strokeStyle = makeCorridorGradient(
      ctx,
      params,
      major ? primary : secondary,
      major ? 0.75 : 0.45,
      secondary,
    );
    ctx.lineWidth = major ? 1.2 : 0.9;
    ctx.beginPath();

    for (let r = 0; r < rows; r += 1) {
      const y = r * cell;
      for (let c = 0; c < cols; c += 1) {
        const x = c * cell;
        const v00 = field[r * stride + c];
        const v10 = field[r * stride + c + 1];
        const v11 = field[(r + 1) * stride + c + 1];
        const v01 = field[(r + 1) * stride + c];

        const pts: [number, number][] = [];
        if ((v00 < level) !== (v10 < level)) {
          const t = (level - v00) / (v10 - v00 || 1e-6);
          pts.push([x + t * cell, y]);
        }
        if ((v10 < level) !== (v11 < level)) {
          const t = (level - v10) / (v11 - v10 || 1e-6);
          pts.push([x + cell, y + t * cell]);
        }
        if ((v11 < level) !== (v01 < level)) {
          const t = (level - v01) / (v11 - v01 || 1e-6);
          pts.push([x + t * cell, y + cell]);
        }
        if ((v01 < level) !== (v00 < level)) {
          const t = (level - v00) / (v01 - v00 || 1e-6);
          pts.push([x, y + t * cell]);
        }

        if (pts.length >= 2) {
          ctx.moveTo(pts[0][0], pts[0][1]);
          ctx.lineTo(pts[1][0], pts[1][1]);
          if (pts.length === 4) {
            ctx.moveTo(pts[2][0], pts[2][1]);
            ctx.lineTo(pts[3][0], pts[3][1]);
          }
        }
      }
    }
    ctx.stroke();
  }
}

function renderPreset(
  ctx: CanvasRenderingContext2D,
  preset: ChatBackdropPreset,
  params: DrawParams,
): void {
  if (preset === "pixel-wave") drawPixelWave(ctx, params);
  else if (preset === "bayer-dither") drawBayerDither(ctx, params);
  else if (preset === "flickering-grid") drawFlickeringGrid(ctx, params);
  else if (preset === "silk-ribbons") drawSilkRibbons(ctx, params);
  else if (preset === "komorebi") drawKomorebi(ctx, params);
  else if (preset === "swiss-cross") drawSwissCross(ctx, params);
  else if (preset === "blueprint-grid") drawBlueprintGrid(ctx, params);
  else if (preset === "dot-constellation") drawDotConstellation(ctx, params);
  else if (preset === "aurora-mesh") drawAuroraMesh(ctx, params);
  else if (preset === "topographic") drawTopographic(ctx, params);
}

/**
 * Ambient backdrop mounted behind the active conversation timeline/composer.
 * Isolates itself via CSS `-z-10` under an isolated parent column, throttles
 * to <= 30fps, pauses whenever inactive/hidden/reduced-motion, supports
 * zero-reflow passive scroll parallax, and applies readability protection so
 * foreground text remains sharp.
 */
export const ConversationBackdrop = memo(function ConversationBackdrop({
  preview = false,
  className,
}: {
  preview?: boolean;
  className?: string;
}) {
  const { backdrop, themeRevision } = useBackdropSnapshot();
  const preset = effectiveBackdropPreset(backdrop);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageLayerRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef(STATIC_PHASE);
  const scrollTopRef = useRef(0);
  const [customImageUrl, setCustomImageUrl] = useState("");

  const { isDark, primaryRgb, secondaryRgb } = useMemo(() => {
    const dark =
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark");
    const accent =
      typeof document !== "undefined" ? document.documentElement.dataset.accent : "blue";
    const { primary, secondary } = resolveBackdropRgb(backdrop, accent, dark);
    return { isDark: dark, primaryRgb: primary, secondaryRgb: secondary };
    // themeRevision refreshes accent/dark colors synchronously on Settings changes.
  }, [backdrop, themeRevision]);

  useEffect(() => {
    if (preset !== "custom-image" || !backdrop.imageFile || !CAN_DRAW_CANVAS()) {
      setCustomImageUrl("");
      return;
    }
    let alive = true;
    void ensureBackdropImageLoaded(backdrop.imageFile)
      .then((url) => {
        if (alive) setCustomImageUrl(url);
      })
      .catch(() => {
        if (alive) setCustomImageUrl("");
      });
    return () => {
      alive = false;
    };
  }, [preset, backdrop.imageFile]);

  const isProcedural = isProceduralBackdropPreset(preset);

  useEffect(() => {
    if (!isProcedural || !CAN_DRAW_CANVAS()) return;
    const container = rootRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const motionQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    let rafId = 0;
    let lastDrawAt = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastDpr = 0;
    let disposed = false;
    let scrollDirty = false;

    const parallaxEnabled = (): boolean =>
      !preview && backdrop.parallax && !motionQuery?.matches;

    const shouldBlockRender = (): boolean => {
      if (typeof document !== "undefined" && document.hidden) return true;
      if (!preview) {
        if (
          typeof window !== "undefined" &&
          /^#\/(?:settings|p\/)/i.test(window.location.hash)
        ) {
          return true;
        }
        if (container.closest(".invisible") !== null) {
          return true;
        }
      }
      return false;
    };

    const shouldAnimateTime = (): boolean => {
      if (backdrop.speed <= 0) return false;
      if (motionQuery?.matches) return false;
      return !shouldBlockRender();
    };

    const paintFrame = (now: number, force = false): void => {
      const rect = container.getBoundingClientRect();
      const width = rect.width || container.clientWidth || 0;
      const height = rect.height || container.clientHeight || 0;
      if (width <= 0 || height <= 0) return;

      const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
      if (
        force ||
        Math.abs(width - lastWidth) > 0.5 ||
        Math.abs(height - lastHeight) > 0.5 ||
        dpr !== lastDpr
      ) {
        lastWidth = width;
        lastHeight = height;
        lastDpr = dpr;
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      if (backdrop.speed <= 0 || motionQuery?.matches) {
        phaseRef.current = STATIC_PHASE;
      } else if (lastDrawAt > 0) {
        const dt = Math.min(120, Math.max(0, now - lastDrawAt));
        phaseRef.current += (dt / 1000) * (backdrop.speed / 50) * 0.9;
      }
      lastDrawAt = now;

      const scrollY = parallaxEnabled() ? scrollTopRef.current * PARALLAX_FACTOR : 0;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      renderPreset(ctx, preset, {
        width,
        height,
        phase: phaseRef.current,
        scrollY,
        baseAlpha: (isDark ? 0.3 : 0.32) * (backdrop.opacity / 100),
        scaleNorm: (backdrop.scale - 20) / 80,
        scrim: backdrop.scrim,
        preview,
        isDark,
        primary: primaryRgb,
        secondary: secondaryRgb,
      });
      ctx.restore();
    };

    const tick = (now: number): void => {
      rafId = 0;
      if (disposed || shouldBlockRender()) {
        scrollDirty = false;
        return;
      }
      const animateTime = shouldAnimateTime();
      if (now - lastDrawAt >= FRAME_STEP_MS) {
        scrollDirty = false;
        paintFrame(now);
      }
      if (animateTime || scrollDirty) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const scheduleOrDrawOnce = (force = false): void => {
      if (disposed) return;
      if (force) {
        scrollDirty = false;
        paintFrame(performance.now(), true);
      }
      if (!shouldAnimateTime() && !scrollDirty) {
        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else if (!rafId) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const existingScroller = findTimelineScroller(container.parentElement);
    if (existingScroller) {
      scrollTopRef.current = existingScroller.scrollTop || 0;
    }

    scheduleOrDrawOnce(true);

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => scheduleOrDrawOnce(true))
        : null;
    observer?.observe(container);

    const onStateChange = () => scheduleOrDrawOnce(false);
    document.addEventListener("visibilitychange", onStateChange);
    window.addEventListener("hashchange", onStateChange);
    motionQuery?.addEventListener("change", onStateChange);

    // Passive captured listener reads the active timeline scroller directly into a ref
    // without touching React state; when speed is 0, coalesced rAF redraws once per frame.
    const scope = !preview ? container.parentElement : null;
    const onScroll = (event: Event): void => {
      if (!parallaxEnabled() || !isTimelineScrollTarget(event.target)) return;
      scrollTopRef.current = event.target.scrollTop || 0;
      if (shouldBlockRender()) return;
      if (!shouldAnimateTime()) {
        scrollDirty = true;
        if (!rafId) {
          rafId = window.requestAnimationFrame(tick);
        }
      }
    };
    if (scope && backdrop.parallax) {
      scope.addEventListener("scroll", onScroll, { capture: true, passive: true });
    }

    // Observe `.invisible` toggle on parent surfaces in ChatCenterPane.
    let attrObserver: MutationObserver | null = null;
    if (!preview && typeof MutationObserver !== "undefined") {
      attrObserver = new MutationObserver(onStateChange);
      let node: HTMLElement | null = container.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1) {
        attrObserver.observe(node, { attributes: true, attributeFilter: ["class"] });
        node = node.parentElement;
      }
    }

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      observer?.disconnect();
      attrObserver?.disconnect();
      document.removeEventListener("visibilitychange", onStateChange);
      window.removeEventListener("hashchange", onStateChange);
      motionQuery?.removeEventListener("change", onStateChange);
      scope?.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [
    backdrop.opacity,
    backdrop.parallax,
    backdrop.scale,
    backdrop.scrim,
    backdrop.speed,
    isDark,
    isProcedural,
    preset,
    preview,
    primaryRgb,
    secondaryRgb,
  ]);

  // Passive scroll parallax for custom local wallpapers (`custom-image`).
  useEffect(() => {
    if (preview || preset !== "custom-image" || !customImageUrl) return;
    const container = rootRef.current;
    const imgEl = imageLayerRef.current;
    if (!container || !imgEl) return;

    const motionQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    const parallaxOn = (): boolean => backdrop.parallax && !motionQuery?.matches;

    const applyImageTransform = (): void => {
      const scrollTop = parallaxOn() ? scrollTopRef.current : 0;
      if (backdrop.fit === "repeat") {
        imgEl.style.backgroundPosition = `center ${-Math.round(scrollTop * 0.12)}px`;
        imgEl.style.transform = backdrop.blur > 0 ? "scale(1.06)" : "";
        return;
      }
      imgEl.style.backgroundPosition = "center";
      if (parallaxOn() && backdrop.fit !== "contain") {
        const shiftY = -Math.atan(scrollTop / 1400) * 14;
        const scale = backdrop.blur > 0 ? 1.11 : 1.07;
        imgEl.style.transform = `translate3d(0, ${shiftY.toFixed(1)}px, 0) scale(${scale})`;
      } else if (parallaxOn() && backdrop.fit === "contain") {
        const shiftY = -Math.atan(scrollTop / 1400) * 8;
        imgEl.style.transform =
          backdrop.blur > 0
            ? `translate3d(0, ${shiftY.toFixed(1)}px, 0) scale(1.06)`
            : `translate3d(0, ${shiftY.toFixed(1)}px, 0)`;
      } else {
        imgEl.style.transform = backdrop.blur > 0 ? "scale(1.06)" : "";
      }
    };

    const existing = findTimelineScroller(container.parentElement);
    if (existing) {
      scrollTopRef.current = existing.scrollTop || 0;
    }
    applyImageTransform();

    if (!parallaxOn()) return;
    const scope = container.parentElement;
    if (!scope) return;

    let rafId = 0;
    const onScroll = (event: Event): void => {
      if (!isTimelineScrollTarget(event.target)) return;
      scrollTopRef.current = event.target.scrollTop || 0;
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        applyImageTransform();
      });
    };

    scope.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const onMotionChange = () => applyImageTransform();
    motionQuery?.addEventListener("change", onMotionChange);

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      scope.removeEventListener("scroll", onScroll, { capture: true });
      motionQuery?.removeEventListener("change", onMotionChange);
    };
  }, [backdrop.blur, backdrop.fit, backdrop.parallax, customImageUrl, preset, preview]);

  if (preset === "none") return null;

  const corridorPct =
    preset === "custom-image"
      ? Math.round(backdrop.scrim * 0.92)
      : Math.round(backdrop.scrim * 0.45);
  const globalImageVeilPct = Math.round(26 + backdrop.scrim * 0.44);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      data-conversation-backdrop={preset}
      className={cx(
        "pointer-events-none absolute inset-0 overflow-hidden select-none",
        preview ? "z-0" : "-z-10",
        className,
      )}
    >
      {isProcedural && (
        <canvas ref={canvasRef} className="block h-full w-full" />
      )}
      {preset === "custom-image" && customImageUrl && (
        <>
          <div
            ref={imageLayerRef}
            data-backdrop-layer="custom-image"
            className="pointer-events-none absolute inset-0 transition-opacity duration-200"
            style={{
              backgroundImage: `url("${customImageUrl}")`,
              backgroundSize:
                backdrop.fit === "contain"
                  ? "contain"
                  : backdrop.fit === "repeat"
                    ? "auto"
                    : "cover",
              backgroundRepeat: backdrop.fit === "repeat" ? "repeat" : "no-repeat",
              backgroundPosition: "center",
              opacity: Math.max(0.1, backdrop.opacity / 100),
              filter: backdrop.blur > 0 ? `blur(${backdrop.blur}px)` : undefined,
              transform: backdrop.blur > 0 ? "scale(1.06)" : undefined,
            }}
          />
          <div
            data-backdrop-layer="image-polarity-veil"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundColor: `color-mix(in srgb, var(--color-background-primary-default) ${globalImageVeilPct}%, transparent)`,
            }}
          />
        </>
      )}
      {corridorPct > 0 && (
        <div
          data-backdrop-layer="corridor-veil"
          className="pointer-events-none absolute inset-0"
          style={{
            background: `linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--color-background-primary-default) ${corridorPct}%, transparent) 22%, color-mix(in srgb, var(--color-background-primary-default) ${corridorPct}%, transparent) 78%, transparent 100%)`,
          }}
        />
      )}
    </div>
  );
});
