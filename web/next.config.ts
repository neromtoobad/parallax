import type { NextConfig } from 'next';

const api = process.env.PARALLAX_API_URL ?? 'http://127.0.0.1:8787';

const config: NextConfig = {
  // The job page streams events; gzip would buffer them.
  compress: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default config;
