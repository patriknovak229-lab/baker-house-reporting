import { describe, it, expect } from "vitest";
import {
  adoptWidth,
  clampGeo,
  clampSheet,
  initialGeo,
  parseSaved,
  sheetShouldMinimise,
  toSaved,
  CASCADE,
  MARGIN,
} from "./floatingGeometry";

const laptop = { w: 1440, h: 900 };
const phone = { w: 390, h: 844 };

describe("initialGeo", () => {
  it("opens centred near the top at the form's width", () => {
    const g = initialGeo(448, laptop, null, 0);
    expect(g).toMatchObject({ x: 496, w: 448, h: null, sized: false });
    expect(g.y).toBe(54);
  });

  it("reopens where it was left", () => {
    expect(initialGeo(448, laptop, { x: 40, y: 100 }, 0)).toMatchObject({ x: 40, y: 100, w: 448, h: null });
  });

  it("keeps a size the operator chose", () => {
    expect(initialGeo(448, laptop, { x: 40, y: 100, w: 700, h: 500 }, 0)).toMatchObject({ w: 700, h: 500, sized: true });
  });

  it("offsets a second window of the same form", () => {
    const a = initialGeo(448, laptop, { x: 40, y: 100 }, 0);
    const b = initialGeo(448, laptop, { x: 40, y: 100 }, 1);
    expect(b.x - a.x).toBe(CASCADE);
    expect(b.y - a.y).toBe(CASCADE);
  });

  it("never opens wider than the screen", () => {
    expect(initialGeo(900, { w: 700, h: 800 }, null, 0).w).toBe(700 - 2 * MARGIN);
  });
});

describe("clampGeo", () => {
  it("keeps part of the title bar on screen when dragged off an edge", () => {
    const g = clampGeo({ x: 5000, y: 5000, w: 448, h: null, sized: false }, laptop);
    expect(g.x).toBeLessThanOrEqual(laptop.w - 120);
    expect(g.y).toBeLessThanOrEqual(laptop.h - 48);
    const top = clampGeo({ x: -5000, y: -50, w: 448, h: null, sized: false }, laptop);
    expect(top.x + top.w).toBeGreaterThanOrEqual(120);
    expect(top.y).toBe(MARGIN);
  });

  it("enforces a minimum size", () => {
    expect(clampGeo({ x: 0, y: 0, w: 50, h: 20, sized: true }, laptop)).toMatchObject({ w: 320, h: 180 });
  });

  it("shrinks a saved window to fit a smaller screen", () => {
    const g = clampGeo({ x: 100, y: 100, w: 1200, h: 800, sized: true }, { w: 800, h: 600 });
    expect(g.w).toBe(800 - 2 * MARGIN);
    expect(g.h).toBe(600 - g.y - MARGIN);
  });
});

describe("adoptWidth", () => {
  it("follows the form's new width and stays centred", () => {
    const g = adoptWidth({ x: 496, y: 54, w: 448, h: null, sized: false }, 896, laptop);
    expect(g.w).toBe(896);
    expect(g.x).toBe(272);
  });

  it("leaves a window the operator resized alone", () => {
    const g = { x: 10, y: 10, w: 500, h: 400, sized: true };
    expect(adoptWidth(g, 896, laptop)).toBe(g);
  });
});

describe("saved geometry", () => {
  it("remembers size only after a resize", () => {
    expect(toSaved({ x: 1, y: 2, w: 448, h: null, sized: false })).toEqual({ x: 1, y: 2 });
    expect(toSaved({ x: 1, y: 2, w: 600, h: 500, sized: true })).toEqual({ x: 1, y: 2, w: 600, h: 500 });
  });

  it("ignores junk in localStorage", () => {
    expect(parseSaved(null)).toBeNull();
    expect(parseSaved("{oops")).toBeNull();
    expect(parseSaved('{"x":"a","y":1}')).toBeNull();
    expect(parseSaved('{"x":1,"y":2,"w":3}')).toEqual({ x: 1, y: 2 });
  });
});

describe("mobile sheet", () => {
  it("never covers the very top of the screen", () => {
    expect(clampSheet(5000, phone)).toBe(phone.h - 48);
    expect(clampSheet(10, phone)).toBe(160);
  });

  it("minimises when pulled down most of the way", () => {
    expect(sheetShouldMinimise(120, phone)).toBe(true);
    expect(sheetShouldMinimise(400, phone)).toBe(false);
  });
});
