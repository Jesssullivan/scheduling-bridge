import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyDiff,
  fetchWithHmac,
  runParityCheck,
  type SlotsResponse,
} from './check.js';

// ---------------------------------------------------------------------------
// classifyDiff — four classifier bands
// ---------------------------------------------------------------------------
describe('classifyDiff for /availability/slots', () => {
  const modal: SlotsResponse = {
    service_id: 's1',
    slots: [
      { start_iso: '2026-05-01T10:00:00Z' },
      { start_iso: '2026-05-01T11:00:00Z' },
    ],
  };

  it('OK when identical', () => {
    expect(classifyDiff(modal, modal).level).toBe('OK');
  });

  it('OK for ≤ 2 slot drift', () => {
    const k8s: SlotsResponse = {
      ...modal,
      slots: [...modal.slots, { start_iso: '2026-05-01T12:00:00Z' }],
    };
    expect(classifyDiff(modal, k8s).level).toBe('OK');
  });

  it('WARN for 3–5 slot drift', () => {
    const k8s: SlotsResponse = {
      service_id: 's1',
      slots: ['10', '11', '12', '13', '14'].map(h => ({
        start_iso: `2026-05-01T${h}:00:00Z`,
      })),
    };
    expect(classifyDiff(modal, k8s).level).toBe('WARN');
  });

  it('CRITICAL for > 5 slot drift', () => {
    const k8s: SlotsResponse = {
      service_id: 's1',
      slots: Array.from({ length: 10 }, (_, i) => ({
        start_iso: `2026-05-01T${String(i + 10).padStart(2, '0')}:00:00Z`,
      })),
    };
    expect(classifyDiff(modal, k8s).level).toBe('CRITICAL');
  });
});

// ---------------------------------------------------------------------------
// fetchWithHmac — signature shape + Bearer header
// ---------------------------------------------------------------------------
describe('fetchWithHmac signature shape', () => {
  const SECRET = 'test-secret-abc';
  const BASE = 'https://modal.example.internal';
  const PATH = '/availability/slots?service=99&date=2026-05-01';
  const BEARER = 'my-bearer-token';

  let capturedRequest: Request | undefined;
  let restoreFetch: typeof globalThis.fetch;

  beforeEach(() => {
    restoreFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest = new Request(input, init);
      return new Response(JSON.stringify({ service_id: '99', slots: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    globalThis.fetch = restoreFetch;
  });

  it('sends X-Timestamp, X-Signature, and Authorization: Bearer headers', async () => {
    await fetchWithHmac(BASE, PATH, SECRET, BEARER);

    expect(capturedRequest).toBeDefined();
    const ts = capturedRequest!.headers.get('X-Timestamp');
    const sig = capturedRequest!.headers.get('X-Signature');
    const auth = capturedRequest!.headers.get('Authorization');

    expect(ts).not.toBeNull();
    expect(sig).not.toBeNull();
    expect(auth).toBe(`Bearer ${BEARER}`);

    // Independently recompute expected HMAC: bodyHash = sha256('') for bodyless GET.
    const emptyBodyHash = createHash('sha256').update('').digest('hex');
    const expected = createHmac('sha256', SECRET)
      .update(`${ts}${PATH}${emptyBodyHash}`)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  it('omits Authorization header when no bearerToken supplied', async () => {
    await fetchWithHmac(BASE, PATH, SECRET);

    expect(capturedRequest!.headers.get('Authorization')).toBeNull();
    expect(capturedRequest!.headers.get('X-Signature')).not.toBeNull();
  });

  it('sends POST with Content-Type JSON and stringified body when body provided', async () => {
    const body = { service_id: '99', date: '2026-05-01' };
    await fetchWithHmac(BASE, '/availability/slots', SECRET, undefined, body);

    expect(capturedRequest!.method).toBe('POST');
    expect(capturedRequest!.headers.get('Content-Type')).toBe('application/json');

    // Verify body was serialized and sent
    const sent = await capturedRequest!.text();
    expect(sent).toBe(JSON.stringify(body));
  });

  it('canonical string includes body hash: signatures differ with/without body', async () => {
    // Freeze time so timestamps match between the two calls
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'));

    try {
      let sigNoBody: string | null = null;
      let sigWithBody: string | null = null;
      let sigEmptyBodyObj: string | null = null;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const s = req.headers.get('X-Signature');
        // Order of capture matches order of calls below
        if (sigNoBody === null) sigNoBody = s;
        else if (sigWithBody === null) sigWithBody = s;
        else sigEmptyBodyObj = s;
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      // Call 1: no body (GET)
      await fetchWithHmac(BASE, '/availability/slots', SECRET);
      // Call 2: with body (POST)
      await fetchWithHmac(BASE, '/availability/slots', SECRET, undefined, { service_id: '99', date: '2026-05-01' });
      // Call 3: with explicit empty-string-equivalent body — JSON.stringify('') === '""', so this MUST differ from Call 1.
      // To verify the "empty body vs no body" equivalence, we pass an empty object and compare against no body separately.

      expect(sigNoBody).not.toBeNull();
      expect(sigWithBody).not.toBeNull();
      // Different bodies → different signatures
      expect(sigWithBody).not.toBe(sigNoBody);

      // And: "no body at all" vs "body = undefined" should produce the same canonical string
      // (both take the bodyHash of ''). Re-run the no-body path a second time to confirm stable output.
      sigEmptyBodyObj = null;
      await fetchWithHmac(BASE, '/availability/slots', SECRET);
      expect(sigEmptyBodyObj).toBe(sigNoBody);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// runParityCheck — happy path and error path
// ---------------------------------------------------------------------------
describe('runParityCheck', () => {
  const makeSlotPayload = (slots: string[]): SlotsResponse => ({
    service_id: 'svc1',
    slots: slots.map(s => ({ start_iso: s })),
  });

  const happyPayload = makeSlotPayload([
    '2026-05-01T10:00:00Z',
    '2026-05-01T11:00:00Z',
  ]);

  let restoreFetch: typeof globalThis.fetch;

  beforeEach(() => {
    restoreFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = restoreFetch;
  });

  it('happy path: identical payloads → classification OK with all structured fields', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(happyPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const results = await runParityCheck({
      modalUrl: 'https://modal.internal',
      k8sUrl: 'https://k8s.internal',
      hmacSecret: 'secret',
      serviceIds: ['svc1'],
      dateHorizonDays: 0,
    });

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.level).toBe('OK');
    expect(r.service).toBe('svc1');
    expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.modalCount).toBe(2);
    expect(r.k8sCount).toBe(2);
    expect(typeof r.detail).toBe('string');
  });

  it('error path: K8s fetch throws → emits CRITICAL rather than crashing', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      callCount++;
      if (url.startsWith('https://k8s.internal')) {
        throw new Error('connection refused');
      }
      return new Response(JSON.stringify(happyPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const results = await runParityCheck({
      modalUrl: 'https://modal.internal',
      k8sUrl: 'https://k8s.internal',
      hmacSecret: 'secret',
      serviceIds: ['svc1'],
      dateHorizonDays: 0,
    });

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.level).toBe('CRITICAL');
    expect(r.detail).toMatch(/fetch error/);
    expect(r.service).toBe('svc1');
    // modalCount / k8sCount are sentinel -1 on error
    expect(r.modalCount).toBe(-1);
    expect(r.k8sCount).toBe(-1);
  });
});
