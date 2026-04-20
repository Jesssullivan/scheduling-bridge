// bench/k6-load-10k.js — ~10k req sustained load test
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

export const options = {
  stages: [
    { duration: '8m', target: 20 }, // 20 VUs sustained for 8 min
    { duration: '30s', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(99)<15000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://ts-acuity-mw.ts.net:3001';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const EXPECTED_CACHE_HIT_RATIO = parseFloat(
  __ENV.EXPECTED_CACHE_HIT_RATIO || '0.8'
);

// Service IDs to rotate through for /availability/slots requests
const RAW_IDS = __ENV.SERVICE_IDS || '1,2,3,4,5';
const SERVICE_IDS = RAW_IDS.split(',').map((s) => s.trim());

// Custom metric: track cache-hit-indicative fast responses (<200ms)
const fastResponses = new Rate('cache_hint_fast_response');

// Simple date helper: YYYY-MM-DD for tomorrow
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

export default function () {
  const headers = { Authorization: `Bearer ${AUTH_TOKEN}` };
  const tag = { target: __ENV.TARGET || 'unknown' };

  // Alternate between /services and /availability/slots
  const iteration = __ITER % 2;
  if (iteration === 0) {
    const res = http.get(`${BASE_URL}/services`, { headers, tags: tag });
    check(res, {
      'status 200': (r) => r.status === 200,
      'services array present': (r) =>
        Array.isArray(r.json('services')) || Array.isArray(r.json()),
    });
    fastResponses.add(res.timings.duration < 200);
  } else {
    // __ITER is always odd in this branch; using `__ITER % length` skips
    // half the services when `SERVICE_IDS.length` is even. `Math.floor(__ITER / 2)`
    // gives a dense 0,0,1,1,2,2,... index that rotates through every entry.
    const serviceId = SERVICE_IDS[Math.floor(__ITER / 2) % SERVICE_IDS.length];
    const date = tomorrow();
    const res = http.get(
      `${BASE_URL}/availability/slots?serviceId=${serviceId}&date=${date}`,
      { headers, tags: tag }
    );
    check(res, {
      'status 200': (r) => r.status === 200,
    });
    fastResponses.add(res.timings.duration < 200);
  }

  sleep(0.05);
}

export function teardown() {
  // Log expected vs observed cache-hit proxy at teardown.
  // k6 does not expose aggregated custom metric values in teardown,
  // so this is a reminder note only — inspect cache_hint_fast_response
  // in the summary JSON to compare against EXPECTED_CACHE_HIT_RATIO.
  console.log(
    `Expected cache-hit ratio proxy: ${EXPECTED_CACHE_HIT_RATIO}. ` +
      `Check 'cache_hint_fast_response' in summary JSON for observed value.`
  );
}
