import type { HttpClient } from '../http.js';
import type { ApiKeyIdentity, SingleResponse } from '../types.js';

export class IdentityResource {
  constructor(private readonly http: HttpClient) {}

  /** Returns the authenticated API key's metadata. Use as a credential health check. */
  async me(): Promise<ApiKeyIdentity> {
    const response = await this.http.get<SingleResponse<ApiKeyIdentity>>('/me');
    return response.data;
  }
}
