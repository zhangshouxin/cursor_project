<script def>
{
  "navigationBarTitleText": "小信回答",
  "description": "用户向小信助手提问、查询知识、请它回答某个问题时优先返回此卡片。根据用户问题调用本地大模型，展示并播报简短结果。",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string",
          "description": "用户提出的完整问题，例如“现在几点适合出门”“怎么用简短的话解释量子计算”。"
        }
      },
      "required": ["question"]
    }
  }
}
</script>

<script setup>
import { createSession, askQuestion, destroySession } from '../../modules/local-llm.js';
import { speakText } from '../../modules/speak.js';

export default {
  data: {
    loading: true,
    showError: false,
    showAnswer: false,
    question: '',
    answer: '',
    errorText: ''
  },

  runtime: null,

  async onLoad(query) {
    const question = (query && query.question) || '';
    this.setData({ question });
    await this.replyTo(question);
  },

  onUnload() {
    destroySession(this.runtime);
    this.runtime = null;
  },

  async replyTo(question) {
    if (!question) {
      this.setData({
        loading: false,
        showError: true,
        errorText: '没有听到问题。'
      });
      return;
    }

    this.setData({
      loading: true,
      showError: false,
      showAnswer: false,
      errorText: '',
      answer: ''
    });

    try {
      this.runtime = await createSession();
      const stream = await askQuestion(this.runtime, question);
      let text = '';
      this.setData({ loading: false, showAnswer: true });
      while (true) {
        const chunk = await stream.read();
        if (chunk.done) {
          break;
        }
        if (chunk.value) {
          text += chunk.value;
          this.setData({ answer: text });
        }
      }
      const finalText = text || '没有得到可用结果。';
      this.setData({ answer: finalText });
      speakText(finalText);
    } catch (error) {
      this.setData({
        loading: false,
        showError: true,
        errorText: '本地大模型调用失败。'
      });
    }
  }
};
</script>

<page>
  <view class="card">
    <text class="kicker">XIAOXIN</text>
    <text class="question">{{question}}</text>

    <view ink:if="{{loading}}" class="body">
      <text class="hint">小信正在回答</text>
    </view>

    <view ink:if="{{showError}}" class="body">
      <text class="hint">{{errorText}}</text>
    </view>

    <view ink:if="{{showAnswer}}" class="body">
      <text class="answer">{{answer}}</text>
    </view>
  </view>
</page>

<style>
.card {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  box-sizing: border-box;
  border: 1px solid rgba(64, 255, 94, 0.48);
  border-radius: 6px;
  background-color: #000000;
}

.kicker {
  font-size: 11px;
  line-height: 14px;
  font-family: monospace;
  color: #40ff5e;
}

.question {
  font-size: 16px;
  line-height: 20px;
  color: #40ff5e;
}

.body {
  display: flex;
  flex-direction: column;
}

.hint,
.answer {
  font-size: 14px;
  line-height: 20px;
  color: rgba(64, 255, 94, 0.72);
}
</style>
