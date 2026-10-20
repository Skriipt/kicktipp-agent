/** Optional process policy. Selection alone (KICKTIPP_PROFILE) is not a lock. */
export function lockedProfile(): string | null {
  return process.env.KICKTIPP_PROFILE_LOCK || null;
}

export class ProfilePolicyError extends Error {
  constructor(message = 'This action is disabled while the Auth Profile is locked.') {
    super(message);
    this.name = 'ProfilePolicyError';
  }
}

export function assertProfileAllowed(profileId: string | null): void {
  const locked = lockedProfile();
  if (locked && profileId !== locked) {
    throw new ProfilePolicyError('The requested Auth Profile is not allowed by this process.');
  }
}

/** Locked deployments use pre-provisioned accounts and cannot act as an admin. */
export function assertProfileUnlocked(): void {
  if (lockedProfile()) throw new ProfilePolicyError();
}
