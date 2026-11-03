import { describe, expect, it } from "@jest/globals";
import { segmentGeometry } from "../../app/_components/stack-geometry.ts";

// Stack order as on the chart: index 0 = ERPNext (nearest zero), index 1 = Unit B (outside it).
// Pixel boxes: zero line at y = 200; 1 px = $1 for readability. SVG y grows downwards.
const R = 4;
const at = (values: number[], index: number, y: number, height: number) =>
  segmentGeometry({ values, index, y, height, radius: R });

describe("segmentGeometry", () => {
  it("both positive: the inner segment gives up 1 px on top only and is square; the outer one gives up 1 px below and is rounded on top", () => {
    // ERPNext 100 -> [100, 200]; Unit B 50 -> [50, 100].
    expect(at([100, 50], 0, 100, 100)).toEqual({ y0: 101, y1: 200, radiusTop: 0, radiusBottom: 0 });
    expect(at([100, 50], 1, 50, 50)).toEqual({ y0: 50, y1: 99, radiusTop: R, radiusBottom: 0 });
  });

  it("both negative: mirror image, the outer one is rounded at its bottom", () => {
    // ERPNext -100 -> [200, 300]; Unit B -50 -> [300, 350].
    expect(at([-100, -50], 0, 200, 100)).toEqual({ y0: 200, y1: 299, radiusTop: 0, radiusBottom: 0 });
    expect(at([-100, -50], 1, 300, 50)).toEqual({ y0: 301, y1: 350, radiusTop: 0, radiusBottom: R });
  });

  it("mixed signs: each side gives up 1 px at zero and is rounded at its free end", () => {
    // ERPNext 100 -> [100, 200]; Unit B -50 -> [200, 250].
    expect(at([100, -50], 0, 100, 100)).toEqual({ y0: 100, y1: 199, radiusTop: R, radiusBottom: 0 });
    expect(at([100, -50], 1, 200, 50)).toEqual({ y0: 201, y1: 250, radiusTop: 0, radiusBottom: R });
    // And the other way round: ERPNext negative, Unit B positive.
    expect(at([-100, 50], 0, 200, 100)).toEqual({ y0: 201, y1: 300, radiusTop: 0, radiusBottom: R });
    expect(at([-100, 50], 1, 150, 50)).toEqual({ y0: 150, y1: 199, radiusTop: R, radiusBottom: 0 });
  });

  it("one source zero: the zero segment draws nothing, the other is whole and rounded", () => {
    expect(at([0, 50], 0, 200, 0)).toBeNull();
    expect(at([0, 50], 1, 150, 50)).toEqual({ y0: 150, y1: 200, radiusTop: R, radiusBottom: 0 });
    expect(at([-80, 0], 0, 200, 80)).toEqual({ y0: 200, y1: 280, radiusTop: 0, radiusBottom: R });
    expect(at([-80, 0], 1, 280, 0)).toBeNull();
  });

  it("accepts a negative pixel height (the chart may report the box upside down)", () => {
    expect(at([100, 50], 0, 200, -100)).toEqual({ y0: 101, y1: 200, radiusTop: 0, radiusBottom: 0 });
  });

  describe("a segment thinner than its gaps stays inside its own box", () => {
    it("inner positive, under a same-side neighbour: anchored at zero (its inner end)", () => {
      // ERPNext 1.5 -> [198.5, 200]; would be [199.5, 200] after 1 px on top: 0.5 px < 1.
      const g = at([1.5, 50], 0, 198.5, 1.5)!;
      expect(g).toEqual({ y0: 199, y1: 200, radiusTop: 0, radiusBottom: 0 });
    });

    it("inner positive with a negative segment across zero: anchored at zero, never below it", () => {
      // ERPNext 1.5 -> [198.5, 200], Unit B -50 below zero: gives up 1 px at zero -> 0.5 px.
      const g = at([1.5, -50], 0, 198.5, 1.5)!;
      expect(g.y1).toBe(200);
      expect(g.y0).toBe(199);
    });

    it("outer positive, on top of a same-side neighbour: anchored at its outer end, never in the neighbour's band", () => {
      // Unit B 1.5 -> [148.5, 150], on top of ERPNext [150, 200]: gives up 1 px below -> 0.5 px.
      const g = at([50, 1.5], 1, 148.5, 1.5)!;
      expect(g).toEqual({ y0: 148.5, y1: 149.5, radiusTop: R, radiusBottom: 0 });
      expect(g.y1).toBeLessThanOrEqual(150);
    });

    it("inner negative: anchored at zero (its top), never above it", () => {
      // ERPNext -1.5 -> [200, 201.5], Unit B -50 below it.
      const g = at([-1.5, -50], 0, 200, 1.5)!;
      expect(g).toEqual({ y0: 200, y1: 201, radiusTop: 0, radiusBottom: 0 });
    });

    it("outer negative, under a same-side neighbour: anchored at its outer end (its bottom)", () => {
      // Unit B -1.5 -> [250, 251.5], under ERPNext [200, 250].
      const g = at([-50, -1.5], 1, 250, 1.5)!;
      expect(g).toEqual({ y0: 250.5, y1: 251.5, radiusTop: 0, radiusBottom: R });
      expect(g.y0).toBeGreaterThanOrEqual(250);
    });

    it("outer negative alone on its side, across zero from a positive one: anchored at zero, never above it", () => {
      // ERPNext 50 -> [150, 200]; Unit B -1.5 -> [200, 201.5]: gives up 1 px at zero -> 0.5 px.
      const g = at([50, -1.5], 1, 200, 1.5)!;
      expect(g).toEqual({ y0: 200, y1: 201, radiusTop: 0, radiusBottom: R });
    });

    it("thinner than the 1 px sliver itself: clamped to its own box", () => {
      const g = at([0.4, -50], 0, 199.6, 0.4)!;
      expect(g.y0).toBeCloseTo(199.6);
      expect(g.y1).toBe(200);
    });
  });

  it("derives neighbours from the stack order, not from a fixed pair of sources", () => {
    // Three sources: 30, -20, 40. Positive side stacks index 0 then index 2; index 1 is alone below zero.
    // Index 0 [170, 200]: same-side neighbour above it (index 2) and an opposite side -> both ends give up 1 px, square.
    expect(at([30, -20, 40], 0, 170, 30)).toEqual({ y0: 171, y1: 199, radiusTop: 0, radiusBottom: 0 });
    // Index 2 [130, 170]: outermost positive -> rounded on top, gives up 1 px below.
    expect(at([30, -20, 40], 2, 130, 40)).toEqual({ y0: 130, y1: 169, radiusTop: R, radiusBottom: 0 });
    // Index 1 [200, 220]: alone on the negative side -> gives up 1 px at zero, rounded at its bottom.
    expect(at([30, -20, 40], 1, 200, 20)).toEqual({ y0: 201, y1: 220, radiusTop: 0, radiusBottom: R });
    // A zero in the middle is not a neighbour: index 2 sits directly on index 0.
    expect(at([30, 0, 40], 2, 130, 40)).toEqual({ y0: 130, y1: 169, radiusTop: R, radiusBottom: 0 });
    expect(at([30, 0, 40], 0, 170, 30)).toEqual({ y0: 171, y1: 200, radiusTop: 0, radiusBottom: 0 });
  });
});
