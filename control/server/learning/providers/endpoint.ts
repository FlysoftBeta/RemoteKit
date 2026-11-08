export function providerEndpoint(input: string | URL): string {
  if (process.env.NODE_ENV === 'test') {
    const overrides = process.env.REMOTEKIT_TEST_LEARNING_ENDPOINTS;
    if (overrides) {
      const url = new URL(input);
      const endpoints = JSON.parse(overrides) as Record<string, string>;
      const base = endpoints[url.origin];
      if (base) return new URL(url.pathname + url.search, base).href;
    }
  }
  return String(input);
}
