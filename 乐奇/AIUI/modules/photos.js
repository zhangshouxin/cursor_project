import { LOCAL_LLM } from './config.js';
import { requestJson } from './http.js';

export function uploadPhoto(photo) {
  const base = String(LOCAL_LLM.baseUrl || '').replace(/\/$/, '');
  return requestJson({
    url: base + '/photos',
    method: 'POST',
    timeout: 70000,
    data: {
      mimeType: (photo && photo.mimeType) || 'image/webp',
      data: (photo && photo.base64) || ''
    }
  });
}
