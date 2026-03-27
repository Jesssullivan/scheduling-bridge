import { describe, it, expect } from 'vitest';
import {
	extractBusinessFromHtml,
	businessToServices,
	type AcuityBusinessData,
} from '../extract-business.js';
import {
	mockBusinessData,
	mockBusinessHtml,
	mockHtmlNoBusiness,
	mockHtmlMalformedBusiness,
	mockAppointmentTypes,
	mockInactiveType,
	mockPrivateType,
} from './fixtures.js';

// =============================================================================
// extractBusinessFromHtml
// =============================================================================

describe('extractBusinessFromHtml', () => {
	it('parses valid BUSINESS object from HTML', () => {
		const result = extractBusinessFromHtml(mockBusinessHtml);
		expect(result).not.toBeNull();
		expect(result!.id).toBe(30262130);
		expect(result!.ownerKey).toBe('4671d709');
		expect(result!.name).toBe('Massage Ithaca');
		expect(result!.timezone).toBe('America/New_York');
	});

	it('extracts appointmentTypes grouped by category', () => {
		const result = extractBusinessFromHtml(mockBusinessHtml)!;
		expect(Object.keys(result.appointmentTypes)).toEqual(
			expect.arrayContaining(['1 Urgent Care Massage', '2 TMD', '3 Cervical']),
		);
		expect(result.appointmentTypes['2 TMD']).toHaveLength(3);
	});

	it('extracts calendar data', () => {
		const result = extractBusinessFromHtml(mockBusinessHtml)!;
		const calendars = Object.values(result.calendars).flat();
		expect(calendars).toHaveLength(1);
		expect(calendars[0].name).toBe('1. Jennifer Whitaker');
		expect(calendars[0].id).toBe(8973181);
	});

	it('returns null when BUSINESS object is missing', () => {
		const result = extractBusinessFromHtml(mockHtmlNoBusiness);
		expect(result).toBeNull();
	});

	it('returns null for malformed JSON', () => {
		const result = extractBusinessFromHtml(mockHtmlMalformedBusiness);
		expect(result).toBeNull();
	});

	it('returns null for empty string', () => {
		const result = extractBusinessFromHtml('');
		expect(result).toBeNull();
	});

	it('handles BUSINESS with empty appointmentTypes', () => {
		const html = `<script>var BUSINESS = ${JSON.stringify({
			...mockBusinessData,
			appointmentTypes: {},
		})};var FEATURE_FLAGS = [];</script>`;
		const result = extractBusinessFromHtml(html);
		expect(result).not.toBeNull();
		expect(result!.appointmentTypes).toEqual({});
	});
});

// =============================================================================
// businessToServices
// =============================================================================

describe('businessToServices', () => {
	it('flattens category-grouped appointment types into Service[]', () => {
		const services = businessToServices(mockBusinessData);
		// 1 urgent + 3 TMD + 1 cervical = 5 active services
		expect(services).toHaveLength(5);
	});

	it('preserves Acuity numeric IDs as string', () => {
		const services = businessToServices(mockBusinessData);
		const urgent = services.find((s) => s.name.includes('URGENT'));
		expect(urgent).toBeDefined();
		expect(urgent!.id).toBe('53178494');
	});

	it('converts price strings to cents', () => {
		const services = businessToServices(mockBusinessData);
		const urgent = services.find((s) => s.id === '53178494')!;
		expect(urgent.price).toBe(15500); // "155.00" → 15500
	});

	it('converts fractional prices correctly', () => {
		const data: AcuityBusinessData = {
			...mockBusinessData,
			appointmentTypes: {
				'Test': [{
					...mockAppointmentTypes['1 Urgent Care Massage'][0],
					price: '99.99',
				}],
			},
		};
		const services = businessToServices(data);
		expect(services[0].price).toBe(9999);
	});

	it('strips numeric prefixes from category names', () => {
		const services = businessToServices(mockBusinessData);
		const categories = [...new Set(services.map((s) => s.category))];
		// "1 Urgent Care Massage" → "Urgent Care Massage"
		// "2 TMD" → "TMD"
		// "3 Cervical" → "Cervical"
		expect(categories).not.toContain('1 Urgent Care Massage');
		expect(categories).not.toContain('2 TMD');
		expect(categories).toContain('Urgent Care Massage');
		expect(categories).toContain('TMD');
		expect(categories).toContain('Cervical');
	});

	it('strips "4. " style prefixes too', () => {
		const data: AcuityBusinessData = {
			...mockBusinessData,
			appointmentTypes: {
				'4. Medical Massage': [mockAppointmentTypes['1 Urgent Care Massage'][0]],
			},
		};
		const services = businessToServices(data);
		expect(services[0].category).toBe('Medical Massage');
	});

	it('filters out inactive services', () => {
		const data: AcuityBusinessData = {
			...mockBusinessData,
			appointmentTypes: {
				'Test': [mockInactiveType],
			},
		};
		const services = businessToServices(data);
		expect(services).toHaveLength(0);
	});

	it('filters out private services', () => {
		const data: AcuityBusinessData = {
			...mockBusinessData,
			appointmentTypes: {
				'Admin': [mockPrivateType],
			},
		};
		const services = businessToServices(data);
		expect(services).toHaveLength(0);
	});

	it('sets currency to USD', () => {
		const services = businessToServices(mockBusinessData);
		expect(services.every((s) => s.currency === 'USD')).toBe(true);
	});

	it('sets active to true for all returned services', () => {
		const services = businessToServices(mockBusinessData);
		expect(services.every((s) => s.active === true)).toBe(true);
	});

	it('preserves duration in minutes', () => {
		const services = businessToServices(mockBusinessData);
		const tuneup = services.find((s) => s.id === '91149479')!;
		expect(tuneup.duration).toBe(75);
	});

	it('returns empty array for empty appointmentTypes', () => {
		const data: AcuityBusinessData = {
			...mockBusinessData,
			appointmentTypes: {},
		};
		expect(businessToServices(data)).toEqual([]);
	});

	it('handles mixed active/inactive in same category', () => {
		const data: AcuityBusinessData = {
			...mockBusinessData,
			appointmentTypes: {
				'Mixed': [
					mockAppointmentTypes['1 Urgent Care Massage'][0],
					mockInactiveType,
					mockPrivateType,
				],
			},
		};
		const services = businessToServices(data);
		expect(services).toHaveLength(1);
		expect(services[0].id).toBe('53178494');
	});
});
