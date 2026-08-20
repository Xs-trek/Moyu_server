// Single source of truth for the moyu version. Kept in a tiny standalone module
// (not in cli.ts) so src/net/embedded-bin.ts can import it without forming a
// cycle: cli.ts -> net/easytier.ts -> net/embedded-bin.ts -> cli.ts would loop.
// Keep in sync with package.json. The compiled binary bakes this in (no
// package.json read at runtime, so bun-compile stays self-contained).
export const VERSION = '0.0.3';
