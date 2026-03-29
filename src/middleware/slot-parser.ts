/**
 * Slot Text Parser
 *
 * Parses Acuity time slot button text like "4:00 PM1 spot left"
 * into structured data. The button textContent concatenates the
 * time with the availability indicator without any separator.
 */

/**
 * Parse raw slot button text into time and spots-left.
 *
 * Examples:
 *   "4:00 PM1 spot left"  => { time: "4:00 PM", spotsLeft: 1 }
 *   "10:00 AM"            => { time: "10:00 AM", spotsLeft: null }
 *   "2:30 PM3 spots left" => { time: "2:30 PM", spotsLeft: 3 }
 *   ""                    => null
 */
export const parseSlotText = (
	text: string,
): { time: string; spotsLeft: number | null } | null => {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const timeMatch = trimmed.match(/^(\d{1,2}:\d{2}\s*[AP]M)/i);
	if (!timeMatch) return null;

	const time = timeMatch[1];
	const rest = trimmed.slice(timeMatch.index! + time.length).trim();

	const spotsMatch = rest.match(/^(\d+)\s*spot/i);
	const spotsLeft = spotsMatch ? parseInt(spotsMatch[1], 10) : null;

	return { time, spotsLeft };
};

/**
 * Build an ISO datetime string from a date string and a 12-hour time string.
 *
 * @param dateStr - "2026-03-15" format
 * @param timeStr - "10:00 AM" or "4:00 PM" format
 * @returns "2026-03-15T10:00:00" or "2026-03-15T16:00:00"
 */
export const buildIsoDatetime = (dateStr: string, timeStr: string): string => {
	const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*([AP]M)/i);
	if (!match) return `${dateStr}T00:00:00`;

	let hours = parseInt(match[1], 10);
	const minutes = match[2];
	const period = match[3].toUpperCase();

	if (period === 'AM' && hours === 12) hours = 0;
	if (period === 'PM' && hours !== 12) hours += 12;

	return `${dateStr}T${String(hours).padStart(2, '0')}:${minutes}:00`;
};
