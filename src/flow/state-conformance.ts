/**
 * State-schema conformance helper — volatile-state fence (b) from design §4/§11.
 *
 * Every registered flow's FlowStateSpec must encode to JSON primitives/arrays/records only.
 * This walks the ENCODED side of each schema's AST and reports any construct that could
 * smuggle a volatile runtime value (Page, ElementHandle) into durable state — notably
 * `Schema.declare` (Declaration) and `Schema.Any` (AnyKeyword), the two escapes the design
 * names explicitly. Exported for reuse by later lanes' flow-definition test suites.
 */

import { SchemaAST } from 'effect';
import type { FlowStateSpec } from './state.js';

export interface SpecViolation {
	/** Spec key whose schema failed the fence. */
	readonly key: string;
	/** AST path within the schema. */
	readonly path: string;
	/** Offending AST tag, e.g. 'Declaration' (Schema.declare) or 'AnyKeyword' (Schema.Any). */
	readonly tag: string;
}

const ALLOWED_LITERALS = new Set(['string', 'number', 'boolean']);

const walk = (
	ast: SchemaAST.AST,
	key: string,
	path: string,
	violations: SpecViolation[],
	seen: Set<SchemaAST.AST>,
): void => {
	if (seen.has(ast)) return;
	seen.add(ast);

	switch (ast._tag) {
		case 'StringKeyword':
		case 'NumberKeyword':
		case 'BooleanKeyword':
		case 'TemplateLiteral':
		case 'Enums':
			return;
		case 'Literal': {
			const literal = (ast as SchemaAST.Literal).literal;
			if (literal !== null && !ALLOWED_LITERALS.has(typeof literal)) {
				violations.push({ key, path, tag: `Literal(${typeof literal})` });
			}
			return;
		}
		case 'Union': {
			(ast as SchemaAST.Union).types.forEach((member, i) =>
				walk(member, key, `${path}|${i}`, violations, seen),
			);
			return;
		}
		case 'TupleType': {
			const tuple = ast as SchemaAST.TupleType;
			tuple.elements.forEach((element, i) =>
				walk(element.type, key, `${path}[${i}]`, violations, seen),
			);
			tuple.rest.forEach((rest, i) => walk(rest.type, key, `${path}[...${i}]`, violations, seen));
			return;
		}
		case 'TypeLiteral': {
			const literal = ast as SchemaAST.TypeLiteral;
			for (const prop of literal.propertySignatures) {
				if (typeof prop.name === 'symbol') {
					violations.push({ key, path: `${path}.${String(prop.name)}`, tag: 'SymbolPropertyName' });
					continue;
				}
				walk(prop.type, key, `${path}.${String(prop.name)}`, violations, seen);
			}
			for (const index of literal.indexSignatures) {
				if (index.parameter._tag !== 'StringKeyword' && index.parameter._tag !== 'TemplateLiteral') {
					violations.push({ key, path: `${path}[index]`, tag: `IndexParameter(${index.parameter._tag})` });
				}
				walk(index.type, key, `${path}[index]`, violations, seen);
			}
			return;
		}
		case 'Refinement':
			walk((ast as SchemaAST.Refinement).from, key, path, violations, seen);
			return;
		case 'Transformation':
			walk(SchemaAST.encodedAST(ast), key, path, violations, seen);
			return;
		case 'Suspend':
			walk(SchemaAST.encodedAST((ast as SchemaAST.Suspend).f()), key, `${path}(suspended)`, violations, seen);
			return;
		default:
			// Declaration (Schema.declare), AnyKeyword (Schema.Any), UnknownKeyword, ObjectKeyword,
			// SymbolKeyword, BigIntKeyword, UndefinedKeyword, VoidKeyword, NeverKeyword, UniqueSymbol —
			// none of these encode to JSON primitives/arrays/records.
			violations.push({ key, path, tag: ast._tag });
	}
};

/** Collect every JSON-encodability violation in a FlowStateSpec (empty = conformant). */
export const jsonEncodableViolations = (spec: FlowStateSpec): readonly SpecViolation[] => {
	const violations: SpecViolation[] = [];
	for (const [key, schema] of Object.entries(spec)) {
		walk(SchemaAST.encodedAST(schema.ast), key, '$', violations, new Set());
	}
	return violations;
};

/** Assert a FlowStateSpec encodes to JSON primitives/arrays/records only; throws otherwise. */
export const assertJsonEncodableSpec = (spec: FlowStateSpec): void => {
	const violations = jsonEncodableViolations(spec);
	if (violations.length > 0) {
		throw new Error(
			`FlowStateSpec is not JSON-encodable:\n${violations
				.map((v) => `- key '${v.key}' at ${v.path}: forbidden ${v.tag}`)
				.join('\n')}`,
		);
	}
};
