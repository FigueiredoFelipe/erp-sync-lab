// R20: the period every reconciliation run covers — the validation period (BR03). Its own module, with no
// adapter imports, so the dashboard pages can show the same period without bundling the reconciliation code.
import { defaultValidationConfig } from "../validation/validate.ts";

export function reconciliationPeriod(): { from: string; to: string } {
  return { from: defaultValidationConfig.periodStart, to: defaultValidationConfig.periodEnd };
}
