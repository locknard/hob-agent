/**
 * The narrow OAuth seam owned by the DSH composition.
 *
 * DSH rc.7 exposes credential references and values, but its generic
 * `dsh-llm-pi-ai` adapter only accepts API-key routes and has no interactive
 * OAuth login/logout contract. This interface is therefore deliberately
 * provider-neutral: a future DSH OAuth adapter owns browser/callback/device
 * mechanics, while the product boundary owns profile selection, persistence,
 * expiry metadata, and redacted errors.
 */

export type DshOAuthPrompt =
  | { readonly type: "text" | "secret" | "manual_code"; readonly message: string; readonly placeholder?: string }
  | {
    readonly type: "select";
    readonly message: string;
    readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
  };

export type DshOAuthEvent =
  | { readonly type: "info" | "progress"; readonly message: string }
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | {
    readonly type: "device_code";
    readonly userCode: string;
    readonly verificationUri: string;
    readonly intervalSeconds?: number;
    readonly expiresInSeconds?: number;
  };

export interface DshOAuthInteraction {
  readonly signal?: AbortSignal;
  prompt(prompt: DshOAuthPrompt): Promise<string>;
  notify(event: DshOAuthEvent): void;
}

/** Canonical OAuth value exchanged at the DSH/provider boundary. */
export interface DshOAuthCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly [key: string]: unknown;
}

export interface DshOAuthLoginRequest {
  readonly provider: string;
  readonly profileId: string;
  readonly interaction: DshOAuthInteraction;
}

export interface DshOAuthLogoutRequest {
  readonly provider: string;
  readonly profileId: string;
  readonly credential?: DshOAuthCredential;
}

/**
 * Provider implementation supplied by a DSH composition.
 *
 * It does not receive a SecretVault or a pi object. Login returns a canonical
 * credential for the product persistence boundary; logout can optionally use
 * the current credential for provider-side revocation before local deletion.
 */
export interface DshOAuthProvider {
  login(request: DshOAuthLoginRequest): Promise<DshOAuthCredential>;
  logout(request: DshOAuthLogoutRequest): Promise<void>;
}

/** Fail-closed default until an upstream/provider-specific DSH OAuth adapter exists. */
export const unsupportedDshOAuthProvider: DshOAuthProvider = {
  async login(): Promise<DshOAuthCredential> {
    throw new Error("DSH interactive OAuth provider is not configured");
  },
  async logout(): Promise<void> {
    throw new Error("DSH interactive OAuth provider is not configured");
  },
};

export function isDshOAuthCredential(value: unknown): value is DshOAuthCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Record<string, unknown>;
  return credential.type === "oauth" &&
    typeof credential.access === "string" && credential.access.length > 0 &&
    typeof credential.refresh === "string" && credential.refresh.length > 0 &&
    typeof credential.expires === "number" && Number.isFinite(credential.expires);
}

/** Parses one SecretVault value without exposing token contents in failures. */
export function parseDshOAuthCredential(value: string): DshOAuthCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored OAuth credential is invalid");
  }
  if (!isDshOAuthCredential(parsed)) throw new Error("Stored OAuth credential is invalid");
  return parsed;
}
