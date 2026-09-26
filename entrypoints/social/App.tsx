import { createEffect, createMemo, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { img, inPrivate, inWorld, outsideGame, ownerIdOf, type Friend } from '@/lib/vrchat';
import { FriendCard, Img, InstanceCard, Member } from './cards';
import { LogTab } from './log';
import { Drawer } from './drawer';
import { Reorder, setSettled } from './motion';
import { motion, persisted, setMotion } from './settings';
import {
  byLoc,
  instanceOf,
  load,
  loadGroupInstances,
  openDrawer,
  ownerOf,
  setCountsForAll,
  setState,
  state,
  worldOf,
} from './state';

type SortKey<T> = (x: T) => number | string;
// 並びの条件（キーと逆順かどうか）を優先順に並べたもの
type SortSpec<T> = [SortKey<T>, boolean][];

// 数値は大きい順、文字列は名前順（数字は数値として比べる）
const collator = new Intl.Collator('ja', { numeric: true });
const compare = (a: number | string, b: number | string) =>
  typeof a === 'string' && typeof b === 'string' ? collator.compare(a, b) : Number(b) - Number(a);
// 前の条件で同じだったものだけ次の条件で比べる。どの条件でも同じものは元の順（API が返した順）を保つ
const sortBy = <T,>(list: T[], specs: SortSpec<T>) =>
  list.toSorted((a, b) => {
    for (const [key, reverse] of specs) {
      const c = compare(key(a), key(b));
      if (c) return reverse ? -c : c;
    }
    return 0;
  });

const usersIn = (loc: string) => instanceOf(loc)?.userCount ?? -1;
// ワールド情報がまだ無いものは名前順の最後に回す
const worldNameOf = (loc: string) => worldOf(loc)?.name ?? '\uffff';

const FRIEND_SORTS = {
  default: ['既定', () => 0],
  cohabit: ['同居フレンド数', f => (inWorld(f) ? byLoc().get(f.location)!.length : 0)],
  users: ['インスタンス人数', f => (inWorld(f) ? usersIn(f.location) : -1)],
  // ページを開いてから移動・オンラインになった順。開いた時点の居場所に居続けている人は後ろ
  moved: ['最近の移動', f => state.movedAt[f.id] ?? 0],
  name: ['名前', f => f.displayName],
  world: ['ワールド名', f => (inWorld(f) ? worldNameOf(f.location) : '')],
} satisfies Record<string, [string, SortKey<Friend>]>;
const INSTANCE_SORTS = {
  friends: ['フレンド数', loc => byLoc().get(loc)!.length],
  users: ['現在人数', usersIn],
  world: ['ワールド名', worldNameOf],
} satisfies Record<string, [string, SortKey<string>]>;
// グループタブ（グループの中のインスタンスの並び）
const GROUP_SORTS = {
  users: ['現在人数', usersIn],
  world: ['ワールド名', worldNameOf],
} satisfies Record<string, [string, SortKey<string>]>;

const keysOf = <K extends string>(o: Record<K, unknown>) => Object.keys(o) as K[];

// 表示設定（開き直しても保つ）
const [tab, setTab] = persisted<'friends' | 'instances' | 'groups' | 'log'>('tab', 'friends', [
  'friends',
  'instances',
  'groups',
  'log',
]);
// ゲーム外（Web・モバイル）のフレンドを別の行に分けて出すか、隠すか
const [outsideMode, setOutsideMode] = persisted<'separate' | 'hidden'>('outsideMode', 'separate', [
  'separate',
  'hidden',
]);
const showOutside = () => outsideMode() === 'separate';
// 配色。自動は OS の設定に従う
const THEMES = { dark: 'ダーク', light: 'ライト', system: '自動' };
const [theme, setTheme] = persisted('theme', 'dark', keysOf(THEMES));
const [favMode, setFavMode] = persisted<'grouped' | 'mixed'>('favMode', 'grouped', ['grouped', 'mixed']);

// 操作部品。選択肢はラジオボタンではなく並べたボタンにし、見た目と操作をそろえる
// 選択肢を並べて 1 クリックで切り替えられるようにする（options の値は表示名、または先頭が表示名の配列）。disabled の選択肢は選べない
function Segmented<K extends string>(p: {
  options: Record<K, string | readonly [string, ...unknown[]]>;
  value: K;
  set: (k: K) => void;
  disabled?: string;
}) {
  return (
    <span class="seg">
      <For each={keysOf(p.options)}>
        {k => {
          const o = p.options[k];
          return (
            <button aria-pressed={p.value === k} disabled={p.disabled === k} onClick={() => p.set(k)}>
              {typeof o === 'string' ? o : o[0]}
            </button>
          );
        }}
      </For>
    </span>
  );
}

const Toggle = (p: { value: boolean; set: (v: boolean) => void; title?: string; children: JSX.Element }) => (
  <button class="toggle" aria-pressed={p.value} title={p.title} onClick={() => p.set(!p.value)}>
    {p.children}
  </button>
);

// 見出し付きの操作のまとまり
const Ctl = (p: { label: string; children: JSX.Element }) => (
  <span class="ctl">
    <span class="ctl-label">{p.label}</span>
    {p.children}
  </span>
);

// 並びの設定。第 1 条件で同じだったものを第 2 条件で並べ、それぞれ逆順にできる（開き直しても保つ）
function sortSetting<T, K extends string>(name: string, sorts: Record<K, [string, SortKey<T>]>, initial: NoInfer<K>) {
  const keys = keysOf(sorts);
  const [key, setKey] = persisted<K>(`${name}Sort`, initial, keys);
  const [reverse, setReverse] = persisted<boolean>(`${name}Reverse`, false);
  const [key2, setKey2] = persisted<K | 'none'>(`${name}Sort2`, 'none', ['none', ...keys]);
  const [reverse2, setReverse2] = persisted<boolean>(`${name}Reverse2`, false);
  const second = () => {
    const k = key2();
    return k === 'none' || k === key() ? undefined : k;
  };
  const specs = (): SortSpec<T> => {
    const k = second();
    return [[sorts[key()][1], reverse()], ...(k ? [[sorts[k][1], reverse2()] as [SortKey<T>, boolean]] : [])];
  };
  const secondOptions = { none: 'なし', ...sorts } as Record<K | 'none', string | [string, SortKey<T>]>;
  const Control = () => (
    <>
      <Ctl label="並び">
        <Segmented options={sorts} value={key()} set={setKey} />
        <Toggle value={reverse()} set={setReverse}>
          逆順
        </Toggle>
      </Ctl>
      <Ctl label="次に">
        <Segmented options={secondOptions} value={second() ?? 'none'} set={setKey2} disabled={key()} />
        <Show when={second()}>
          <Toggle value={reverse2()} set={setReverse2}>
            逆順
          </Toggle>
        </Show>
      </Ctl>
    </>
  );
  // 第 1・第 2 条件のどちらかに使っているか
  const uses = (k: K) => key() === k || second() === k;
  return { specs, Control, uses };
}
const friendSort = sortSetting('friend', FRIEND_SORTS, 'default');
const instanceSort = sortSetting('instance', INSTANCE_SORTS, 'friends');
const groupSort = sortSetting('group', GROUP_SORTS, 'users');

// ワールドにいる人・ゲーム内で private の人・ゲーム外（Web・モバイル）の人は別の行から並べる
function FriendSection(p: { title: string; group?: string; list: Friend[] }) {
  const visible = () => (showOutside() ? p.list : p.list.filter(f => !outsideGame(f)));
  // 空になっても入れ物は残す（最初の 1 枚が入ったときも出現として見せるため。空の間は CSS で詰める）
  const grid = (list: () => Friend[]) => (
    <div class="grid">
      <Reorder>
        <For each={sortBy(list(), friendSort.specs())}>{f => <FriendCard f={f} />}</For>
      </Reorder>
    </div>
  );
  return (
    <section>
      <h2 class={p.group ? `fav-${p.group}` : undefined}>
        {p.title} ({visible().length})
      </h2>
      {grid(() => p.list.filter(inWorld))}
      {grid(() => p.list.filter(inPrivate))}
      <Show when={showOutside()}>{grid(() => p.list.filter(outsideGame))}</Show>
    </section>
  );
}

function FriendsTab() {
  const favs = () => state.friends.filter(f => f.id in state.favTags);
  return (
    <>
      <div class="modes">
        <Ctl label="お気に入り">
          <Segmented options={{ grouped: 'グループ別', mixed: 'まとめて' }} value={favMode()} set={setFavMode} />
        </Ctl>
        <friendSort.Control />
      </div>
      <Show when={favMode() === 'grouped'} fallback={<FriendSection title="お気に入り" list={favs()} />}>
        <For each={state.favGroups}>
          {g => (
            <FriendSection
              title={g.displayName}
              group={g.name}
              list={favs().filter(f => state.favTags[f.id]?.includes(g.name))}
            />
          )}
        </For>
      </Show>
      <FriendSection title="その他のフレンド" list={state.friends.filter(f => !(f.id in state.favTags))} />
    </>
  );
}

function InstancesTab() {
  const locs = () => sortBy([...byLoc().keys()], instanceSort.specs());
  const privates = () => state.friends.filter(inPrivate);
  const outside = () => state.friends.filter(outsideGame);
  return (
    <>
      <div class="modes">
        <instanceSort.Control />
      </div>
      <div class="grid">
        <Reorder>
          <For each={locs()}>{loc => <InstanceCard loc={loc} />}</For>
        </Reorder>
      </div>
      <div class="others">
        <h2>private ({privates().length})</h2>
        <div class="members">
          <Reorder>
            <For each={privates()}>{f => <Member f={f} />}</For>
          </Reorder>
        </div>
        <Show when={showOutside()}>
          <h2>Web・モバイル ({outside().length})</h2>
          <div class="members outside">
            <Reorder>
              <For each={outside()}>{f => <Member f={f} />}</For>
            </Reorder>
          </div>
        </Show>
      </div>
    </>
  );
}

// グループのインスタンスの変化は Pipeline では届かないので、開き直したとき（前回から 1 分以上経っていれば）と、
// 開いている間は 5 分ごと（ページが隠れている間は除く）に取り直す
const GROUP_REOPEN_REFRESH = 60 * 1000;
const GROUP_AUTO_REFRESH = 5 * 60 * 1000;

function GroupsTab() {
  // ログイン直後に開いていた場合は自分の情報が取れてから取る
  createEffect(() => {
    if (state.me) void loadGroupInstances(GROUP_REOPEN_REFRESH);
  });
  const timer = setInterval(() => {
    if (!document.hidden) void loadGroupInstances(GROUP_AUTO_REFRESH);
  }, 60 * 1000);
  onCleanup(() => clearInterval(timer));
  return (
    <>
      <div class="modes">
        <button
          class="refresh"
          disabled={state.groupInstancesLoading || !state.me}
          onClick={() => void loadGroupInstances(0)}
        >
          {state.groupInstancesLoading ? '更新中…' : '更新'}
        </button>
        <groupSort.Control />
        <Show when={state.groupInstancesAt}>
          {at => (
            <span class="updated">
              最終更新 {new Date(at()).toLocaleTimeString()}（開いている間は 5 分ごとに自動更新）
            </span>
          )}
        </Show>
      </div>
      <GroupList />
    </>
  );
}

// 加入しているグループのインスタンスを、グループごとに人数の多い順で並べる
function GroupList() {
  const usersOf = (locs: string[]) => locs.reduce((n, loc) => n + Math.max(usersIn(loc), 0), 0);
  const locsOf = (groupId: string) =>
    sortBy(
      (state.groupInstances ?? []).filter(loc => ownerIdOf(loc) === groupId),
      groupSort.specs(),
    );
  const groups = createMemo(() =>
    [...new Set((state.groupInstances ?? []).map(loc => ownerIdOf(loc)!))].toSorted(
      (a, b) => usersOf(locsOf(b)) - usersOf(locsOf(a)),
    ),
  );
  return (
    <Show when={state.groupInstances} fallback={<p class="empty">読み込み中…</p>}>
      <Show when={groups().length} fallback={<p class="empty">加入しているグループのインスタンスはありません</p>}>
        <For each={groups()}>
          {groupId => (
            <section>
              <h2 class="group-title clickable" onClick={() => openDrawer(groupId)}>
                <Img src={img(ownerOf(groupId)?.image, 64)} />
                {ownerOf(groupId)?.name ?? groupId} ({locsOf(groupId).length})
              </h2>
              <div class="grid">
                <Reorder>
                  <For each={locsOf(groupId)}>{loc => <InstanceCard loc={loc} />}</For>
                </Reorder>
              </div>
            </section>
          )}
        </For>
      </Show>
    </Show>
  );
}

export function App() {
  onMount(() =>
    load()
      .then(() => setTimeout(() => setSettled(true), 1000))
      .catch(e => setState('error', (e as Error).message)),
  );
  createEffect(() => {
    const root = document.documentElement;
    if (theme() === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme();
  });
  // 表示中のタブがインスタンスの人数で並べているときは、画面の外のインスタンスの人数も取る
  // （グループタブはグループのインスタンスの取得で全部の人数が分かる）
  createEffect(() =>
    setCountsForAll(
      (tab() === 'friends' && friendSort.uses('users')) || (tab() === 'instances' && instanceSort.uses('users')),
    ),
  );
  const loading = () => state.progress.done < state.progress.total;
  const header = () => {
    if (!state.me) return '読み込み中…';
    if (!state.friends.length) return `${state.me} / フレンド一覧を取得中…`;
    const outside = state.friends.filter(outsideGame).length;
    const favs = state.friends.filter(f => f.id in state.favTags).length;
    return `${state.me} / オンライン ${state.friends.length} 人（ゲーム内 ${state.friends.length - outside} / Web・モバイル ${outside}、お気に入り ${favs}）/ インスタンス ${byLoc().size} か所`;
  };
  return (
    <>
      <Show when={state.loginRequired}>
        <div class="login-required">
          <p class="headline">VRChat にログインしていません</p>
          <p>vrchat.com でログインしてから、このページを再読み込みしてください。</p>
          <p>
            <a class="button primary" href="https://vrchat.com/home/login" target="_blank">
              vrchat.com でログイン
            </a>
            <button class="button" onClick={() => location.reload()}>
              再読み込み
            </button>
          </p>
          <p class="detail">{state.error}</p>
          <div class="notice">
            <p class="notice-title">⚠ VRC Social Overview は VRChat の非公式ツールです</p>
            <p>VRChat Inc. とは関係がなく、承認も受けていません。</p>
            <p>ログイン情報を本拡張に入力することはありません。vrchat.com のログイン状態をそのまま使います。</p>
          </div>
        </div>
      </Show>
      <Show when={!state.loginRequired}>
        <header>
          {state.error ? `エラー: ${state.error}` : header()}
          <Show when={state.live !== undefined}>
            <span class="live" classList={{ on: state.live }}>
              {state.live ? ' ● リアルタイム更新中' : ' ○ 再接続中…'}
            </span>
          </Show>
          <Show when={loading()}>
            <span class="progress-text">
              {' '}
              / 取得中 {state.progress.done} / {state.progress.total}
            </span>
          </Show>
        </header>
        <div class="progress" classList={{ active: loading() }}>
          <i style={{ width: `${(state.progress.done / Math.max(state.progress.total, 1)) * 100}%` }} />
        </div>
        <nav>
          <button aria-pressed={tab() === 'friends'} onClick={() => setTab('friends')}>
            フレンド
          </button>
          <button aria-pressed={tab() === 'instances'} onClick={() => setTab('instances')}>
            インスタンス
          </button>
          <button aria-pressed={tab() === 'groups'} onClick={() => setTab('groups')}>
            グループ
          </button>
          <button aria-pressed={tab() === 'log'} onClick={() => setTab('log')}>
            イベント ({state.eventLog.length})
          </button>
          <span class="nav-settings">
            <Ctl label="Web・モバイルのフレンド">
              <Segmented
                options={{ separate: '分けて表示', hidden: '非表示' }}
                value={outsideMode()}
                set={setOutsideMode}
              />
            </Ctl>
            <Toggle value={motion()} set={setMotion} title="並びの入れ替わりや人数の増減をアニメーションで見せる">
              変化のアニメーション
            </Toggle>
            <Ctl label="テーマ">
              <Segmented options={THEMES} value={theme()} set={setTheme} />
            </Ctl>
          </span>
        </nav>
        <main>
          <Show when={tab() === 'friends'}>
            <FriendsTab />
          </Show>
          <Show when={tab() === 'instances'}>
            <InstancesTab />
          </Show>
          <Show when={tab() === 'groups'}>
            <GroupsTab />
          </Show>
          <Show when={tab() === 'log'}>
            <LogTab />
          </Show>
        </main>
        <Drawer />
      </Show>
    </>
  );
}
