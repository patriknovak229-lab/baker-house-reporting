/**
 * Position + size maths for the floating action forms (components/shared/FloatingPanel).
 * Pure so it can be tested without a DOM.
 */

export type Viewport = { w: number; h: number };

/** Desktop window geometry. `h: null` = as tall as its content (up to the screen). */
export type PanelGeo = {
  x: number;
  y: number;
  w: number;
  h: number | null;
  /** The operator resized it — keep their size instead of the form's preferred width. */
  sized: boolean;
};

/** What's remembered per form in localStorage. Size only once the operator resized it. */
export type SavedGeo = { x: number; y: number; w?: number; h?: number };

export const MARGIN = 12;
export const MIN_W = 320;
export const MIN_H = 180;
/** How much of the title bar must stay on screen so the window can be grabbed back. */
const KEEP_VISIBLE_X = 120;
const KEEP_VISIBLE_Y = 48;
/** Each extra window of the same form opens this much further down-right. */
export const CASCADE = 24;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Keep the window grabbable: never wider than the screen, title bar always reachable. */
export function clampGeo(g: PanelGeo, vp: Viewport): PanelGeo {
  const w = clamp(g.w, Math.min(MIN_W, vp.w - 2 * MARGIN), vp.w - 2 * MARGIN);
  const x = clamp(g.x, KEEP_VISIBLE_X - w, vp.w - KEEP_VISIBLE_X);
  const y = clamp(g.y, MARGIN, vp.h - KEEP_VISIBLE_Y);
  const h = g.h == null ? null : clamp(g.h, MIN_H, vp.h - y - MARGIN);
  return { x, y, w, h, sized: g.sized };
}

/** Where a form opens: where it was last left, else centred near the top. */
export function initialGeo(
  preferredWidth: number,
  vp: Viewport,
  saved: SavedGeo | null,
  cascadeIndex: number,
): PanelGeo {
  const offset = cascadeIndex * CASCADE;
  const sized = saved?.w != null;
  const w = Math.min(sized ? saved!.w! : preferredWidth, vp.w - 2 * MARGIN);
  const x = (saved ? saved.x : Math.round((vp.w - w) / 2)) + offset;
  const y = (saved ? saved.y : Math.round(Math.max(MARGIN, vp.h * 0.06))) + offset;
  return clampGeo({ x, y, w, h: sized && saved?.h != null ? saved.h : null, sized }, vp);
}

/** The form asked for a different width (e.g. the email preview step) — follow it
 *  unless the operator sized the window themselves; grow around the centre. */
export function adoptWidth(g: PanelGeo, preferredWidth: number, vp: Viewport): PanelGeo {
  if (g.sized || g.w === preferredWidth) return g;
  return clampGeo({ ...g, w: preferredWidth, x: Math.round(g.x - (preferredWidth - g.w) / 2) }, vp);
}

export function toSaved(g: PanelGeo): SavedGeo {
  return g.sized && g.h != null ? { x: g.x, y: g.y, w: g.w, h: g.h } : { x: g.x, y: g.y };
}

export function parseSaved(raw: string | null): SavedGeo | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SavedGeo>;
    if (typeof v.x !== "number" || typeof v.y !== "number") return null;
    return {
      x: v.x,
      y: v.y,
      ...(typeof v.w === "number" && typeof v.h === "number" ? { w: v.w, h: v.h } : {}),
    };
  } catch {
    return null;
  }
}

// ─── Mobile bottom sheet ────────────────────────────────────────────────────

/** Gap left above a full-height sheet, so it reads as a sheet over the app. */
export const SHEET_TOP_GAP = 48;
export const SHEET_MIN = 160;

export function sheetMax(vp: Viewport): number {
  return vp.h - SHEET_TOP_GAP;
}

export function clampSheet(height: number, vp: Viewport): number {
  return clamp(height, Math.min(SHEET_MIN, sheetMax(vp)), sheetMax(vp));
}

/** Dragged the sheet below this → it tucks away into a bar. */
export function sheetShouldMinimise(dragHeight: number, vp: Viewport): boolean {
  return dragHeight < vp.h * 0.22;
}
