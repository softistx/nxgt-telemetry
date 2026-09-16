/**
 * [Standard Schema](https://standardschema.dev), the part `event` calls. Zod 4,
 * Valibot and ArkType schemas all carry it, so this package imports none of
 * them: it reads their `~standard`. The same shape `@nxgt/httpyz` declares, and
 * for the same reason.
 */

export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly '~standard': {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (
			value: unknown,
		) => StandardResult<Output> | Promise<StandardResult<Output>>;
		readonly types?:
			| { readonly input: Input; readonly output: Output }
			| undefined;
	};
}

export type StandardResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
	readonly message: string;
	readonly path?:
		| readonly (PropertyKey | { readonly key: PropertyKey })[]
		| undefined;
}

/** What a schema accepts. */
export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
	Schema['~standard']['types']
>['input'];
