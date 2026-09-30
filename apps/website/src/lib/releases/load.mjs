import {
  RELEASE_API,
  HOMEBREW_RAW_URL,
  HOMEBREW_URL,
  publishedReleaseCandidates,
  releaseMetadataEndpoints,
  validateReleasePair,
  validateHomebrew,
  sortReleases,
} from './model.mjs';

/** Bounded public requests. No account cookies or credentials are sent to GitHub or asset redirects. */
async function requestText(fetcher, url, signal, limit, accept) {
  const response = await fetcher(url, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { Accept: accept },
  });
  if (!response.ok) throw new Error(`Release metadata request failed (${response.status}).`);
  if (Number(response.headers.get('content-length')) > limit)
    throw new Error('Release metadata is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Release metadata body is unavailable.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Release metadata is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Refresh once, keeping only snapshot pairs that still match the live published asset list. */
export async function loadPublishedReleases(snapshot, options = {}) {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 12000);
  const signal = controller.signal;
  try {
    const text = await requestText(
      fetcher,
      RELEASE_API,
      signal,
      2 * 1024 * 1024,
      'application/vnd.github+json',
    );
    const api = JSON.parse(text);
    if (!Array.isArray(api)) throw new Error('Invalid release list.');
    const all = publishedReleaseCandidates(api);
    // Limit work while checking both channels; the first valid result per channel is offered.
    const candidates = [
      ...all.filter((item) => !item.prerelease).slice(0, 2),
      ...all.filter((item) => item.prerelease).slice(0, 2),
    ];
    let incomplete = false;
    const resolved = await Promise.all(
      candidates.map(async (release) => {
        const endpoints = releaseMetadataEndpoints(release);
        try {
          const [manifestText, checksums] = await Promise.all([
            requestText(
              fetcher,
              endpoints.manifest,
              signal,
              128 * 1024,
              'application/octet-stream',
            ),
            requestText(
              fetcher,
              endpoints.checksums,
              signal,
              128 * 1024,
              'application/octet-stream',
            ),
          ]);
          const result = validateReleasePair(release, JSON.parse(manifestText), checksums);
          if (!result) throw new Error('Release metadata does not match published assets.');
          return result;
        } catch {
          incomplete = true;
          for (const pair of snapshot.pairs) {
            const result = validateReleasePair(release, pair.manifest, pair.checksums);
            if (result) return result;
          }
          return null;
        }
      }),
    );
    const releases = sortReleases(resolved.filter(Boolean));
    let homebrew = null;
    if (releases.some((release) => release.homebrewCask)) {
      try {
        const content = await requestText(
          fetcher,
          HOMEBREW_RAW_URL,
          signal,
          64 * 1024,
          'text/plain',
        );
        for (const release of releases) {
          const verified = await validateHomebrew({ url: HOMEBREW_URL, content }, release);
          if (verified) {
            homebrew = verified;
            break;
          }
        }
      } catch {
        // A tap that cannot be checked is not advertised as installable.
      }
    }
    return {
      releases,
      homebrew,
      status: incomplete ? 'partial' : 'live',
      checkedAt: new Date().toISOString(),
    };
  } catch {
    let homebrew = null;
    for (const release of snapshot.releases) {
      try {
        const verified = await validateHomebrew(snapshot.homebrew, release);
        if (verified) {
          homebrew = verified;
          break;
        }
      } catch {
        /* WebCrypto unavailable: hide the command. */
      }
    }
    return {
      releases: snapshot.releases,
      homebrew,
      status: snapshot.releases.length ? 'snapshot' : 'unavailable',
      checkedAt: snapshot.checkedAt,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
