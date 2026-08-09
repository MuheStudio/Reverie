declare global {
  const __ENV__: string;

  interface AvatarRecord {
    id: string;
    name: string;
    kind: 'live2d' | 'vrm' | 'glb';
    entryUrl: string;
    status: 'ready' | 'invalid' | 'missing' | 'error';
    detected?: {
      expressions: string[];
      animationClips: string[];
    };
    mapping?: {
      expressions: Record<string, string>;
      actions: Record<string, string>;
    };
    capabilities?: {
      expressionPlayback?: boolean;
      embeddedAnimationPlayback?: boolean;
      vrmaImport?: boolean;
      vrmaPlayback?: boolean;
      [key: string]: boolean | undefined;
    };
    motions?: Array<{
      id: string;
      name: string;
      url: string;
      playbackSupported?: boolean;
    }>;
  }

  interface AvatarListResult {
    records: AvatarRecord[];
    activeId: string | null;
    runtime?: AvatarRuntime;
  }

  interface AvatarDetected {
    animationClips: string[];
    expressions: string[];
  }

  interface AvatarImportCandidate {
    importId: string;
    name: string;
    kind: 'live2d' | 'vrm' | 'glb';
    preview?: {
      url: string;
      format: string;
      capabilities?: AvatarDetected;
    };
  }

  interface FocusState {
    running: boolean;
    startedAt?: string;
    endsAt?: string;
    [key: string]: unknown;
  }

  interface FocusSoundRecord {
    id: string;
    name: string;
    url: string;
    [key: string]: unknown;
  }

  interface AvatarRuntime {
    live2d?: {
      available: boolean;
      licenseAccepted: boolean;
      developmentOnly?: boolean;
      reason?: string;
    };
  }

  interface BridgeConnectionConfig {
    transport?: 'electron-ipc' | 'websocket';
    url: string;
    secret: string;
    origin?: string;
    protocolVersion: 4;
    generation?: number;
    clientId?: string;
    personaId?: string;
    personaEpoch?: number;
    personaFingerprint?: string;
    modelEpoch?: number;
    restartRequired?: boolean;
  }

  interface LocalModeState {
    enabled: boolean;
    epoch: number;
    sessionId: string | null;
    changedAtUtc: string;
    available: boolean;
    reason: string;
    transitioning?: boolean;
  }

  interface CredentialStatus {
    available: boolean;
    persistentAvailable?: boolean;
    corrupted: boolean;
    lastErrorCode?: string;
    writeError?: {
      code: string;
      message: string;
    };
    sessionWarning?: string;
    llm: {
      hasApiKey: boolean;
      hasCustomHeaders: boolean;
      sessionOnly?: boolean;
      bindingKnown?: boolean;
    };
    stored?: boolean;
    runtimeApplied?: boolean;
    runtimePending?: boolean;
    runtimeAppliedScopes?: { llm: boolean };
    bindingMismatch?: { llm: boolean };
  }

  interface PublicProviderConfig {
    llm: {
      provider: 'openai' | 'anthropic' | 'gemini' | 'grok' | 'deepseek' | 'kimi' | 'glm'
        | 'ollama' | 'custom';
      baseUrl: string;
      model: string;
      customProviderName?: string;
    };
  }

  interface ProviderCredential {
    apiKey?: string;
    customHeaders?: string;
  }

  interface Window {
    electronAPI?: {
      platform?: string;
      getAppVersion?: () => Promise<string>;
      onAppLifecycle?: (
        callback: (event: { state: string; at: string }) => void,
      ) => () => void;
      bridge?: {
        getConnectionConfig: () => Promise<BridgeConnectionConfig>;
        send: (frame: {
          type: string;
          payload: Record<string, unknown>;
          request_id?: string;
        }) => Promise<{ accepted: boolean }>;
        onMessage: (callback: (frame: unknown) => void) => () => void;
        onChanged: (
          callback: (state: { ready: boolean; generation?: number }) => void,
        ) => () => void;
      };
      localMode?: {
        get: () => Promise<LocalModeState>;
        set: (enabled: boolean) => Promise<LocalModeState>;
        onChanged: (callback: (state: LocalModeState) => void) => () => void;
      };
      credentials?: {
        status: () => Promise<CredentialStatus>;
        clear: () => Promise<CredentialStatus>;
        onChanged: (callback: (status: CredentialStatus) => void) => () => void;
        // Legacy DreamRoom surface kept for type compatibility.
        set?: (scope: string, value: Record<string, unknown>) => Promise<CredentialStatus>;
        setSession?: (scope: string, value: Record<string, unknown>) => Promise<CredentialStatus>;
      };
      providerConfig?: {
        get: () => Promise<PublicProviderConfig | null>;
        test: (
          value: PublicProviderConfig,
          credential?: ProviderCredential,
        ) => Promise<
          | {
              ok: true;
              receipt: string;
              latencyMs: number;
              finishReason: string;
              model?: string;
            }
          | {
              ok: false;
              code: string;
              message: string;
            }
        >;
        commit: (
          value: PublicProviderConfig,
          credential: ProviderCredential | undefined,
          mode: 'persistent' | 'session',
          testReceipt: string,
        ) => Promise<{
          config: PublicProviderConfig;
          status: CredentialStatus;
        }>;
        // Legacy DreamRoom surface kept for type compatibility.
        set?: (value: Record<string, unknown>) => Promise<unknown>;
      };
      character?: {
        get: () => Promise<{
          record: AvatarRecord | null;
          runtime?: AvatarRuntime;
        }>;
      };
      pet?: {
        toggle: () => Promise<boolean>;
        show: () => Promise<boolean>;
        hide: () => Promise<boolean>;
        isVisible: () => Promise<boolean>;
      };
      // DreamRoom / legacy surface (kept for the switchable her-room view)
      showNotification?: (title: string, body: string) => Promise<boolean>;
      getNotificationStatus?: () => Promise<{ supported: boolean; enabled: boolean }>;
      stickers?: {
        list: () => Promise<{ items: unknown[] }>;
        collect: (value: Record<string, unknown>) => Promise<{ ok: boolean }>;
      };
      files?: {
        selectAudio?: () => Promise<{ name: string; dataUrl: string } | null>;
        selectVideo?: () => Promise<{ name: string; dataUrl: string } | null>;
      };
      backup?: {
        export: () => Promise<{ ok: boolean }>;
        import: () => Promise<{ ok: boolean }>;
      };
      focus?: {
        get: () => Promise<unknown>;
        set: (value: unknown) => Promise<unknown>;
      };
      focusSound?: {
        list: () => Promise<{ items: unknown[] }>;
        add: (value: unknown) => Promise<{ ok: boolean }>;
      };
      avatar?: {
        list: () => Promise<{ records: unknown[]; activeId: string | null }>;
      };
      companionPreferences?: {
        get: () => Promise<unknown>;
        set: (value: unknown) => Promise<unknown>;
      };
      getCurrentWindowsLocation?: () => Promise<{
        latitude: number;
        longitude: number;
        accuracy?: number;
      } | null>;
      openLocationSettings?: () => Promise<void>;
    };
  }
}

export {};
