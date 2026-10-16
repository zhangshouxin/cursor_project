<script def>
{
  "navigationBarTitleText": "小信助手"
}
</script>

<script setup>
import { createSession, askQuestion, destroySession } from '../../modules/local-llm.js';
import { speakText, stopSpeaking } from '../../modules/speak.js';
import { takeGlassesPhoto } from '../../modules/camera.js';
import { uploadPhoto } from '../../modules/photos.js';

const MODEL_LABEL = '本地模型';

const SILENCE_MS = 1500;
const MAX_LISTEN_MS = 60000;
const END_FALLBACK_MS = 700;
const RESUME_MS = 400;

function stripWakeWord(text) {
  return String(text || '')
    .replace(/^(你好)?乐奇[,，。！! ]*/g, '')
    .trim();
}

function looksLikeEcho(heard, spoken) {
  const a = String(heard || '').replace(/\s/g, '');
  const b = String(spoken || '').replace(/\s/g, '');
  if (!a || !b) {
    return false;
  }
  if (b.indexOf(a) >= 0 && a.length >= 2) {
    return true;
  }
  if (a.indexOf(b) >= 0 && b.length >= 4) {
    return true;
  }
  return false;
}

function describeAskError(error) {
  const msg = String((error && error.message) || '');
  if (msg.indexOf('timeout') >= 0) {
    return '本地模型响应超时，请稍后重试。';
  }
  if (msg.indexOf('404') >= 0 || msg.indexOf('405') >= 0) {
    return '局域网接口未接通，请确认 lan-hub 已重启。';
  }
  if (msg.indexOf('fail') >= 0 || msg.indexOf('unavailable') >= 0) {
    return '眼镜连不上局域网中枢，请确认和电脑在同一热点。';
  }
  return '模型调用失败，请确认 lan-hub 已启动且能访问 DeepSeek。';
}

function pickText(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return '';
}

function extractWakeupUtterance(event) {
  if (!event) {
    return '';
  }
  const direct = pickText(event.text)
    || pickText(event.asr)
    || pickText(event.transcript)
    || pickText(event.query)
    || pickText(event.content);
  if (direct) {
    return direct;
  }
  if (typeof event.data === 'string') {
    return event.data.trim();
  }
  if (event.data && typeof event.data === 'object') {
    return pickText(event.data.text)
      || pickText(event.data.asr)
      || pickText(event.data.transcript)
      || pickText(event.data.query);
  }
  return '';
}

function screenShotSize() {
  let width = 360;
  if (typeof window !== 'undefined' && window.innerWidth) {
    width = window.innerWidth;
  }
  return Math.max(48, Math.round(width * 0.3));
}

const SLOT_COUNT = 16;

function blankSlot() {
  return {
    show: false,
    askLabel: '',
    question: '',
    answerLabel: '',
    answer: '',
    photoTitle: '',
    shotLabel: '',
    isShot: false,
    shotSrc: '',
    shotWidth: 0,
    shotHeight: 0
  };
}

function slotView(row) {
  const isShot = !!(row && row.shotSrc);
  return {
    show: true,
    askLabel: row.askLabel || '',
    question: row.question || '',
    answerLabel: row.answerLabel || '',
    answer: row.answer || '',
    photoTitle: row.photoTitle || '',
    shotLabel: row.shotLabel || '',
    isShot,
    shotSrc: isShot ? row.shotSrc : '',
    shotWidth: isShot ? (row.shotWidth || 0) : 0,
    shotHeight: isShot ? (row.shotHeight || 0) : 0
  };
}

function createPageData() {
  const data = {
    statusLabel: MODEL_LABEL,
    listening: false,
    asking: false,
    showEmpty: true,
    draft: '',
    scrollTop: 0,
    threadHeight: 220,
    shotSize: 108,
    photoNote: '',
    hint: '正在听'
  };
  for (let i = 0; i < SLOT_COUNT; i += 1) {
    data['s' + i] = blankSlot();
  }
  return data;
}

function describePhotoError(error) {
  const msg = String((error && (error.message || error.errMsg)) || error || '未知错误');
  if (msg.indexOf('timeout') >= 0) {
    return '拍照超时';
  }
  return msg;
}

function isPhotoCommand(text) {
  const normalized = String(text || '').replace(/[。！!，,.\s]/g, '');
  return (
    normalized === '拍照' ||
    normalized === '拍张照' ||
    normalized === '拍一张' ||
    normalized === '拍个照' ||
    normalized === '拍照片'
  );
}

function readTranscript(event) {
  const results = event && event.results;
  if (!results || !results.length) {
    return pickText(event && (event.transcript || event.result || event.asr));
  }
  let transcript = '';
  for (let i = 0; i < results.length; i += 1) {
    const item = results[i];
    if (!item) {
      continue;
    }
    const alt = item[0] || item;
    const piece = pickText(alt && alt.transcript) || pickText(item.transcript) || pickText(item);
    transcript += piece;
  }
  return transcript.trim();
}

export default {
  data: createPageData(),

  runtime: null,
  rows: null,
  answerIndex: -1,
  threadReady: false,
  scrollTick: 0,
  turnSeed: 1,
  recognition: null,
  silenceTimer: null,
  maxListenTimer: null,
  endFallbackTimer: null,
  asrText: '',
  lastSpoken: '',
  busy: false,
  closingListen: false,
  askLock: false,
  pageActive: true,
  resumeTimer: null,

  async onLoad(query) {
    this.pageActive = true;
    this.rows = [];
    let threadHeight = 220;
    if (typeof window !== 'undefined' && window.innerHeight) {
      threadHeight = Math.max(160, Math.round(window.innerHeight * 0.62));
    }
    this.setData({
      shotSize: screenShotSize(),
      threadHeight
    });
    if (typeof this.enableWorldAwareness === 'function') {
      this.enableWorldAwareness();
    }
    await this.bootstrap();
    const question = query && (query.question || query.q);
    if (question) {
      await this.replyTo(question);
      return;
    }
    this.resumeListen();
  },

  onShow() {
    this.pageActive = true;
    this.resumeListen();
  },

  onHide() {
    this.pageActive = false;
    this.pauseListen();
  },

  onUnload() {
    this.pageActive = false;
    this.pauseListen();
    destroySession(this.runtime);
    this.runtime = null;
  },

  async bootstrap() {
    try {
      this.runtime = await createSession();
      this.setData({
        statusLabel: MODEL_LABEL
      });
    } catch (error) {
      this.setData({
        statusLabel: '模型未就绪',
        hint: '模型未连接，请检查 lan-hub。'
      });
    }
  },

  onVoiceWakeup(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    if (this.data.asking) {
      return;
    }
    stopSpeaking();
    const spoken = stripWakeWord(extractWakeupUtterance(event));
    if (spoken && !looksLikeEcho(spoken, this.lastSpoken)) {
      this.finishListen(spoken);
      return;
    }
    this.resumeListen();
  },

  onAskTap() {
    if (this.data.listening && this.asrText) {
      this.finishListen(this.asrText);
      return;
    }
    this.resumeListen();
  },

  resumeListen() {
    if (!this.pageActive || this.busy || this.data.asking || this.data.listening) {
      return;
    }
    this.clearTimer('resumeTimer');
    this.resumeTimer = setTimeout(() => {
      if (!this.pageActive || this.busy || this.data.asking || this.data.listening) {
        return;
      }
      this.startListen();
    }, RESUME_MS);
  },

  startListen() {
    if (this.busy || this.data.asking || this.data.listening) {
      return;
    }
    if (typeof SpeechRecognition === 'undefined') {
      this.setData({
        hint: '当前环境不支持语音识别'
      });
      return;
    }

    this.releaseRecognition(false);
    this.asrText = '';
    this.closingListen = false;

    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      this.armMaxListenTimer();
      this.setData({
        listening: true,
        statusLabel: '正在听',
        hint: '直接说，说完自动回答'
      });
    };

    recognition.onresult = (event) => {
      if (this.closingListen || this.busy) {
        return;
      }
      const transcript = stripWakeWord(readTranscript(event));
      if (!transcript || looksLikeEcho(transcript, this.lastSpoken)) {
        return;
      }
      this.asrText = transcript;
      this.scrollTick += 1;
      this.setData({
        draft: transcript,
        scrollTop: 100000 + this.scrollTick
      });
      this.armSilenceTimer();
    };

    recognition.onerror = () => {
      if (this.closingListen || this.busy) {
        return;
      }
      if (this.asrText) {
        this.finishListen(this.asrText);
        return;
      }
      this.pauseListen();
      this.resumeListen();
    };

    recognition.onend = () => {
      const text = this.asrText;
      this.recognition = null;
      if (this.askLock || this.busy) {
        this.clearAsrTimers();
        return;
      }
      if (text) {
        this.finishListen(text);
        return;
      }
      this.pauseListen();
      this.resumeListen();
    };

    this.recognition = recognition;
    this.setData({
      listening: true,
      statusLabel: '正在听',
      hint: '直接说，说完自动回答'
    });
    this.armMaxListenTimer();
    try {
      recognition.start();
    } catch (error) {
      this.pauseListen();
      this.resumeListen();
    }
  },

  armSilenceTimer() {
    this.clearTimer('silenceTimer');
    this.silenceTimer = setTimeout(() => {
      this.requestRecognitionEnd();
    }, SILENCE_MS);
  },

  armMaxListenTimer() {
    this.clearTimer('maxListenTimer');
    this.maxListenTimer = setTimeout(() => {
      if (this.asrText) {
        this.finishListen(this.asrText);
        return;
      }
      this.pauseListen();
      this.resumeListen();
    }, MAX_LISTEN_MS);
  },

  requestRecognitionEnd() {
    if (this.closingListen || this.busy) {
      return;
    }
    if (!this.asrText) {
      return;
    }
    this.closingListen = true;
    const recognition = this.recognition;
    try {
      if (recognition && typeof recognition.stop === 'function') {
        recognition.stop();
      } else {
        this.finishListen(this.asrText);
        return;
      }
    } catch (error) {
      this.finishListen(this.asrText);
      return;
    }
    this.clearTimer('endFallbackTimer');
    this.endFallbackTimer = setTimeout(() => {
      if (this.asrText && !this.busy && !this.askLock) {
        this.finishListen(this.asrText);
      }
    }, END_FALLBACK_MS);
  },

  finishListen(text) {
    if (this.busy || this.askLock) {
      return;
    }
    const question = stripWakeWord(text);
    const photo = isPhotoCommand(question);
    this.askLock = true;
    this.closingListen = true;
    this.releaseRecognition(photo);
    this.setData({
      listening: false,
      statusLabel: MODEL_LABEL
    });
    if (!question) {
      this.askLock = false;
      this.closingListen = false;
      this.resumeListen();
      return;
    }
    if (photo) {
      this.capturePhoto();
      return;
    }
    this.replyTo(question);
  },

  pauseListen() {
    this.clearTimer('resumeTimer');
    this.closingListen = false;
    this.asrText = '';
    this.releaseRecognition(true);
    this.setData({
      listening: false,
      statusLabel: this.data.asking ? '正在答' : MODEL_LABEL
    });
  },

  clearTimer(name) {
    if (this[name]) {
      clearTimeout(this[name]);
      this[name] = null;
    }
  },

  clearAsrTimers() {
    this.clearTimer('silenceTimer');
    this.clearTimer('maxListenTimer');
    this.clearTimer('endFallbackTimer');
    this.clearTimer('resumeTimer');
  },

  releaseRecognition(forceAbort) {
    this.clearAsrTimers();
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) {
      return;
    }
    try {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      if (forceAbort && typeof recognition.abort === 'function') {
        recognition.abort();
      } else if (typeof recognition.stop === 'function') {
        recognition.stop();
      }
    } catch (error) {
      // Ignore stop/abort during hide.
    }
  },

  nextId(prefix) {
    const id = prefix + '-' + this.turnSeed;
    this.turnSeed += 1;
    return id;
  },

  photoCount() {
    let count = 0;
    const rows = this.rows || [];
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].shotSrc) {
        count += 1;
      }
    }
    return count;
  },

  publishSlot(index) {
    if (index < 0 || index >= SLOT_COUNT || !this.rows || !this.rows[index]) {
      return false;
    }
    if (this.rows[index].shotSrc && this.rows[index].painted) {
      return true;
    }
    this.scrollTick += 1;
    const patch = {
      showEmpty: false,
      draft: '',
      scrollTop: 100000 + this.scrollTick
    };
    patch['s' + index] = slotView(this.rows[index]);
    if (this.rows[index].shotSrc) {
      this.rows[index].painted = true;
    }
    this.setData(patch);
    return true;
  },

  appendTurn(question) {
    if (!this.rows) {
      this.rows = [];
    }
    if (this.rows.length >= SLOT_COUNT) {
      this.setData({ hint: '对话已满，请重新打开' });
      return false;
    }
    const id = this.nextId('turn');
    this.rows.push({
      id,
      askLabel: '问',
      question,
      answerLabel: '答',
      answer: '',
      photoTitle: '',
      shotLabel: '',
      shotSrc: '',
      shotWidth: 0,
      shotHeight: 0
    });
    this.answerIndex = this.rows.length - 1;
    this.publishSlot(this.answerIndex);
    return true;
  },

  writeLastAnswer(answer) {
    if (!this.rows || this.answerIndex < 0 || !this.rows[this.answerIndex]) {
      return;
    }
    this.rows[this.answerIndex].answer = answer;
    this.scrollTick += 1;
    const patch = {
      scrollTop: 100000 + this.scrollTick
    };
    patch['s' + this.answerIndex + '.answer'] = answer;
    this.setData(patch);
  },

  appendShot(src) {
    if (!this.rows) {
      this.rows = [];
    }
    if (this.rows.length >= SLOT_COUNT) {
      return false;
    }
    let count = 0;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i].shotSrc) {
        count += 1;
        continue;
      }
      break;
    }
    const size = this.data.shotSize || 108;
    const index = this.rows.length;
    this.rows.push({
      id: this.nextId('shot'),
      askLabel: '',
      question: '',
      answerLabel: '',
      answer: '',
      photoTitle: count === 0 ? '拍摄的照片' : '',
      shotLabel: '拍摄的照片' + (count + 1),
      shotSrc: src,
      shotWidth: size,
      shotHeight: size
    });
    return this.publishSlot(index);
  },

  rememberPhotoAnalysis(analysis) {
    const session = this.runtime && this.runtime.session;
    if (!session || !Array.isArray(session.messages)) {
      return;
    }
    session.messages.push({ role: 'user', content: '看一下这张照片有什么，有没有报错或指示灯异常' });
    session.messages.push({ role: 'assistant', content: analysis });
  },

  async capturePhoto() {
    this.busy = true;
    this.setData({
      listening: false,
      statusLabel: '正在拍',
      hint: '正在拍照',
      draft: ''
    });
    try {
      const photo = await takeGlassesPhoto();
      const saved = this.appendShot(photo.src);
      const count = this.photoCount();
      this.setData({
        asking: true,
        statusLabel: '正在答',
        hint: '正在看这张照片',
        photoNote: count ? ('对话里有 ' + count + ' 张照片') : ''
      });
      let uploaded = false;
      let analysis = '';
      try {
        const result = await uploadPhoto(photo);
        uploaded = true;
        analysis = result && typeof result.analysis === 'string' ? result.analysis.trim() : '';
      } catch (error) {
        uploaded = false;
      }
      if (analysis) {
        this.rememberPhotoAnalysis(analysis);
        const shown = this.appendTurn('这张照片里有什么');
        if (shown && this.rows && this.rows[this.answerIndex]) {
          this.rows[this.answerIndex].answer = analysis;
          this.publishSlot(this.answerIndex);
        }
        this.lastSpoken = analysis;
        this.setData({
          statusLabel: '正在说',
          hint: shown ? '播报完成后继续听' : '分析完成，对话已满'
        });
        try {
          await speakText(analysis);
        } catch (error) {
          // 分析结果已经显示在对话里。
        }
      }
      let hint = '照片已显示，上传失败';
      if (analysis) {
        hint = '照片已分析';
      } else if (uploaded && saved) {
        hint = '照片已上传，分析失败';
      } else if (uploaded) {
        hint = '照片已上传，对话已满';
      } else if (!saved) {
        hint = '对话已满，上传也失败了';
      }
      this.setData({
        statusLabel: MODEL_LABEL,
        hint,
        photoNote: count ? ('对话里有 ' + count + ' 张照片') : ''
      });
    } catch (error) {
      this.setData({
        statusLabel: MODEL_LABEL,
        hint: '拍照失败：' + describePhotoError(error)
      });
    } finally {
      this.busy = false;
      this.askLock = false;
      this.closingListen = false;
      this.setData({
        asking: false,
        listening: false,
        statusLabel: MODEL_LABEL
      });
      this.resumeListen();
    }
  },

  async replyTo(text) {
    const question = stripWakeWord(text);
    if (!question) {
      this.askLock = false;
      this.closingListen = false;
      this.resumeListen();
      return;
    }
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.askLock = true;
    this.closingListen = true;
    this.releaseRecognition(false);
    if (!this.appendTurn(question)) {
      this.busy = false;
      this.askLock = false;
      this.closingListen = false;
      this.resumeListen();
      return;
    }
    this.setData({
      asking: true,
      listening: false,
      statusLabel: '正在答',
      hint: '小信正在回答'
    });

    if (!this.runtime) {
      await this.bootstrap();
    }
    if (!this.runtime) {
      this.busy = false;
      this.askLock = false;
      this.closingListen = false;
      this.setData({
        asking: false,
        listening: false,
        statusLabel: '模型未就绪',
        hint: '模型未连接'
      });
      this.resumeListen();
      return;
    }

    try {
      const stream = await askQuestion(this.runtime, question);
      let answer = '';
      while (true) {
        const chunk = await stream.read();
        if (chunk.done) {
          break;
        }
        if (chunk.value) {
          answer += chunk.value;
          this.writeLastAnswer(answer);
        }
      }
      const finalText = answer || '我没有得到可用结果，请换个问法。';
      this.lastSpoken = finalText;
      if (this.rows && this.rows[this.answerIndex]) {
        this.rows[this.answerIndex].answer = finalText;
      }
      this.publishSlot(this.answerIndex);
      this.setData({
        asking: false,
        listening: false,
        statusLabel: '正在说',
        hint: '播报完成后继续听'
      });
      await speakText(finalText);
    } catch (error) {
      this.writeLastAnswer(describeAskError(error));
      this.publishSlot(this.answerIndex);
      this.setData({
        asking: false,
        listening: false,
        statusLabel: MODEL_LABEL,
        hint: '回答失败'
      });
    } finally {
      this.busy = false;
      this.askLock = false;
      this.closingListen = false;
      this.setData({
        asking: false,
        listening: false,
        statusLabel: MODEL_LABEL
      });
      this.resumeListen();
    }
  },

  onKeyUp(event) {
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      event.preventDefault();
      const scroller = typeof this.querySelector === 'function' ? this.querySelector('.thread') : null;
      if (scroller && typeof scroller.scrollBy === 'function') {
        scroller.scrollBy({
          top: event.code === 'ArrowDown' ? 80 : -80,
          behavior: 'auto'
        });
      }
      return;
    }
    if (event.code === 'Enter' || event.code === 'GlobalHook') {
      event.preventDefault();
      if (this.data.listening && this.asrText) {
        this.finishListen(this.asrText);
        return;
      }
      this.resumeListen();
    }
  }
};
</script>

<page>
  <view class="page">
    <view class="header">
      <text class="kicker">小信助手</text>
      <text class="model">{{statusLabel}}</text>
    </view>

    <scroll-view id="thread" class="thread" style="height: {{threadHeight}}px;" scroll-y="true" scroll-top="{{scrollTop}}">
      <view ink:if="{{showEmpty}}" class="turn">
        <text class="turn-answer">打开后直接说话，小信会自动回答。</text>
      </view>

      <view ink:if="{{s0.show}}" id="row-0" class="turn">
        <text ink:if="{{s0.askLabel}}" class="turn-label">{{s0.askLabel}}</text>
        <text ink:if="{{s0.question}}" class="turn-question">{{s0.question}}</text>
        <text ink:if="{{s0.answerLabel}}" class="turn-label">{{s0.answerLabel}}</text>
        <text ink:if="{{s0.answer}}" class="turn-answer">{{s0.answer}}</text>
        <text ink:if="{{s0.photoTitle}}" class="turn-label">{{s0.photoTitle}}</text>
        <text ink:if="{{s0.shotLabel}}" class="shot-label">{{s0.shotLabel}}</text>
        <image ink:if="{{s0.isShot}}" class="shot-image" style="width: {{s0.shotWidth}}px; height: {{s0.shotHeight}}px;" src="{{s0.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s1.show}}" id="row-1" class="turn">
        <text ink:if="{{s1.askLabel}}" class="turn-label">{{s1.askLabel}}</text>
        <text ink:if="{{s1.question}}" class="turn-question">{{s1.question}}</text>
        <text ink:if="{{s1.answerLabel}}" class="turn-label">{{s1.answerLabel}}</text>
        <text ink:if="{{s1.answer}}" class="turn-answer">{{s1.answer}}</text>
        <text ink:if="{{s1.photoTitle}}" class="turn-label">{{s1.photoTitle}}</text>
        <text ink:if="{{s1.shotLabel}}" class="shot-label">{{s1.shotLabel}}</text>
        <image ink:if="{{s1.isShot}}" class="shot-image" style="width: {{s1.shotWidth}}px; height: {{s1.shotHeight}}px;" src="{{s1.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s2.show}}" id="row-2" class="turn">
        <text ink:if="{{s2.askLabel}}" class="turn-label">{{s2.askLabel}}</text>
        <text ink:if="{{s2.question}}" class="turn-question">{{s2.question}}</text>
        <text ink:if="{{s2.answerLabel}}" class="turn-label">{{s2.answerLabel}}</text>
        <text ink:if="{{s2.answer}}" class="turn-answer">{{s2.answer}}</text>
        <text ink:if="{{s2.photoTitle}}" class="turn-label">{{s2.photoTitle}}</text>
        <text ink:if="{{s2.shotLabel}}" class="shot-label">{{s2.shotLabel}}</text>
        <image ink:if="{{s2.isShot}}" class="shot-image" style="width: {{s2.shotWidth}}px; height: {{s2.shotHeight}}px;" src="{{s2.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s3.show}}" id="row-3" class="turn">
        <text ink:if="{{s3.askLabel}}" class="turn-label">{{s3.askLabel}}</text>
        <text ink:if="{{s3.question}}" class="turn-question">{{s3.question}}</text>
        <text ink:if="{{s3.answerLabel}}" class="turn-label">{{s3.answerLabel}}</text>
        <text ink:if="{{s3.answer}}" class="turn-answer">{{s3.answer}}</text>
        <text ink:if="{{s3.photoTitle}}" class="turn-label">{{s3.photoTitle}}</text>
        <text ink:if="{{s3.shotLabel}}" class="shot-label">{{s3.shotLabel}}</text>
        <image ink:if="{{s3.isShot}}" class="shot-image" style="width: {{s3.shotWidth}}px; height: {{s3.shotHeight}}px;" src="{{s3.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s4.show}}" id="row-4" class="turn">
        <text ink:if="{{s4.askLabel}}" class="turn-label">{{s4.askLabel}}</text>
        <text ink:if="{{s4.question}}" class="turn-question">{{s4.question}}</text>
        <text ink:if="{{s4.answerLabel}}" class="turn-label">{{s4.answerLabel}}</text>
        <text ink:if="{{s4.answer}}" class="turn-answer">{{s4.answer}}</text>
        <text ink:if="{{s4.photoTitle}}" class="turn-label">{{s4.photoTitle}}</text>
        <text ink:if="{{s4.shotLabel}}" class="shot-label">{{s4.shotLabel}}</text>
        <image ink:if="{{s4.isShot}}" class="shot-image" style="width: {{s4.shotWidth}}px; height: {{s4.shotHeight}}px;" src="{{s4.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s5.show}}" id="row-5" class="turn">
        <text ink:if="{{s5.askLabel}}" class="turn-label">{{s5.askLabel}}</text>
        <text ink:if="{{s5.question}}" class="turn-question">{{s5.question}}</text>
        <text ink:if="{{s5.answerLabel}}" class="turn-label">{{s5.answerLabel}}</text>
        <text ink:if="{{s5.answer}}" class="turn-answer">{{s5.answer}}</text>
        <text ink:if="{{s5.photoTitle}}" class="turn-label">{{s5.photoTitle}}</text>
        <text ink:if="{{s5.shotLabel}}" class="shot-label">{{s5.shotLabel}}</text>
        <image ink:if="{{s5.isShot}}" class="shot-image" style="width: {{s5.shotWidth}}px; height: {{s5.shotHeight}}px;" src="{{s5.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s6.show}}" id="row-6" class="turn">
        <text ink:if="{{s6.askLabel}}" class="turn-label">{{s6.askLabel}}</text>
        <text ink:if="{{s6.question}}" class="turn-question">{{s6.question}}</text>
        <text ink:if="{{s6.answerLabel}}" class="turn-label">{{s6.answerLabel}}</text>
        <text ink:if="{{s6.answer}}" class="turn-answer">{{s6.answer}}</text>
        <text ink:if="{{s6.photoTitle}}" class="turn-label">{{s6.photoTitle}}</text>
        <text ink:if="{{s6.shotLabel}}" class="shot-label">{{s6.shotLabel}}</text>
        <image ink:if="{{s6.isShot}}" class="shot-image" style="width: {{s6.shotWidth}}px; height: {{s6.shotHeight}}px;" src="{{s6.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s7.show}}" id="row-7" class="turn">
        <text ink:if="{{s7.askLabel}}" class="turn-label">{{s7.askLabel}}</text>
        <text ink:if="{{s7.question}}" class="turn-question">{{s7.question}}</text>
        <text ink:if="{{s7.answerLabel}}" class="turn-label">{{s7.answerLabel}}</text>
        <text ink:if="{{s7.answer}}" class="turn-answer">{{s7.answer}}</text>
        <text ink:if="{{s7.photoTitle}}" class="turn-label">{{s7.photoTitle}}</text>
        <text ink:if="{{s7.shotLabel}}" class="shot-label">{{s7.shotLabel}}</text>
        <image ink:if="{{s7.isShot}}" class="shot-image" style="width: {{s7.shotWidth}}px; height: {{s7.shotHeight}}px;" src="{{s7.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s8.show}}" id="row-8" class="turn">
        <text ink:if="{{s8.askLabel}}" class="turn-label">{{s8.askLabel}}</text>
        <text ink:if="{{s8.question}}" class="turn-question">{{s8.question}}</text>
        <text ink:if="{{s8.answerLabel}}" class="turn-label">{{s8.answerLabel}}</text>
        <text ink:if="{{s8.answer}}" class="turn-answer">{{s8.answer}}</text>
        <text ink:if="{{s8.photoTitle}}" class="turn-label">{{s8.photoTitle}}</text>
        <text ink:if="{{s8.shotLabel}}" class="shot-label">{{s8.shotLabel}}</text>
        <image ink:if="{{s8.isShot}}" class="shot-image" style="width: {{s8.shotWidth}}px; height: {{s8.shotHeight}}px;" src="{{s8.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s9.show}}" id="row-9" class="turn">
        <text ink:if="{{s9.askLabel}}" class="turn-label">{{s9.askLabel}}</text>
        <text ink:if="{{s9.question}}" class="turn-question">{{s9.question}}</text>
        <text ink:if="{{s9.answerLabel}}" class="turn-label">{{s9.answerLabel}}</text>
        <text ink:if="{{s9.answer}}" class="turn-answer">{{s9.answer}}</text>
        <text ink:if="{{s9.photoTitle}}" class="turn-label">{{s9.photoTitle}}</text>
        <text ink:if="{{s9.shotLabel}}" class="shot-label">{{s9.shotLabel}}</text>
        <image ink:if="{{s9.isShot}}" class="shot-image" style="width: {{s9.shotWidth}}px; height: {{s9.shotHeight}}px;" src="{{s9.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s10.show}}" id="row-10" class="turn">
        <text ink:if="{{s10.askLabel}}" class="turn-label">{{s10.askLabel}}</text>
        <text ink:if="{{s10.question}}" class="turn-question">{{s10.question}}</text>
        <text ink:if="{{s10.answerLabel}}" class="turn-label">{{s10.answerLabel}}</text>
        <text ink:if="{{s10.answer}}" class="turn-answer">{{s10.answer}}</text>
        <text ink:if="{{s10.photoTitle}}" class="turn-label">{{s10.photoTitle}}</text>
        <text ink:if="{{s10.shotLabel}}" class="shot-label">{{s10.shotLabel}}</text>
        <image ink:if="{{s10.isShot}}" class="shot-image" style="width: {{s10.shotWidth}}px; height: {{s10.shotHeight}}px;" src="{{s10.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s11.show}}" id="row-11" class="turn">
        <text ink:if="{{s11.askLabel}}" class="turn-label">{{s11.askLabel}}</text>
        <text ink:if="{{s11.question}}" class="turn-question">{{s11.question}}</text>
        <text ink:if="{{s11.answerLabel}}" class="turn-label">{{s11.answerLabel}}</text>
        <text ink:if="{{s11.answer}}" class="turn-answer">{{s11.answer}}</text>
        <text ink:if="{{s11.photoTitle}}" class="turn-label">{{s11.photoTitle}}</text>
        <text ink:if="{{s11.shotLabel}}" class="shot-label">{{s11.shotLabel}}</text>
        <image ink:if="{{s11.isShot}}" class="shot-image" style="width: {{s11.shotWidth}}px; height: {{s11.shotHeight}}px;" src="{{s11.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s12.show}}" id="row-12" class="turn">
        <text ink:if="{{s12.askLabel}}" class="turn-label">{{s12.askLabel}}</text>
        <text ink:if="{{s12.question}}" class="turn-question">{{s12.question}}</text>
        <text ink:if="{{s12.answerLabel}}" class="turn-label">{{s12.answerLabel}}</text>
        <text ink:if="{{s12.answer}}" class="turn-answer">{{s12.answer}}</text>
        <text ink:if="{{s12.photoTitle}}" class="turn-label">{{s12.photoTitle}}</text>
        <text ink:if="{{s12.shotLabel}}" class="shot-label">{{s12.shotLabel}}</text>
        <image ink:if="{{s12.isShot}}" class="shot-image" style="width: {{s12.shotWidth}}px; height: {{s12.shotHeight}}px;" src="{{s12.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s13.show}}" id="row-13" class="turn">
        <text ink:if="{{s13.askLabel}}" class="turn-label">{{s13.askLabel}}</text>
        <text ink:if="{{s13.question}}" class="turn-question">{{s13.question}}</text>
        <text ink:if="{{s13.answerLabel}}" class="turn-label">{{s13.answerLabel}}</text>
        <text ink:if="{{s13.answer}}" class="turn-answer">{{s13.answer}}</text>
        <text ink:if="{{s13.photoTitle}}" class="turn-label">{{s13.photoTitle}}</text>
        <text ink:if="{{s13.shotLabel}}" class="shot-label">{{s13.shotLabel}}</text>
        <image ink:if="{{s13.isShot}}" class="shot-image" style="width: {{s13.shotWidth}}px; height: {{s13.shotHeight}}px;" src="{{s13.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s14.show}}" id="row-14" class="turn">
        <text ink:if="{{s14.askLabel}}" class="turn-label">{{s14.askLabel}}</text>
        <text ink:if="{{s14.question}}" class="turn-question">{{s14.question}}</text>
        <text ink:if="{{s14.answerLabel}}" class="turn-label">{{s14.answerLabel}}</text>
        <text ink:if="{{s14.answer}}" class="turn-answer">{{s14.answer}}</text>
        <text ink:if="{{s14.photoTitle}}" class="turn-label">{{s14.photoTitle}}</text>
        <text ink:if="{{s14.shotLabel}}" class="shot-label">{{s14.shotLabel}}</text>
        <image ink:if="{{s14.isShot}}" class="shot-image" style="width: {{s14.shotWidth}}px; height: {{s14.shotHeight}}px;" src="{{s14.shotSrc}}" mode="aspectFit" />
      </view>
      <view ink:if="{{s15.show}}" id="row-15" class="turn">
        <text ink:if="{{s15.askLabel}}" class="turn-label">{{s15.askLabel}}</text>
        <text ink:if="{{s15.question}}" class="turn-question">{{s15.question}}</text>
        <text ink:if="{{s15.answerLabel}}" class="turn-label">{{s15.answerLabel}}</text>
        <text ink:if="{{s15.answer}}" class="turn-answer">{{s15.answer}}</text>
        <text ink:if="{{s15.photoTitle}}" class="turn-label">{{s15.photoTitle}}</text>
        <text ink:if="{{s15.shotLabel}}" class="shot-label">{{s15.shotLabel}}</text>
        <image ink:if="{{s15.isShot}}" class="shot-image" style="width: {{s15.shotWidth}}px; height: {{s15.shotHeight}}px;" src="{{s15.shotSrc}}" mode="aspectFit" />
      </view>

      <view ink:if="{{draft}}" id="draft-line" class="turn">
        <text class="turn-label">问</text>
        <text class="turn-question">{{draft}}</text>
      </view>
      <view id="thread-bottom" class="thread-bottom"></view>
    </scroll-view>

    <view class="footer">
      <text class="hint">{{hint}}</text>
      <text ink:if="{{photoNote}}" class="hint">{{photoNote}}</text>
     
    </view>
  </view>
</page>

<style>
.page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  box-sizing: border-box;
  overflow: hidden;
  background-color: #000000;
}

.header {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
}

.kicker {
  font-size: 11px;
  line-height: 14px;
  color: #40ff5e;
  font-family: monospace;
}

.model {
  font-size: 11px;
  line-height: 14px;
  color: rgba(64, 255, 94, 0.48);
}

.thread {
  width: 100%;
  margin-top: 8px;
  overflow: hidden;
}

.thread-bottom {
  width: 100%;
  height: 8px;
}

.turn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-width: 0 0 1px 0;
  border-style: solid;
  border-color: rgba(64, 255, 94, 0.24);
}

.turn-label {
  font-size: 11px;
  line-height: 14px;
  font-family: monospace;
  color: rgba(64, 255, 94, 0.48);
}

.turn-question {
  font-size: 16px;
  line-height: 20px;
  color: #40ff5e;
}

.turn-answer {
  font-size: 14px;
  line-height: 20px;
  color: rgba(64, 255, 94, 0.72);
}

.shot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.shot-label {
  font-size: 14px;
  line-height: 20px;
  color: #40ff5e;
}

.shot-image {
  margin-bottom: 8px;
}

.footer {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}

.hint {
  font-size: 12px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.48);
}

.ask {
  height: 32px;
  padding: 0 12px;
  color: rgba(64, 255, 94, 0.72);
  background-color: transparent;
  border: 1px solid rgba(64, 255, 94, 0.48);
  border-radius: 4px;
  font-size: 11px;
  line-height: 14px;
}

.ask-on {
  color: #40ff5e;
  border-color: #40ff5e;
  background-color: rgba(64, 255, 94, 0.12);
}
</style>
