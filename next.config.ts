import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module and must not be bundled by webpack.
  // Marking it as external ensures Next.js loads it from node_modules at runtime.
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
