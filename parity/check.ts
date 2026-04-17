// parity/check.ts
import { createHmac } from 'node:crypto';

export interface Slot { start_iso: string }
export interface SlotsResponse { service_id: string; slots: Slot[] }
export type DiffLevel = 'OK' | 'WARN' | 'CRITICAL';
export interface DiffResult { level: DiffLevel; detail: string }

const sign = (secret: string, path: string, ts: string): string =>
  createHmac('sha256', secret).update(`${ts}${path}`).digest('hex');

export const classifyDiff = (modal: SlotsResponse, k8s: SlotsResponse): DiffResult => {
  const modalSet = new Set(modal.slots.map(s => s.start_iso));
  const k8sSet = new Set(k8s.slots.map(s => s.start_iso));
  const onlyModal = [...modalSet].filter(s => !k8sSet.has(s));
  const onlyK8s = [...k8sSet].filter(s => !modalSet.has(s));
  const drift = onlyModal.length + onlyK8s.length;

  if (drift <= 2) return { level: 'OK', detail: `drift=${drift}` };
  if (drift <= 5) return { level: 'WARN', detail: `drift=${drift}, onlyModal=${onlyModal.length}, onlyK8s=${onlyK8s.length}` };
  return { level: 'CRITICAL', detail: `drift=${drift}, onlyModal=${onlyModal.length}, onlyK8s=${onlyK8s.length}` };
};

const fetchWithHmac = async (base: string, path: string, secret: string): Promise<unknown> => {
  const ts = Date.now().toString();
  const res = await fetch(`${base}${path}`, {
    headers: {
      'X-Timestamp': ts,
      'X-Signature': sign(secret, path, ts),
    },
  });
  if (!res.ok) throw new Error(`${base}${path} → ${res.status}`);
  return res.json();
};

export interface ParityConfig {
  modalUrl: string;
  k8sUrl: string;
  hmacSecret: string;
  serviceIds: string[];
  dateHorizonDays: number;
}

export const runParityCheck = async (cfg: ParityConfig): Promise<DiffResult[]> => {
  const results: DiffResult[] = [];
  const today = new Date();
  for (const sid of cfg.serviceIds) {
    for (let d = 0; d <= cfg.dateHorizonDays; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() + d);
      const iso = date.toISOString().slice(0, 10);
      const path = `/availability/slots?service=${sid}&date=${iso}`;
      try {
        const modal = (await fetchWithHmac(cfg.modalUrl, path, cfg.hmacSecret)) as SlotsResponse;
        const k8s = (await fetchWithHmac(cfg.k8sUrl, path, cfg.hmacSecret)) as SlotsResponse;
        results.push(classifyDiff(modal, k8s));
      } catch (e) {
        results.push({ level: 'CRITICAL', detail: `fetch error: ${String(e)}` });
      }
    }
  }
  return results;
};

// CLI entry point (skip in tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  (async (): Promise<void> => {
    const results = await runParityCheck({
      modalUrl: process.env.MODAL_URL!,
      k8sUrl: process.env.K8S_URL!,
      hmacSecret: process.env.HMAC_SECRET!,
      serviceIds: (process.env.SERVICE_IDS ?? '').split(',').filter(Boolean),
      dateHorizonDays: Number(process.env.DATE_HORIZON ?? 14),
    });

    for (const r of results) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), ...r }));
    }
    const critical = results.filter(r => r.level === 'CRITICAL').length;
    process.exit(critical > 0 ? 2 : 0);
  })().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
