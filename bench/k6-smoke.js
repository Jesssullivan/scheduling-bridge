// bench/k6-smoke.js — 100 req smoke test, 1 VU
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  iterations: 100,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(99)<8000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://ts-acuity-mw.ts.net:3001';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

export default function () {
  const res = http.get(`${BASE_URL}/services`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    tags: { target: __ENV.TARGET || 'unknown' },
  });
  check(res, {
    'status 200': (r) => r.status === 200,
    'services array present': (r) =>
      Array.isArray(r.json('services')) || Array.isArray(r.json()),
  });
  sleep(0.1);
}
