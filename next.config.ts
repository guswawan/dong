import path from "node:path";
import type { NextConfig } from "next";

const projectRoot = path.resolve(__dirname);

const nextConfig: NextConfig = {
  output: "standalone",
  // Prevent wrong monorepo root detection (breaks Docker / Cloud Build NFT tracing)
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },
  // Keep heavy Node packages external — stable in CI and Cloud Run
  serverExternalPackages: ["undici", "@google/genai"],
};

export default nextConfig;
