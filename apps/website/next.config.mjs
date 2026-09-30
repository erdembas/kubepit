import { pagesBasePath } from '../../scripts/site/config.mjs';

const basePath = pagesBasePath();

/** @type {import('next').NextConfig} */
export default {
  output: 'export',
  experimental: { globalNotFound: true },
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};
