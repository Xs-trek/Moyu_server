// §3 single-binary delivery tests for src/net/embedded-bin.ts.
// Covers the dev-mode no-op (no Bun global / no embedded asset -> null, so
// resolveBin falls back to bin/<platform>/) and the versioned-temp-dir reuse /
// stale-cleanup logic (extractToDir + dirValid + stamp). The full materialize-
// from-embedded-asset path needs a real compiled binary and is exercised by the
// build selfcheck (`moyu --selfcheck`), not here (per the "no account/system
// impact in unit tests" rule).
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  materializeEmbeddedBin,
  getEmbeddedBinPath,
  dirFor,
  stampValue,
  exeName,
  dirValid,
  extractToDir,
  EMBEDDED_GLOBAL,
} from '../src/net/embedded-bin';
import { VERSION } from '../src/version';
import { getPlatform, getArch, isWindows } from '../src/util/platform';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name}${detail ? ' ' + detail : ''}`); }
}

async function main(): Promise<void> {
  // --- A. Dev/source mode: no embedded asset, no Bun global -> null everywhere ---
  ok('A1: embedded global unset in dev', (globalThis as Record<string, unknown>)[EMBEDDED_GLOBAL] === undefined);
  ok('A2: getEmbeddedBinPath() null in dev', getEmbeddedBinPath() === null);
  const m = await materializeEmbeddedBin();
  ok('A3: materializeEmbeddedBin() null in dev (no throw)', m === null);
  ok('A4: cache stays null after materialize (dev)', getEmbeddedBinPath() === null);

  // --- B. dirFor / stampValue / exeName shape (drives reuse + stale detection) ---
  const dir = dirFor();
  ok('B1: dirFor under tmpdir', dir.startsWith(tmpdir()));
  ok('B2: dirFor encodes version+platform+arch',
    dir.includes(VERSION) && dir.includes(getPlatform()) && dir.includes(getArch()));
  const stamp = stampValue();
  ok('B3: stampValue = VERSION|platform|arch', stamp === `${VERSION}|${getPlatform()}|${getArch()}`);
  ok('B4: exeName win->.exe else bare', isWindows ? exeName() === 'easytier-core.exe' : exeName() === 'easytier-core');

  // --- C. dirValid on missing dir -> false (no throw) ---
  const missing = join(tmpdir(), `moyu-embedded-missing-${process.pid}`);
  ok('C1: dirValid(missing) false', dirValid(missing) === false);

  // --- D. extractToDir writes binary + stamp; dirValid true; bytes match ---
  const dirD = mkdtempSync(join(tmpdir(), 'moyu-embedded-extract-'));
  try {
    const bytes = Buffer.from('fake-easytier-core-bytes');
    const binPath = extractToDir(dirD, bytes);
    ok('D1: extractToDir returns bin path ending in exeName', binPath.endsWith(exeName()));
    ok('D2: binary file exists', existsSync(binPath));
    ok('D3: binary bytes match input', readFileSync(binPath).equals(bytes));
    ok('D4: dirValid true after extract', dirValid(dirD) === true);
    // Simulate the reuse path: a second run sees a valid dir and reuses it.
    ok('D5: reuse -> dirValid still true', dirValid(dirD) === true);
  } finally {
    rmSync(dirD, { recursive: true, force: true });
  }

  // --- E. Stale stamp (version/platform mismatch) -> dirValid false ---
  const dirE = mkdtempSync(join(tmpdir(), 'moyu-embedded-stale-'));
  try {
    extractToDir(dirE, Buffer.from('x'));
    // Corrupt the stamp to simulate a residue from an older version.
    writeFileSync(join(dirE, '.moyu-stamp'), '0.0.0-old|linux|x64');
    ok('E1: stale stamp -> dirValid false', dirValid(dirE) === false);
  } finally {
    rmSync(dirE, { recursive: true, force: true });
  }

  // --- F. Stamp present but binary missing -> dirValid false ---
  const dirF = mkdtempSync(join(tmpdir(), 'moyu-embedded-nobin-'));
  try {
    writeFileSync(join(dirF, '.moyu-stamp'), stampValue());
    ok('F1: stamp without binary -> dirValid false', dirValid(dirF) === false);
  } finally {
    rmSync(dirF, { recursive: true, force: true });
  }

  // --- G. extractToDir overwrites a stale dir cleanly (re-extract path) ---
  const dirG = mkdtempSync(join(tmpdir(), 'moyu-embedded-overwrite-'));
  try {
    extractToDir(dirG, Buffer.from('old-bytes'));
    writeFileSync(join(dirG, '.moyu-stamp'), 'stale');
    ok('G1: dir stale before re-extract', dirValid(dirG) === false);
    const newBytes = Buffer.from('new-bytes-longer-than-old');
    const binPath = extractToDir(dirG, newBytes);
    ok('G2: re-extract restores validity', dirValid(dirG) === true);
    ok('G3: re-extract writes new bytes', readFileSync(binPath).equals(newBytes));
  } finally {
    rmSync(dirG, { recursive: true, force: true });
  }

  console.log(`\nEMBEDDED-BIN: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
