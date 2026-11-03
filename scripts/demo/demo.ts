// Operator helpers for a live walkthrough. Tooling outside the system: talks to the cloud database directly as
// the postgres user (DATABASE_URL), like an operator at a psql prompt. Never prints connection strings or keys.
//
//   npm run demo:poll           force one ERPNext poll and wait for its sync_run to finish
//   npm run demo:switch on|off  turn the fail_freshness_api test switch on or off (scene (b))
//   npm run demo:status         queue depth, invoices, quarantine and revenue figures
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

const FRESHNESS_SWITCH = "fail_freshness_api";
const DEMO_CUSTOMER = "Union Station Eatery";
const OCTOBER = { from: "2026-10-01", to: "2026-11-01" } as const;
const POLL_TIMEOUT_MS = 180_000; // the function's wall clock is 150 s
const POLL_INTERVAL_MS = 3_000;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

type Command = (db: pg.Client, args: string[]) => Promise<void>;

const commands: Record<string, Command> = { poll, switch: toggleSwitch, status };

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2);
  const command = name ? commands[name] : undefined;
  if (!command) throw new Error(`Usage: demo.ts ${Object.keys(commands).join("|")} [args]`);

  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("Missing DATABASE_URL in .env");
  // The cloud pooler presents a certificate Node doesn't chain to a trusted root.
  const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await command(db, args);
  } finally {
    await db.end();
  }
}

async function poll(db: pg.Client): Promise<void> {
  const { rows } = await db.query<{ triggered_at: Date; request_id: string }>(
    "select now() as triggered_at, internal.trigger_poll() as request_id",
  );
  const trigger = rows[0];
  if (!trigger) throw new Error("trigger_poll returned nothing");
  console.log(`Poll triggered (pg_net request ${trigger.request_id}); waiting for its sync_run...`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let announced = false;
  while (Date.now() < deadline) {
    // A cron run may start in the same window; either one reads the same changes.
    const { rows: runs } = await db.query<{
      status: string;
      started_at: Date;
      finished_at: Date | null;
      fetched_count: number;
      enqueued: number;
      error: string | null;
    }>(
      `select status, started_at, finished_at, fetched_count, enqueued, error
         from public.sync_run
        where source = 'erpnext' and started_at >= $1::timestamptz - interval '5 seconds'
        order by started_at desc
        limit 1`,
      [trigger.triggered_at],
    );
    const run = runs[0];
    if (run && !announced) {
      console.log(`  sync_run started at ${run.started_at.toISOString()}`);
      announced = true;
    }
    if (run?.finished_at) {
      const seconds = ((run.finished_at.getTime() - run.started_at.getTime()) / 1000).toFixed(1);
      console.log(`Poll finished: status ${run.status}, fetched ${run.fetched_count}, enqueued ${run.enqueued} (${seconds} s)`);
      if (run.error) console.log(`  error: ${run.error}`);
      console.log(`Queued messages now: ${await queuedCount(db)} (the consumer drains up to 10 per minute)`);
      if (run.status !== "succeeded") process.exitCode = 1;
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // No run recorded: report the HTTP status pg_net got back, if any (status only, no body).
  const { rows: responses } = await db.query<{ status_code: number | null; timed_out: boolean | null }>(
    "select status_code, timed_out from net._http_response where id = $1",
    [trigger.request_id],
  );
  const response = responses[0];
  const detail = response ? `pg_net status ${response.status_code ?? "none"}${response.timed_out ? ", timed out" : ""}` : "no pg_net response yet";
  throw new Error(`No finished erpnext sync_run within ${POLL_TIMEOUT_MS / 1000} s (${detail})`);
}

async function toggleSwitch(db: pg.Client, args: string[]): Promise<void> {
  const mode = args[0];
  if (mode === "on") {
    await db.query(
      `insert into internal.test_switch (name, enabled) values ($1, true)
       on conflict (name) do update set enabled = true`,
      [FRESHNESS_SWITCH],
    );
  } else if (mode === "off") {
    await db.query("delete from internal.test_switch where name = $1", [FRESHNESS_SWITCH]);
  } else {
    throw new Error("Usage: npm run demo:switch on|off");
  }
  const { rows } = await db.query<{ enabled: boolean }>("select enabled from internal.test_switch where name = $1", [FRESHNESS_SWITCH]);
  console.log(`${FRESHNESS_SWITCH}: ${rows[0]?.enabled ? "ON" : "OFF"} (only read by a dev server started with ENABLE_TEST_SWITCHES=true)`);
}

async function status(db: pg.Client): Promise<void> {
  const { rows } = await db.query<{
    invoices: number;
    quarantined: number;
    total: string;
    october: string;
    october_invoices: number;
    customer_october: string;
    customer_october_invoices: number;
    last_sync: Date | null;
    last_consumer: Date | null;
  }>(
    `select
       (select count(*)::int from public.invoice) as invoices,
       (select count(*)::int from public.quarantine where status = 'open') as quarantined,
       (select coalesce(sum(amount), 0)::text from public.invoice) as total,
       (select coalesce(sum(amount), 0)::text from public.invoice
         where invoice_date >= $1 and invoice_date < $2) as october,
       (select count(*)::int from public.invoice
         where invoice_date >= $1 and invoice_date < $2) as october_invoices,
       (select coalesce(sum(i.amount), 0)::text
          from public.invoice i left join public.customer c on c.canonical_id = i.canonical_customer_id
         where coalesce(c.display_name, i.source_customer) = $3
           and i.invoice_date >= $1 and i.invoice_date < $2) as customer_october,
       (select count(*)::int
          from public.invoice i left join public.customer c on c.canonical_id = i.canonical_customer_id
         where coalesce(c.display_name, i.source_customer) = $3
           and i.invoice_date >= $1 and i.invoice_date < $2) as customer_october_invoices,
       (select max(finished_at) from public.sync_run where source = 'erpnext' and status = 'succeeded') as last_sync,
       (select last_run_at from public.consumer_heartbeat) as last_consumer`,
    [OCTOBER.from, OCTOBER.to, DEMO_CUSTOMER],
  );
  const row = rows[0];
  if (!row) throw new Error("status query returned nothing");

  console.log(`Queued messages (invoice_events): ${await queuedCount(db)}`);
  console.log(`Invoices (valid):                 ${row.invoices}`);
  console.log(`Quarantined (open):               ${row.quarantined}`);
  console.log(`Total revenue:                    ${money(row.total)}`);
  console.log(`October 2026:                     ${money(row.october)} (${row.october_invoices} invoices)`);
  console.log(`${DEMO_CUSTOMER}, October 2026: ${money(row.customer_october)} (${row.customer_october_invoices} invoices)`);
  console.log(`Last successful ERPNext sync:     ${row.last_sync?.toISOString() ?? "never"}`);
  console.log(`Last consumer run:                ${row.last_consumer?.toISOString() ?? "never"}`);
}

async function queuedCount(db: pg.Client): Promise<number> {
  const { rows } = await db.query<{ queued: number }>("select count(*)::int as queued from pgmq.q_invoice_events");
  return rows[0]?.queued ?? 0;
}

// numeric arrives as text with two decimals.
function money(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  return usd.format(Number(`${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`));
}

main().catch((error: unknown) => {
  console.error(`demo stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
