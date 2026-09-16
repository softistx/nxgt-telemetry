/**
 * The OTLP/HTTP **JSON** documents, as types.
 *
 * These are hand-written rather than generated from the protobufs, and that is
 * the point of this package: OTLP is a wire format, not a library. The whole
 * surface a collector needs is the two request documents below, and writing
 * them by hand costs less than the SDK's dependency tree.
 *
 * Two places where proto3 JSON and OTLP JSON differ, and where an
 * implementation that guesses gets it wrong:
 *
 * - **ids are lowercase hex, not base64.** Proto3 JSON would encode a `bytes`
 *   field as base64; the OTLP specification overrides that for `trace_id`,
 *   `span_id` and `parent_span_id`.
 * - **64-bit integers are strings.** `timeUnixNano` and an integer attribute
 *   both cross the wire as text, because a JSON number is a double and
 *   nanoseconds do not fit in one.
 */

/** A value, tagged by which of the fields is set. An empty object is unset. */
export interface AnyValue {
	readonly stringValue?: string;
	readonly boolValue?: boolean;
	/** Decimal text: a JSON number would lose the low bits. */
	readonly intValue?: string;
	readonly doubleValue?: number;
	readonly arrayValue?: { readonly values: readonly AnyValue[] };
}

export interface KeyValue {
	readonly key: string;
	readonly value: AnyValue;
}

export interface OtlpResource {
	readonly attributes: readonly KeyValue[];
}

/** Which library produced the signal. `source` for logs, this package for spans. */
export interface InstrumentationScope {
	readonly name: string;
	readonly version?: string;
}

export interface OtlpLogRecord {
	readonly timeUnixNano: string;
	readonly observedTimeUnixNano: string;
	readonly severityNumber: number;
	readonly severityText: string;
	readonly body: AnyValue;
	readonly attributes: readonly KeyValue[];
	readonly traceId?: string;
	readonly spanId?: string;
	/** The W3C trace flags, in the low eight bits: `1` when sampled. */
	readonly flags?: number;
}

export interface ScopeLogs {
	readonly scope: InstrumentationScope;
	readonly logRecords: readonly OtlpLogRecord[];
}

export interface ResourceLogs {
	readonly resource: OtlpResource;
	readonly scopeLogs: readonly ScopeLogs[];
}

export interface ExportLogsServiceRequest {
	readonly resourceLogs: readonly ResourceLogs[];
}

export interface OtlpSpanEvent {
	readonly timeUnixNano: string;
	readonly name: string;
	readonly attributes: readonly KeyValue[];
}

export interface OtlpStatus {
	/** `0` unset, `1` ok, `2` error. */
	readonly code: number;
	readonly message?: string;
}

export interface OtlpSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	/** `1` internal … `5` consumer. */
	readonly kind: number;
	readonly startTimeUnixNano: string;
	readonly endTimeUnixNano: string;
	readonly attributes: readonly KeyValue[];
	readonly events: readonly OtlpSpanEvent[];
	readonly status: OtlpStatus;
}

export interface ScopeSpans {
	readonly scope: InstrumentationScope;
	readonly spans: readonly OtlpSpan[];
}

export interface ResourceSpans {
	readonly resource: OtlpResource;
	readonly scopeSpans: readonly ScopeSpans[];
}

export interface ExportTraceServiceRequest {
	readonly resourceSpans: readonly ResourceSpans[];
}

/**
 * What a collector answers when it accepted the request but not everything in
 * it — a rejected record, a quota, a bad attribute. The counts are strings for
 * the same reason `timeUnixNano` is.
 */
export interface PartialSuccess {
	readonly rejectedLogRecords?: string;
	readonly rejectedSpans?: string;
	readonly errorMessage?: string;
}
