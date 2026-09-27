// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MockArgs = Record<string, any>;
export type MockHandler = (args: MockArgs) => unknown;

/** Command name → demo implementation. Domain files register themselves here. */
export const handlers: Record<string, MockHandler> = {};

export function register(table: Record<string, MockHandler>) {
  Object.assign(handlers, table);
}
