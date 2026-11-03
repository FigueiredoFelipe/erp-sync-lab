"use client";

// A sideways-scrolling table with fixed leading and trailing columns (R21, PLAN "Customers table: trends always
// visible"). The native scroller is the source of truth: a focusable region the arrow keys scroll. Above it, a
// mirror scrollbar (hidden from assistive tech, no tab stop) lets a mouse scroll without first reaching the end
// of the table, and the "more" cues say on which side columns are hidden. Both are hidden, keeping their row's
// height, when the table fits.
//
// The component measures the fixed columns from the header row (the first cell, and the last `fixedEnd` cells)
// into CSS variables on the scroller: --col-left (first column's width), --col-right (the trailing fixed
// columns' width) and --end-offset-<n> (the `right` offset of the n-th trailing column counted from the end,
// 0-based: --end-offset-1 is the width of the last column). The table's own CSS decides what is sticky.
// When the fixed columns would take more than CRAMPED_RATIO of the scroller (phone widths), the scroller gets
// data-cramped and only the last trailing column stays fixed (SPEC Q12, provisionally option (a)); the CSS
// unsticks the others on that attribute.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  edgeCues,
  fixedLayout,
  focusScrollDelta,
  scrollSyncAction,
  TOLERANCE_PX,
  type EdgeCues,
} from "./table-scroll-geometry.ts";

// Room kept around a focused element for its focus ring.
const FOCUS_MARGIN_PX = 4;
const NO_CUES: EdgeCues = { overflow: false, left: false, right: false };

function sameCues(a: EdgeCues, b: EdgeCues): boolean {
  return a.overflow === b.overflow && a.left === b.left && a.right === b.right;
}

export function TableScroll({
  label,
  what,
  testIdPrefix,
  fixedEnd,
  children,
}: {
  // The scrolling region's accessible name.
  label: string;
  // What scrolls, for the cues: "months" gives "◀ More months" and "More months ▶".
  what: string;
  // Cue test ids: `${testIdPrefix}-more-left` and `${testIdPrefix}-more-right`.
  testIdPrefix: string;
  // How many trailing columns are fixed on the right.
  fixedEnd: number;
  // The table.
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const mirrorInner = useRef<HTMLDivElement>(null);
  const fixed = useRef({ left: 0, right: 0 });
  const [cues, setCues] = useState<EdgeCues>(NO_CUES);

  // Before paint: measure, size the mirror and set the cues, so the first frame is already right.
  useLayoutEffect(() => {
    const box = scroller.current;
    const bar = mirror.current;
    const inner = mirrorInner.current;
    if (!box || !bar || !inner) return;

    const updateCues = () => {
      const next = edgeCues(box.scrollLeft, box.clientWidth, box.scrollWidth);
      // The scroller stops being a tab stop when the table fits: focus on it moves to the table's section.
      if (!next.overflow && document.activeElement === box) {
        const section = box.closest("section") ?? box.parentElement;
        if (section instanceof HTMLElement) {
          if (!section.hasAttribute("tabindex")) section.setAttribute("tabindex", "-1");
          section.focus({ preventScroll: true });
        }
      }
      setCues((current) => (sameCues(current, next) ? current : next));
    };

    const measure = () => {
      const row = box.querySelector("thead tr");
      const cells = row ? Array.from(row.children) : [];
      const first = cells[0];
      const leftWidth = first ? first.getBoundingClientRect().width : 0;
      const endWidths: number[] = [];
      for (let index = 0; index < fixedEnd && index < cells.length; index++) {
        endWidths.push((cells[cells.length - 1 - index] as Element).getBoundingClientRect().width);
      }
      const layout = fixedLayout(leftWidth, endWidths, box.clientWidth, box.scrollWidth);
      layout.offsets.forEach((offset, index) => box.style.setProperty(`--end-offset-${index}`, `${offset}px`));
      for (let index = layout.stickyEnd; index < fixedEnd; index++) box.style.removeProperty(`--end-offset-${index}`);
      if (layout.cramped) box.dataset["cramped"] = "true";
      else delete box.dataset["cramped"];
      fixed.current = { left: layout.left, right: layout.right };
      box.style.setProperty("--col-left", `${layout.left}px`);
      box.style.setProperty("--col-right", `${layout.right}px`);
      // Same box width as the scroller, inner width = its scrollWidth: both have the same scroll range.
      inner.style.width = `${box.scrollWidth}px`;
      follow(box, bar);
      updateCues();
    };

    // Two-way sync without a feedback loop: a write to the other element is remembered as the value read back
    // after it (browsers clamp and round what is written), and that element's next scroll event matching it
    // within 1 px is the echo, not passed back. Writes happen only when the two differ by at least 1 px.
    const echo = new Map<Element, number>();
    const follow = (source: HTMLElement, target: HTMLElement) => {
      if (Math.abs(target.scrollLeft - source.scrollLeft) < TOLERANCE_PX) return;
      const before = target.scrollLeft;
      target.scrollLeft = source.scrollLeft;
      const after = target.scrollLeft;
      // A write the browser didn't apply fires no scroll event, so it leaves no echo to wait for.
      if (Math.abs(after - before) >= TOLERANCE_PX) echo.set(target, after);
    };
    const onScrollOf = (source: HTMLElement, target: HTMLElement) => () => {
      const action = scrollSyncAction(source.scrollLeft, echo.get(source) ?? null, target.scrollLeft);
      echo.delete(source);
      if (action === "propagate") follow(source, target);
    };
    const syncFromBox = onScrollOf(box, bar);
    const syncFromBar = onScrollOf(bar, box);
    const onScroll = () => {
      syncFromBox();
      updateCues();
    };
    const onMirrorScroll = () => syncFromBar();

    // A focused figure (and its ring) never stays under a fixed column. The browser's own focus scrolling
    // uses scroll-padding; this corrects what it leaves, now and after the next frame.
    let frame = 0;
    const correct = (target: Element) => {
      if (!box.contains(target) || target === box) return;
      const cell = target.closest("th, td");
      if (cell && getComputedStyle(cell).position === "sticky") return;
      const rect = target.getBoundingClientRect();
      const view = box.getBoundingClientRect();
      const delta = focusScrollDelta({
        targetLeft: rect.left,
        targetRight: rect.right,
        viewLeft: view.left + box.clientLeft,
        viewRight: view.left + box.clientLeft + box.clientWidth,
        fixedLeft: fixed.current.left,
        fixedRight: fixed.current.right,
        margin: FOCUS_MARGIN_PX,
      });
      if (Math.abs(delta) >= TOLERANCE_PX) box.scrollLeft += delta;
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      correct(target);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => correct(target));
    };

    measure();
    box.addEventListener("scroll", onScroll, { passive: true });
    bar.addEventListener("scroll", onMirrorScroll, { passive: true });
    box.addEventListener("focusin", onFocusIn);

    // One observer for the scroller, the table and the measured cells: a resize or a different number of
    // columns re-syncs everything.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(box);
      const table = box.querySelector("table");
      if (table) observer.observe(table);
      const row = box.querySelector("thead tr");
      // The cells are picked once: a change to the set of columns (adding or removing one) needs a remount
      // (e.g. a `key` on TableScroll); a change of widths, rows or month range is picked up as is.
      if (row) {
        const cells = Array.from(row.children);
        const watched = [cells[0], ...(fixedEnd > 0 ? cells.slice(-fixedEnd) : [])];
        for (const cell of watched) if (cell) observer.observe(cell);
      }
    }

    return () => {
      box.removeEventListener("scroll", onScroll);
      bar.removeEventListener("scroll", onMirrorScroll);
      box.removeEventListener("focusin", onFocusIn);
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [fixedEnd]);

  // A cue click moves one view's width of free (non-fixed) columns; the mirror and the keyboard do the rest.
  function page(direction: -1 | 1) {
    const box = scroller.current;
    if (!box) return;
    const free = box.clientWidth - fixed.current.left - fixed.current.right;
    box.scrollLeft += direction * Math.max(free * 0.8, 40);
  }

  return (
    <div className="table-scroll-frame">
      <div className="table-scroll-bar" data-overflow={cues.overflow} aria-hidden="true">
        <div className="table-scroll-cues">
          <span
            className="table-scroll-cue"
            data-testid={`${testIdPrefix}-more-left`}
            data-visible={cues.left}
            onClick={() => page(-1)}
          >
            ◀ More {what}
          </span>
          <span
            className="table-scroll-cue"
            data-testid={`${testIdPrefix}-more-right`}
            data-visible={cues.right}
            onClick={() => page(1)}
          >
            More {what} ▶
          </span>
        </div>
        <div
          ref={mirror}
          className="table-scroll-mirror"
          tabIndex={-1}
          // Hidden from assistive tech, so it must never keep focus (a click can give it focus): hand it back
          // to what had it, or to the scroller.
          onFocus={(event) => {
            const previous = event.relatedTarget;
            const back =
              previous instanceof HTMLElement && previous.isConnected && previous !== event.currentTarget
                ? previous
                : scroller.current;
            back?.focus({ preventScroll: true });
          }}
        >
          <div ref={mirrorInner} className="table-scroll-mirror-inner" />
        </div>
      </div>
      <div
        ref={scroller}
        className="table-scroller"
        // A named, focusable region only while it scrolls (the arrow keys scroll it); a plain box otherwise.
        role={cues.overflow ? "region" : undefined}
        aria-label={cues.overflow ? label : undefined}
        tabIndex={cues.overflow ? 0 : undefined}
        data-overflow={cues.overflow}
      >
        {children}
      </div>
    </div>
  );
}
