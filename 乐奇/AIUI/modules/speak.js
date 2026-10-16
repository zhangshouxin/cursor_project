import wx from 'wx';

export function stopSpeaking() {
  try {
    if (typeof speechSynthesis !== 'undefined' && speechSynthesis.cancel) {
      speechSynthesis.cancel();
    }
  } catch (error) {
    // Ignore missing TTS runtime.
  }
}

function estimateSpeechMs(text) {
  return Math.min(8000, Math.max(700, String(text || '').length * 180 + 400));
}

export function speakText(text) {
  const content = String(text || '').trim();
  if (!content) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    if (wx && wx.speech && typeof wx.speech.playTTS === 'function') {
      try {
        stopSpeaking();
        const result = wx.speech.playTTS(content);
        if (result && typeof result.then === 'function') {
          result.then(done, done);
          return;
        }
        if (result && typeof result.onend === 'function') {
          result.onend = done;
          result.onerror = done;
          return;
        }
        setTimeout(done, estimateSpeechMs(content));
        return;
      } catch (error) {
        // 宿主播报不可用时，再改走浏览器语音。
      }
    }

    if (
      typeof speechSynthesis === 'undefined' ||
      typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      setTimeout(done, estimateSpeechMs(content));
      return;
    }

    try {
      const utterance = new SpeechSynthesisUtterance(content);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.onend = done;
      utterance.onerror = done;
      speechSynthesis.speak(utterance);
      setTimeout(done, estimateSpeechMs(content) + 1200);
    } catch (error) {
      console.warn('TTS failed', error);
      done();
    }
  });
}
