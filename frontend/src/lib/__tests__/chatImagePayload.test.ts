import { describe, expect, it } from 'vitest';
import { imageAttachmentFromFile, toChatImagePayload } from '../chatImage';

describe('toChatImagePayload', () => {
  it('prefers a local path so large image bytes stay outside the bridge frame', () => {
    expect(toChatImagePayload({
      path: 'C:\\test\\image.png',
      previewUrl: 'data:image/png;base64,preview',
    })).toEqual({ image_path: 'C:\\test\\image.png' });
  });

  it('uses the bounded data URL for clipboard images without a path', () => {
    expect(toChatImagePayload({ previewUrl: 'data:image/jpeg;base64,abc=' }))
      .toEqual({ image_data_url: 'data:image/jpeg;base64,abc=' });
  });

  it('does not forward non-image previews', () => {
    expect(toChatImagePayload({ previewUrl: 'blob:unsafe' })).toEqual({});
    expect(toChatImagePayload(undefined)).toEqual({});
  });

  it('gets a disk image path through the preload bridge instead of File.path', async () => {
    const file = { name: 'image.png', size: 10, type: 'image/png' } as File;
    Object.assign(file, { path: 'C:\\deprecated\\wrong.png' });
    const previousApi = window.electronAPI;
    window.electronAPI = {
      getPathForFile: (candidate) => {
        expect(candidate).toBe(file);
        return 'C:\\secure\\image.png';
      },
    };

    try {
      await expect(imageAttachmentFromFile(file)).resolves.toEqual({
        path: 'C:\\secure\\image.png',
        previewUrl: '',
      });
    } finally {
      window.electronAPI = previousApi;
    }
  });
});
