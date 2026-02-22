import type { NextConfig } from 'next';

const crossOriginIsolationDisabled = process.env.DISABLE_CROSS_ORIGIN_ISOLATION === '1';
const crossOriginIsolationHeaders = crossOriginIsolationDisabled
  ? []
  : [
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      // `credentialless` preserves broader third-party compatibility than `require-corp`.
      { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
      { key: 'Origin-Agent-Cluster', value: '?1' }
    ];

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingIncludes: {
    '/*': ['data/approach-viz.sqlite']
  },
  async headers() {
    if (crossOriginIsolationHeaders.length === 0) {
      return [];
    }
    return [
      {
        source: '/:path*',
        headers: crossOriginIsolationHeaders
      }
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb'
    }
  }
};

export default nextConfig;
