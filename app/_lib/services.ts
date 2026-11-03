// Server-only wiring: builds the services over the signed-in user's client (T22), so RLS is the security
// boundary (PLAN "Dashboard, API and access"). Imported only by route handlers, never by a client component.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createCustomerRevenueService } from "../../src/services/customer-revenue-service.ts";
import { createDocumentsService } from "../../src/services/documents-service.ts";
import { createFreshnessService } from "../../src/services/freshness-service.ts";
import { createQuarantineService } from "../../src/services/quarantine-service.ts";
import { createRevenueService } from "../../src/services/revenue-service.ts";

export const revenueService = (client: SupabaseClient) => () => createRevenueService(client);

export const customerRevenueService = (client: SupabaseClient) => () => createCustomerRevenueService(client);

export const freshnessService = (client: SupabaseClient) => () =>
  createFreshnessService(client, { testSwitchesEnabled: process.env["ENABLE_TEST_SWITCHES"] === "true" });

export const quarantineService = (client: SupabaseClient) => () => createQuarantineService(client);

export const documentsService = (client: SupabaseClient) => () => createDocumentsService(client);
