import { describe, expect, it } from 'vitest';
import { GREETING_OPTION_LIMIT, greetingOptionsFromPersona } from '../greetings';

describe('greetingOptionsFromPersona', () => {
  it('returns the first message and alternate greetings from the identity', () => {
    const options = greetingOptionsFromPersona({
      name: '诗怀雅',
      identity: {
        first_message: '用户，欢迎来到龙门。',
        alternate_greetings: ['用户，来了啊。', '今天怎么这么晚？'],
      },
    });

    expect(options).toEqual(['用户，欢迎来到龙门。', '用户，来了啊。', '今天怎么这么晚？']);
  });

  it('returns an empty array when the persona has no identity', () => {
    expect(greetingOptionsFromPersona(null)).toEqual([]);
    expect(greetingOptionsFromPersona({})).toEqual([]);
    expect(greetingOptionsFromPersona({ name: '无主角色' })).toEqual([]);
  });

  it('returns an empty array when there is no opening line', () => {
    expect(greetingOptionsFromPersona({
      identity: { first_message: '', alternate_greetings: [] },
    })).toEqual([]);
  });

  it('drops blank entries and trims whitespace', () => {
    const options = greetingOptionsFromPersona({
      identity: {
        first_message: '  你好，{user}  ',
        alternate_greetings: ['  ', '第二次问候', '   '],
      },
    });

    expect(options).toEqual(['你好，{user}', '第二次问候']);
  });

  it('caps the options to a bounded display list', () => {
    const large = Array.from({ length: 200 }, (_, index) => `问候 ${index}`);
    const options = greetingOptionsFromPersona({
      identity: { first_message: '开始', alternate_greetings: large },
    });

    expect(options.length).toBeLessThanOrEqual(GREETING_OPTION_LIMIT + 1);
  });
});