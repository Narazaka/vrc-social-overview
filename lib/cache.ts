import { createLimiter } from './vrchat';

// API への負荷を抑えるため、取得結果を TTL 付きで拡張機能内に保存する

type Entry<T> = { v: T; at: number };

// localStorage に保存する小さなキャッシュ。上限件数を超えたら古い順に捨てる
export function ttlStore<T>(name: string, max: number) {
  let data: Record<string, Entry<T>> = {};
  try {
    data = JSON.parse(localStorage.getItem(name) ?? '{}');
  } catch {
    // 壊れていたら空から始める
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      data = Object.fromEntries(
        Object.entries(data)
          .sort(([, a], [, b]) => b.at - a.at)
          .slice(0, max),
      );
      try {
        localStorage.setItem(name, JSON.stringify(data));
      } catch {
        // 保存できなくても表示には影響しない
      }
    }, 1000);
  };
  return {
    // ttlMs 以内に保存されたものだけ返す
    fresh: (key: string, ttlMs: number) => {
      const e = data[key];
      return e && Date.now() - e.at < ttlMs ? e.v : undefined;
    },
    // 古さを問わず返す
    any: (key: string) => data[key]?.v,
    all: () => Object.fromEntries(Object.entries(data).map(([k, e]) => [k, e.v])),
    set: (key: string, v: T) => {
      data[key] = { v, at: Date.now() };
      save();
    },
  };
}

// 画像 API は CDN の署名付き URL へリダイレクトする。署名 URL は期限（数日〜2 週間、日付単位）まで変わらず、
// その間はブラウザの HTTP キャッシュが効く。リダイレクト先を期限まで保存して img に直接渡し、画像 API へのアクセスを減らす
type ResolvedImage = { url: string; exp: number };
const resolvedImages = ttlStore<ResolvedImage>('imageUrls', 3000);
const EXPIRY_MARGIN = 60 * 60 * 1000;
// 署名 URL に期限が付いていない場合の保存期間
const DEFAULT_IMAGE_TTL = 24 * 60 * 60 * 1000;
const imageLimited = createLimiter(6);
const resolving = new Map<string, Promise<string>>();

export function resolveImage(url: string): Promise<string> {
  const hit = resolvedImages.any(url);
  if (hit && hit.exp - EXPIRY_MARGIN > Date.now()) return Promise.resolve(hit.url);
  let p = resolving.get(url);
  if (!p) {
    // 画像 API は認証不要で、リダイレクト先の CDN に Cookie を送ると CORS で弾かれるので送らない。
    // CDN は HEAD に CORS ヘッダーを付けないので GET で取る。img が CORS なしで読んだ応答がキャッシュにあると
    // CORS で失敗するのでキャッシュは読まず（reload）、取った応答はキャッシュに入るので続く img 表示はそれを使う
    p = imageLimited(() => fetch(url, { credentials: 'omit', cache: 'reload' }))
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        const expires = Number(new URL(res.url).searchParams.get('Expires')) * 1000;
        resolvedImages.set(url, { url: res.url, exp: expires || Date.now() + DEFAULT_IMAGE_TTL });
        return res.url;
      })
      .finally(() => resolving.delete(url));
    resolving.set(url, p);
  }
  return p;
}
