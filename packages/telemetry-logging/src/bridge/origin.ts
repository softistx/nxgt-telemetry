/**
 * The mark a line carries when this library is what wrote it into winston.
 *
 * It exists because the two halves of this bridge point at each other. A logger
 * with a {@link telemetryTransport} sends its lines to the pipeline; a
 * {@link winstonExporter} sends the pipeline's signals to a logger. Both on the
 * same logger is a loop, and a loop here does not crash — it spins, quietly,
 * at whatever rate the process can manage.
 *
 * `winstonExporter` refuses that wiring when it can see it, at construction.
 * This mark is what catches the shapes it cannot see: two loggers pointing at
 * each other, or a transport added after the exporter was built. It is a
 * string key rather than a symbol because it has to survive `JSON.stringify` —
 * winston's `json()` format, a transport that serialises, `logform`'s
 * splat — anywhere the line may be copied before it comes back round.
 */
export const FROM_TELEMETRY = 'nxgt.telemetry.origin';
