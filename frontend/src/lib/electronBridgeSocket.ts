type BridgeApi = NonNullable<NonNullable<Window['electronAPI']>['bridge']>;

interface IpcBridgeConfig extends BridgeConnectionConfig {
  transport?: 'electron-ipc';
  clientId?: string;
  personaId?: string;
  personaEpoch?: number;
  personaFingerprint?: string;
  modelEpoch?: number;
  restartRequired?: boolean;
}

export interface BridgeSocketLike {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

export class ElectronBridgeSocket implements BridgeSocketLike {
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private readonly queued: unknown[] = [];
  private authenticated = false;
  private disposed = false;
  private unsubscribeMessage: (() => void) | null = null;
  private unsubscribeChanged: (() => void) | null = null;

  constructor(
    private readonly api: BridgeApi,
    private readonly config: IpcBridgeConfig,
  ) {
    this.unsubscribeMessage = api.onMessage?.((frame) => {
      if (this.disposed) return;
      if (!this.authenticated) {
        this.queued.push(frame);
        return;
      }
      this.emitMessage(frame);
    }) ?? null;
    this.unsubscribeChanged = api.onChanged?.((state) => {
      if (state?.ready === false) this.close(1011, 'bridge unavailable');
    }) ?? null;
    queueMicrotask(() => {
      if (this.disposed) return;
      this.readyState = WebSocket.OPEN;
      this.onopen?.(new Event('open'));
    });
  }

  send(value: string): void {
    if (this.disposed || this.readyState !== WebSocket.OPEN) {
      throw new Error('Electron bridge socket is not open');
    }
    const frame = JSON.parse(value) as {
      type?: unknown;
      payload?: unknown;
      request_id?: unknown;
    };
    if (frame.type === 'bridge:auth') {
      this.authenticated = true;
      this.emitMessage({
        type: 'bridge:auth_ok',
        payload: {
          protocol_version: this.config.protocolVersion,
          client_id: this.config.clientId,
          persona_id: this.config.personaId,
          persona_epoch: this.config.personaEpoch,
          persona_fingerprint: this.config.personaFingerprint,
          model_epoch: this.config.modelEpoch,
          persona_restart_required: this.config.restartRequired === true,
        },
      });
      for (const queued of this.queued.splice(0)) this.emitMessage(queued);
      return;
    }
    if (
      typeof frame.type !== 'string'
      || !frame.payload
      || typeof frame.payload !== 'object'
      || Array.isArray(frame.payload)
      || (
        frame.request_id !== undefined
        && typeof frame.request_id !== 'string'
      )
    ) {
      throw new Error('Electron bridge frame is invalid');
    }
    void this.api.send?.({
      type: frame.type,
      payload: frame.payload as Record<string, unknown>,
      ...(typeof frame.request_id === 'string'
        ? { request_id: frame.request_id }
        : {}),
    }).catch(() => {
      // A rejected command must not destroy a healthy connection. Only surface
      // the failure; the owning hook decides whether the bridge is still usable.
      this.onerror?.(new Event('error'));
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readyState = WebSocket.CLOSED;
    this.unsubscribeMessage?.();
    this.unsubscribeChanged?.();
    this.unsubscribeMessage = null;
    this.unsubscribeChanged = null;
    this.queued.length = 0;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  private emitMessage(frame: unknown): void {
    if (this.disposed) return;
    this.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify(frame),
    }));
  }
}

export function isElectronIpcBridge(
  value: BridgeConnectionConfig,
): value is IpcBridgeConfig {
  return value.transport === 'electron-ipc';
}
