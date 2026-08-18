/**
 * Process-local single-flight guard for refresh-token rotation. Providers that
 * invalidate a refresh token after use must never receive simultaneous refresh
 * requests for the same profile.
 */
export class OAuthRefreshCoordinator {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<T>(profileId: string, refresh: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(profileId) as Promise<T> | undefined;
    if (existing) return existing;

    const pending = Promise.resolve().then(refresh);
    this.inFlight.set(profileId, pending);
    void pending.then(
      () => this.clear(profileId, pending),
      () => this.clear(profileId, pending),
    );
    return pending;
  }

  private clear(profileId: string, pending: Promise<unknown>): void {
    if (this.inFlight.get(profileId) === pending) this.inFlight.delete(profileId);
  }
}
