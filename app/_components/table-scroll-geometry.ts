// Pure geometry of a sideways-scrolling table with fixed columns (R21, PLAN "Customers table: trends always
// visible"). Kept apart from the component so the rules are unit tested (tests/ui/table-scroll-geometry.test.ts).

// Below this many CSS px a difference is rounding (subpixel scroll positions, zoom), not a hidden column.
export const TOLERANCE_PX = 1;

export interface EdgeCues {
  // The content is wider than the scroller: the scroll controls and cues apply at all.
  overflow: boolean;
  // Content is hidden on that side (the cue "◀ More months" / "More months ▶" shows).
  left: boolean;
  right: boolean;
}

// Which "more" cues show for a scroller's position. A side scrolled to its end (within 1 px) shows none, and a
// table that fits shows none at all.
export function edgeCues(scrollLeft: number, clientWidth: number, scrollWidth: number): EdgeCues {
  const hidden = scrollWidth - clientWidth;
  if (!(hidden > TOLERANCE_PX)) return { overflow: false, left: false, right: false };
  const position = Math.min(Math.max(scrollLeft, 0), hidden);
  return {
    overflow: true,
    left: position > TOLERANCE_PX,
    right: hidden - position > TOLERANCE_PX,
  };
}

export interface FocusGeometry {
  // The focused element's left and right edges, in viewport px (getBoundingClientRect).
  targetLeft: number;
  targetRight: number;
  // The scroller's visible box, in viewport px.
  viewLeft: number;
  viewRight: number;
  // Widths covered by the fixed columns on each side.
  fixedLeft: number;
  fixedRight: number;
  // Room kept around the element for its focus ring.
  margin: number;
}

// How far to move scrollLeft so a focused element and its focus ring sit fully between the fixed columns.
// 0 when it already does. When the element is wider than the free band, its start wins.
export function focusScrollDelta(g: FocusGeometry): number {
  const bandLeft = g.viewLeft + g.fixedLeft;
  const bandRight = g.viewRight - g.fixedRight;
  const start = g.targetLeft - g.margin;
  const end = g.targetRight + g.margin;
  if (start < bandLeft - TOLERANCE_PX / 2) return start - bandLeft;
  if (end > bandRight + TOLERANCE_PX / 2) return Math.min(end - bandRight, start - bandLeft);
  return 0;
}

// What a scroll listener does with a scroll event of its element, when two scrollers mirror each other.
// - "ignore-echo": the event is the echo of our own write (its position matches, within 1 px, the value read back
//   from the element after writing it; browsers clamp and round what is written), so it is not passed back.
// - "in-sync": the other element is already within 1 px; nothing to write.
// - "propagate": a real scroll (user, keyboard, cue click); the other element follows.
export type ScrollSyncAction = "ignore-echo" | "in-sync" | "propagate";

export function scrollSyncAction(position: number, expectedEcho: number | null, otherPosition: number): ScrollSyncAction {
  if (expectedEcho !== null && Math.abs(position - expectedEcho) <= TOLERANCE_PX) return "ignore-echo";
  if (Math.abs(position - otherPosition) < TOLERANCE_PX) return "in-sync";
  return "propagate";
}

// Above this share of the scroller's width, the fixed columns leave too little room for the scrolling ones
// (SPEC Q12, provisionally option (a)).
export const CRAMPED_RATIO = 0.7;

export interface FixedLayout {
  // Too narrow to keep every fixed column: only the last trailing column stays fixed on the right.
  cramped: boolean;
  // How many trailing columns stay fixed.
  stickyEnd: number;
  // The `right` offset of each fixed trailing column, from the last one (offsets[0] = 0).
  offsets: number[];
  // Width covered on each side by the columns that stay fixed.
  left: number;
  right: number;
}

// Which columns stay fixed, and where. `endWidths` are the trailing fixed columns' widths from the last column
// backwards; they are measured whatever the mode (the columns keep their widths when unstuck), so the decision
// doesn't flip back and forth. Cramped applies only while the table overflows and there is a column to give up:
// then every trailing column but the last scrolls with the months (Q12 (a): Total scrolls, Trend stays).
export function fixedLayout(
  leftWidth: number,
  endWidths: readonly number[],
  clientWidth: number,
  scrollWidth: number,
): FixedLayout {
  const allRight = endWidths.reduce((sum, width) => sum + width, 0);
  const overflow = scrollWidth - clientWidth > TOLERANCE_PX;
  const cramped = overflow && endWidths.length > 1 && leftWidth + allRight > CRAMPED_RATIO * clientWidth;
  const stickyEnd = cramped ? 1 : endWidths.length;
  const offsets: number[] = [];
  let right = 0;
  for (let index = 0; index < stickyEnd; index++) {
    offsets.push(right);
    right += endWidths[index] as number;
  }
  return { cramped, stickyEnd, offsets, left: leftWidth, right };
}
