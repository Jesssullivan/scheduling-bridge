/**
 * Auth Middleware
 *
 * Pure-function auth check extracted from handler.ts for testability.
 * K8s probe paths (/health, /ready, /metrics) bypass auth so kubelet
 * liveness/readiness probes and Prometheus scrapers work without tokens.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthResult {
	readonly authorized: boolean;
}

export interface AuthRejection extends AuthResult {
	readonly authorized: false;
	readonly statusCode: number;
	readonly body: {
		readonly success: false;
		readonly error: {
			readonly tag: string;
			readonly code: string;
			readonly message: string;
		};
	};
}

export interface AuthSuccess extends AuthResult {
	readonly authorized: true;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Paths that bypass Bearer-token auth (K8s probes + Prometheus scraper). */
export const UNAUTHENTICATED_PATHS = new Set(['/health', '/ready', '/metrics']);

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------

/**
 * Check whether a request is authorized.
 *
 * Returns `{ authorized: true }` when:
 *   - No AUTH_TOKEN is configured (auth disabled)
 *   - The request path is in the unauthenticated set
 *   - The Authorization header matches `Bearer <token>`
 *
 * Returns `{ authorized: false, statusCode, body }` otherwise,
 * providing a ready-to-send HTTP error response.
 */
export const checkAuth = (
	authToken: string | undefined,
	path: string,
	authorizationHeader: string | undefined,
	unauthenticatedPaths: ReadonlySet<string> = UNAUTHENTICATED_PATHS,
): AuthSuccess | AuthRejection => {
	// No auth token configured — all requests pass
	if (!authToken) {
		return { authorized: true };
	}

	// Probe/scraper paths bypass auth
	if (unauthenticatedPaths.has(path)) {
		return { authorized: true };
	}

	// Check Bearer token
	if (authorizationHeader === `Bearer ${authToken}`) {
		return { authorized: true };
	}

	return {
		authorized: false,
		statusCode: 401,
		body: {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'UNAUTHORIZED',
				message: 'Invalid auth token',
			},
		},
	};
};
