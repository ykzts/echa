import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    typedEnv: true,
  },
  typedRoutes: true,
};

export default nextConfig;
