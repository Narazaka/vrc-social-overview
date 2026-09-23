const API = 'https://vrchat.com/api/1';

export type Friend = {
  id: string;
  displayName: string;
  status: string;
  statusDescription: string;
  location: string;
  currentAvatarImageUrl: string;
};
export type World = { name: string; thumbnailImageUrl: string; releaseStatus: string; tags: string[] };
export type Instance = { userCount: number; capacity: number; world: World };
export type Owner = { name: string; image: string };
export type Favorite = { favoriteId: string; tags: string[] };
export type FavoriteGroup = { name: string; displayName: string };

// vrchat.com のログイン Cookie がそのまま送られる（host_permissions による）
async function get<T>(path: string): Promise<T> {
  const res = await fetch(API + path, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// インスタンス数だけ API を叩くので、同時リクエスト数を絞ってレート制限を避ける
// ponytail: 固定並列数のみ。429 が出るようなら間隔制御・リトライを入れる
const queue: (() => void)[] = [];
let active = 0;
function limited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
    next();
  });
}
function next() {
  while (active < 3 && queue.length) { active++; queue.shift()!(); }
}

async function getAll<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await get<T[]>(`${path}&n=100&offset=${offset}`);
    all.push(...page);
    if (page.length < 100) return all;
  }
}

export const fetchMe = () => get<{ displayName: string }>('/auth/user');
export const fetchFriends = () => getAll<Friend>('/auth/user/friends?offline=false');
export const fetchFavorites = () => getAll<Favorite>('/favorites?type=friend');
export const fetchFavoriteGroups = () => get<FavoriteGroup[]>('/favorite/groups?type=friend&n=50');
export const fetchInstance = (loc: string) => limited(() => get<Instance>(`/instances/${loc}`));

// フレンド以外のユーザーは currentAvatarImageUrl が返らないので iconUrl で代用する
export function fetchOwner(id: string): Promise<Owner> {
  if (id.startsWith('grp_')) return limited(() => get<{ name: string; iconUrl: string }>(`/groups/${id}`)).then(g => ({ name: g.name, image: g.iconUrl }));
  return limited(() => get<{ displayName: string; iconUrl: string }>(`/users/${id}`)).then(u => ({ name: u.displayName, image: u.iconUrl }));
}

// 画像 API も認証必須。Cookie があるのは vrchat.com 側なのでホストを差し替える
// 大きい画像を縮小表示するとジャギるので、/image/{file}/{version}/{size} 形式で表示サイズに近いもの（64/128/256）を取る
export const img = (url: string | undefined, size: 64 | 128 | 256) =>
  url
    ? url.replace('://api.vrchat.cloud/', '://vrchat.com/').replace(/\/api\/1\/(?:file|image)\/(file_[^/]+)\/(\d+)\/.*$/, `/api/1/image/$1/$2/${size}`)
    : undefined;

export const STATUS_COLOR: Record<string, string> = { 'join me': '#4fc3f7', active: '#66bb6a', 'ask me': '#ffa726', busy: '#ef5350' };

export const inWorld = (f: Friend) => f.location.startsWith('wrld_');
export const ownerIdOf = (loc: string) => loc.match(/\(((?:usr|grp)_[^)]+)\)/)?.[1];

// [表示名, 色分け用のキー]
export function instanceType(loc: string): [string, string] {
  const access = loc.match(/~groupAccessType\((\w+)\)/)?.[1];
  if (access) return [({ public: 'Group Public', plus: 'Group+', members: 'Group' } as Record<string, string>)[access] ?? 'Group', `group-${access}`];
  if (loc.includes('~hidden(')) return ['Friends+', 'friends-plus'];
  if (loc.includes('~friends(')) return ['Friends', 'friends'];
  if (loc.includes('~private(')) return loc.includes('~canRequestInvite') ? ['Invite+', 'invite-plus'] : ['Invite', 'invite'];
  return ['Public', 'public'];
}

// 正式公開（Labs 卒業済み）のワールドは何も出さず、それ以外だけアイコンで注記する。[アイコン, 説明]
export function worldStatus(w: World): [string, string] | undefined {
  if (w.releaseStatus === 'private') return ['🔒', 'Private World'];
  if (w.releaseStatus !== 'public') return ['⚠', w.releaseStatus];
  return w.tags.includes('system_approved') ? undefined : ['🧪', 'Community Labs'];
}

// 現在人数・上限人数とも同じ尺度で絶対値を色分けし、2 人部屋や大人数のインスタンスをひと目で分かるようにする
export const sizeClass = (n: number) => (n <= 1 ? 'n-1' : n <= 2 ? 'n-2' : n <= 4 ? 'n-4' : n < 10 ? '' : n < 30 ? 'n-10' : 'n-30');
