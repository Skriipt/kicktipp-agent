import type { Page } from './page.js';

/** The session is gone or was never valid — logging in again may help. */
export class AuthError extends Error {}
/** The page does not exist — usually a wrong community name. */
export class NotFoundError extends Error {}
/** The page requires Spielleiter rights, not a fresh login. */
export class AdminRequiredError extends Error {}

/** Validate the response before an authenticated page is parsed as data. */
export function assertReadable(page: Page, url: string): void {
  if (page.isAdminRequired()) {
    throw new AdminRequiredError(`Spielleiter (admin) rights are required for ${url}.`);
  }
  if (page.status() === 401 || page.isAuthRedirect() || page.has('input[type="password"]')) {
    throw new AuthError(`Kicktipp session is not authenticated (at ${page.url()}). Verify credentials.`);
  }
  if (page.isNotFound()) {
    throw new NotFoundError(`Kicktipp page not found: ${url}. Check the community name.`);
  }
  if (page.status() < 200 || page.status() >= 300) {
    throw new Error(`Kicktipp HTTP ${page.status()} while loading ${url}.`);
  }
}
