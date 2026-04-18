import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
	sendJson,
	sendSuccess,
	sendError,
	parseBody,
	BodyTooLargeError,
	DEFAULT_MAX_BODY_BYTES,
} from '../src/server/http.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock ServerResponse that captures writeHead + end calls. */
const mockRes = () => {
	let writtenStatus = 0;
	let writtenHeaders: Record<string, string> = {};
	let writtenBody = '';

	const res = {
		writeHead: (status: number, headers: Record<string, string>) => {
			writtenStatus = status;
			writtenHeaders = headers;
		},
		end: (body: string) => {
			writtenBody = body;
		},
		get status() {
			return writtenStatus;
		},
		get headers() {
			return writtenHeaders;
		},
		get body() {
			return JSON.parse(writtenBody);
		},
		get rawBody() {
			return writtenBody;
		},
	} as unknown as ServerResponse & {
		status: number;
		headers: Record<string, string>;
		body: unknown;
		rawBody: string;
	};

	return res;
};

/** Create a readable stream that emits the given string as the request body. */
const fakeReq = (body: string): IncomingMessage => {
	const stream = new Readable({
		read() {
			this.push(Buffer.from(body));
			this.push(null);
		},
	});
	return stream as unknown as IncomingMessage;
};

/** Create a readable stream from a Buffer. */
const fakeReqFromBuffer = (buf: Buffer): IncomingMessage => {
	const stream = new Readable({
		read() {
			this.push(buf);
			this.push(null);
		},
	});
	return stream as unknown as IncomingMessage;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendJson', () => {
	it('writes status and JSON content-type', () => {
		const res = mockRes();
		sendJson(res, 200, { success: true, data: 'ok' });
		expect(res.status).toBe(200);
		expect(res.headers['Content-Type']).toBe('application/json');
	});

	it('serializes body as JSON', () => {
		const res = mockRes();
		sendJson(res, 200, { success: true, data: { id: 1 } });
		expect(res.body).toEqual({ success: true, data: { id: 1 } });
	});

	it('sends error status codes', () => {
		const res = mockRes();
		sendJson(res, 503, {
			success: false,
			error: { tag: 'X', code: 'Y', message: 'Z' },
		});
		expect(res.status).toBe(503);
		expect(res.body).toEqual({
			success: false,
			error: { tag: 'X', code: 'Y', message: 'Z' },
		});
	});
});

describe('sendSuccess', () => {
	it('sends 200 with success envelope', () => {
		const res = mockRes();
		sendSuccess(res, [1, 2, 3]);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, data: [1, 2, 3] });
	});
});

describe('sendError', () => {
	it('maps SchedulingError to error envelope', () => {
		const res = mockRes();
		const err = {
			_tag: 'ScrapingError' as const,
			code: 'TIMEOUT',
			message: 'Page timed out',
		};
		sendError(res, 500, err as any);
		expect(res.body).toEqual({
			success: false,
			error: {
				tag: 'ScrapingError',
				code: 'TIMEOUT',
				message: 'Page timed out',
			},
		});
	});

	it('falls back to _tag when code is missing', () => {
		const res = mockRes();
		const err = { _tag: 'InfrastructureError' as const };
		sendError(res, 500, err as any);
		expect(res.body.error.code).toBe('InfrastructureError');
	});

	it('falls back to Unknown error when message is missing', () => {
		const res = mockRes();
		const err = { _tag: 'InfrastructureError' as const };
		sendError(res, 500, err as any);
		expect(res.body.error.message).toBe('Unknown error');
	});
});

describe('parseBody', () => {
	it('parses JSON from request stream', async () => {
		const req = fakeReq('{"name":"test"}');
		const result = await parseBody(req);
		expect(result).toEqual({ name: 'test' });
	});

	it('returns empty object for empty body', async () => {
		const req = fakeReq('');
		const result = await parseBody(req);
		expect(result).toEqual({});
	});

	it('throws SyntaxError on invalid JSON', async () => {
		const req = fakeReq('not-json');
		await expect(parseBody(req)).rejects.toThrow(SyntaxError);
	});

	it('throws BodyTooLargeError when body exceeds limit', async () => {
		const oversized = Buffer.alloc(200, 'x');
		const req = fakeReqFromBuffer(oversized);
		await expect(parseBody(req, 100)).rejects.toThrow(BodyTooLargeError);
	});

	it('accepts body exactly at limit', async () => {
		const body = JSON.stringify({ data: 'a'.repeat(50) });
		const req = fakeReq(body);
		const result = await parseBody(req, body.length);
		expect(result).toEqual({ data: 'a'.repeat(50) });
	});

	it('default limit is 1 MiB', () => {
		expect(DEFAULT_MAX_BODY_BYTES).toBe(1024 * 1024);
	});
});
