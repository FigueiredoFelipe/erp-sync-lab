import { createLogoutHandler } from "../../../src/http/auth-handler.ts";
import { onlyAllow } from "../../../src/http/problem.ts";
import { userClient } from "../../_lib/supabase.ts";

export const dynamic = "force-dynamic";

export const POST = createLogoutHandler(async () => (await userClient()).auth);
const methodNotAllowed = onlyAllow("POST");
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
