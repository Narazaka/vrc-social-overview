import { onCleanup, onMount, Show, type JSX } from 'solid-js';
import { UserProfile } from './profile';
import { drawerId, setDrawerId } from './state';
import { WorldInfo } from './world';

// ユーザーやワールドは常時は詳しく出さず、クリックしたときだけ取得して右側のパネルに出す
const close = () => setDrawerId(undefined);

export function Drawer() {
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => document.removeEventListener('keydown', onKey));

  return (
    <Show when={drawerId()}>
      {id => (
        <div class="drawer-backdrop" onClick={close}>
          <aside class="drawer" onClick={e => e.stopPropagation()}>
            <button class="drawer-close" title="閉じる" onClick={close}>
              ×
            </button>
            <Show when={id().startsWith('wrld_')} fallback={<UserProfile id={id()} />}>
              <WorldInfo id={id()} />
            </Show>
          </aside>
        </div>
      )}
    </Show>
  );
}

// 取得中・失敗時の表示。読み込み中は前に開いたものの結果が残るので中身を出さない
export function Loaded<T>(p: {
  data: { (): T | undefined; loading: boolean; error: unknown };
  children: (d: () => T) => JSX.Element;
}) {
  return (
    <Show when={!p.data.error} fallback={<p class="meta">取得できませんでした（{String(p.data.error)}）</p>}>
      <Show when={!p.data.loading && p.data()} fallback={<p class="meta">読み込み中…</p>}>
        {d => p.children(d as () => T)}
      </Show>
    </Show>
  );
}

// 本文中のリンクは http(s) のものだけリンクにする
export const safeUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : undefined;
  } catch {
    return undefined;
  }
};
