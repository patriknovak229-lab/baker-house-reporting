import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "app/api/send-invoice/route": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
    ],
    // Include sharp's pre-built native binaries for HEIC conversion in extract + drive-upload
    "app/api/supplier-invoices/extract/route": [
      "./node_modules/sharp/build/Release/**/*",
    ],
    "app/api/supplier-invoices/drive-upload/route": [
      "./node_modules/sharp/build/Release/**/*",
    ],
  },
};

export default nextConfig;
