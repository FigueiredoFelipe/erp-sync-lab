// Pixel geometry of one segment of a sign-stacked bar (R19; Recharts stackOffset="sign"). Pure, so the rules
// are unit tested (tests/ui/stack-geometry.test.ts) apart from the chart.
//
// The stack: segments are drawn in stack order; positive values stack upwards from zero and negative values
// downwards from zero, each side in the same order. A zero value draws nothing and is not a neighbour.
//
// The rules:
// - A segment's pixel ends sit on its stacked values. Where an end touches another segment (a same-side
//   neighbour, or the first segment on the other side of zero) it gives up HALF_GAP px, so two segments are
//   separated by a 2 px gap while the boundary stays where the values put it.
// - Only the outermost non-zero segment on its side of zero is rounded, at its outer (free) end.
// - A segment thinner than its gaps keeps a sliver of at most 1 px, inside its own [top, bottom], so it never
//   crosses zero and never enters a neighbour's band: anchored at the zero side when its inner end is zero,
//   otherwise at its outer end.

export const HALF_GAP = 1;
const SLIVER = 1;

export interface SegmentInput {
  // The signed values of every segment of the bar, in stack order (any unit; only signs and order matter).
  values: readonly number[];
  // Which segment of `values` to place.
  index: number;
  // The segment's pixel box as the chart computed it (height may be negative).
  y: number;
  height: number;
  // Corner radius of the free end.
  radius: number;
}

export interface SegmentGeometry {
  y0: number; // top edge (SVG y grows downwards)
  y1: number; // bottom edge, y1 > y0
  radiusTop: number;
  radiusBottom: number;
}

// null when the segment draws nothing (a zero value).
export function segmentGeometry({ values, index, y, height, radius }: SegmentInput): SegmentGeometry | null {
  const value = values[index] ?? 0;
  if (value === 0) return null;
  const sign = Math.sign(value);
  const sameSide = (other: number) => other !== 0 && Math.sign(other) === sign;
  const hasInner = values.slice(0, index).some(sameSide);
  const hasOuter = values.slice(index + 1).some(sameSide);
  const hasOpposite = values.some((other) => other !== 0 && Math.sign(other) !== sign);
  // The inner end faces zero (or the same-side neighbour below it); the outer end faces away from zero.
  const innerTouches = hasInner || hasOpposite;
  const outerTouches = hasOuter;
  const positive = sign > 0;

  const top = Math.min(y, y + height);
  const bottom = Math.max(y, y + height);
  // A positive segment's outer end is its top; a negative one's is its bottom.
  const [topTouches, bottomTouches] = positive ? [outerTouches, innerTouches] : [innerTouches, outerTouches];
  let y0 = top + (topTouches ? HALF_GAP : 0);
  let y1 = bottom - (bottomTouches ? HALF_GAP : 0);
  if (y1 - y0 < SLIVER) {
    const size = Math.min(SLIVER, bottom - top);
    // Anchor side: zero when nothing sits between the segment and zero, else the outer end.
    const anchorAtBottom = positive ? !hasInner : hasInner;
    if (anchorAtBottom) {
      y1 = bottom;
      y0 = bottom - size;
    } else {
      y0 = top;
      y1 = top + size;
    }
  }
  const outerRadius = outerTouches ? 0 : radius;
  return {
    y0,
    y1,
    radiusTop: positive ? outerRadius : 0,
    radiusBottom: positive ? 0 : outerRadius,
  };
}
