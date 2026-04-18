import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { registerGracefulShutdown, type ShutdownDeps } from '../src/server/shutdown.js';
import { EventEmitter } from 'node:events';

describe('graceful shutdown', () => {
	let mockServer: EventEmitter & { close: ReturnType<typeof vi.fn> };
	let disposeBrowser: ReturnType<typeof vi.fn>;
	let disposeRedis: ReturnType<typeof vi.fn>;
	let log: ReturnType<typeof vi.fn>;
	let deps: ShutdownDeps;
	let cleanup: () => void;

	// Capture real process.exit and prevent it from killing the test runner
	const realExit = process.exit;

	beforeEach(() => {
		mockServer = Object.assign(new EventEmitter(), {
			close: vi.fn((cb?: () => void) => {
				// Simulate immediate close
				if (cb) cb();
			}),
		});
		disposeBrowser = vi.fn();
		disposeRedis = vi.fn();
		log = vi.fn();
		deps = {
			server: mockServer as any,
			disposeBrowser,
			disposeRedis,
			log,
		};
		// Mock process.exit to prevent test runner death
		process.exit = vi.fn() as any;
	});

	afterEach(() => {
		if (cleanup) cleanup();
		process.exit = realExit;
	});

	it('registers SIGTERM and SIGINT handlers', () => {
		const listenersBefore = process.listenerCount('SIGTERM');
		cleanup = registerGracefulShutdown(deps);
		expect(process.listenerCount('SIGTERM')).toBe(listenersBefore + 1);
		expect(process.listenerCount('SIGINT')).toBe(listenersBefore + 1);
	});

	it('cleanup removes signal handlers', () => {
		const listenersBefore = process.listenerCount('SIGTERM');
		cleanup = registerGracefulShutdown(deps);
		cleanup();
		expect(process.listenerCount('SIGTERM')).toBe(listenersBefore);
	});

	it('closes server on SIGTERM', () => {
		cleanup = registerGracefulShutdown(deps);
		process.emit('SIGTERM');

		expect(mockServer.close).toHaveBeenCalledOnce();
		expect(disposeBrowser).toHaveBeenCalledOnce();
		expect(disposeRedis).toHaveBeenCalledOnce();
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it('closes server on SIGINT', () => {
		cleanup = registerGracefulShutdown(deps);
		process.emit('SIGINT');

		expect(mockServer.close).toHaveBeenCalledOnce();
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it('ignores duplicate signals', () => {
		cleanup = registerGracefulShutdown(deps);
		process.emit('SIGTERM');
		process.emit('SIGTERM');

		// Should only close once
		expect(mockServer.close).toHaveBeenCalledOnce();
	});

	it('logs shutdown lifecycle events', () => {
		cleanup = registerGracefulShutdown(deps);
		process.emit('SIGTERM');

		const events = log.mock.calls.map((c: unknown[]) => (c[2] as any)?.event);
		expect(events).toContain('shutdown_initiated');
		expect(events).toContain('server_closed');
		expect(events).toContain('shutdown_complete');
	});

	it('logs the signal name in shutdown_initiated', () => {
		cleanup = registerGracefulShutdown(deps);
		process.emit('SIGTERM');

		const initiatedCall = log.mock.calls.find(
			(c: unknown[]) => (c[2] as any)?.event === 'shutdown_initiated',
		);
		expect(initiatedCall?.[2]).toEqual(
			expect.objectContaining({ signal: 'SIGTERM' }),
		);
	});

	it('accepts custom drain timeout', () => {
		cleanup = registerGracefulShutdown(deps, { drainTimeoutMs: 5000 });
		process.emit('SIGTERM');

		const initiatedCall = log.mock.calls.find(
			(c: unknown[]) => (c[2] as any)?.event === 'shutdown_initiated',
		);
		expect(initiatedCall?.[2]).toEqual(
			expect.objectContaining({ drainTimeoutMs: 5000 }),
		);
	});

	it('disposes browser and redis after server closes', () => {
		// Make server.close async
		mockServer.close = vi.fn();
		cleanup = registerGracefulShutdown(deps);
		process.emit('SIGTERM');

		// Before close callback fires, resources should NOT be disposed
		expect(disposeBrowser).not.toHaveBeenCalled();
		expect(disposeRedis).not.toHaveBeenCalled();

		// Simulate server finishing drain
		const closeCallback = mockServer.close.mock.calls[0][0] as () => void;
		closeCallback();

		expect(disposeBrowser).toHaveBeenCalledOnce();
		expect(disposeRedis).toHaveBeenCalledOnce();
	});
});
