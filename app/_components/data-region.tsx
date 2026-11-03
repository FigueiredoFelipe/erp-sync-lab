"use client";

// One data region and its load (PLAN "Loading feedback (R18)"): placeholders while loading, the content
// once loaded, an error with "Try again" on failure. Never a "—", a 0 or an empty table in place of data.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Load } from "./fetch-json.ts";
import { regionReady } from "./load-state.ts";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function DataRegion<T>({
  what,
  load,
  onRetry,
  placeholder,
  testId,
  errorVariant = "box",
  errorNote,
  errorLead,
  children,
}: {
  what: string;
  load: Load<T>;
  onRetry: () => void;
  placeholder: ReactNode;
  testId: string;
  errorVariant?: "box" | "banner";
  // Extra text after "<What> could not be loaded.", in either variant.
  errorNote?: ReactNode;
  // Shown before the error, inside the region, only while it has failed (Revenue keeps its sync-health
  // alerts visible when the figures fail).
  errorLead?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number | null>(null);
  const [status, setStatus] = useState("");

  // Polite status outside the busy container: '' -> "Loading <what>…" -> "<What> loaded". On failure the
  // alert is the only announcement, so the status is cleared.
  useEffect(() => {
    if (load.state === "loading") setStatus(`Loading ${what}…`);
    else if (load.state === "ok") setStatus(`${capitalize(what)} loaded`);
    else setStatus("");
  }, [load.state, what]);

  // A reload keeps the region's last content height until the new content renders, so nothing below jumps.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    if (load.state === "loading") {
      if (lastHeight.current !== null) element.style.minHeight = `${lastHeight.current}px`;
      return;
    }
    element.style.minHeight = "";
    if (load.state !== "ok") return;
    lastHeight.current = element.offsetHeight;
    if (typeof ResizeObserver === "undefined") return;
    // Content such as a chart may settle after the first paint: keep the height current while loaded.
    const observer = new ResizeObserver(() => {
      lastHeight.current = element.offsetHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [load.state]);

  function retry() {
    // The button disappears once the region is loading again: focus the region so it is not lost.
    container.current?.focus();
    onRetry();
  }

  return (
    <>
      <div
        ref={container}
        className="data-region"
        data-testid={testId}
        data-ready={regionReady(load)}
        aria-busy={load.state === "loading" ? true : undefined}
        tabIndex={-1}
      >
        {load.state === "loading" && placeholder}
        {load.state === "ok" && children(load.data)}
        {load.state === "error" && errorLead}
        {load.state === "error" &&
          (errorVariant === "banner" ? (
            // Keeps the Sync health banner's test id and critical state: a page that cannot read health still
            // shows it red. The wrapper carries `${testId}-error`, as the box variant does, so a check finds the
            // error of either variant the same way.
            <div data-testid={`${testId}-error`}>
              <div className="banner banner-critical" role="alert" data-testid="health-banner" data-state="critical">
                <strong>{capitalize(what)} could not be loaded.</strong>
                {errorNote && <> {errorNote}</>} {load.message}{" "}
                <button type="button" data-testid={`${testId}-retry`} onClick={retry}>
                  Try again
                </button>
              </div>
            </div>
          ) : (
            <div className="error-box" role="alert" data-testid={`${testId}-error`}>
              <p>
                <strong>{capitalize(what)} could not be loaded.</strong>
                {errorNote && <> {errorNote}</>}
              </p>
              <p className="error-detail">{load.message}</p>
              <button type="button" data-testid={`${testId}-retry`} onClick={retry}>
                Try again
              </button>
            </div>
          ))}
      </div>
      <p role="status" className="visually-hidden">
        {status}
      </p>
    </>
  );
}

// A failed line of text (Revenue's "data as of"): "could not be loaded · Try again", same line height.
export function InlineRetry({ what, onRetry, testId }: { what: string; onRetry: () => void; testId: string }) {
  return (
    <span className="inline-retry" role="alert" data-testid={`${testId}-error`}>
      could not be loaded ·{" "}
      <button type="button" className="link" data-testid={`${testId}-retry`} aria-label={`Try again: load ${what}`} onClick={onRetry}>
        Try again
      </button>
    </span>
  );
}
