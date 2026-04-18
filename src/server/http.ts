/**
 * HTTP Primitives
 *
 * Extracted from handler.ts for testability and K8s hardening.
 * - parseBody enforces a max size limit to prevent OOM in constrained pods.
 * - Response helpers produce the standard bridge protocol JSON envelope.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SchedulingError } from '../core/types.js';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface SuccessResponse<T> {
	readonly success: true;
	readonly data: T;
}

export interface ErrorResponse {
	readonly success: false;
	readonly error: {
		readonly tag: string;
		readonly code: string;
		readonly message: string;
	};
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export const sendJson = (
	res: ServerResponse,
	status: number,
	body: SuccessResponse<unknown> | ErrorResponse,
): void => {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
};

export const sendSuccess = <T>(res: ServerResponse, data: T): void =>
	sendJson(res, 200, { success: true, data });

export const sendError = (res: ServerResponse, status: number, err: SchedulingError): void =>
	sendJson(res, status, {
		success: false,
		error: {
			tag: err._tag,
			code: 'code' in err ? (err as { code: string }).code : err._tag,
			message: 'message' in err ? (err as { message: string }).message : 'Unknown error',
		},
	});

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/** Default max body size: 1 MiB. Booking payloads are typically < 2 KiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
	readonly code = 'BODY_TOO_LARGE';
	constructor(limit: number) {
		super(`Request body exceeds ${limit} byte limit`);
		this.name = 'BodyTooLargeError';
	}
}

/**
 * Parse the request body as JSON with a byte-size safety valve.
 *
 * In a K8s pod with constrained memory (e.g., 256 Mi), an unbounded
 * body read can trigger an OOM kill. The limit prevents that.
 */
export const parseBody = async (
	req: IncomingMessage,
	maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> => {
	const chunks: Buffer[] = [];
	let totalBytes = 0;

	for await (const chunk of req) {
		totalBytes += (chunk as Buffer).length;
		if (totalBytes > maxBytes) {
			// Destroy the stream to stop reading
			req.destroy();
			throw new BodyTooLargeError(maxBytes);
		}
		chunks.push(chunk as Buffer);
	}

	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? JSON.parse(raw) : {};
};
