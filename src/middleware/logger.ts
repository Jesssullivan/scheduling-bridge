/**
 * Structured NDJSON Logger
 *
 * Provides two logging mechanisms:
 * 1. Effect Logger (for code inside Effect.gen) — uses Effect's Logger API
 * 2. ndjsonLog() standalone helper (for plain async handlers outside Effect)
 *
 * Both emit JSON lines to stdout/stderr, compatible with Modal's log capture.
 */

import { Logger, Layer, HashMap } from 'effect';

// =============================================================================
// EFFECT LOGGER (for inside Effect programs)
// =============================================================================

/**
 * JSON-line logger that writes structured entries to stdout/stderr.
 * Integrates with Effect.logInfo, Effect.logWarning, Effect.logError, etc.
 */
const JsonLogger = Logger.make(({ logLevel, message, annotations, date }) => {
	const entry: Record<string, unknown> = {
		ts: date.toISOString(),
		level: logLevel.label.toUpperCase(),
		msg: typeof message === 'string' ? message : JSON.stringify(message),
	};

	// Merge annotations as top-level fields
	if (!HashMap.isEmpty(annotations)) {
		for (const [key, value] of HashMap.toEntries(annotations)) {
			entry[key] = value;
		}
	}

	const line = JSON.stringify(entry) + '\n';

	if (logLevel.ordinal >= 40000) { // Error, Fatal
		process.stderr.write(line);
	} else {
		process.stdout.write(line);
	}
});

/**
 * Effect Layer that replaces the default logger with NDJSON output.
 * Add to your layer composition: `Layer.merge(BrowserServiceLive(...), LoggerLive)`
 */
export const LoggerLive: Layer.Layer<never> = Logger.replace(Logger.defaultLogger, JsonLogger);

// =============================================================================
// STANDALONE LOGGER (for plain async code outside Effect)
// =============================================================================

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Write a structured NDJSON log entry.
 * Use this in plain async handlers that are NOT inside Effect programs.
 *
 * @example
 * ndjsonLog('INFO', 'Request received', { endpoint: '/services', serviceId: '123' });
 */
export const ndjsonLog = (
	level: LogLevel,
	msg: string,
	data?: Record<string, unknown>,
): void => {
	const entry: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level,
		msg,
		...data,
	};

	const line = JSON.stringify(entry) + '\n';

	if (level === 'ERROR') {
		process.stderr.write(line);
	} else {
		process.stdout.write(line);
	}
};
