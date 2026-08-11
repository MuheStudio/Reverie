declare global {
  const __ENV__: string;

  interface AvatarRecord {
    id: string;
    name: string;
    kind: 'live2d' | 'vrm' | 'glb';
    entryUrl: string;
    status: 'ready' | 'invalid' | 'missing' | 'error';
    warnings?: string[];
    stats?: Record<string, unknown>;
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
    motions?: AvatarMotionRecord[];
  }

  interface AvatarMotionRecord {
    id: string;
    name: string;
    url: string;
    size?: number;
    importedAtUtc?: string;
    playbackSupported?: boolean;
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
    warnings: string[];
    stats?: Record<string, unknown>;
    detected?: AvatarDetected;
    preview: {
      url: string;
      format: AvatarRecord['kind'];
      expiresAtUtc: string;
      capabilities?: AvatarRecord['capabilities'];
    };
    requiresRightsConfirmation: boolean;
    requiresWarningAcceptance: boolean;
  }

  interface AvatarImportConfirmation {
    rightsConfirmed: boolean;
    warningsAccepted: boolean;
  }

  interface FocusState {
    phase: 'idle' | 'starting' | 'running' | 'paused' | 'completed' | 'stopped';
    id: string | null;
    durationSeconds: number;
    remainingSeconds: number;
    startedAtUtc: string | null;
    endsAtUtc: string | null;
    pausedAtUtc: string | null;
    requiresAudioRearm?: boolean;
    available?: boolean;
  }

  interface FocusSoundRecord {
    id: string;
    name: string;
    url: string;
    format?: string;
    mimeType?: string;
    size?: number;
    importedAtUtc?: string;
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
    clearApiKey?: boolean;
    clearCustomHeaders?: boolean;
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
              model: string;
            }
          | {
              ok: false;
              code: string;
              message: string;
              retryable?: boolean;
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
      showNotification?: (
        title: string,
        body: string,
      ) => Promise<{ shown: boolean }>;
      getNotificationStatus?: () => Promise<{
        supported: boolean;
        installedIdentity: boolean;
      }>;
      stickers?: {
        list: () => Promise<{ items: unknown[] }>;
        collect: (value: Record<string, unknown>) => Promise<{ ok: boolean }>;
        importFile: (value?: {
          text?: string;
          emotions?: string[];
          styleTags?: string[];
        }) => Promise<{
          canceled: boolean;
          fileName?: string;
          item?: {
            id: string;
            text: string;
            emotions: string[];
            source?: string;
            usage_count?: number;
            last_used?: string;
            image_path?: string;
            image_data_url?: string;
            style_tags?: string[];
            favorite_score?: number;
          } | null;
          items?: unknown[];
        }>;
      };
      files?: {
        saveJson?: (name: string, payload: unknown) => Promise<{ ok: boolean }>;
        selectAudio?: () => Promise<{ name: string; dataUrl: string } | null>;
        selectVideo?: () => Promise<{ name: string; dataUrl: string } | null>;
      };
      backup?: {
        export: () => Promise<{ ok: boolean; canceled: boolean; fileName?: string }>;
        import: () => Promise<{ ok: boolean; canceled: boolean }>;
      };
      focus?: {
        getState: () => Promise<FocusState>;
        start: (durationSeconds: number) => Promise<FocusState>;
        pause: (id: string) => Promise<FocusState>;
        resume: (id: string) => Promise<FocusState>;
        stop: (id: string) => Promise<FocusState>;
        acknowledgeAudioRearm: (id: string) => Promise<FocusState>;
        onChanged: (callback: (state: FocusState) => void) => () => void;
      };
      focusSound?: {
        list: () => Promise<{ available: boolean; records: FocusSoundRecord[] }>;
        import: () => Promise<FocusSoundRecord | null>;
        remove: (id: string) => Promise<{ removed: boolean; id: string }>;
        onChanged: (
          callback: (value: { available: boolean; records: FocusSoundRecord[] }) => void,
        ) => () => void;
      };
      avatar?: {
        list: () => Promise<AvatarListResult>;
        onChanged: (callback: (value: AvatarListResult) => void) => () => void;
        beginImport: () => Promise<AvatarImportCandidate | null>;
        beginImportFolder: () => Promise<AvatarImportCandidate | null>;
        confirmPreview: (
          importId: string,
          report: {
            detected: AvatarDetected;
            capabilities: {
              expressionPlayback: boolean;
              embeddedAnimationPlayback: boolean;
            };
          },
        ) => Promise<{ ready: boolean }>;
        failPreview: (importId: string) => Promise<{ discarded: boolean }>;
        discardImport: (importId: string) => Promise<{ discarded: boolean }>;
        commitImport: (
          importId: string,
          confirmation: AvatarImportConfirmation,
        ) => Promise<AvatarRecord>;
        setActive: (id: string | null) => Promise<{ activeId: string | null }>;
        remove: (id: string) => Promise<{ removed: boolean }>;
        setMapping: (
          id: string,
          category: 'expression' | 'action',
          key: string,
          target: string | null,
        ) => Promise<unknown>;
        addMotion: (id: string) => Promise<AvatarMotionRecord | null>;
        removeMotion: (id: string, motionId: string) => Promise<{ removed: boolean }>;
      };
      companionPreferences?: {
        get: () => Promise<{ sound: string; volume: number; autoStart: boolean }>;
        set: (value: {
          sound: string;
          volume: number;
          autoStart: boolean;
        }) => Promise<{ sound: string; volume: number; autoStart: boolean }>;
      };
      getCurrentWindowsLocation?: () => Promise<{
        ok: boolean;
        code: string;
        status?: string;
        latitude?: number;
        longitude?: number;
        accuracy?: number;
      }>;
      openLocationSettings?: () => Promise<void>;
    };
  }
}

export {};
