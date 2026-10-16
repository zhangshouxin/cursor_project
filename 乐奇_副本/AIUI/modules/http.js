import wx from 'wx';

export function requestJson(options) {
  const header = Object.assign(
    { 'content-type': 'application/json' },
    options.header || {}
  );

  const timeout = options.timeout || 8000;
  if (!wx || typeof wx.request !== 'function') {
    return Promise.reject(new Error('wx.request unavailable'));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, timeout);

    wx.request({
      url: options.url,
      method: options.method || 'GET',
      data: options.data,
      header,
      timeout,
      responseType: 'text',
      dataType: 'json',
      success(res) {
        clearTimeout(timer);
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          let data = res.data;
          if (typeof data === 'string' && data) {
            try {
              data = JSON.parse(data);
            } catch (error) {
              reject(new Error('invalid json'));
              return;
            }
          }
          resolve(data);
          return;
        }
        reject(new Error('HTTP ' + status));
      },
      fail(err) {
        clearTimeout(timer);
        reject(new Error((err && err.errMsg) || 'request failed'));
      }
    });
  });
}

export function decodeChunk(chunk) {
  if (chunk == null) {
    return '';
  }
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (chunk instanceof ArrayBuffer) {
    return decodeBytes(new Uint8Array(chunk));
  }
  if (chunk && chunk.buffer instanceof ArrayBuffer) {
    return decodeBytes(chunk);
  }
  return String(chunk);
}

function decodeBytes(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) {
    text += String.fromCharCode(bytes[i]);
  }
  try {
    return decodeURIComponent(escape(text));
  } catch (error) {
    return text;
  }
}
