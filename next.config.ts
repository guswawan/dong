import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable Turbopack by default
  experimental: {
    turbo: {
      rules: {
        "*.svg": {
          loaders: ["@svgr/webpack"],
          as: "*.js",
        },
      },
    },
  },
  // Standalone output for production
  output: "standalone",
  // Enable source maps for better debugging
  experimentalSourceMaps: true,
  // Optimize for development performance
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  // Webpack optimizations
  webpack: (config, { dev, isServer }) => {
    // Exclude unnecessary libraries from bundle
    if (!dev && !isServer) {
      config.externals = [
        ...(config.externals || []),
        {
          "hls.js": "hls.js",
          "dashjs": "dashjs",
        },
      ];
    }

    // Configure module rules for better performance
    config.module.rules = config.module.rules.map((rule) => {
      if (rule.test instanceof RegExp && rule.test.test(".tsx")) {
        return {
          ...rule,
          use: rule.use?.map((loader) => {
            if (typeof loader === "string" && loader.includes("babel-loader")) {
              return {
                loader: loader,
                options: {
                  cacheDirectory: true,
                  cacheCompression: false,
                },
              };
            }
            return loader;
          }),
        };
      }
      return rule;
    });

    return config;
  },
};

export default nextConfig;