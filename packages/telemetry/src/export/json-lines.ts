import type { Resource, Signal } from '../model/signal';
import type { Exporter } from './exporter';

export interface JsonLinesExporterOptions {
	/** Where a line goes. Default: `console.log`. */
	readonly write?: (line: string) => void;
}

/**
 * One JSON object per signal, one per line — the format `jq`, a log shipper and
 * a collector's file receiver all read.
 *
 * The line is the signal as it is: `type` discriminates `"log"` from `"span"`,
 * instants are epoch milliseconds, and absent fields are absent rather than
 * null. **It does not carry the resource.** A file belongs to one service, so
 * repeating its name on every line would be noise; an exporter that writes
 * somewhere shared — `@nxgt/telemetry-mongo` — stamps it instead.
 */
export function jsonLinesExporter(
	options: JsonLinesExporterOptions = {},
): Exporter {
	const write = options.write ?? ((line: string) => console.log(line));

	return {
		export(_resource: Resource, batch: readonly Signal[]): void {
			for (const signal of batch) {
				const line = render(signal);
				if (line !== undefined) write(line);
			}
		},
	};
}

/** One signal that will not serialise must not cost the rest of the batch. */
function render(signal: Signal): string | undefined {
	try {
		return JSON.stringify(signal);
	} catch {
		return undefined;
	}
}
