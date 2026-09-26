import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-solid'],
  // Firefox も MV3 でビルドする（WXT の既定は Firefox だけ MV2）
  manifestVersion: 3,
  manifest: {
    name: 'VRC Social Overview',
    description: 'VRChat のフレンドの居場所とインスタンスを見やすく一覧する非公式の拡張機能',
    action: {},
    // files.vrchat.cloud は画像 API のリダイレクト先。画像をキャッシュ保存するため中身を読む必要がある
    host_permissions: ['https://vrchat.com/*', 'https://files.vrchat.cloud/*'],
    browser_specific_settings: {
      gecko: {
        id: 'vrc-social-overview@narazaka.net',
        // data_collection_permissions に対応するのが 140 から
        strict_min_version: '140.0',
        // リアルタイム更新（Pipeline）の接続に、ログイン Cookie と同じ認証トークンを VRChat のサーバーへ送る。
        // 送り先は VRChat の公式サーバーだけで、開発者や第三者には送らない
        data_collection_permissions: { required: ['authenticationInfo'] },
      },
    },
  },
  // AMO の審査で読める出力にするため minify しない
  vite: () => ({ build: { minify: false } }),
  // AMO に出すソースの zip には、ビルドに要らないストア掲載用のスクリーンショットを入れない
  zip: { excludeSources: ['assets/store/**'] },
});
