/**
 * Compatibility re-exports for the fuzzy matcher surface.
 *
 * TIN-2098 graduates the implementation to `@tummycrypt/scheduling-kit/fuzzy`.
 * Bridge keeps this module so existing internal imports do not churn, but the
 * Context tags and scorer code now come from the reusable kit package.
 */

export {
	FUZZY_THRESHOLD,
	FuzzyMatchError,
	ServiceMatcher,
	ServiceMatcherLive,
	TOKEN_THRESHOLD,
	fuzzyConfidence,
	levenshtein,
	makeServiceMatcher,
	normalize,
	scoreLabel,
	tokenOverlap,
	type FuzzyMatcher,
	type FuzzyResolution,
	type FuzzyStrategy,
	type ServiceCandidate,
	type ServiceMatchQuery,
} from '@tummycrypt/scheduling-kit/fuzzy';
