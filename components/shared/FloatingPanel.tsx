"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  adoptWidth,
  clampGeo,
  clampSheet,
  initialGeo,
  parseSaved,
  sheetMax,
  sheetShouldMinimise,
  toSaved,
  type PanelGeo,
  type Viewport,
} from "@/utils/floatingGeometry";

/**
 * A non-blocking window for the action forms (New booking, Translate, Email
 * guest, …). The forms used to cover the whole app with a dark overlay that
 * closed — and wiped — them on any click outside. Now the rest of the app stays
 * usable while a form is open:
 *
 *  - Desktop: drag by the title bar, resize from the bottom-right corner,
 *    minimise to a chip at the bottom-left. Each form remembers where it was left.
 *  - Mobile: a bottom sheet — drag the title bar to make it taller/shorter, or
 *    down to tuck it into a chip.
 *
 * Minimising only hides the window — the form stays mounted, so nothing typed
 * is lost. Only ✕ / the form's own Cancel closes it. Several can be open at once.
 *
 * All windows live in one layer above the reservation drawer (z-50) and below
 * the drawer's own confirm dialogs (z-[60]).
 */

const LAYER_Z = 55;
const STORAGE_PREFIX = "bh.floating.";
const FOCUS_EVENT = "floating-panel:focus";
const MOBILE_QUERY = "(max-width: 639px)";

// ─── Shared layer + stacking ────────────────────────────────────────────────

let layer: { root: HTMLElement; dock: HTMLElement } | null = null;

function getLayer() {
  if (layer && document.body.contains(layer.root)) return layer;
  const root = document.createElement("div");
  root.setAttribute("data-floating-layer", "");
  root.style.cssText = `position:fixed;inset:0;z-index:${LAYER_Z};pointer-events:none;`;
  // Chips of minimised windows. Below the windows, so a chip never covers a form's buttons.
  const dock = document.createElement("div");
  dock.style.cssText =
    "position:absolute;left:12px;right:12px;bottom:12px;z-index:0;display:flex;flex-wrap:wrap-reverse;gap:8px;align-items:flex-end;pointer-events:none;";
  root.appendChild(dock);
  document.body.appendChild(root);
  layer = { root, dock };
  return layer;
}

let topZ = 1;
/** Open windows per form, so a second one of the same form opens offset. */
const openCount = new Map<string, number>();
/** Open windows in total — a form with no remembered spot opens offset from the others. */
let openTotal = 0;

/** Restore (if minimised) and raise the window with this id — e.g. when its pill is clicked again. */
export function focusFloatingPanel(id: string) {
  window.dispatchEvent(new CustomEvent<string>(FOCUS_EVENT, { detail: id }));
}

const noopSubscribe = () => () => {};

function subscribeMobile(cb: () => void) {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(() =>
    typeof window === "undefined" ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight },
  );
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return vp;
}

function readSaved(key: string) {
  try {
    return parseSaved(window.localStorage.getItem(STORAGE_PREFIX + key));
  } catch {
    return null;
  }
}

function writeSaved(key: string, g: PanelGeo) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(toSaved(g)));
  } catch {
    // private mode / quota — position just isn't remembered
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

type Drag =
  | { kind: "move"; sx: number; sy: number; g: PanelGeo }
  | { kind: "resize"; sx: number; sy: number; g: PanelGeo; h0: number }
  | { kind: "sheet"; sy: number; h0: number };

export default function FloatingPanel({
  id,
  title,
  subtitle,
  icon,
  chipLabel,
  headerClassName = "",
  width = 448,
  onClose,
  children,
}: {
  /** "translate", "email:BH-123", … The part before ":" is the form — its position is remembered per form. */
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Text on the minimised chip. Defaults to the title when that's a string. */
  chipLabel?: string;
  /** Extra classes for the title bar, e.g. a tint. */
  headerClassName?: string;
  /** Preferred desktop width in px (the old max-w-*). */
  width?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const formKey = id.split(":")[0];
  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const isMobile = useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
  const vp = useViewport();

  const [geo, setGeo] = useState<PanelGeo>(() => {
    const saved = typeof window === "undefined" ? null : readSaved(formKey);
    return initialGeo(width, vp, saved, saved ? (openCount.get(formKey) ?? 0) : openTotal);
  });
  const [sheetH, setSheetH] = useState(() => sheetMax(vp));
  const [minimized, setMinimized] = useState(false);
  const [z, setZ] = useState(() => ++topZ);
  const drag = useRef<Drag | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    openCount.set(formKey, (openCount.get(formKey) ?? 0) + 1);
    openTotal += 1;
    return () => {
      openTotal -= 1;
      const n = (openCount.get(formKey) ?? 1) - 1;
      if (n > 0) openCount.set(formKey, n);
      else openCount.delete(formKey);
    };
  }, [formKey]);

  // Screen resized / rotated, or the form wants another width (email preview).
  const [lastVp, setLastVp] = useState(vp);
  const [lastWidth, setLastWidth] = useState(width);
  if (lastVp !== vp || lastWidth !== width) {
    setLastVp(vp);
    setLastWidth(width);
    setGeo((g) => clampGeo(adoptWidth(g, width, vp), vp));
    setSheetH((h) => clampSheet(h, vp));
  }

  const bringToFront = () => {
    if (z !== topZ) setZ(++topZ);
  };

  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return;
      setMinimized(false);
      setZ(++topZ);
    };
    window.addEventListener(FOCUS_EVENT, on);
    return () => window.removeEventListener(FOCUS_EVENT, on);
  }, [id]);

  // ── Pointer handling (title bar drag, corner resize, sheet height) ──
  const startDrag = (e: ReactPointerEvent<HTMLElement>, kind: "move" | "resize") => {
    if (e.button !== 0) return;
    if (kind === "move" && (e.target as HTMLElement).closest("button, a, input, select, textarea, [data-no-drag]")) return;
    bringToFront();
    if (isMobile) {
      drag.current = { kind: "sheet", sy: e.clientY, h0: sheetH };
    } else if (kind === "move") {
      drag.current = { kind: "move", sx: e.clientX, sy: e.clientY, g: geo };
    } else {
      drag.current = { kind: "resize", sx: e.clientX, sy: e.clientY, g: geo, h0: geo.h ?? cardRef.current?.offsetHeight ?? 400 };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  // Sheet height is free while dragging (down to a sliver) so a pull-down can read as "minimise".
  const sheetFor = (d: Extract<Drag, { kind: "sheet" }>, e: ReactPointerEvent) =>
    Math.max(64, Math.min(d.h0 - (e.clientY - d.sy), sheetMax(vp)));
  const geoFor = (d: Exclude<Drag, { kind: "sheet" }>, e: ReactPointerEvent) =>
    d.kind === "move"
      ? clampGeo({ ...d.g, x: d.g.x + e.clientX - d.sx, y: d.g.y + e.clientY - d.sy }, vp)
      : clampGeo({ ...d.g, w: d.g.w + e.clientX - d.sx, h: d.h0 + e.clientY - d.sy, sized: true }, vp);

  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "sheet") setSheetH(sheetFor(d, e));
    else setGeo(geoFor(d, e));
  };

  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.kind === "sheet") {
      const h = sheetFor(d, e);
      if (sheetShouldMinimise(h, vp)) {
        setMinimized(true);
        setSheetH(clampSheet(d.h0, vp)); // reopen at the height it had
      } else {
        setSheetH(clampSheet(h, vp));
      }
      return;
    }
    const final = geoFor(d, e);
    setGeo(final);
    writeSaved(formKey, final);
  };

  const dragHandlers = {
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };

  if (!isClient) return null;
  const host = getLayer();

  const restore = () => {
    setMinimized(false);
    setZ(++topZ);
  };

  const label = chipLabel ?? (typeof title === "string" ? title : "Form");

  const cardStyle: CSSProperties = isMobile
    ? { left: 0, right: 0, bottom: 0, height: sheetH, zIndex: z }
    : {
        left: geo.x,
        top: geo.y,
        width: geo.w,
        ...(geo.h != null ? { height: geo.h } : { maxHeight: vp.h - geo.y - 12 }),
        zIndex: z,
      };

  return (
    <>
      {createPortal(
        <div
          ref={cardRef}
          role="dialog"
          aria-label={label}
          onPointerDownCapture={bringToFront}
          style={{ ...cardStyle, display: minimized ? "none" : undefined }}
          className={`absolute pointer-events-auto flex flex-col bg-white shadow-2xl ring-1 ring-black/10 overflow-hidden ${
            isMobile ? "rounded-t-2xl" : "rounded-2xl"
          }`}
        >
          {/* Title bar — drag handle */}
          <div
            onPointerDown={(e) => startDrag(e, "move")}
            {...dragHandlers}
            style={{ touchAction: "none" }}
            className={`relative shrink-0 flex items-center gap-2 px-5 border-b border-gray-100 select-none cursor-move ${
              isMobile ? "pt-4 pb-3" : "py-3"
            } ${headerClassName}`}
            title={isMobile ? "Drag to resize · pull down to minimise" : "Drag to move"}
          >
            {isMobile && (
              <span className="absolute left-1/2 top-1.5 -translate-x-1/2 h-1 w-10 rounded-full bg-gray-300" />
            )}
            {icon}
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-gray-900 truncate">{title}</h2>
              {subtitle && <div className="text-[11px] text-gray-500 mt-0.5">{subtitle}</div>}
            </div>
            <button
              type="button"
              onClick={() => setMinimized(true)}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-black/5 transition-colors"
              title="Minimise — keeps what you typed"
              aria-label="Minimise"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-black/5 transition-colors"
              title="Close"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Body. A flex column so a form with its own scroll area + footer keeps the footer in view. */}
          <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">{children}</div>

          {/* Resize grip (desktop) */}
          {!isMobile && (
            <div
              onPointerDown={(e) => startDrag(e, "resize")}
              {...dragHandlers}
              style={{ touchAction: "none" }}
              className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize text-gray-300 hover:text-gray-500"
              title="Drag to resize"
            >
              <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="M14 6L6 14M14 10l-4 4" strokeLinecap="round" />
              </svg>
            </div>
          )}
        </div>,
        host.root,
      )}

      {minimized &&
        createPortal(
          <div className="pointer-events-auto flex items-center gap-1 max-w-[18rem] rounded-full bg-white shadow-lg ring-1 ring-black/10 pl-3 pr-1 py-1">
            <button
              type="button"
              onClick={restore}
              className="min-w-0 truncate text-xs font-medium text-gray-700 hover:text-indigo-600"
              title={`Reopen ${label}`}
            >
              {label}
            </button>
            <button
              type="button"
              onClick={restore}
              className="p-1 rounded-full text-gray-400 hover:text-indigo-600 hover:bg-gray-100"
              aria-label={`Reopen ${label}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-full text-gray-400 hover:text-red-600 hover:bg-gray-100"
              aria-label={`Close ${label}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>,
          host.dock,
        )}
    </>
  );
}
