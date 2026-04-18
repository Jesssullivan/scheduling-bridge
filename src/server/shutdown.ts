/**
 * Graceful Shutdown
 *
 * Handles SIGTERM/SIGINT for clean K8s pod termination:
 *   1. Stop accepting new connections
 *   2. Wait for in-flight requests to drain (with timeout)
 *   3. Close Redis and browser pool
 *   4. Exit with code 0
 *
 * Without this, K8s hard-kills the pod after terminationGracePeriodSeconds.
 */

import type { Server } from 'node:http';

export interface ShutdownDeps {
	/** Node HTTP server to close */
	readonly server: Server;
	/** Dispose the ManagedRuntime browser pool */
	readonly disposeBrowser: () => void;
	/** Close the Redis client */
	readonly disposeRedis: () => void;
	/** Structured logger */
	readonly log: (level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) => void;
}

export interface ShutdownConfig {
	/** Max time to wait for in-flight requests before force-closing (ms) */
	readonly drainTimeoutMs: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

/**
 * Register SIGTERM and SIGINT handlers for graceful shutdown.
 * Returns a cleanup function that removes the handlers (useful for tests).
 */
export const registerGracefulShutdown = (
	deps: ShutdownDeps,
	config: ShutdownConfig = { drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS },
): (() => void) => {
	let shutdownInProgress = false;

	const shutdown = (signal: string) => {
		if (shutdownInProgress) return;
		shutdownInProgress = true;

		deps.log('INFO', `Received ${signal}, starting graceful shutdown`, {
			event: 'shutdown_initiated',
			signal,
			drainTimeoutMs: config.drainTimeoutMs,
		});

		// Force-exit safety net — if drain hangs, exit before K8s kills us
		const forceTimer = setTimeout(() => {
			deps.log('WARN', 'Drain timeout exceeded, forcing exit', {
				event: 'shutdown_forced',
				drainTimeoutMs: config.drainTimeoutMs,
			});
			process.exit(1);
		}, config.drainTimeoutMs);

		// Unref so the timer doesn't keep the event loop alive if we exit cleanly
		forceTimer.unref();

		// Stop accepting new connections, wait for in-flight to finish
		deps.server.close(() => {
			deps.log('INFO', 'HTTP server closed, disposing resources', {
				event: 'server_closed',
			});

			deps.disposeBrowser();
			deps.disposeRedis();

			deps.log('INFO', 'Graceful shutdown complete', {
				event: 'shutdown_complete',
				signal,
			});

			clearTimeout(forceTimer);
			process.exit(0);
		});
	};

	const onSigterm = () => shutdown('SIGTERM');
	const onSigint = () => shutdown('SIGINT');

	process.on('SIGTERM', onSigterm);
	process.on('SIGINT', onSigint);

	// Return cleanup for tests
	return () => {
		process.removeListener('SIGTERM', onSigterm);
		process.removeListener('SIGINT', onSigint);
	};
};
