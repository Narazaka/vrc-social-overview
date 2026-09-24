const API = 'https://vrchat.com/api/1';

export type Friend = {
  id: string;
  displayName: string;
  status: string;
  statusDescription: string;
  location: string;
  platform: string;
  currentAvatarImageUrl: string;
};
export type World = {
  name: string;
  // 以前に保存したワールド情報には無いことがある
  authorId?: string;
  authorName?: string;
  thumbnailImageUrl: string;
  releaseStatus: string;
  capacity: number;
  tags: string[];
};
export type Instance = { userCount: number; capacity: number; world: World };
export type Owner = { name: string; image: string };
export type Favorite = { favoriteId: string; tags: string[] };
export type FavoriteGroup = { name: string; displayName: string };

// ログインが切れている（401）。ログインし直すまで何を取っても失敗する
export class AuthError extends Error {}
let onAuthLost = () => {};
export const setAuthLostHandler = (fn: () => void) => {
  onAuthLost = fn;
};

// 429（レート制限）や一時的なサーバーエラーのときは、以降のリクエストもまとめて止めてから再試行する。
// 待ち時間は Retry-After があればそれに従い、無ければ失敗が続くほど延ばす
const MAX_RETRIES = 3;
const MIN_BACKOFF = 5 * 1000;
const MAX_BACKOFF = 60 * 1000;
let backoff = MIN_BACKOFF;
let pausedUntil = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// vrchat.com のログイン Cookie がそのまま送られる（host_permissions による）
async function get<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await fetch(API + path, { credentials: 'include' });
    if (res.ok) {
      backoff = MIN_BACKOFF;
      return res.json();
    }
    if (res.status === 401) {
      onAuthLost();
      throw new AuthError(`${res.status} ${path}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      // Retry-After は秒数。日付形式や欠けているときは NaN / 0 になるので自前の待ち時間を使う
      const retryAfter = Number(res.headers.get('Retry-After')) * 1000;
      pausedUntil = Math.max(pausedUntil, Date.now() + (retryAfter || backoff));
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      continue;
    }
    throw new Error(`${res.status} ${path}`);
  }
}

// インスタンス数だけ API を叩くので、同時リクエスト数を絞ってレート制限を避ける
export function createLimiter(concurrency: number) {
  const queue: (() => void)[] = [];
  let active = 0;
  const next = () => {
    while (active < concurrency && queue.length) {
      active++;
      queue.shift()!();
    }
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      queue.push(() =>
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          }),
      );
      next();
    });
}
const limited = createLimiter(3);

async function getAll<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await get<T[]>(`${path}&n=100&offset=${offset}`);
    all.push(...page);
    if (page.length < 100) return all;
  }
}

// friends にはオフラインを含むフレンド全員の ID が入っている
export const fetchMe = () => get<{ id: string; displayName: string; friends: string[] }>('/auth/user');
// ponytail: ページ送りせず 1 回で取得（約 200 件は 1 回で返る）。取りこぼしが出たら offset でページ送りする
export const fetchMyGroupIds = (userId: string) =>
  get<{ groupId: string }[]>(`/users/${userId}/groups`).then(gs => gs.map(g => g.groupId));
export const fetchFriends = () => getAll<Friend>('/auth/user/friends?offline=false');
export const fetchFavorites = () => getAll<Favorite>('/favorites?type=friend');
export const fetchFavoriteGroups = () => get<FavoriteGroup[]>('/favorite/groups?type=friend&n=50');
export const fetchInstance = (loc: string) => limited(() => get<Instance>(`/instances/${loc}`));
// プロフィール（自己紹介・リンク・バッジ等）は /users/{id} ではなく /profile/{id} にある
export type Profile = {
  id: string;
  displayName: string;
  iconUrl: string;
  pronouns: string;
  bio: string;
  bioLinks: string[];
  languages: string[];
  trustTags: string[];
  badges: { badgeName: string; badgeDescription: string; badgeImageUrl: string; showcased: boolean }[];
  representedGroup: { id: string; name: string; iconUrl: string } | null;
};
export const fetchProfile = (id: string) => limited(() => get<Profile>(`/profile/${id}`));
// 自分がそのユーザーに付けたメモと、今のステータス（変わりやすい部分）
// メモ。ステータスも返るが、フレンド一覧（のちに WebSocket で更新）の値を使うので読まない
export const fetchNote = (id: string) =>
  limited(() => get<{ note?: string }>(`/profile/${id}/private`)).then(p => p.note ?? '');

// 信頼ランク。trustTags は下位のものも全部入るので上位から探す。[表示名, 色分け用のキー]
const TRUST_RANKS: [string, string, string][] = [
  ['system_trust_veteran', 'Trusted User', 'trusted'],
  ['system_trust_trusted', 'Known User', 'known'],
  ['system_trust_known', 'User', 'user'],
  ['system_trust_basic', 'New User', 'new'],
];
export function trustRank(tags: string[]): [string, string] {
  const rank = TRUST_RANKS.find(([tag]) => tags.includes(tag));
  return rank ? [rank[1], rank[2]] : ['Visitor', 'visitor'];
}

// 一覧には World の項目だけを使い、詳細パネルでは残りも使う
export type WorldDetail = World & {
  id: string;
  description: string;
  authorId: string;
  authorName: string;
  recommendedCapacity: number;
  imageUrl: string;
  publicationDate: string;
  labsPublicationDate: string;
  updated_at: string;
  unityPackages: { platform: string }[];
  favorites: number;
  visits: number;
};
// Pipeline（WebSocket）の接続に使う認証トークン。ログイン Cookie の値と同じもの
export const fetchAuthToken = () => get<{ token: string }>('/auth').then(a => a.token);
// Pipeline のイベントにはアバター画像が入らないので、新しくオンラインになったフレンドの分だけ取る
export const fetchAvatarImage = (id: string) =>
  limited(() => get<{ currentAvatarImageUrl: string }>(`/users/${id}`)).then(u => u.currentAvatarImageUrl);

export const fetchWorld = (worldId: string) => limited(() => get<WorldDetail>(`/worlds/${worldId}`));

// フレンド以外のユーザーは currentAvatarImageUrl が返らないので iconUrl で代用する
export function fetchOwner(id: string): Promise<Owner> {
  if (id.startsWith('grp_'))
    return limited(() => get<{ name: string; iconUrl: string }>(`/groups/${id}`)).then(g => ({
      name: g.name,
      image: g.iconUrl,
    }));
  return limited(() => get<{ displayName: string; iconUrl: string }>(`/users/${id}`)).then(u => ({
    name: u.displayName,
    image: u.iconUrl,
  }));
}

// 拡張の host_permissions に収めるため、画像 URL のホストを vrchat.com に揃える
// 大きい画像を縮小表示するとジャギるので、/image/{file}/{version}/{size} 形式で表示サイズに近いもの（64/128/256/512）を取る
export const img = (url: string | undefined, size: 64 | 128 | 256 | 512) =>
  url
    ? url
        .replace('://api.vrchat.cloud/', '://vrchat.com/')
        .replace(/\/api\/1\/(?:file|image)\/(file_[^/]+)\/(\d+)\/.*$/, `/api/1/image/$1/$2/${size}`)
    : undefined;

export const STATUS_COLOR: Record<string, string> = {
  'join me': '#4fc3f7',
  active: '#66bb6a',
  'ask me': '#ffa726',
  busy: '#ef5350',
};

export const inWorld = (f: Friend) => f.location.startsWith('wrld_');
// ゲーム外（Web サイトやモバイルアプリ）からのオンラインは location が offline になる
export const outsideGame = (f: Friend) => f.location === 'offline';
export const inPrivate = (f: Friend) => !inWorld(f) && !outsideGame(f);

// ワールド外にいるときの居場所を示すアイコンと説明。[アイコン, 説明]。
// private は一覧の行が分かれているので何も出さない
export function placeIcon(f: Friend): [string, string] | undefined {
  if (outsideGame(f)) {
    if (f.platform === 'web') return ['🌐', 'Web'];
    if (f.platform === 'nativemobile') return ['📱', 'モバイル'];
    return ['🌐', f.platform];
  }
  if (f.location === 'traveling') return ['✈️', '移動中'];
  return undefined;
}
export const worldIdOf = (loc: string) => loc.split(':')[0]!;
export const ownerIdOf = (loc: string) => loc.match(/\(((?:usr|grp)_[^)]+)\)/)?.[1];

// [表示名, 色分け用のキー]
export function instanceType(loc: string): [string, string] {
  const access = loc.match(/~groupAccessType\((\w+)\)/)?.[1];
  if (access)
    return [
      ({ public: 'Group Public', plus: 'Group+', members: 'Group' } as Record<string, string>)[access] ?? 'Group',
      `group-${access}`,
    ];
  if (loc.includes('~hidden(')) return ['Friends+', 'friends-plus'];
  if (loc.includes('~friends(')) return ['Friends', 'friends'];
  if (loc.includes('~private('))
    return loc.includes('~canRequestInvite') ? ['Invite+', 'invite-plus'] : ['Invite', 'invite'];
  return ['Public', 'public'];
}

// 正式公開（Labs 卒業済み）のワールドは何も出さず、それ以外だけアイコンで注記する。[アイコン, 説明]
export function worldStatus(w: World): [string, string] | undefined {
  if (w.releaseStatus === 'private') return ['🔒', 'Private World'];
  if (w.releaseStatus !== 'public') return ['⚠', w.releaseStatus];
  return w.tags.includes('system_approved') ? undefined : ['🧪', 'Community Labs'];
}

// 現在人数・上限人数とも同じ尺度で絶対値を色分けし、2 人部屋や大人数のインスタンスをひと目で分かるようにする
export const sizeClass = (n: number) =>
  n <= 1 ? 'n-1' : n <= 2 ? 'n-2' : n <= 4 ? 'n-4' : n < 10 ? '' : n < 30 ? 'n-10' : 'n-30';
