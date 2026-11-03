import { describe, expect, it } from "@jest/globals";
import { createRng } from "../../scripts/seed/random.ts";

// Proves the test toolchain runs TypeScript with .ts import specifiers, as Node and Deno do.
describe("test toolchain", () => {
  it("runs TypeScript sources with .ts imports", () => {
    const a = createRng(1);
    const b = createRng(1);
    expect(a.next()).toBe(b.next());
  });
});
