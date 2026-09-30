export async function github(
  path,
  { method = 'GET', body, token = process.env.GH_TOKEN, binary = false } = {},
) {
  if (!token) throw new Error('GH_TOKEN is required');
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const error = new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204
    ? null
    : binary
      ? Buffer.from(await response.arrayBuffer())
      : response.json();
}
