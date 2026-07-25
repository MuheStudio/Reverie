/**
 * AvatarView — 虚拟形象渲染组件。
 *
 * 集成 AIRI 的 Live2D / VRM 渲染模块，通过 WebSocket 接收后端情绪数据驱动表情。
 * 原始渲染模块: Project AIRI (MIT) by Neko Ayaka & moeru-ai
 * 集成修改: Muhe Studio 2026
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import type { FC } from 'react';

// ── 类型定义 ──────────────────────────────────────────

export interface AvatarEmotion {
  name: string;        // emotion name: happy, sad, angry, etc.
  value: number;       // intensity 0-100
  timestamp: number;
}

export interface AvatarState {
  emotions: AvatarEmotion[];
  speaking: boolean;
  modelType: 'live2d' | 'vrm' | 'none';
  modelPath: string;
  scale: number;
  position: { x: number; y: number };
}

interface AvatarViewProps {
  wsUrl?: string;          // WebSocket URL for emotion feed
  initialModel?: string;   // path to .zip (Live2D) or .vrm (VRM)
  width?: number;
  height?: number;
  className?: string;
  onModelLoaded?: () => void;
  onModelError?: (error: string) => void;
}

// ── 情绪 → 表情映射 ───────────────────────────────────

const EMOTION_TO_EXPRESSION: Record<string, string> = {
  happy: 'happy',
  joy: 'happy',
  excited: 'happy',
  sad: 'sad',
  upset: 'sad',
  angry: 'angry',
  annoyed: 'angry',
  surprised: 'surprised',
  shocked: 'surprised',
  calm: 'neutral',
  neutral: 'neutral',
  fearful: 'fearful',
  worried: 'fearful',
  loving: 'loving',
  caring: 'loving',
};

function dominantEmotion(emotions: AvatarEmotion[]): string {
  if (!emotions.length) return 'neutral';
  const top = emotions.reduce((a, b) => (a.value > b.value ? a : b));
  return EMOTION_TO_EXPRESSION[top.name.toLowerCase()] || 'neutral';
}

// ── 组件 ──────────────────────────────────────────────

const AvatarView: FC<AvatarViewProps> = ({
  wsUrl = 'ws://127.0.0.1:48913',
  initialModel,
  width = 400,
  height = 600,
  className,
  onModelLoaded,
  onModelError,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [modelType, setModelType] = useState<'live2d' | 'vrm' | 'none'>('none');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expression, setExpression] = useState('neutral');
  const [speaking, setSpeaking] = useState(false);

  // ── 模型加载 ──────────────────────────────────────

  const loadLive2D = useCallback(async (modelPath: string) => {
    setLoading(true);
    setError(null);
    try {
      // 动态导入 AIRI Live2D 渲染模块
      const { Live2DModel } = await import(
        /* webpackChunkName: "airi-live2d" */
        '../../airi/packages/stage-ui-live2d/src'
      );
      const model = await Live2DModel.load(modelPath);
      modelRef.current = model;
      setModelType('live2d');
      onModelLoaded?.();
    } catch (err: any) {
      const msg = `Live2D 模型加载失败: ${err.message}`;
      setError(msg);
      onModelError?.(msg);
      // 回退到占位显示
      setModelType('none');
    } finally {
      setLoading(false);
    }
  }, [onModelLoaded, onModelError]);

  const loadVRM = useCallback(async (modelPath: string) => {
    setLoading(true);
    setError(null);
    try {
      // 动态导入 Three.js + VRM 渲染模块
      const { VRMModel } = await import(
        /* webpackChunkName: "airi-vrm" */
        '../../airi/packages/stage-ui-three/src'
      );
      const model = await VRMModel.load(modelPath);
      modelRef.current = model;
      setModelType('vrm');
      onModelLoaded?.();
    } catch (err: any) {
      const msg = `VRM 模型加载失败: ${err.message}`;
      setError(msg);
      onModelError?.(msg);
      setModelType('none');
    } finally {
      setLoading(false);
    }
  }, [onModelLoaded, onModelError]);

  // ── 初始化模型 ────────────────────────────────────

  useEffect(() => {
    if (initialModel) {
      if (initialModel.endsWith('.vrm')) {
        loadVRM(initialModel);
      } else {
        loadLive2D(initialModel);
      }
    }
  }, [initialModel, loadLive2D, loadVRM]);

  // ── WebSocket 情绪订阅 ────────────────────────────

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[AvatarView] WebSocket 已连接');
        // 订阅情绪更新
        ws.send(JSON.stringify({ type: 'emotion:subscribe', payload: {} }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'emotion:update': {
              const emotions: AvatarEmotion[] = msg.payload.emotions || [];
              const expr = dominantEmotion(emotions);
              setExpression(expr);
              // 驱动模型表情
              if (modelRef.current?.setExpression) {
                modelRef.current.setExpression(expr);
              }
              break;
            }
            case 'chat:typing':
              setSpeaking(true);
              if (modelRef.current?.startSpeaking) {
                modelRef.current.startSpeaking();
              }
              break;
            case 'chat:chunk':
              setSpeaking(true);
              break;
            case 'chat:done':
              setSpeaking(false);
              if (modelRef.current?.stopSpeaking) {
                modelRef.current.stopSpeaking();
              }
              break;
            case 'proactive:notify':
              if (modelRef.current?.playMotion) {
                modelRef.current.playMotion('surprised');
              }
              break;
          }
        } catch {}
      };

      ws.onclose = () => {
        console.log('[AvatarView] WebSocket 断开，5s 后重连');
        reconnectTimer = setTimeout(connect, 5000);
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [wsUrl]);

  // ── 渲染 ──────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className={`avatar-container ${className || ''}`}
      style={{
        width,
        height,
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 12,
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* 加载中 */}
      {loading && (
        <div style={{ color: '#87CEEB', fontSize: 14 }}>
          <div className="loading-spinner" />
          <p>正在加载模型…</p>
        </div>
      )}

      {/* 错误 */}
      {error && (
        <div style={{ color: '#ff6b6b', fontSize: 13, textAlign: 'center', padding: 16 }}>
          <p>⚠️ {error}</p>
          <p style={{ color: '#888', marginTop: 8 }}>
            请在设置中导入 Live2D (.zip) 或 VRM (.vrm) 模型文件
          </p>
        </div>
      )}

      {/* 无模型占位 */}
      {!loading && !error && modelType === 'none' && (
        <div style={{ textAlign: 'center', color: '#666' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🐱</div>
          <p style={{ fontSize: 13 }}>尚未加载虚拟形象</p>
          <p style={{ fontSize: 11, color: '#888' }}>
            在设置中导入 Live2D 或 VRM 模型
          </p>
        </div>
      )}

      {/* Live2D / VRM 画布 */}
      <canvas
        id="avatar-canvas"
        style={{
          width: '100%',
          height: '100%',
          display: modelType !== 'none' && !loading ? 'block' : 'none',
        }}
      />

      {/* 情绪指示器 */}
      {modelType !== 'none' && !loading && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'rgba(0,0,0,0.5)',
            borderRadius: 8,
            padding: '4px 8px',
            fontSize: 11,
            color: '#87CEEB',
          }}
        >
          {expression} {speaking ? '🔊' : ''}
        </div>
      )}
    </div>
  );
};

export default AvatarView;
export { dominantEmotion };
export type { AvatarViewProps };
