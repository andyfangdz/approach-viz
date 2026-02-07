import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
