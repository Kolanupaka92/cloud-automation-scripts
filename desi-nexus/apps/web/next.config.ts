import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Vendor portfolio media is served from S3 behind CloudFront; nothing else
  // is allowed to become an image source by accident.
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**.cloudfront.net" }],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
          { key: "x-frame-options", value: "DENY" },
          {
            key: "strict-transport-security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default config;
