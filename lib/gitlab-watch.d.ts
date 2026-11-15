import { F as Thread, I as ThreadFact, R as ThreadRef, S as ChannelRef, U as Trigger, h as SourceScope, l as OutboundMessage, lt as Deployment, m as ScopeResult, t as ReceiveResult, v as AdmissionCell, z as Ticket } from "./intake-Cpe8OLLK.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import "@deepseek-ai/dsh-llm";
import { Agent } from "@deepseek-ai/dsh-agent";
interface Tally {
  skipped: number;
}
/**
 * Executes gh, glab, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
declare class Commands {
  private readonly resolved;
  private readonly environment;
  private readonly signal;
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(resolved: () => Deployment, environment: Record<string, string | undefined>, signal: AbortSignal);
  get deployment(): Deployment;
  get repository(): string;
  withSignal(signal?: AbortSignal): Commands;
  run(program: string, args: string[], cwd?: string): Promise<string>;
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  gh<T>(args: string[]): Promise<T>;
  /** Runs the agent's GitLab CLI (the glab-agent wrapper) and parses its JSON output. */
  glab<T>(args: string[]): Promise<T>;
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>;
  api(path: string, ...flags: string[]): Promise<string>;
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]>;
  private path;
  /** Numeric GitLab project id, or undefined for a legacy GitHub deployment. */
  get projectId(): number | undefined;
  /** `path_with_namespace` of the configured GitLab project. */
  get projectPath(): string | undefined;
  /**
   * Calls the GitLab API on a path within the configured project, validating JSON output when a schema is provided.
   * @throws CliError with GitLab's HTTP status as `code` on failure.
   */
  gitlabApi<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>;
  gitlabApi(path: string, ...flags: string[]): Promise<string>;
  /** Fetches every page of a GitLab API list as newline-delimited JSON; malformed lines are skipped and counted. */
  gitlabPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]>;
  private gitlabPath;
  /**
   * Calls the user-level GitLab API, which is not scoped to the configured project: the agent's TODOs and own account.
   * @throws CliError with GitLab's HTTP status as `code` on failure.
   */
  gitlabUserApi<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>;
  gitlabUserApi(path: string, ...flags: string[]): Promise<string>;
  /** Fetches every page of a user-level GitLab API list as newline-delimited JSON; malformed lines are skipped and counted. */
  gitlabUserPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]>;
  private userPath;
  /** Parses newline-delimited JSON items, skipping malformed lines and items that fail `item` validation. */
  private ndjson;
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  git(args: string[], cwd: string): Promise<string>;
}
/** A merge request; `state` is `opened`, `closed`, `locked`, or `merged`. */
declare const MergeRequestSchema: z.ZodObject<{
  id: z.ZodOptional<z.ZodNumber>;
  iid: z.ZodNumber;
  title: z.ZodString;
  description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  state: z.ZodString;
  author: z.ZodPipe<z.ZodNullable<z.ZodObject<{
    id: z.ZodOptional<z.ZodNumber>;
    username: z.ZodString;
    name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    state: z.ZodDefault<z.ZodString>;
    bot: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$loose>>, z.ZodTransform<{
    [x: string]: unknown;
    id?: number | undefined;
    username: string;
    name?: string | null | undefined;
    state: string;
    bot?: boolean | undefined;
  }, {
    [x: string]: unknown;
    id?: number | undefined;
    username: string;
    name?: string | null | undefined;
    state: string;
    bot?: boolean | undefined;
  } | null>>;
  created_at: z.ZodString;
  updated_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  web_url: z.ZodString;
  source_branch: z.ZodString;
  target_branch: z.ZodOptional<z.ZodString>;
  sha: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  merged_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  closed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  merge_when_pipeline_succeeds: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
  auto_merge_enabled: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
  detailed_merge_status: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  source_project_id: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
  target_project_id: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
  draft: z.ZodOptional<z.ZodBoolean>;
  discussion_locked: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
  project_id: z.ZodOptional<z.ZodNumber>;
  head_pipeline: z.ZodOptional<z.ZodNullable<z.ZodObject<{
    id: z.ZodNumber;
    iid: z.ZodOptional<z.ZodNumber>;
    status: z.ZodString;
    ref: z.ZodOptional<z.ZodString>;
    sha: z.ZodOptional<z.ZodString>;
    web_url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  }, z.core.$loose>>>;
}, z.core.$loose>;
type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>;
declare const ADMISSION_OPTIONS: {
  readonly listedUnaddressed: readonly ["inferred", "ignore"];
  readonly unlistedAddressed: readonly ["explicit", "inferred", "ignore"];
  readonly unlistedUnaddressed: readonly ["inferred", "ignore"];
};
type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number]; };
interface HealthEntry {
  get(): Health | undefined;
  set(health: Health): void;
  /** Unregisters the entry from the board (such as when a Source kind unregisters); subsequent `set` calls become no-ops. */
  release(): void;
}
/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by Runtime, Effects, Sessions, DshExecutor, Settings, and SourceRegistry, and read by management HTTP routes.
 */
declare class HealthBoard {
  private readonly entries;
  private readonly claimed;
  claim(name: string, initial?: Health): HealthEntry;
  get all(): Readonly<Record<string, Health>>;
}
declare const SettingsSchema: z.ZodObject<{
  paused: z.ZodDefault<z.ZodBoolean>;
  sources: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strict>>>;
  policy: z.ZodDefault<z.ZodObject<{
    rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
      id: z.ZodString;
      name: z.ZodString;
      enabled: z.ZodBoolean;
      instruction: z.ZodString;
    }, z.core.$strict>>>;
    sources: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
      allowed: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
      }, z.core.$strict>>>;
      admission: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodType<AdmissionRow, unknown, z.core.$ZodTypeInternals<AdmissionRow, unknown>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>;
  }, z.core.$strict>>;
  eval: z.ZodDefault<z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<{
      auto: "auto";
      observe: "observe";
      off: "off";
    }>>;
    timeoutSeconds: z.ZodDefault<z.ZodNumber>;
    model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
      provider: z.ZodString;
      model: z.ZodString;
      reasoningEffort: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
  }, z.core.$strict>>;
  executor: z.ZodDefault<z.ZodObject<{
    model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
      provider: z.ZodString;
      model: z.ZodString;
      reasoningEffort: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    maxWorkers: z.ZodDefault<z.ZodNumber>;
    directory: z.ZodDefault<z.ZodString>;
    prepare: z.ZodDefault<z.ZodString>;
    blockedCommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
  }, z.core.$strict>>;
}, z.core.$strict>;
type Settings = z.infer<typeof SettingsSchema>;
/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
declare class SourceRegistry implements SourceScope {
  private readonly settings;
  private readonly board;
  private readonly registered;
  private readonly kinds;
  private readonly health;
  constructor(settings: () => Settings, board?: Pick<HealthBoard, 'claim'>, registered?: (kind: SourceKind) => () => void);
  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void;
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry>;
  kind(id: string): SourceKind | undefined;
  /** Every registered kind's instance ordered by ID, followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "auto" | "observe" | "off";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): (SourceInstance & {
    installed: boolean;
  })[];
  instance<C extends Record<string, unknown>>(id: string, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "auto" | "observe" | "off";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): SourceInstance<C> | undefined;
  validate(id: string, value: {
    enabled: boolean;
    config: unknown;
  }): {
    enabled: boolean;
    config: Record<string, unknown>;
  };
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & {
    allowed: {
      id: string;
      name?: string;
    }[];
  }>;
  policyPart(id: string, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "auto" | "observe" | "off";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): {
    allowed: {
      id: string;
      name?: string;
    }[];
    admission: Record<string, AdmissionRow>;
  } | undefined;
  channelAllowed(channel: {
    source: string;
    address: Record<string, string>;
  }, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "auto" | "observe" | "off";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): boolean;
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): {
    kind: string;
    variables: readonly VariableSpec[];
  }[];
  environments(settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "auto" | "observe" | "off";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): {
    kind: SourceKind<Record<string, unknown>>;
    environment: {
      variables: readonly VariableSpec[];
      values(input: EnvironmentInput<Record<string, unknown>>): Record<string, string>;
    };
    config: Record<string, unknown>;
  }[];
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'>;
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink;
  find(query: string): {
    threads: string[];
    terms: string[];
  };
  repliesTo(trigger: Trigger): string | undefined;
  threadContext(trigger: Trigger, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "auto" | "observe" | "off";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): TriggerContext | undefined;
  scope(input: {
    source: string;
    meta: Record<string, unknown>;
  }, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "auto" | "observe" | "off";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): ScopeResult;
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve;
}
type SetupPlace = 'deployment' | 'github' | 'gitlab';
declare const SETUP_PROBLEMS: {
  readonly foreignFile: readonly ["deployment", "{file} was not written by dsh-superagent; move it, or choose another state directory."];
  readonly gitTooOld: readonly ["deployment", "git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later."];
  readonly environmentFailed: readonly ["deployment", "Preparing the agent environment failed."];
  readonly repositoryUnset: readonly ["github", "The GitHub Source names no repository."];
  readonly agentCliUnset: readonly ["github", "The agent GitHub CLI is not set."];
  readonly agentCliMissing: readonly ["github", "The agent GitHub CLI was not found."];
  readonly agentCliSignedOut: readonly ["github", "The agent GitHub CLI cannot read its account."];
  readonly agentCliNoAccount: readonly ["github", "The agent GitHub CLI did not report a GitHub account."];
  readonly repositoryUnreadable: readonly ["github", "@{account} cannot read {repository}."];
  readonly repositoryUnreported: readonly ["github", "The agent GitHub CLI did not return {repository}."];
  readonly repositoryReadOnly: readonly ["github", "@{account} cannot push to {repository}."];
  readonly projectUnset: readonly ["gitlab", "The GitLab Source names no project."];
  readonly gitlabCliUnset: readonly ["gitlab", "The agent glab CLI is not set."];
  readonly gitlabCliMissing: readonly ["gitlab", "The agent glab CLI was not found."];
  readonly gitlabCliSignedOut: readonly ["gitlab", "The agent glab CLI cannot read its account."];
  readonly gitlabCliNoAccount: readonly ["gitlab", "The agent glab CLI did not report a GitLab account."];
  readonly projectUnreadable: readonly ["gitlab", "@{account} cannot read {project}."];
  readonly projectUnreported: readonly ["gitlab", "The agent glab CLI did not return {project}."];
  readonly projectReadOnly: readonly ["gitlab", "@{account} cannot push to {project}."];
  readonly projectHostMismatch: readonly ["gitlab", "The GitLab CLI is signed in to {actual}, but the Source names {host}."];
  readonly gitlabGitTooOld: readonly ["deployment", "git does not read the credential configuration for {host}; dsh-superagent needs git 2.32 or later."];
  readonly stateDirUnsupported: readonly ["deployment", "This state directory belongs to a GitHub installation; start with a new state directory for GitLab."];
};
type SetupCode = keyof typeof SETUP_PROBLEMS;
interface SetupProblem {
  place: SetupPlace;
  code: SetupCode;
  values: Record<string, string>;
  detail: string;
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void;
  }
}
/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
type Key<V> = string & {
  readonly __value?: V;
};
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & {
  readonly prefix: string;
};
/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
declare const HEALTH_TEXT: {
  readonly setupPending: 'Waiting for the deployment check';
  readonly sourceOff: 'Off';
  readonly pollFailures: '{count} consecutive failed polls; last: {error}';
};
type HealthCode = keyof typeof HEALTH_TEXT;
type Health = {
  state: 'starting' | 'ready' | 'paused' | 'error';
  detail: string;
  at?: string;
  code?: HealthCode;
  values?: Record<string, string>;
};
interface SourceHost {
  readonly sources: SourceRegistry;
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: {
    kind: string;
    health: readonly string[];
  }): SourceContext;
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
interface ThreadDescription {
  label?: string;
  url?: string;
  facts?: Record<string, ThreadFact | null>;
}
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
interface SourceContext {
  readonly deployment: Deployment;
  readonly commands: Commands;
  readonly ready: Promise<void>;
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean;
  /** Setup problem keeping this Source's account from running. */
  readonly problem?: SetupProblem | undefined;
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined;
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>;
  atomic<T>(work: () => T): T;
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: {
    get<V>(key: Key<V>): V | undefined;
    set<V>(key: Key<V>, value: V | undefined): void;
    keys<V>(family: Family<V, never>): Key<V>[];
  };
  threads: {
    get(key: string): Thread | undefined;
    subscribed(source: string): Thread[];
    describe(key: string, description: ThreadDescription): void;
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void;
  };
  tickets: {
    get(id: string): Ticket | undefined;
    /** Open tickets, newest first. */
    open(): Ticket[];
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void;
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void;
  };
  triggers: {
    get(id: string): Trigger | undefined; /** The newest Trigger on a Thread. */
    latest(thread: string): Trigger | undefined;
  };
  notify(message: OutboundMessage): void;
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void;
}
interface Localized {
  zh: string;
  en: string;
}
/** `advanced` folds a rarely changed field (such as a polling tunable) behind the card's Advanced section. */
interface FieldBase {
  key: string;
  label: Localized;
  hint?: Localized;
  advanced?: true;
}
/**
 * Configuration field specification; `rows` edits a list of records keyed by its first column, `choose` picks from
 * resolved source labels, and `fact` displays a read-only value from `facts`.
 */
type FieldSpec = (FieldBase & {
  type: 'switch';
}) | (FieldBase & {
  type: 'select';
  options: {
    value: string;
    label: Localized;
  }[];
}) | (FieldBase & {
  type: 'number';
  min: number;
  max: number;
}) | (FieldBase & {
  type: 'text';
  pattern?: string;
  readonly?: boolean;
  choose?: Localized;
}) | (FieldBase & {
  type: 'fact';
  settings?: 'deployment';
}) | (FieldBase & {
  type: 'rows';
  columns: ({
    key: string;
    label: Localized;
    type: 'text';
    pattern?: string;
    optional?: boolean;
    choose?: Localized;
    refresh?: Localized;
  } | {
    key: string;
    label: Localized;
    type: 'select';
    options: {
      value: string;
      label: Localized;
    }[];
  })[];
});
interface VariableSpec {
  key: string;
  description: Localized;
}
interface EnvironmentInput<C> {
  deployment: Deployment;
  config: C;
  trigger?: Trigger;
}
interface AdmissionRowView {
  id: string;
  label: Localized | string;
  note: Localized;
  cells: {
    listedUnaddressed: boolean;
    unlistedAddressed: boolean;
    unlistedUnaddressed: boolean;
  };
}
/** Policy extension for a source kind, defining allowed senders, admission table rows, and optional external roster sync. */
interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** Validates the Source's part of the Policy, including `allowed` (senders who may originate work). */
  schema: z.ZodType<P>;
  /** Form fields of the policy part; the first is `allowed`. */
  fields: FieldSpec[];
  /** Describes what the Source marks as addressed to the agent, which an allowed sender's explicit request requires. */
  explicit: Localized;
  /** Fallback display labels for unlisted human or bot senders when raw sender IDs are not human-readable. */
  unnamed?: {
    person: Localized;
    bot: Localized;
  };
  /** Receiving scopes of the Policy's admission table under `config` (matching `scope().row`); kinds without `rows` use the table's defaults. */
  rows?(config: Record<string, unknown>): AdmissionRowView[];
  /** Optional external roster sync (such as chat members); `ready` reports whether `part` names a target to refresh from. */
  sync?: {
    label: Localized;
    ready(part: P): boolean;
    run(host: SourceHost, part: P, signal: AbortSignal): Promise<P>;
  };
}
/** UI link for a channel address; `triggerId` names the Trigger whose own deep link is preferred when available. */
interface ChannelLink {
  url: string;
  label: Localized;
  triggerId?: string;
}
type ChannelLinks = Partial<Pick<Deployment, 'repository' | 'project' | 'codeHost'>>;
/** Outbound messaging adapter for a source kind's threads. */
interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean;
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>;
  /** Returns the URL and label for `address`; `url` is empty when `links` lack the required deployment info. */
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink;
}
/** Normalized message returned by thread context readers; `bot` marks a non-human sender whose message can never authorize work on its own (at most an inferred candidate). */
interface ContextMessage {
  id: string;
  from: string;
  at: string;
  text: string;
  bot?: true;
  deleted?: true;
  reply_to?: string;
  url?: string;
  path?: string;
  line?: number;
}
type ContextPartName = 'thread' | 'root' | 'parent';
interface ContextPart {
  messages: ContextMessage[];
  next?: string | undefined;
  body: Record<string, unknown>;
  status?: string;
}
/** Bounded thread context reader used by assessments to inspect messages and images around a trigger. */
interface ThreadContext<C> {
  /** The ID of the Trigger's own message among the messages of its Thread. */
  messageId(trigger: Trigger): string;
  /** Reads a page of thread messages (`thread`, first page when `cursor` is omitted), the topic root (`root`), or the replied-to message (`parent`). */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>;
  /** Extracts image keys from message text that `image` can read; omitted for kinds without image support. */
  images?(text: string): string[];
  /** Reads one image of a message in the Trigger's Thread as an attachment for `agent`. */
  image?(agent: Agent, commands: Commands, trigger: Trigger, message: {
    id: string;
    text: string;
  }, key: string, stateDir: string, signal: AbortSignal): Promise<unknown>;
}
interface TriggerContext {
  readonly messageId: string;
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>;
  images(text: string): string[];
  /** @throws for a kind without image support. */
  image(agent: Agent, commands: Commands, message: {
    id: string;
    text: string;
  }, key: string, stateDir: string, signal: AbortSignal): Promise<unknown>;
}
/** Pluggable source kind descriptor registered with SourceRegistry. */
interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; a default instance with the same ID exists when none is stored. */
  kind: string;
  title: Localized;
  description: Localized;
  /** Read-only status facts derived from `deployment` (undefined while waiting for setup), keyed by field key. */
  facts?(deployment: Deployment | undefined): Record<string, Localized | string>;
  /** Validates stored and submitted configuration and fills defaults. */
  schema: z.ZodType<C>;
  fields: FieldSpec[];
  /** Health entry names owned by this kind under `health[...]`; no other kind or core loop may report them. */
  health: string[];
  /** Listening rule for a trigger (or recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: {
    meta: Record<string, unknown>;
  }, config: C): ScopeResult;
  /** Outbound reply adapter; kinds without `channel` produce no replies or channel checks. */
  channel?: SourceChannel<C>;
  /** Bounded context reader for assessments; assessments of a kind without `threadContext` read none. */
  threadContext?: ThreadContext<C>;
  /** Maps a search query to candidate Thread keys (such as `gitlab:issue:12`) and Trigger search terms (such as a chat message ID). */
  find?(query: string): {
    threads: string[];
    terms: string[];
  };
  /** Returns the ID of the Trigger whose message this Trigger replies to, when derivable without a network read. */
  repliesTo?(trigger: Trigger): string | undefined;
  /** Policy section for kinds whose senders have their own identity. */
  policy?: SourcePolicyPart<Record<string, unknown> & {
    allowed: {
      id: string;
      name?: string;
    }[];
  }>;
  /** Rereads display names for row keys (such as chat names), stores the resolved names in `KV.sources.labels(kind)`, and returns them. */
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>;
  /** Variables the kind registers with the execution environment and how their values are computed. */
  environment?: {
    variables: readonly VariableSpec[];
    values(input: EnvironmentInput<C>): Record<string, string>;
  };
}
interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  kind: string;
  enabled: boolean;
  config: C;
}
type MergeRequest = GitlabMergeRequest;
/** Minimal GitLab configuration: the project, its agent CLI and host, and the scopes this Source observes. */
export declare const GitlabConfigSchema: z.ZodObject<{
  project: z.ZodDefault<z.ZodString>;
  cli: z.ZodDefault<z.ZodString>;
  host: z.ZodDefault<z.ZodString>;
  pollSeconds: z.ZodDefault<z.ZodNumber>;
  failuresBeforeError: z.ZodDefault<z.ZodNumber>;
  observeIssues: z.ZodDefault<z.ZodBoolean>;
  observeMergeRequests: z.ZodDefault<z.ZodBoolean>;
  observeNotes: z.ZodDefault<z.ZodBoolean>;
  observeCi: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>;
export declare const gitlabKind: SourceKind<GitlabConfig>;
export declare const name = "dsh-superagent-gitlab";
export declare const inject: string[];
/** Register the Source kind and run its polling loop until the plugin unloads. */
export declare function apply(ctx: Context): void;
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export declare function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined;
/** A `429` backoff asked for by `Retry-After`, in seconds; P0 found GitLab may omit the header, hence the five-minute default. */
export declare function retryAfter(error: unknown): number | undefined;
/** The polling loop: resolves setup once, then polls every `pollSeconds` and reports failures as source health. */
export declare function watch(ctx: SourceContext, signal: AbortSignal): Promise<void>;
interface Round {
  started: string;
  signal?: AbortSignal | undefined;
  mrs: Map<number, Promise<MergeRequest>>;
  /** Thread keys already read in this round, so TODO, stream and Thread reads share one read. */
  read: Set<string>;
  failures: string[];
  dropped: number[];
  abandoned: number[];
  tally: Tally;
  backoff?: number;
}
/**
 * One polling round: TODOs, then observed streams, then the open tickets' merge requests and pipelines, then subscribed
 * Threads. Each step and each Issue/MR/Thread fails independently so all steps run before the round fails.
 * @returns the polling interval in seconds.
 */
export declare function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number>;
/** Polls the merge requests of open tickets, observing their lifecycle and CI; each MR is read once per round. */
export declare function pollTicketMrs(ctx: SourceContext, signal?: AbortSignal, round?: Round): Promise<void>;
/** Polls subscribed Issue and MR Threads not already read in this round; a deleted target does not fail the round. */
export declare function pollThreads(ctx: SourceContext, signal?: AbortSignal, round?: Round): Promise<void>;
export {};