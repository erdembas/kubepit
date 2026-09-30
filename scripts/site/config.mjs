/** A Pages project path has no trailing slash; an empty path means a root site. */
export function pagesBasePath(value = process.env.NEXT_PUBLIC_BASE_PATH) {
  const path = value === undefined ? '/kubepit' : value.trim().replace(/\/+$/, '');
  if (path === '') return '';
  if (
    !/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('NEXT_PUBLIC_BASE_PATH must be an absolute URL path, e.g. /kubepit, or empty.');
  }
  return path;
}
