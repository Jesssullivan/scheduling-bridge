/**
 * Test fixtures for extract-business.ts
 *
 * Based on real data from https://MassageIthaca.as.me/ (captured 2026-03-27)
 */

import type { AcuityBusinessData, AcuityAppointmentType } from '../extract-business.js';

// =============================================================================
// MOCK BUSINESS OBJECT
// =============================================================================

export const mockAppointmentTypes: Record<string, AcuityAppointmentType[]> = {
	'1 Urgent Care Massage': [
		{
			id: 53178494,
			name: 'URGENT Care Massage (Same or Next day care)',
			active: true,
			description: 'Same-day or priority care for pain, flare-ups...',
			duration: 45,
			price: '155.00',
			category: '1 Urgent Care Massage',
			color: '#E45A26',
			private: false,
			type: 'service',
			calendarIDs: [8973181],
			formIDs: [2480264],
			addonIDs: [],
			paddingAfter: 13,
			paddingBefore: 0,
			paymentRequired: true,
			classSize: null,
		},
	],
	'2 TMD': [
		{
			id: 82429463,
			name: 'TMD 1st Consultation & Session',
			active: true,
			description: 'Initial TMD consultation',
			duration: 30,
			price: '155.00',
			category: '2 TMD',
			color: '#5b9366',
			private: false,
			type: 'service',
			calendarIDs: [8973181],
			formIDs: [],
			addonIDs: [],
			paddingAfter: 0,
			paddingBefore: 0,
			paymentRequired: true,
			classSize: null,
		},
		{
			id: 82429361,
			name: 'TMD: single session (30 min)',
			active: true,
			description: 'Follow-up TMD session',
			duration: 30,
			price: '105.00',
			category: '2 TMD',
			color: '#5b9366',
			private: false,
			type: 'service',
			calendarIDs: [8973181],
			formIDs: [],
			addonIDs: [],
			paddingAfter: 0,
			paddingBefore: 0,
			paymentRequired: true,
			classSize: null,
		},
		{
			id: 91149479,
			name: 'TMD  Tune up',
			active: true,
			description: 'TMD tune-up session',
			duration: 75,
			price: '255.00',
			category: '2 TMD',
			color: '#5b9366',
			private: false,
			type: 'service',
			calendarIDs: [8973181],
			formIDs: [],
			addonIDs: [],
			paddingAfter: 0,
			paddingBefore: 0,
			paymentRequired: true,
			classSize: null,
		},
	],
	'3 Cervical': [
		{
			id: 82429246,
			name: 'Cervical Medical Massage 30 minutes',
			active: true,
			description: 'Targeted neck area massage',
			duration: 30,
			price: '85.00',
			category: '3 Cervical',
			color: '#5b9366',
			private: false,
			type: 'service',
			calendarIDs: [8973181],
			formIDs: [],
			addonIDs: [],
			paddingAfter: 0,
			paddingBefore: 0,
			paymentRequired: true,
			classSize: null,
		},
	],
};

export const mockInactiveType: AcuityAppointmentType = {
	id: 99999999,
	name: 'Inactive service',
	active: false,
	description: '',
	duration: 30,
	price: '50.00',
	category: 'Test',
	color: '#000',
	private: false,
	type: 'service',
	calendarIDs: [],
	formIDs: [],
	addonIDs: [],
	paddingAfter: 0,
	paddingBefore: 0,
	paymentRequired: false,
	classSize: null,
};

export const mockPrivateType: AcuityAppointmentType = {
	id: 88888888,
	name: 'Private admin-only service',
	active: true,
	description: '',
	duration: 60,
	price: '200.00',
	category: 'Admin',
	color: '#000',
	private: true,
	type: 'service',
	calendarIDs: [],
	formIDs: [],
	addonIDs: [],
	paddingAfter: 0,
	paddingBefore: 0,
	paymentRequired: false,
	classSize: null,
};

export const mockBusinessData: AcuityBusinessData = {
	id: 30262130,
	ownerKey: '4671d709',
	name: 'Massage Ithaca',
	timezone: 'America/New_York',
	appointmentTypes: mockAppointmentTypes,
	calendars: {
		'South Hill Business Campus': [
			{
				id: 8973181,
				name: '1. Jennifer Whitaker',
				description: 'Licensed massage therapist',
				location: 'South Hill Business Campus 950 Danby Rd Suite 202-U  Ithaca, NY 14850',
				timezone: 'America/New_York',
				thumbnail: '//cdn-s.acuityscheduling.com/calendar-thumb-8973181.png',
				image: '//cdn-s.acuityscheduling.com/calendar-8973181.png',
			},
		],
	},
	products: {},
	forms: [],
	addons: [],
};

// =============================================================================
// MOCK HTML
// =============================================================================

export const mockBusinessHtml = `
<!DOCTYPE html>
<html>
<head><title>Massage Ithaca</title></head>
<body>
<script>
var OWNER_KEY = '4671d709';
var BUSINESS = ${JSON.stringify(mockBusinessData)};
var FEATURE_FLAGS = [];
</script>
<div id="secondo-container"></div>
</body>
</html>
`;

export const mockHtmlNoBusiness = `
<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body><p>Page not found</p></body>
</html>
`;

export const mockHtmlMalformedBusiness = `
<!DOCTYPE html>
<script>
var BUSINESS = {this is not valid json at all};
var FEATURE_FLAGS = [];
</script>
`;
