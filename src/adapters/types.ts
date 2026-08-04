// Unified adapter abstraction (A5). All CLI backends implement this; the gateway
// and approval bridge speak only these types. See backend-design §5.
import type {
  AdapterKind,
  AdapterConfig,
  ApprovalPolicy,
  ApprovalsReviewer,
  SandboxMode,
} from '../config/schema';
import type { FailureCategory } from '../util/logger';

export type { AdapterKind };

export interface AuthProfile {
  adapter: AdapterKind;
  mode: 'oauth' | 'apiKey' | 'authToken+BaseUrl' | 'providerKey' | 'none';
  hasCredentials: boolean; // existence only (S4/S5)
  baseUrlPresent?: boolean; // existence only, NEVER the value
  proxyDetected?: boolean;
  // NEVER contains any secret value.
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Native CLI reasoning-effort values. Adapters expose their supported subset through
 * capabilities; the gateway never translates an unsupported value into a prompt. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Observable path timings. They are intentionally not presented as one-way network
 * measurements: dispatch is local process overhead and first-event is an aggregate that may
 * include CLI startup, provider processing and network time. */
export interface TransportMetrics {
  backendCliQueueMs?: number;
  backendCliDispatchMs?: number;
  cliFirstEventMs?: number;
  observedAt: string;
}

export type ApprovalKind = 'command' | 'fileChange' | 'permission' | 'mcpElicit' | 'userInput';
export type ApprovalChoice = 'allow' | 'allow_session' | 'deny' | 'cancel';
export type ApprovalDecision = ApprovalChoice | { allowWithModification?: unknown };

export interface SessionOpts {
  sessionId: string; // backend-internal id
  cliSessionRef?: string; // claude --session-id / codex threadId / opencode session id (resume)
  cwd?: string;
  extraDirs?: string[];
  /** v3: resolved env vars from the active account profile, injected at spawn.
   * claude: the profile's credential env vars (from a user-maintained env file, 0-modify).
   * codex: { CODEX_HOME: <dir> } for a codexHome profile (a PATH, not a credential; codex
   *   reads its own auth.json there). Never holds raw OAuth tokens; NEVER echoed back in events. */
  profileEnv?: Record<string, string>;
  /** Per-session override. Undefined inherits the adapter's configured native default. */
  model?: string;
  /** Per-session native CLI reasoning effort. Undefined preserves the CLI's own default. */
  effort?: ReasoningEffort;
}

export interface UserInput {
  text: string;
  attachments?: { name: string; base64?: string; path?: string }[];
}

export interface Message {
  seq: number; // global incrementing per session (I2 incremental history)
  role: 'user' | 'assistant' | 'tool' | 'system';
  text?: string;
  toolCallId?: string;
  tool?: string;
  toolInput?: unknown;
  toolOutput?: string;
  thinking?: string;
  createdAt: string;
}

export type AdapterEvent =
  | { type: 'turn.started' }
  | { type: 'thinking.delta'; text: string }
  | { type: 'thinking.done' }
  | { type: 'text.delta'; text: string }
  | { type: 'text.done'; text: string }
  | { type: 'tool.start'; toolCallId: string; tool: string; input: unknown }
  | { type: 'tool.output'; toolCallId: string; text?: string; base64?: string }
  | { type: 'tool.done'; toolCallId: string; isError: boolean }
  | {
      type: 'approval.request';
      approvalId: string;
      kind: ApprovalKind;
      tool?: string;
      input?: unknown;
      summary: string;
      choices: ApprovalChoice[];
    }
  | { type: 'approval.resolved'; approvalId: string; decision: ApprovalDecision }
  | { type: 'turn.completed'; usage?: Usage; costUsd?: number; model?: string; effort?: ReasoningEffort }
  | { type: 'turn.failed'; category: FailureCategory; summary: string }
  | { type: 'transport.metrics'; metrics: TransportMetrics };

export interface SessionHandle {
  readonly sessionId: string;
  readonly cliSessionRef?: string;
  /** Resolved explicit values. Undefined means the CLI's native default remains authoritative. */
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  send(input: UserInput): Promise<void>; // I3
  interrupt(): Promise<void>; // I5
  history(afterSeq?: number): Promise<Message[]>; // I2
  onEvent(cb: (e: AdapterEvent) => void): () => void; // streaming -> unified events
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>; // I4
  /** Update the native CLI argument used by subsequent turns. Must reject while a turn runs. */
  setEffort?(effort?: ReasoningEffort): Promise<void>;
  dispose(): Promise<void>;
}

/** Frontend-readable contract for adapter differences. Adding an adapter requires registering
 * this metadata, not adding provider-specific conditionals to the gateway. */
export interface AdapterCapabilities {
  streaming: {
    text: boolean;
    thinking: boolean;
    tools: boolean;
  };
  resume: boolean;
  interrupt: boolean;
  accountProfiles: boolean;
  approval: {
    transport: 'http-hook' | 'command-hook' | 'native';
    semantics: 'remote-every-tool-or-never' | 'native';
    policies: readonly ApprovalPolicy[];
  };
  configuration: {
    model: boolean;
    effortLevels: readonly ReasoningEffort[];
    sandboxModes: readonly SandboxMode[];
    reviewers: readonly ApprovalsReviewer[];
  };
}

export interface Adapter {
  readonly kind: AdapterKind;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  isAvailable(): Promise<boolean>; // CLI installed?
  detect(): Promise<AuthProfile>; // 0-modify: read-only
  startSession(opts: SessionOpts): Promise<SessionHandle>;
  /** Apply live config after a /config PATCH. Adapters capture approvalTimeoutSec + adapterConfig
   *  at construction; without this, post-PATCH sessions spawn with stale config (review P1). */
  reconfigure?(opts: { approvalTimeoutSec: number; adapterConfig: AdapterConfig }): void;
}
