import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    outputFileTracingIncludes: {
      "app/api/send-invoice/route": [
        "./node_modules/@sparticuz/chromium/bin/**/*",
      ],
    },
  },
};

export default nextConfig;
