import { describe, expect, it } from 'vitest';
import { classifyDiff, type SlotsResponse } from './check.js';

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
