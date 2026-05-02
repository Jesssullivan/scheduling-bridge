import IORedisMock from "ioredis-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BRIDGE_READ_CACHE_DEFAULTS,
  runBridgeReadCached,
  type BridgeReadCacheClient,
  type BridgeReadCacheEvent,
} from "./bridge-read-cache.js";

describe("runBridgeReadCached", () => {
  let mock: IORedisMock;
  let events: BridgeReadCacheEvent[];

  beforeEach(async () => {
    mock = new IORedisMock();
    await mock.flushall();
    events = [];
  });

  const run = <A>(
    key: string,
    read: () => Promise<{ ok: true; value: A } | { ok: false; error: Error }>,
  ) =>
    runBridgeReadCached({
      redisClient: mock as unknown as BridgeReadCacheClient,
      cacheKind: "availability_slots",
      cacheKey: key,
      ttlSeconds: 60,
      emptyTtlSeconds: 10,
      read,
      log: (event) => events.push(event),
      waitTimeoutMs: 1000,
      pollIntervalMs: 10,
    });

  it("returns a cached value without running the bridge read", async () => {
    await mock.set(
      "slot-key",
      JSON.stringify([{ datetime: "2026-05-03T14:00:00" }]),
    );
    const read = vi.fn(async () => ({
      ok: true as const,
      value: [{ datetime: "fresh" }],
    }));

    const result = await run("slot-key", read);

    expect(result).toEqual({
      ok: true,
      value: [{ datetime: "2026-05-03T14:00:00" }],
    });
    expect(read).not.toHaveBeenCalled();
    expect(events.map((event) => event.event)).toContain(
      "bridge_read_cache_hit",
    );
  });

  it("single-flights concurrent misses so only one caller reads Acuity", async () => {
    let calls = 0;
    const read = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        ok: true as const,
        value: [{ datetime: `2026-05-03T14:0${calls}:00` }],
      };
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => run("shared-slot-key", read)),
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(results).toEqual(
      Array.from({ length: 5 }, () => ({
        ok: true,
        value: [{ datetime: "2026-05-03T14:01:00" }],
      })),
    );
    expect(events.map((event) => event.event)).toContain(
      "bridge_read_cache_wait",
    );
    expect(await mock.get("lock:shared-slot-key")).toBeNull();
  });

  it("keeps the default wait budget above the observed Acuity cold-read envelope", () => {
    expect(BRIDGE_READ_CACHE_DEFAULTS.waitTimeoutMs).toBeGreaterThanOrEqual(
      35_000,
    );
    expect(BRIDGE_READ_CACHE_DEFAULTS.lockTtlMs).toBeGreaterThan(
      BRIDGE_READ_CACHE_DEFAULTS.waitTimeoutMs,
    );
  });

  it("does not cache failed bridge reads", async () => {
    const error = new Error("acuity failed");
    const read = vi.fn(async () => ({ ok: false as const, error }));

    const result = await run("failed-slot-key", read);

    expect(result).toEqual({ ok: false, error });
    expect(await mock.get("failed-slot-key")).toBeNull();
    expect(await mock.get("lock:failed-slot-key")).toBeNull();
  });

  it("falls through when the single-flight winner does not publish before the wait budget", async () => {
    await mock.set("lock:slow-slot-key", "winner-token", "PX", 30_000, "NX");
    const read = vi.fn(async () => ({
      ok: true as const,
      value: [{ datetime: "2026-05-04T15:00:00" }],
    }));

    const result = await runBridgeReadCached({
      redisClient: mock as unknown as BridgeReadCacheClient,
      cacheKind: "availability_slots",
      cacheKey: "slow-slot-key",
      ttlSeconds: 60,
      emptyTtlSeconds: 10,
      read,
      log: (event) => events.push(event),
      waitTimeoutMs: 30,
      pollIntervalMs: 5,
    });

    expect(result).toEqual({
      ok: true,
      value: [{ datetime: "2026-05-04T15:00:00" }],
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.event)).toContain(
      "bridge_read_cache_wait_timeout",
    );
  });
});
