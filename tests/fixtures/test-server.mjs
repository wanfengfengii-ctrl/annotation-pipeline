export function testServer(
  value = process.env.PIPELINE_API_URL || 'http://localhost:3001',
) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.port !== '3001' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error(
      'Integration fixtures must use the isolated local test server on port 3001; production URLs are blocked',
    );
  return url.origin;
}
export const base = testServer();
