import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingIncludes: {
    '/*': [
      'data/approach-viz.sqlite',
      'fixtures/historical-approaches/*.json',
      'fixtures/historical-approaches/plates/*.PDF'
    ]
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb'
    }
  }
};

export default nextConfig;
