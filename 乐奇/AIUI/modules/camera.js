import wx from 'wx';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const parts = [];
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64[(triple >> 18) & 63];
    out += B64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[triple & 63] : '=';
    if (out.length >= 16384) {
      parts.push(out);
      out = '';
    }
  }
  if (out) {
    parts.push(out);
  }
  return parts.join('');
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') {
    return;
  }
  const tracks = stream.getTracks();
  for (let i = 0; i < tracks.length; i += 1) {
    try {
      tracks[i].stop();
    } catch (error) {
      // The track is already stopped.
    }
  }
}

function blobToBytes(blob) {
  if (!blob) {
    return Promise.reject(new Error('没有拍到画面'));
  }
  if (blob instanceof Uint8Array) {
    return Promise.resolve(blob);
  }
  if (typeof ArrayBuffer !== 'undefined' && blob instanceof ArrayBuffer) {
    return Promise.resolve(new Uint8Array(blob));
  }
  if (blob.buffer instanceof ArrayBuffer && typeof blob.byteLength === 'number') {
    return Promise.resolve(new Uint8Array(blob.buffer, blob.byteOffset || 0, blob.byteLength));
  }
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('没有拍到画面'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result));
    };
    reader.onerror = () => {
      reject(new Error('没有拍到画面'));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function photoResult(bytes, mimeType) {
  if (!bytes || !bytes.byteLength) {
    throw new Error('没有拍到画面');
  }
  const type = String(mimeType || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
  const base64 = toBase64(bytes);
  return {
    mimeType: type,
    base64,
    src: 'data:' + type + ';base64,' + base64
  };
}

async function takeFromCamera() {
  const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function' || typeof ImageCapture !== 'function') {
    return null;
  }
  let stream = null;
  let opened = false;
  const opening = mediaDevices.getUserMedia({ audio: false, video: true }).then((value) => {
    if (opened) {
      stopStream(value);
      throw new Error('打开相机超时');
    }
    stream = value;
    return value;
  });
  try {
    stream = await withTimeout(opening, 8000, '打开相机超时');
  } catch (error) {
    opened = true;
    stopStream(stream);
    throw error;
  }
  opened = true;
  const tracks = stream && typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
  const videoTrack = tracks && tracks[0];
  if (!videoTrack) {
    stopStream(stream);
    throw new Error('相机不可用');
  }
  try {
    const capture = new ImageCapture(videoTrack);
    const blob = await withTimeout(capture.takePhoto({
      quality: 'low',
      mode: 'telephoto',
      enableSystemPreview: false
    }), 10000, '拍照超时');
    const bytes = await blobToBytes(blob);
    const mimeType = (blob && blob.type) || 'image/jpeg';
    return photoResult(bytes, mimeType);
  } finally {
    stopStream(stream);
  }
}

async function takeWithContext() {
  if (!wx || !wx.media || typeof wx.media.createCameraContext !== 'function') {
    throw new Error('相机不可用');
  }
  const camera = wx.media.createCameraContext();
  if (!camera || typeof camera.takePhoto !== 'function') {
    throw new Error('相机不可用');
  }
  const photo = await withTimeout(camera.takePhoto({
    quality: 'high',
    mode: 'telephoto',
    enableSystemPreview: false
  }), 10000, '拍照超时');
  const data = photo && photo.data;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  return photoResult(bytes, (photo && photo.mimeType) || 'image/webp');
}

export async function takeGlassesPhoto() {
  const photo = await takeFromCamera();
  if (photo) {
    return photo;
  }
  return takeWithContext();
}
