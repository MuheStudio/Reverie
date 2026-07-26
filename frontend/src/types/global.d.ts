declare global {
  const __ENV__: string;

  type AvatarKind = 'vrm' | 'glb' | 'live2d';
  type AvatarRecordStatus = 'ready' | 'importing' | 'invalid' | 'missing' | 'error';

  interface AvatarCapabilities {
    renderReady: boolean;
    expressionMapping: boolean;
    actionMapping: boolean;
    expressionPlayback: boolean;
    embeddedAnimationPlayback: boolean;
    vrmaImport: boolean;
    vrmaPlayback: boolean;
  }

  interface AvatarDetected {
    animationClips: string[];
    expressions: string[];
  }

  interface AvatarMapping {
    expressions: Record<string, string>;
    actions: Record<string, string>;
  }

  interface AvatarMotionRecord {
    id: string;
    name: string;
    url: string;
    size: number;
    importedAtUtc: string;
    playbackSupported: boolean;
  }

  interface AvatarRecord {
    id: string;
    name: string;
    kind: AvatarKind;
    entryUrl: string;
    thumbnailUrl?: string;
    status: AvatarRecordStatus;
    warnings: string[];
    stats?: Record<string, unknown>;
    detected?: AvatarDetected;
    capabilities?: AvatarCapabilities;
    mapping?: AvatarMapping;
    motions?: AvatarMotionRecord[];
  }

  interface AvatarListResult {
    records: AvatarRecord[];
    activeId: string | null;
    runtime?: {
      live2d?: {
        available: boolean;
        licenseAccepted: boolean;
        developmentOnly?: boolean;
        reason?: string;
      };
    };
  }

  interface AvatarImportCandidate {
    importId: string;
    name: string;
    kind: AvatarKind;
    warnings: string[];
    stats?: Record<string, unknown>;
    detected: AvatarDetected;
    summary?: {
      files?: number;
      bytes?: number;
      triangles?: number;
      estimatedVramBytes?: number;
    };
    preview: {
      url: string;
      format: AvatarKind;
      expiresAtUtc: string;
      capabilities: AvatarCapabilities;
    };
    requiresRightsConfirmation: boolean;
    requiresWarningAcceptance: boolean;
  }

  interface AvatarImportConfirmation {
    rightsConfirmed: boolean;
    warningsAccepted: boolean;
  }

  type FocusPhase = 'idle' | 'starting' | 'running' | 'paused' | 'completed' | 'stopped';

  interface FocusState {
    phase: FocusPhase;
    id: string | null;
    durationSeconds: number;
    remainingSeconds: number;
    startedAtUtc: string | null;
    endsAtUtc: string | null;
    pausedAtUtc: string | null;
    requiresAudioRearm?: boolean;
  }

  interface BridgeConnectionConfig {
    transport?: 'electron-ipc' | 'websocket';
    url: string;
    secret: string;
    origin?: string;
    protocolVersion: 2;
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

  interface CredentialScopeStatus {
    hasApiKey: boolean;
    hasCustomHeaders: boolean;
    sessionOnly?: boolean;
    bindingKnown?: boolean;
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
    llm: CredentialScopeStatus;
    imageGen: CredentialScopeStatus;
    stored?: boolean;
    runtimeApplied?: boolean;
    runtimePending?: boolean;
    runtimeAppliedScopes?: {
      llm: boolean;
      imageGen: boolean;
    };
    bindingMismatch?: {
      llm: boolean;
      imageGen: boolean;
    };
  }

  interface NativeBackupResult {
    ok: boolean;
    canceled: boolean;
    operation?: 'export' | 'import';
    fileName?: string;
    result?: Record<string, number>;
  }

  interface Window {
    electronAPI?: {
      platform?: string;
      onAppLifecycle?: (callback: (event: { state: string; at: string }) => void) => () => void;
      showNotification?: (title: string, body: string) => Promise<{ shown: boolean }>;
      getNotificationStatus?: () => Promise<{
        supported: boolean;
        platform: string;
        permission: 'managed_by_windows' | 'runtime';
        appUserModelId: string;
        installedIdentity: boolean;
      }>;
      openLocationSettings?: () => Promise<{ opened: boolean }>;
      getCurrentWindowsLocation?: () => Promise<
        | {
            ok: true;
            code: 'REVERIE_LOCATION_OK';
            status: string;
            latitude: number;
            longitude: number;
            accuracy: number;
            timestamp: string;
            source: 'windows-winrt';
          }
        | {
            ok: false;
            code: string;
            status: string;
            source: 'windows-winrt';
          }
      >;
      bridge?: {
        getConnectionConfig: () => Promise<BridgeConnectionConfig>;
        send: (frame: {
          type: string;
          payload: Record<string, unknown>;
          request_id?: string;
        }) => Promise<{ accepted: boolean }>;
        onMessage: (callback: (frame: unknown) => void) => () => void;
        onChanged: (callback: (state: { ready: boolean; generation?: number }) => void) => () => void;
      };
      stickers?: {
        importFile: (value?: {
          text?: string;
          emotions?: string[];
          styleTags?: string[];
        }) => Promise<{
          canceled: boolean;
          fileName?: string;
          item: {
            id: string;
            text: string;
            emotions: string[];
            image_data_url?: string;
            image_path?: string;
            style_tags?: string[];
          } | null;
          items: unknown[];
        }>;
      };
      companionPreferences?: {
        get: () => Promise<{
          sound: string;
          volume: number;
          autoStart: boolean;
        }>;
        set: (value: {
          sound: string;
          volume: number;
          autoStart: boolean;
        }) => Promise<{
          sound: string;
          volume: number;
          autoStart: boolean;
        }>;
      };
      localMode?: {
        get: () => Promise<LocalModeState>;
        set: (enabled: boolean) => Promise<LocalModeState>;
        onChanged: (callback: (state: LocalModeState) => void) => () => void;
      };
      credentials?: {
        status: () => Promise<CredentialStatus>;
        set: (
          scope: 'llm' | 'imageGen',
          value: { apiKey?: string; customHeaders?: string },
        ) => Promise<CredentialStatus>;
        setSession: (
          scope: 'llm' | 'imageGen',
          value: { apiKey?: string; customHeaders?: string },
        ) => Promise<CredentialStatus>;
        clear: (scope: 'llm' | 'imageGen') => Promise<CredentialStatus>;
        onChanged: (callback: (status: CredentialStatus) => void) => () => void;
      };
      providerConfig?: {
        get: () => Promise<{
          llm: {
            provider: string;
            baseUrl: string;
            model: string;
            customProviderName?: string;
          };
          imageGen?: {
            provider: string;
            baseUrl: string;
            model: string;
          };
        } | null>;
        set: (value: {
          llm: {
            provider: string;
            baseUrl: string;
            model: string;
            customProviderName?: string;
          };
          imageGen?: {
            provider: string;
            baseUrl: string;
            model: string;
          };
        }) => Promise<unknown>;
        test: (
          value: {
            llm: {
              provider: string;
              baseUrl: string;
              model: string;
              customProviderName?: string;
            };
          },
          credential?: { apiKey?: string; customHeaders?: string },
        ) => Promise<
          | {
              ok: true;
              receipt: string;
              expiresAt: string;
              provider: string;
              model: string;
              latencyMs: number;
            }
          | {
              ok: false;
              code: string;
              message: string;
              retryable: boolean;
            }
        >;
        commit: (
          value: {
            llm: {
              provider: string;
              baseUrl: string;
              model: string;
              customProviderName?: string;
            };
            imageGen?: {
              provider: string;
              baseUrl: string;
              model: string;
            };
          },
          credential?: { apiKey?: string; customHeaders?: string },
          mode?: 'persistent' | 'session',
          testReceipt?: string,
        ) => Promise<{
          config: {
            llm: {
              provider: string;
              baseUrl: string;
              model: string;
              customProviderName?: string;
            };
          };
          status: CredentialStatus;
        }>;
      };
      backup?: {
        export: () => Promise<NativeBackupResult>;
        import: () => Promise<NativeBackupResult>;
        onProgress: (
          callback: (progress: {
            operation: 'export' | 'import';
            phase: 'started' | 'completed' | 'failed';
            result?: Record<string, number>;
          }) => void,
        ) => () => void;
      };
      files?: {
        saveJson: (
          suggestedName: string,
          payload: unknown,
        ) => Promise<{ ok: boolean; canceled: boolean; fileName?: string }>;
      };
      avatar?: {
        list: () => Promise<AvatarListResult | AvatarRecord[]>;
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
        ) => Promise<{
          importId: string;
          ready: boolean;
          previewReadyAtUtc: string;
          detected: AvatarDetected;
          capabilities: AvatarCapabilities;
        }>;
        discardImport: (importId: string) => Promise<{ discarded: boolean }>;
        failPreview: (importId: string) => Promise<{ discarded: boolean }>;
        commitImport: (
          importId: string,
          confirmation: AvatarImportConfirmation,
        ) => Promise<AvatarRecord>;
        remove: (id: string) => Promise<{ removed: boolean }>;
        setActive: (id: string | null) => Promise<{ activeId: string | null }>;
        addMotion: (id: string) => Promise<AvatarMotionRecord | null>;
        removeMotion: (id: string, motionId: string) => Promise<{ removed: boolean; motionId: string }>;
        setMapping: (
          id: string,
          category: 'expression' | 'action',
          key: string,
          target: string | null,
        ) => Promise<{ id: string; mapping: AvatarMapping }>;
        onChanged: (callback: (result: AvatarListResult | AvatarRecord[]) => void) => () => void;
      };
      focus?: {
        getState: () => Promise<FocusState>;
        start: (durationSeconds: number) => Promise<FocusState>;
        pause: (id: string) => Promise<FocusState>;
        resume: (id: string) => Promise<FocusState>;
        stop: (id: string) => Promise<FocusState>;
        acknowledgeAudioRearm: (id: string) => Promise<FocusState>;
        onChanged: (callback: (state: FocusState) => void) => () => void;
        showNotification: (title: string, body: string) => Promise<{ shown: boolean }>;
      };
      focusSound?: {
        list: () => Promise<{ available: boolean; records: FocusSoundRecord[] }>;
        import: () => Promise<FocusSoundRecord | null>;
        open: (id: string) => Promise<FocusSoundRecord>;
        remove: (id: string) => Promise<{ removed: boolean }>;
        onChanged: (
          callback: (result: { available: boolean; records: FocusSoundRecord[] }) => void,
        ) => () => void;
      };
    };
  }

  interface FocusSoundRecord {
    id: string;
    name: string;
    url: string;
    format: 'aac' | 'flac' | 'm4a' | 'mp3' | 'ogg' | 'wav';
    mimeType: string;
    size: number;
    importedAtUtc: string;
  }
}

export {};
