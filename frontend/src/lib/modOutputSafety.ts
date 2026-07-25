import { parseStrictJsonText } from './reverieArchive';

export interface SafeGeneratedModTarget {
  id: number;
  description: string;
}

export interface SafeGeneratedModStage {
  name: string;
  description: string;
  targets: SafeGeneratedModTarget[];
}

export interface SafeGeneratedMod {
  name: string;
  identifier: string;
  description: string;
  displayDesc: string;
  prologue: string;
  openingReplies: string[];
  stages: SafeGeneratedModStage[];
}

const MAX_RESPONSE_CHARS = 512 * 1024;
const MAX_STAGES = 20;
const MAX_TARGETS_PER_STAGE = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .trim()
    .slice(0, maxLength);
}

function unwrapJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (!match) throw new Error('模型返回了无法识别的代码块');
  return match[1].trim();
}

export function parseGeneratedModResponse(raw: string): SafeGeneratedMod {
  if (raw.length > MAX_RESPONSE_CHARS) throw new Error('模型返回内容过大，已停止保存');
  const parsed = parseStrictJsonText(unwrapJsonFence(raw));
  if (!isRecord(parsed)) throw new Error('模型未返回有效的模组 JSON');

  const stages = Array.isArray(parsed.stages)
    ? parsed.stages
        .slice(0, MAX_STAGES)
        .filter(isRecord)
        .map((stage, stageIndex) => {
          const targets = Array.isArray(stage.targets)
            ? stage.targets
                .slice(0, MAX_TARGETS_PER_STAGE)
                .filter(isRecord)
                .map((target, targetIndex) => ({
                  id: targetIndex,
                  description: safeText(target.description, 2_000),
                }))
                .filter((target) => Boolean(target.description))
            : [];
          return {
            name: safeText(stage.name, 120) || `阶段 ${stageIndex + 1}`,
            description: safeText(stage.description, 12_000),
            targets,
          };
        })
    : [];

  return {
    name: safeText(parsed.name, 120),
    identifier: safeText(parsed.identifier, 120)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64),
    description: safeText(parsed.description, 24_000),
    displayDesc: safeText(parsed.display_desc, 2_000),
    prologue: safeText(parsed.prologue, 8_000),
    openingReplies: Array.isArray(parsed.opening_rec_replies)
      ? parsed.opening_rec_replies
          .slice(0, 6)
          .map((reply) => safeText(reply, 120))
          .filter(Boolean)
      : [],
    stages,
  };
}
