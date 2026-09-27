import { sleep } from './bus';
import { getDb } from './fixtures/db';
import { demoOpenApiDocument, demoOpenApiIndex } from './fixtures/openapi';
import { register, type MockArgs } from './registry';

/**
 * OpenAPI v3 for browser previews: a handcrafted subset (see
 * `fixtures/openapi.ts`) so schema completion, hovers, markers and the API
 * explorer work in `pnpm dev:ui`. Read-only, like the real commands.
 */
register({
  openapi_v3_index: async ({ clusterId }: MockArgs) => {
    await sleep(60);
    return demoOpenApiIndex(getDb(clusterId));
  },
  openapi_v3_document: async ({ clusterId, apiVersion }: MockArgs) => {
    await sleep(140);
    const doc = demoOpenApiDocument(getDb(clusterId), String(apiVersion));
    if (!doc) throw new Error(`${apiVersion} has no OpenAPI v3 document on this cluster`);
    // A copy, like a fresh IPC payload.
    return structuredClone(doc);
  },
});
