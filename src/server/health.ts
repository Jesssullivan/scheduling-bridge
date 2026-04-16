export const BRIDGE_PROTOCOL_VERSION = '1.0.0' as const;

export const BRIDGE_PROTOCOL_ENDPOINTS = {
	health: '/health',
	services: '/services',
	service: '/services/:id',
	availabilityDates: '/availability/dates',
	availabilitySlots: '/availability/slots',
	availabilityCheck: '/availability/check',
	bookingCreate: '/booking/create',
	bookingCreateWithPayment: '/booking/create-with-payment',
} as const;

export const BRIDGE_PROTOCOL_CAPABILITIES = [
	'services:list',
	'services:get',
	'availability:dates',
	'availability:slots',
	'availability:check',
	'booking:create',
	'booking:create-with-payment',
	'service-catalog:static-fallback',
	'service-catalog:business-extract',
	'service-catalog:scraper-fallback',
	'payment:bypass-coupon',
] as const;

export interface BuildHealthPayloadOptions {
	baseUrl: string;
	hasCoupon: boolean;
	headless: boolean;
	staticServices: number;
	serviceCacheTtlMs: number;
	releaseSha?: string | null;
	releaseRef?: string | null;
	releaseVersion?: string | null;
	releaseBuiltAt?: string | null;
	modalEnvironment?: string | null;
	timestamp?: string;
}

export const buildHealthPayload = ({
	baseUrl,
	hasCoupon,
	headless,
	staticServices,
	serviceCacheTtlMs,
	releaseSha,
	releaseRef,
	releaseVersion,
	releaseBuiltAt,
	modalEnvironment,
	timestamp = new Date().toISOString(),
}: BuildHealthPayloadOptions) => ({
	status: 'ok' as const,
	baseUrl,
	hasCoupon,
	headless,
	staticServices,
	serviceCacheTtlMs,
	releaseSha: releaseSha ?? 'unknown',
	releaseRef: releaseRef ?? 'unknown',
	releaseVersion: releaseVersion ?? 'unknown',
	releaseBuiltAt: releaseBuiltAt ?? null,
	modalEnvironment: modalEnvironment ?? null,
	protocolVersion: BRIDGE_PROTOCOL_VERSION,
	release: {
		sha: releaseSha ?? 'unknown',
		ref: releaseRef ?? 'unknown',
		version: releaseVersion ?? 'unknown',
		builtAt: releaseBuiltAt ?? null,
		modalEnvironment: modalEnvironment ?? null,
	},
	protocol: {
		version: BRIDGE_PROTOCOL_VERSION,
		flowOwner: 'scheduling-bridge' as const,
		backend: 'acuity' as const,
		transport: 'http-json' as const,
		endpoints: BRIDGE_PROTOCOL_ENDPOINTS,
		capabilities: [...BRIDGE_PROTOCOL_CAPABILITIES],
	},
	timestamp,
});
