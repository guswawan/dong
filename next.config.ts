import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for production
  output: "standalone",
  // Optimize for development performance
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
};

export default nextConfig;