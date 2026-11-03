// "Oct 18, 2026, 3:12 PM EDT". dateStyle/timeStyle can't be combined with timeZoneName (Chrome throws
// "Invalid option"), so the fields are spelled out.
export function formatTimestamp(iso: string, timeZone = "America/New_York"): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
}
