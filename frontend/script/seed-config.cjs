'use strict';

function createSeedConfig() {
  return {
    llm: {
      provider: 'ollama',
      model: '',
      base_url: 'http://localhost:11434/v1',
      temperature: 0.82,
      max_tokens: 2048,
    },
    memory: {
      embedding_model: 'BAAI/bge-small-zh-v1.5',
      retention_days: 730,
      forgetting_enabled: true,
      long_term_forget_days: 90,
      short_term_forget_days: 7,
      long_term_forget_probability: 0.05,
      short_term_forget_probability: 0.005,
      forget_probability: 0.05,
      decay_lambda: 0.0077,
      recall_reinforcement_alpha: 0.12,
      minimum_retrieval_retention: 0.05,
      misremembering_enabled: false,
      misremember_probability: 0.05,
      long_term_misremember_probability: 0.05,
      short_term_misremember_probability: 0.05,
    },
    chat: {
      reply_delay_min: 3,
      reply_delay_max: 25,
      split_messages: true,
      typing_indicator: true,
    },
    features: {
      web_surfing_enabled: false,
      web_disclaimer_acknowledged: false,
      web_allowed_topics: ['热门梗', '新番/动漫资讯', '二次元内容', '游戏更新'],
      web_refresh_interval_minutes: 180,
      diary_enabled: false,
      diary_privacy_enabled: true,
      diary_peek_enabled: true,
      timeline_enabled: false,
      proactive_chat_enabled: false,
      late_night_enabled: false,
      late_night_probability: 0.1,
      autonomous_memory_enabled: true,
      autonomous_memory_llm_enabled: false,
    },
    cloud_mode: 'local',
  };
}

module.exports = { createSeedConfig };
