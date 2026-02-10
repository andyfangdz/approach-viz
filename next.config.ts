import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['nexrad-level-3-data'],
  outputFileTracingIncludes: {
    '/*': ['data/approach-viz.sqlite']
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb'
    }
  }
};

export default nextConfig;
