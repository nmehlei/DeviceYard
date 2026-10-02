import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true }, // no Image Optimization API available under static export; artifact
                                  // screenshots are served by the existing GET /api/artifacts/:id route
                                  // via plain <img>, not next/image, so this only affects future usage.
};

export default nextConfig;
