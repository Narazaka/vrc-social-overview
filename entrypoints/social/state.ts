import { createMemo, createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  fetchFavoriteGroups,
  fetchFavorites,
  fetchFriends,
  fetchInstance,
  fetchMe,
  fetchMyGroupIds,
  fetchOwner,
  inWorld,
  ownerIdOf,
  type FavoriteGroup,
  type Friend,
  type Instance,
  type Owner,
} from '@/lib/vrchat';

export const [state, setState] = createStore({
  me: undefined as string | undefined,
  error: undefined as string | undefined,
  loginRequired: false,
  friends: [] as Friend[],
  favTags: {} as Record<string, string[]>,
  favGroups: [] as FavoriteGroup[],
  // location / ユーザー・グループ ID ごとに、取得でき次第埋まる
  instances: {} as Record<string, Instance | { error: string }>,
  owners: {} as Record<string, Owner>,
});

export const byLoc = createRoot(() => createMemo(() => Map.groupBy(state.friends.filter(inWorld), f => f.location)));
export const friendsById = createRoot(() => createMemo(() => new Map(state.friends.map(f => [f.id, f]))));

export const instanceOf = (loc: string) => {
  const i = state.instances[loc];
  return i && !('error' in i) ? i : undefined;
};

// お気に入りグループごとの色分け用クラス。複数グループに入っている場合は最初のグループの色
export const favClass = (id: string) => {
  const group = state.favTags[id]?.[0];
  return group ? `fav fav-${group}` : '';
};

// オフラインを含む全フレンドと、加入しているグループ。読み込み時に一度だけ設定する
let allFriendIds = new Set<string>();
let myGroupIds = new Set<string>();

// kind: オーナーとの関係。friend はオンラインなら friend に本人の情報が入る
export type OwnerView = Owner & { kind: 'friend' | 'stranger' | 'group-member' | 'group'; friend?: Friend };

export function ownerOf(id: string): OwnerView | undefined {
  const f = friendsById().get(id);
  if (f) return { name: f.displayName, image: f.currentAvatarImageUrl, kind: 'friend', friend: f };
  const o = state.owners[id];
  if (!o) return undefined;
  if (id.startsWith('grp_')) return { ...o, kind: myGroupIds.has(id) ? 'group-member' : 'group' };
  return { ...o, kind: allFriendIds.has(id) ? 'friend' : 'stranger' };
}

const ownerRequested = new Set<string>();

export async function load() {
  try {
    const me = await fetchMe();
    allFriendIds = new Set(me.friends);
    myGroupIds = new Set(await fetchMyGroupIds(me.id));
    setState('me', me.displayName);
  } catch (e) {
    setState({ loginRequired: true, error: (e as Error).message });
    return;
  }
  const [friends, favs, favGroups] = await Promise.all([fetchFriends(), fetchFavorites(), fetchFavoriteGroups()]);
  setState({ friends, favGroups, favTags: Object.fromEntries(favs.map(f => [f.favoriteId, f.tags])) });

  for (const loc of byLoc().keys()) {
    fetchInstance(loc).then(
      i => setState('instances', loc, i),
      e => setState('instances', loc, { error: (e as Error).message }),
    );
    const ownerId = ownerIdOf(loc);
    if (ownerId && !friendsById().has(ownerId) && !ownerRequested.has(ownerId)) {
      ownerRequested.add(ownerId);
      fetchOwner(ownerId).then(
        o => setState('owners', ownerId, o),
        () => setState('owners', ownerId, { name: ownerId, image: '' }),
      );
    }
  }
}
