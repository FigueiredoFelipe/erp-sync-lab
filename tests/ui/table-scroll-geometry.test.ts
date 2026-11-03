import { describe, expect, it } from "@jest/globals";
import {
  CRAMPED_RATIO,
  edgeCues,
  fixedLayout,
  focusScrollDelta,
  scrollSyncAction,
} from "../../app/_components/table-scroll-geometry.ts";

describe("edgeCues", () => {
  it("shows nothing when the table fits", () => {
    expect(edgeCues(0, 1000, 1000)).toEqual({ overflow: false, left: false, right: false });
  });

  it("treats a 1 px difference as fitting", () => {
    expect(edgeCues(0, 1000, 1001)).toEqual({ overflow: false, left: false, right: false });
    expect(edgeCues(0, 1000, 1000.6)).toEqual({ overflow: false, left: false, right: false });
  });

  it("shows only the right cue at the start", () => {
    expect(edgeCues(0, 800, 1200)).toEqual({ overflow: true, left: false, right: true });
  });

  it("shows both cues in the middle", () => {
    expect(edgeCues(200, 800, 1200)).toEqual({ overflow: true, left: true, right: true });
  });

  it("shows only the left cue at the end", () => {
    expect(edgeCues(400, 800, 1200)).toEqual({ overflow: true, left: true, right: false });
  });

  it("hides a side within 1 px of its end (subpixel positions)", () => {
    expect(edgeCues(0.6, 800, 1200)).toEqual({ overflow: true, left: false, right: true });
    expect(edgeCues(399.4, 800, 1200)).toEqual({ overflow: true, left: true, right: false });
  });

  it("shows a side just over 1 px from its end", () => {
    expect(edgeCues(1.5, 800, 1200).left).toBe(true);
    expect(edgeCues(398.5, 800, 1200).right).toBe(true);
  });

  it("clamps positions outside the scroll range (rubber-band overscroll)", () => {
    expect(edgeCues(-20, 800, 1200)).toEqual({ overflow: true, left: false, right: true });
    expect(edgeCues(450, 800, 1200)).toEqual({ overflow: true, left: true, right: false });
  });
});

describe("focusScrollDelta", () => {
  const view = { viewLeft: 100, viewRight: 900, fixedLeft: 200, fixedRight: 250, margin: 4 };
  // Free band: 300..650.

  it("is 0 when the element and its ring are inside the free band", () => {
    expect(focusScrollDelta({ ...view, targetLeft: 400, targetRight: 480 })).toBe(0);
    expect(focusScrollDelta({ ...view, targetLeft: 304, targetRight: 646 })).toBe(0);
  });

  it("scrolls back when the element is under the left fixed column", () => {
    expect(focusScrollDelta({ ...view, targetLeft: 250, targetRight: 330 })).toBe(-54);
  });

  it("scrolls forward when the element is under the right fixed columns", () => {
    expect(focusScrollDelta({ ...view, targetLeft: 620, targetRight: 700 })).toBe(54);
  });

  it("keeps the ring in view, not only the element", () => {
    expect(focusScrollDelta({ ...view, targetLeft: 302, targetRight: 380 })).toBe(-2);
    expect(focusScrollDelta({ ...view, targetLeft: 560, targetRight: 648 })).toBe(2);
  });

  it("puts the start in view when the element is wider than the free band", () => {
    expect(focusScrollDelta({ ...view, targetLeft: 500, targetRight: 1000 })).toBe(196);
  });
});

describe("scrollSyncAction", () => {
  it("ignores the echo of its own write", () => {
    expect(scrollSyncAction(240, 240, 240)).toBe("ignore-echo");
  });

  it("ignores an echo rounded by the browser (within 1 px of the value read back)", () => {
    expect(scrollSyncAction(240.5, 240, 300)).toBe("ignore-echo");
  });

  it("ignores the echo of a clamped write, matched against the value read back, not the value written", () => {
    // 500 was written to an element whose range ends at 400; the browser kept 400 and the echo reports 400.
    expect(scrollSyncAction(400, 400, 500)).toBe("ignore-echo");
  });

  it("propagates a real user scroll", () => {
    expect(scrollSyncAction(120, null, 240)).toBe("propagate");
  });

  it("propagates a user scroll that moves away from a pending echo", () => {
    expect(scrollSyncAction(180, 240, 240)).toBe("propagate");
  });

  it("writes nothing when the other element is already within 1 px", () => {
    expect(scrollSyncAction(240, null, 240.4)).toBe("in-sync");
  });
});

describe("fixedLayout", () => {
  // Trailing widths from the last column: Trend, then Total.
  const ends = [100, 98];

  it("keeps customer, total and trend fixed when there is room", () => {
    expect(fixedLayout(196, ends, 1000, 1500)).toEqual({
      cramped: false,
      stickyEnd: 2,
      offsets: [0, 100],
      left: 196,
      right: 198,
    });
  });

  it("unsticks the total at phone widths (Q12 (a)), keeping customer and trend", () => {
    // 320 px viewport: about 302 px for the scroller; 128 + 198 = 326 px of fixed columns.
    const layout = fixedLayout(128, ends, 302, 900);
    expect(layout).toEqual({ cramped: true, stickyEnd: 1, offsets: [0], left: 128, right: 100 });
  });

  it("leaves months visible between the fixed columns at 320 and 360 px once cramped", () => {
    for (const clientWidth of [302, 342]) {
      const layout = fixedLayout(128, ends, clientWidth, 900);
      expect(layout.cramped).toBe(true);
      expect(clientWidth - layout.left - layout.right).toBeGreaterThan(0);
    }
  });

  it("decides at the ratio, on the full fixed width", () => {
    const clientWidth = 1000;
    const atRatio = CRAMPED_RATIO * clientWidth;
    expect(fixedLayout(atRatio - 198, ends, clientWidth, 1500).cramped).toBe(false);
    expect(fixedLayout(atRatio - 197, ends, clientWidth, 1500).cramped).toBe(true);
  });

  it("is never cramped while the table fits", () => {
    expect(fixedLayout(128, ends, 302, 302).cramped).toBe(false);
  });

  it("is never cramped with a single trailing fixed column", () => {
    expect(fixedLayout(250, [100], 302, 900)).toEqual({
      cramped: false,
      stickyEnd: 1,
      offsets: [0],
      left: 250,
      right: 100,
    });
  });
});
