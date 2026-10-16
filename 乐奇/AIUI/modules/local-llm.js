import { LOCAL_LLM, XIAOXIN_SYSTEM_PROMPT } from './config.js';
import { requestJson } from './http.js';

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;

export function cleanModelText(text) {
  if (!text) {
    return '';
  }
  return String(text).replace(THINK_BLOCK, '').trim();
}

function getLanguageModel() {
  if (typeof globalThis !== 'undefined' && globalThis.LanguageModel) {
    return globalThis.LanguageModel;
  }
  if (typeof window !== 'undefined' && window.LanguageModel) {
    return window.LanguageModel;
  }
  return null;
}

export async function createSession() {
  // 始终走 lan-hub，方便在中枢日志里看到眼镜问答。
  return {
    type: 'http',
    session: {
      messages: [{ role: 'system', content: XIAOXIN_SYSTEM_PROMPT }]
    }
  };
}

export async function askQuestion(runtime, userText) {
  const prompt = String(userText || '').trim();
  if (!prompt) {
    throw new Error('缺少提问内容');
  }

  if (runtime.type === 'language-model') {
    return streamLanguageModel(runtime.session, prompt);
  }
  return streamLocalHttp(runtime.session, prompt);
}

export function destroySession(runtime) {
  if (!runtime) {
    return;
  }
  if (runtime.type === 'language-model' && runtime.session && runtime.session.destroy) {
    runtime.session.destroy();
  }
}

function streamLanguageModel(session, prompt) {
  const stream = session.promptStreaming(prompt);
  return {
    async read() {
      const result = await stream.read();
      if (result.done) {
        return result;
      }
      if (result.value == null) {
        return result;
      }
      return {
        done: false,
        value: cleanModelText(result.value)
      };
    },
    cancel() {
      if (stream.cancel) {
        stream.cancel();
      }
    }
  };
}

async function streamLocalHttp(session, prompt) {
  session.messages.push({ role: 'user', content: prompt });
  const payload = await requestJson({
    url: LOCAL_LLM.baseUrl.replace(/\/$/, '') + LOCAL_LLM.chatPath,
    method: 'POST',
    timeout: 60000,
    header: {
      Authorization: 'Bearer ' + LOCAL_LLM.apiKey
    },
    data: {
      model: LOCAL_LLM.model,
      messages: session.messages,
      stream: false,
      think: false
    }
  });

  const choice = payload && payload.choices && payload.choices[0];
  const message = choice && choice.message;
  const text = cleanModelText(message && message.content);
  if (text) {
    session.messages.push({ role: 'assistant', content: text });
  }

  let delivered = false;
  return {
    async read() {
      if (delivered) {
        return { done: true };
      }
      delivered = true;
      return { done: false, value: text };
    },
    cancel() {}
  };
}
