export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/kubepit';
export const repository = 'https://github.com/erdembas/kubepit';
export const demo = `${basePath}/demo/`;
export const asset = (path: string) => `${basePath}/${path}`;
export const siteOrigin = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? 'https://erdembas.github.io';
