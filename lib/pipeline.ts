import { AuthError, fetchAuthToken } from './vrchat';

// VRChat の Pipeline（WebSocket）。フレンドのオンライン・移動・ステータス変更などが届く
const PIPELINE_URL = 'wss://pipeline.vrchat.cloud/';
const MAX_RETRY_DELAY = 60 * 1000;

export type PipelineHandlers = {
  // content は JSON 文字列で届くので解いてから渡す
  onEvent: (type: string, content: any) => void;
  // 切れていた間のイベントは届かないので、繋ぎ直したときに取り直してもらう
  onReconnect: () => void;
  onStatus: (connected: boolean) => void;
};

// 返り値の関数で切断し、以後は繋ぎ直さない
export function connectPipeline(h: PipelineHandlers) {
  let failures = 0;
  let connectedOnce = false;
  let stopped = false;
  let ws: WebSocket | undefined;
  const retry = () => {
    if (stopped) return;
    h.onStatus(false);
    setTimeout(connect, Math.min(1000 * 2 ** failures++, MAX_RETRY_DELAY));
  };
  async function connect() {
    if (stopped) return;
    let token: string;
    try {
      token = await fetchAuthToken();
    } catch (e) {
      // ログインが切れていれば繋ぎ直しても無駄なので諦める（ログイン切れの表示は API 側から出る）
      return e instanceof AuthError ? undefined : retry();
    }
    ws = new WebSocket(`${PIPELINE_URL}?authToken=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      failures = 0;
      h.onStatus(true);
      if (connectedOnce) h.onReconnect();
      connectedOnce = true;
    };
    ws.onmessage = e => {
      let m: { type: string; content: unknown };
      try {
        m = JSON.parse(e.data);
        if (typeof m.content === 'string' && m.content.startsWith('{')) m.content = JSON.parse(m.content);
      } catch {
        return; // 解釈できないメッセージは無視する
      }
      h.onEvent(m.type, m.content);
    };
    ws.onclose = retry;
  }
  connect();
  return () => {
    stopped = true;
    ws?.close();
  };
}
