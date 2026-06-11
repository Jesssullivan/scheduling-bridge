/**
 * Payment capability extraction — delegated to scheduling-kit.
 *
 * The canonical implementation lives in `@tummycrypt/scheduling-kit/payments`
 * (kit >= 0.9.0). The bridge re-exports it so its public surface is unchanged,
 * but it no longer owns booking-surface payment capability policy
 * (Refs: scheduling-bridge#82).
 *
 * @deprecated Import `extractCapabilities` (and the
 * `PractitionerPaymentSettings` / `PlatformPaymentEnv` aliases) from
 * `@tummycrypt/scheduling-kit/payments` directly. This re-export remains only
 * for backward compatibility of the bridge's export surface.
 */
export {
  extractCapabilities,
  type PractitionerPaymentSettings,
  type PlatformPaymentEnv,
} from '@tummycrypt/scheduling-kit/payments';
