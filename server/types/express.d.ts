// Express Request augmentation for ServiceCycle.
// Properties attached by middleware (auth, apiKeyAuth, requestId, gpc).
import 'express';

declare global {
  namespace Express {
    interface Request {
      // Set by authenticateToken / optionalAuthenticateToken (middleware/auth.js).
      // Null when soft-auth finds no valid bearer.
      user?: {
        id: string;
        accountId?: string;
        name?: string | null;
        email?: string | null;
        role?: string;
        isActive?: boolean;
        contractScopeRestricted?: boolean;
      } | null;

      // Set by middleware/apiKeyAuth.js
      apiKey?: { id: string; name: string };
      apiKeyAccountId?: string;
      _apiKeyHashPrefix?: string;

      // Set by middleware/requestId.js
      requestId?: string;

      // Set by middleware/gpc.js (Sec-GPC header)
      gpc?: boolean;
    }
  }
}

export {};