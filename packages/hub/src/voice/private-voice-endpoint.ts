export type PrivateVoiceTransport = "wyoming" | "openai_http";

/**
 * Produces the one persisted form of a private voice endpoint.
 *
 * OpenAI-compatible providers accept a service root or its conventional
 * `/v1` base and persist the service root. Wyoming remains a local transport
 * with an explicit port. Bearer credentials travel over HTTPS hostnames or
 * plaintext private-address literals, so DNS never decides where a plaintext
 * credential is sent.
 */
export function normalizePrivateVoiceEndpoint(
  transport: PrivateVoiceTransport,
  value: unknown,
  options: { readonly hasCredential?: boolean } = {},
): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2_048) {
    throw new TypeError("Voice endpoint is invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new TypeError("Voice endpoint is invalid");
  }
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new TypeError("Voice endpoint is invalid");
  }
  if (transport === "wyoming") {
    if (endpoint.protocol !== "wyoming:" || endpoint.port === "" || !isLocalVoiceHost(endpoint.hostname)
      || (endpoint.pathname !== "" && endpoint.pathname !== "/")) {
      throw new TypeError("Voice endpoint is invalid");
    }
    return endpoint.toString().replace(/\/$/u, "");
  }
  if (transport !== "openai_http" || (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || (endpoint.pathname !== "" && endpoint.pathname !== "/" && endpoint.pathname !== "/v1" && endpoint.pathname !== "/v1/")) {
    throw new TypeError("Voice endpoint is invalid");
  }
  if (endpoint.protocol === "http:" && options.hasCredential === true && !isPrivateAddressLiteral(endpoint.hostname)) {
    throw new TypeError("Voice endpoint is invalid");
  }
  endpoint.pathname = "/";
  return endpoint.toString().replace(/\/$/u, "");
}

function isLocalVoiceHost(value: string): boolean {
  const host = value.toLowerCase();
  return host === "localhost" || host === "[::1]" || host.endsWith(".local") || host.endsWith(".lan") || isPrivateAddressLiteral(host);
}

function isPrivateAddressLiteral(value: string): boolean {
  const host = value.toLowerCase();
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31);
  }
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (literal === "::1") return true;
  const first = /^[0-9a-f]{1,4}/u.exec(literal)?.[0];
  if (first === undefined || !literal.includes(":")) return false;
  const firstValue = Number.parseInt(first, 16);
  return (firstValue & 0xfe00) === 0xfc00 || (firstValue & 0xffc0) === 0xfe80;
}
