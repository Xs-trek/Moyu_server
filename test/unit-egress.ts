// Egress enforcement (C3 0-perception, review P1 + #2). Proves the backend makes ZERO outbound
// calls to AI providers, turning the invariant from a code convention into a build-enforced one:
//   1. No provider-domain literal appears anywhere in src (except the policy file egress.ts).
//   2. Outbound primitives appear ONLY in EGRESS_ALLOWED_OUTBOUND_FILES -- any new outbound must
//      be consciously allowlisted. Enforced by a TS-compiler AST walk (#2), NOT a regex: the old
//      regex `/\b(fetch\(|createConnection\(|http\.request\(|https\.request\()/` had false
//      negatives (new WebSocket, https.get, net.connect, tls.connect, dns.resolve,
//      require('http').request, dynamic import('https'), globalThis.fetch). The AST walk catches
//      all of these (see BYPASS_SAMPLES) while leaving inbound createServer / WebSocketServer /
//      type-only imports untouched.
//   3. assertNotProviderHost blocks KNOWN provider hosts at runtime (the NetProbe relay-URL
//      guard) -- OPTIONAL defense-in-depth, NOT the acceptance basis (§12).
// Acceptance basis = (1) + (2) [architecture: no provider-request path + static check]. (3)
// only catches KNOWN domains, never "any AI server"; unknown providers + CLI-subprocess
// telemetry are unprovable residual boundaries. Residual static-analysis boundary (#2): the AST
// walk is syntactic -- it cannot follow data flow, so `const f = fetch; f(url)` or
// `globalThis['fetch'](url)` (computed member) evade it. Those require runtime/behavioral
// controls outside this check's scope; the CLI-subprocess boundary remains the load-bearing one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import {
  assertNotProviderHost,
  isProviderHost,
  PROVIDER_HOST_BLOCKLIST,
  EGRESS_ALLOWED_OUTBOUND_FILES,
} from '../src/net/egress';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const POLICY_FILE = 'src/net/egress.ts';
const ALLOW = new Set(EGRESS_ALLOWED_OUTBOUND_FILES);

// #2: the OLD regex -- kept ONLY to prove the AST walk is strictly stronger (BYPASS_SAMPLES
// assert regexMisses for evasions the AST now catches). Not used for enforcement.
const OUTBOUND_RE = /\b(?:fetch\s*\(|createConnection\s*\(|http\.request\s*\(|https\.request\s*\()/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const files = walk(SRC).map((p) => relative(ROOT, p).replace(/\\/g, '/'));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    console.log('  FAIL:', name);
  }
}

// --- #2: AST-based outbound detection ---------------------------------------------------------
// Network modules whose import implies potential outbound. We do NOT flag static `import ...
// from 'node:http'` itself (it is also inbound: createServer, type-only IncomingMessage); we
// flag the OUTBOUND CALL SITES + suspicious runtime loads (require/dynamic-import of a net
// module, which in this ESM codebase only appears for outbound).
const NET_MODULES = new Set(['http', 'https', 'net', 'tls', 'dns', 'ws', 'undici']);
// `obj.prop()` where obj is one of these identifiers and prop is outbound. Narrow object set =>
// `Promise.resolve()` / `tracker.resolve()` / `map.get()` are NOT flagged.
const NET_OBJECTS = new Set(['http', 'https', 'net', 'tls', 'dns']);
const OUTBOUND_PROPS = new Set(['request', 'get', 'createConnection', 'connect', 'resolve', 'lookup', 'reverse']);
// `globalThis.fetch` / `global.fetch` / `self.fetch` / `undici.fetch` / `window.fetch` evasions.
const FETCH_OBJECTS = new Set(['globalThis', 'global', 'self', 'window', 'undici']);

function netBareModule(spec: string): string | null {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  const base = bare.split('/')[0];
  return NET_MODULES.has(base) ? base : null;
}

interface Violation {
  file: string;
  desc: string;
  line: number;
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.js') || file.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Walk a source file's AST and return every outbound primitive call/new it contains.
 *  Call-site-level (not import-level) so inbound `createServer` / `new WebSocketServer` /
 *  `WebSocket.OPEN` (enum access) / type-only imports are NOT flagged. */
function findOutboundViolations(sourceText: string, file: string): Violation[] {
  const out: Violation[] = [];
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // dynamic import('net-module') -- callee kind is ImportKeyword (not an Identifier).
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const arg0 = node.arguments[0];
        if (arg0 && ts.isStringLiteral(arg0) && netBareModule(arg0.text)) {
          out.push({ file, desc: `import('${arg0.text}')`, line: lineOf(node.getStart()) });
        }
      } else if (ts.isIdentifier(callee)) {
        const n = callee.text;
        if (n === 'fetch') {
          out.push({ file, desc: 'fetch() call', line: lineOf(node.getStart()) });
        } else if (n === 'createConnection') {
          out.push({ file, desc: 'createConnection() call', line: lineOf(node.getStart()) });
        } else if (n === 'require') {
          const arg0 = node.arguments[0];
          if (arg0 && ts.isStringLiteral(arg0) && netBareModule(arg0.text)) {
            out.push({ file, desc: `require('${arg0.text}')`, line: lineOf(node.getStart()) });
          }
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const prop = callee.name.text;
        if (ts.isIdentifier(callee.expression)) {
          const obj = callee.expression.text;
          if (prop === 'fetch' && FETCH_OBJECTS.has(obj)) {
            out.push({ file, desc: `${obj}.fetch() call`, line: lineOf(node.getStart()) });
          } else if (OUTBOUND_PROPS.has(prop) && NET_OBJECTS.has(obj)) {
            out.push({ file, desc: `${obj}.${prop}() call`, line: lineOf(node.getStart()) });
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'WebSocket') {
        out.push({ file, desc: 'new WebSocket()', line: lineOf(node.getStart()) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

// 1. No provider-domain literal in src except the policy file itself.
for (const f of files) {
  if (f === POLICY_FILE) continue;
  const src = readFileSync(join(ROOT, f), 'utf8');
  for (const d of PROVIDER_HOST_BLOCKLIST) {
    check(`${f} has no "${d}" literal`, !src.includes(d));
  }
}

// 2. Outbound primitives confined to allowlisted files (AST walk, #2).
let totalViolations = 0;
for (const f of files) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  const violations = ALLOW.has(f) ? [] : findOutboundViolations(src, f);
  for (const v of violations) {
    totalViolations++;
    console.log(`  FAIL: ${v.file}:${v.line} outbound primitive not allowlisted -- ${v.desc}`);
  }
  check(`${f} outbound primitives allowlisted`, violations.length === 0);
}
check('no outbound violations across src', totalViolations === 0);

// Sanity: the allowlisted files are exactly those that need outbound (else the list is stale).
for (const f of EGRESS_ALLOWED_OUTBOUND_FILES) {
  check(`allowlisted ${f} exists`, files.includes(f));
}
// Sanity: each allowlisted file actually contains an outbound primitive (else it shouldn't be
// on the list -- catches a stale entry after a refactor removes the last outbound call).
for (const f of EGRESS_ALLOWED_OUTBOUND_FILES) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  check(`allowlisted ${f} actually uses outbound`, findOutboundViolations(src, f).length > 0);
}

// --- #2 bypass samples: evasions the old regex missed, the AST catches ------------------------
const BYPASS_SAMPLES: { name: string; code: string; regexMisses: boolean }[] = [
  { name: 'new WebSocket', code: `new WebSocket('wss://evil.example')`, regexMisses: true },
  { name: 'https.get', code: `https.get('https://evil.example')`, regexMisses: true },
  { name: 'net.connect', code: `net.connect({ host: 'evil.example', port: 443 })`, regexMisses: true },
  { name: 'tls.connect', code: `tls.connect({ host: 'evil.example', port: 443 })`, regexMisses: true },
  { name: 'dns.resolve', code: `dns.resolve('evil.example')`, regexMisses: true },
  { name: 'dns.lookup', code: `dns.lookup('evil.example')`, regexMisses: true },
  { name: 'require(http).request', code: `require('http').request('https://evil.example')`, regexMisses: true },
  { name: 'dynamic import(https)', code: `import('https')`, regexMisses: true },
  // undici.fetch contains the substring `fetch(` so the OLD regex actually catches it; included
  // to confirm the AST also catches it (FETCH_OBJECTS) -- NOT a regex false-negative.
  { name: 'undici.fetch', code: `undici.fetch('https://evil.example')`, regexMisses: false },
];
for (const s of BYPASS_SAMPLES) {
  const v = findOutboundViolations(s.code, 'sample.ts');
  check(`bypass sample "${s.name}" caught by AST`, v.length > 0);
  if (s.regexMisses) {
    // Prove the OLD regex would have let this through -- the reason we switched to AST.
    check(`bypass sample "${s.name}" was a regex false-negative`, !OUTBOUND_RE.test(s.code));
  }
}

// --- #2 false-positive guard: legitimate non-outbound patterns must NOT be flagged ------------
const LEGIT_SAMPLES: { name: string; code: string }[] = [
  { name: 'http.createServer (inbound)', code: `http.createServer((req, res) => {})` },
  { name: 'net.createServer (inbound)', code: `net.createServer((socket) => {})` },
  { name: 'new WebSocketServer (inbound)', code: `new WebSocketServer({ noServer: true })` },
  { name: 'WebSocket.OPEN (enum access)', code: `if (ws.readyState !== WebSocket.OPEN) return;` },
  { name: 'import type node:http', code: `import type { IncomingMessage } from 'node:http';` },
  { name: 'import createServer node:net', code: `import { createServer } from 'node:net';` },
  { name: 'Promise.resolve', code: `Promise.resolve(42)` },
  { name: 'tracker.resolve (approval)', code: `this.tracker.resolve(id, 'allow');` },
  { name: 'this.request (JSON-RPC)', code: `await this.request('initialize', {});` },
  { name: 'map.get', code: `const v = map.get('key');` },
];
for (const s of LEGIT_SAMPLES) {
  const v = findOutboundViolations(s.code, 'sample.ts');
  check(`legit sample "${s.name}" not flagged`, v.length === 0);
}

// 3. assertNotProviderHost / isProviderHost behavior.
check('api.anthropic.com is provider', isProviderHost('api.anthropic.com'));
check('api.openai.com is provider', isProviderHost('api.openai.com'));
check('subdomain of provider is provider', isProviderHost('us-west.api.anthropic.com'));
check('localhost is not provider', !isProviderHost('localhost'));
check('127.0.0.1 is not provider', !isProviderHost('127.0.0.1'));
check('relay IP is not provider', !isProviderHost('203.0.113.5'));
check('relay URL host is not provider', !isProviderHost('tcp://203.0.113.5:11010'));

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
check('assertNotProviderHost blocks api.anthropic.com', throws(() => assertNotProviderHost('api.anthropic.com')));
check('assertNotProviderHost blocks api.openai.com', throws(() => assertNotProviderHost('api.openai.com')));
check('assertNotProviderHost blocks subdomain', throws(() => assertNotProviderHost('v1.api.openai.com')));
check('assertNotProviderHost allows localhost', !throws(() => assertNotProviderHost('localhost')));
check('assertNotProviderHost allows relay IP', !throws(() => assertNotProviderHost('203.0.113.5')));

console.log(`egress: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
