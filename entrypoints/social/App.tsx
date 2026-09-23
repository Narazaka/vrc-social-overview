import { createSignal, For, onMount, Show } from 'solid-js';
import { inWorld, type Friend } from '@/lib/vrchat';
import { FriendCard, InstanceCard, Member } from './cards';
import { byLoc, instanceOf, load, setState, state } from './state';

type SortKey<T> = (x: T) => number;

// 大きい順。キーが同じものは元の順（API が返した順）を保つ
const sortBy = <T,>(list: T[], key: SortKey<T>, reverse: boolean) => {
  const sorted = list.toSorted((a, b) => key(b) - key(a));
  return reverse ? sorted.toReversed() : sorted;
};

const usersIn = (loc: string) => instanceOf(loc)?.userCount ?? -1;

const FRIEND_SORTS = {
  default: ['既定', () => 0],
  cohabit: ['同居フレンド数', f => (inWorld(f) ? byLoc().get(f.location)!.length : 0)],
  users: ['インスタンス人数', f => (inWorld(f) ? usersIn(f.location) : -1)],
} satisfies Record<string, [string, SortKey<Friend>]>;
const INSTANCE_SORTS = {
  friends: ['フレンド数', loc => byLoc().get(loc)!.length],
  users: ['現在人数', usersIn],
} satisfies Record<string, [string, SortKey<string>]>;

function SortControl<K extends string>(p: { sorts: Record<K, [string, unknown]>; key: K; setKey: (k: K) => void; reverse: boolean; setReverse: (r: boolean) => void }) {
  return (
    <span>
      並び:{' '}
      <select value={p.key} onChange={e => p.setKey(e.currentTarget.value as K)}>
        <For each={Object.entries(p.sorts) as [K, [string, unknown]][]}>{([k, [label]]) => <option value={k}>{label}</option>}</For>
      </select>{' '}
      <label>
        <input type="checkbox" checked={p.reverse} onChange={e => p.setReverse(e.currentTarget.checked)} /> 逆順
      </label>
    </span>
  );
}

// インスタンスが見える人と private 等の人は別の行から並べる
function FriendSection(p: { title: string; list: Friend[]; sort: SortKey<Friend>; reverse: boolean }) {
  const grid = (list: () => Friend[]) => (
    <Show when={list().length}>
      <div class="grid">
        <For each={sortBy(list(), p.sort, p.reverse)}>{f => <FriendCard f={f} />}</For>
      </div>
    </Show>
  );
  return (
    <section>
      <h2>
        {p.title} ({p.list.length})
      </h2>
      {grid(() => p.list.filter(inWorld))}
      {grid(() => p.list.filter(f => !inWorld(f)))}
    </section>
  );
}

function FriendsTab() {
  const [favMode, setFavMode] = createSignal<'grouped' | 'mixed'>('grouped');
  const [key, setKey] = createSignal<keyof typeof FRIEND_SORTS>('default');
  const [reverse, setReverse] = createSignal(false);
  const favs = () => state.friends.filter(f => f.id in state.favTags);
  const sort = () => FRIEND_SORTS[key()][1];
  return (
    <>
      <div class="modes">
        お気に入り:
        <label>
          <input type="radio" name="favmode" checked={favMode() === 'grouped'} onChange={() => setFavMode('grouped')} /> グループ別
        </label>
        <label>
          <input type="radio" name="favmode" checked={favMode() === 'mixed'} onChange={() => setFavMode('mixed')} /> まとめて
        </label>
        <SortControl sorts={FRIEND_SORTS} key={key()} setKey={setKey} reverse={reverse()} setReverse={setReverse} />
      </div>
      <Show when={favMode() === 'grouped'} fallback={<FriendSection title="お気に入り" list={favs()} sort={sort()} reverse={reverse()} />}>
        <For each={state.favGroups}>
          {g => <FriendSection title={g.displayName} list={favs().filter(f => state.favTags[f.id]?.includes(g.name))} sort={sort()} reverse={reverse()} />}
        </For>
      </Show>
      <FriendSection title="その他のフレンド" list={state.friends.filter(f => !(f.id in state.favTags))} sort={sort()} reverse={reverse()} />
    </>
  );
}

function InstancesTab() {
  const [key, setKey] = createSignal<keyof typeof INSTANCE_SORTS>('friends');
  const [reverse, setReverse] = createSignal(false);
  const locs = () => sortBy([...byLoc().keys()], INSTANCE_SORTS[key()][1], reverse());
  const others = () => state.friends.filter(f => !inWorld(f));
  return (
    <>
      <div class="modes">
        <SortControl sorts={INSTANCE_SORTS} key={key()} setKey={setKey} reverse={reverse()} setReverse={setReverse} />
      </div>
      <div class="grid">
        <For each={locs()}>{loc => <InstanceCard loc={loc} />}</For>
      </div>
      <div class="others">
        <h2>private / その他 ({others().length})</h2>
        <div class="members">
          <For each={others()}>{f => <Member f={f} />}</For>
        </div>
      </div>
    </>
  );
}

export function App() {
  const [tab, setTab] = createSignal<'friends' | 'instances'>('friends');
  onMount(() => load().catch(e => setState('error', (e as Error).message)));
  const header = () =>
    state.me
      ? `${state.me} / オンライン ${state.friends.length} 人（お気に入り ${state.friends.filter(f => f.id in state.favTags).length} 人）/ インスタンス ${byLoc().size} か所`
      : '読み込み中…';
  return (
    <>
      <header>
        <Show when={state.loginRequired} fallback={state.error ? `エラー: ${state.error}` : header()}>
          未ログイン？{' '}
          <a href="https://vrchat.com/home/login" target="_blank">
            vrchat.com でログイン
          </a>{' '}
          ({state.error})
        </Show>
      </header>
      <nav>
        <button aria-pressed={tab() === 'friends'} onClick={() => setTab('friends')}>
          フレンド
        </button>
        <button aria-pressed={tab() === 'instances'} onClick={() => setTab('instances')}>
          インスタンス
        </button>
      </nav>
      <main>
        <Show when={tab() === 'friends'} fallback={<InstancesTab />}>
          <FriendsTab />
        </Show>
      </main>
    </>
  );
}
