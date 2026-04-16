/**
 * Payment capability extraction from practitioner settings and platform env vars.
 *
 * This is the canonical extraction logic used by downstream booking surfaces
 * to produce consistent payment method availability.
 */
import type {
  PaymentCapabilities,
  PaymentMethodOption,
  StripeCapability,
  VenmoCapability,
} from '@tummycrypt/scheduling-kit/payments';

/**
 * Extract payment capabilities from practitioner settings and platform env vars.
 *
 * Priority hierarchy: practitioner settings (DB) > platform env vars > disabled.
 * Cash at Visit is structurally excluded (cash: false).
 *
 * @param settings - Practitioner-specific settings from database
 * @param env - Platform environment variables
 * @returns PaymentCapabilities contract for booking surfaces
 */
export const extractCapabilities = (
  settings: Record<string, string>,
  env: Record<string, string>,
): PaymentCapabilities => {
  const methods: PaymentMethodOption[] = [];

  // --- Stripe ---
  const stripeKey = settings.stripe_publishable_key || env.PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
  const stripeConnectId = settings.stripe_connect_account_id || env.STRIPE_CONNECT_ACCOUNT_ID || '';
  let stripe: StripeCapability | null = null;

  if (stripeKey) {
    stripe = {
      available: true,
      publishableKey: stripeKey,
      ...(stripeConnectId ? { connectedAccountId: stripeConnectId } : {}),
    };
    methods.push({
      id: 'card',
      name: 'card',
      displayName: 'Credit/Debit Card',
      icon: 'card',
      available: true,
    });
  }

  // --- Venmo/PayPal ---
  const paypalClientId = env.PUBLIC_PAYPAL_CLIENT_ID || '';
  const payeeEmail = settings.paypal_payee_email || env.PAYPAL_PAYEE_EMAIL || '';
  const paypalEnv: 'sandbox' | 'production' = env.PAYPAL_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  let venmo: VenmoCapability | null = null;

  if (paypalClientId && payeeEmail) {
    venmo = {
      available: true,
      clientId: paypalClientId,
      environment: paypalEnv,
    };
    methods.push({
      id: 'venmo',
      name: 'venmo',
      displayName: 'Venmo',
      icon: 'venmo',
      available: true,
    });
  }

  return { methods, stripe, venmo, cash: false };
};
