/**
 * Compatibility re-exports for the field matcher surface.
 *
 * The implementation lives in `@tummycrypt/scheduling-kit/fuzzy`; bridge keeps
 * this module as a stable import path for flow and adapter code.
 */

export {
	DEFAULT_DEFERRED_VALUE,
	DEFAULT_FIELD_RULES,
	FieldMatcher,
	FieldMatcherLive,
	makeFieldMatcher,
	resolveFieldAnswer,
	scoreFieldRule,
	type FieldMatchQuery,
	type FieldRule,
} from '@tummycrypt/scheduling-kit/fuzzy';
