// Scheduled functions are called by pg_cron with this header; compare in constant time.
export function isAuthorizedCron(req: Request, secret: string | undefined): boolean {
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!secret || given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
