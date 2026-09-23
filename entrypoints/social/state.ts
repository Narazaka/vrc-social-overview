import { createMemo, createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  fetchFavoriteGroups,
  fetchFavorites,
  fetchFriends,
  fetchInstance,
  fetchMe,
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

export function ownerOf(id: string): Owner | undefined {
  const f = friendsById().get(id);
  return f ? { name: f.displayName, image: f.currentAvatarImageUrl } : state.owners[id];
}

const ownerRequested = new Set<string>();

export async function load() {
  try {
    setState('me', (await fetchMe()).displayName);
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
