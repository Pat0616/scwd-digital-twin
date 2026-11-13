import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the Azure SDKs stay plain Node modules on the server (never bundled, never sent to the browser)
  serverExternalPackages: ["@azure/identity", "@azure/digital-twins-core"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
