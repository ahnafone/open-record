import { Injectable, inject } from '@angular/core';
import type { AccessAction, AccessRequest, AccessStatus } from '@open-record/models';
import { AuthStore } from './auth.store';
import type { AuthProjectConfig } from './ports';
import { decideAccessRequest, listAccessRequests, submitAccessRequest } from './access-api';

/**
 * Access requests on the public server. `AccessRequestService.submit` is
 * public (anyone may ask, Turnstile-verified). `AccessAdminService` is for the
 * admin screen: it needs the signed-in admin's session, and the server rejects
 * everyone else with 403.
 */

/** Asks for access on the public server. */
@Injectable({ providedIn: 'root' })
export class AccessRequestService {
  private readonly auth = inject(AuthStore);

  /**
   * Submit a request. Resolves the address's status (`pending`, `approved`,
   * `denied` or `revoked`). Rejects with a user-facing message.
   */
  async submit(email: string, note: string, turnstileToken: string): Promise<AccessStatus> {
    const project = this.auth.project();
    if (!project) throw new Error('Access requests are not set up on this server.');
    const trimmedNote = note.trim();
    return submitAccessRequest(project, {
      email: email.trim(),
      ...(trimmedNote ? { note: trimmedNote } : {}),
      turnstileToken,
    });
  }
}

/** Admin screen calls. Requires the signed-in account to be the server's admin. */
@Injectable({ providedIn: 'root' })
export class AccessAdminService {
  private readonly auth = inject(AuthStore);

  /** Every access request, newest first. */
  async list(): Promise<AccessRequest[]> {
    const { project, token } = await this.session();
    return listAccessRequests(project, token);
  }

  /** Approve, deny or revoke a request; resolves the updated row. */
  async decide(id: string, action: AccessAction): Promise<AccessRequest> {
    const { project, token } = await this.session();
    return decideAccessRequest(project, token, id, action);
  }

  private async session(): Promise<{ project: AuthProjectConfig; token: string }> {
    const project = this.auth.project();
    const token = await this.auth.accessToken();
    if (!project || !token) throw new Error('Sign in to manage access requests.');
    return { project, token };
  }
}
