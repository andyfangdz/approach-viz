import type { NextConfig } from 'next';

const crossOriginIsolationDisabled = process.env.DISABLE_CROSS_ORIGIN_ISOLATION === '1';
const configuredCrossOriginEmbedderPolicy =
  process.env.CROSS_ORIGIN_EMBEDDER_POLICY?.trim().toLowerCase() ?? '';
const crossOriginEmbedderPolicy =
  configuredCrossOriginEmbedderPolicy === 'credentialless' ? 'credentialless' : 'require-corp';
const crossOriginIsolationHeaders = crossOriginIsolationDisabled
  ? []
  : [
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      // Safari reliably enables cross-origin isolation with `require-corp`;
      // opt into `credentialless` via CROSS_ORIGIN_EMBEDDER_POLICY=credentialless when needed.
      { key: 'Cross-Origin-Embedder-Policy', value: crossOriginEmbedderPolicy },
      { key: 'Origin-Agent-Cluster', value: '?1' }
    ];

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingIncludes: {
    '/*': [
      'data/approach-viz.sqlite',
      'fixtures/historical-approaches/*.json',
      'fixtures/historical-approaches/plates/*.PDF'
    ]
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
