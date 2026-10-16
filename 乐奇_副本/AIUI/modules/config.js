export const LOCAL_LLM = {
  baseUrl: 'http://172.20.10.4:8787/v1',
  chatPath: '/chat/completions',
  model: 'local',
  apiKey: 'local'
};

export const XIAOXIN_SYSTEM_PROMPT =
  '你是智能眼镜上的小信助手。根据用户问题直接给出结果。用简短口语中文回答。不要使用 Markdown、列表或表情。不要透露思考过程。不确定时明确说不知道，不要编造。';
