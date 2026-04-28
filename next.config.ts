import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "app/api/send-invoice/route": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
    ],
    "app/api/platform-prices/route": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
    ],
  },
};

export default nextConfig;
