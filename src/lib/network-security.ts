export class UnsafeEndpointError extends Error {
  readonly code = "UNSAFE_ENDPOINT";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeEndpointError";
  }
}

export function isPrivateOrMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "metadata.google.internal" || host === "169.254.169.254" || host === "::1") {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const second = Number(match172[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

export function assertSafeHttpEndpoint(input: {
  url: string;
  purpose: string;
  allowPrivate?: boolean;
}): URL {
  const parsed = new URL(input.url);
  if (parsed.username || parsed.password) {
    throw new UnsafeEndpointError(`${input.purpose} may not include embedded credentials.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeEndpointError(`${input.purpose} must use http or https.`);
  }
  if (isPrivateOrMetadataHost(parsed.hostname) && !input.allowPrivate) {
    throw new UnsafeEndpointError(`${input.purpose} rejected a private, loopback, link-local, or metadata endpoint.`);
  }
  return parsed;
}
