import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Lucide ships ~1,500 icon modules. Barrel optimization rewrites the imports
  // so only the icons actually referenced reach the client bundle.
  experimental: {
    optimizePackageImports: ['lucide-react', '@xyflow/react'],
  },
  // `pg` is only reachable from the optional Postgres store adapter; keep it out
  // of the client graph entirely.
  serverExternalPackages: ['pg'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
