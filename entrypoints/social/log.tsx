import { For, Show } from 'solid-js';
import { instanceType, worldIdOf } from '@/lib/vrchat';
import { favClass, openDrawer, state, worldOf, type LogEntry } from './state';

const EVENT_LABEL: Record<string, string> = {
  'friend-online': 'オンライン',
  'friend-location': '移動',
  'friend-active': 'Web・モバイル',
  'friend-offline': 'オフライン',
  'friend-update': '更新',
  'friend-add': 'フレンド追加',
  'friend-delete': 'フレンド解除',
};

const time = (at: number) => new Date(at).toLocaleTimeString('ja-JP');

function Place(p: { loc: string }) {
  return (
    <Show
      when={p.loc.startsWith('wrld_')}
      fallback={<span class="meta">{p.loc === 'traveling' ? '✈️ 移動中' : p.loc}</span>}
    >
      <span class={`badge ${instanceType(p.loc)[1]}`}>{instanceType(p.loc)[0]}</span>{' '}
      <span class="clickable" onClick={() => openDrawer(worldIdOf(p.loc))}>
        {worldOf(p.loc)?.name ?? worldIdOf(p.loc)}
      </span>
    </Show>
  );
}

function Row(p: { e: LogEntry }) {
  return (
    <div class={`log-row ev-${p.e.type}`}>
      <span class="meta">{time(p.e.at)}</span>
      <span class="ev">{EVENT_LABEL[p.e.type] ?? p.e.type}</span>
      <span class={`clickable ${favClass(p.e.userId)}`} onClick={() => openDrawer(p.e.userId)}>
        {p.e.name}
      </span>
      <span>
        <Show when={p.e.loc}>{loc => <Place loc={loc()} />}</Show>
        {p.e.text}
      </span>
    </div>
  );
}

// Pipeline で受け取ったイベントを新しい順に出す
export function LogTab() {
  return (
    <Show when={state.eventLog.length} fallback={<p class="meta">まだイベントを受け取っていません。</p>}>
      <div class="log">
        <For each={state.eventLog}>{e => <Row e={e} />}</For>
      </div>
    </Show>
  );
}
