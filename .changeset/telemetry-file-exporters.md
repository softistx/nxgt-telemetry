---
'@nxgt/telemetry': minor
---

Add `jsonLinesExporter` and `fileExporter`, and the rotation behind it.

`jsonLinesExporter()` writes one JSON object per signal per line — what `jq`, a
log shipper and a collector's file receiver all read. `fileExporter({ path })`
writes the same format to a file and rotates it.

Rotation is **epoch-aligned**: `every: 24h` rolls at UTC midnight, which is what
somebody reading yesterday's file expects, rather than 24 hours after a restart.
The exporter **appends**, and reads the current period from the file's
modification time, so a service that restarts hourly still rolls once a day. An
**empty file is never rolled** — rolling one produces an empty archive and
resets the period, so an idle service would accumulate a directory of nothing —
and `close()` rolls nothing, because a rolled file is a finished period and a
shutdown is not one. `keep` prunes by name, which sorts correctly because the
stamp is fixed-width UTC, and only ever matches this file's own archives.

Neither line format carries the resource: a file belongs to one service.

The decisions are exported separately as `rotationDue`, `rolledName`,
`rolledOf` and `prunable`, so an exporter that writes its own files can reuse
them without reimplementing the one rule that is easy to get wrong.
