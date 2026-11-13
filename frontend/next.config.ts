import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The repo root has its own pnpm-lock.yaml (for the db/ scripts), so pin the
  // workspace root to this app instead of letting Next.js infer the repo root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
