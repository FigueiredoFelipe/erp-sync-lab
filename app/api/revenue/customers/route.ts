import { createCustomerRevenueHandler } from "../../../../src/http/customer-revenue-handler.ts";
import { guarded } from "../../../../src/http/access.ts";
import { methodNotAllowed } from "../../../../src/http/problem.ts";
import { customerRevenueService } from "../../../_lib/services.ts";
import { openSession } from "../../../_lib/supabase.ts";

export const dynamic = "force-dynamic";

export const GET = guarded(openSession, (client) => createCustomerRevenueHandler(customerRevenueService(client)));
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
