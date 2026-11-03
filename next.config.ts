import type { NextConfig } from "next";

const config: NextConfig = {
  // The root tsconfig.json serves Node, Deno and Jest (NodeNext, no DOM); the app has its own.
  typescript: { tsconfigPath: "tsconfig.next.json" },
};

export default config;
