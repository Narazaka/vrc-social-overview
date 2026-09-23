import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-solid'],
  // Firefox も MV3 でビルドする（WXT の既定は Firefox だけ MV2）
  manifestVersion: 3,
  manifest: {
    name: 'VRC Social',
    description: 'VRChat のフレンド状況を見やすく表示する',
    action: {},
    // files.vrchat.cloud は画像 API のリダイレクト先。画像をキャッシュ保存するため中身を読む必要がある
    host_permissions: ['https://vrchat.com/*', 'https://files.vrchat.cloud/*'],
    browser_specific_settings: {
      gecko: { id: 'vrc-social@narazaka.net', strict_min_version: '128.0' },
    },
  },
  // AMO の審査で読める出力にするため minify しない
  vite: () => ({ build: { minify: false } }),
});
