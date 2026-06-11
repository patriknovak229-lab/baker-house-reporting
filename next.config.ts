import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "app/api/send-invoice/route": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
    ],
    "app/api/platform-prices/route": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
    ],
    // AI reply composer reads the property knowledge base at runtime — make
    // sure the markdown ships inside the webhook's serverless bundle.
    "app/api/webhook/beds24-message/route": [
      "./data/ai-knowledge-base.md",
    ],
  },
};

export default nextConfig;
