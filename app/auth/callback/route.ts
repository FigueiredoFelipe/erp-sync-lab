import { createCallbackHandler } from "../../../src/http/auth-handler.ts";
import { methodNotAllowed } from "../../../src/http/problem.ts";
import { userClient } from "../../_lib/supabase.ts";

export const dynamic = "force-dynamic";

export const GET = createCallbackHandler(async () => (await userClient()).auth);
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
