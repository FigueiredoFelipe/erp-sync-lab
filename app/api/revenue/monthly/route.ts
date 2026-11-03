import { guarded } from "../../../../src/http/access.ts";
import { methodNotAllowed } from "../../../../src/http/problem.ts";
import { createRevenueMonthlyHandler } from "../../../../src/http/revenue-handler.ts";
import { revenueService } from "../../../_lib/services.ts";
import { openSession } from "../../../_lib/supabase.ts";

export const dynamic = "force-dynamic";

export const GET = guarded(openSession, (client) => createRevenueMonthlyHandler(revenueService(client)));
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
