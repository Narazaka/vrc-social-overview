import { resolveElements } from '@solid-primitives/refs';
import { createListTransition } from '@solid-primitives/transition-group';
import { createSignal, onCleanup, untrack, type JSX } from 'solid-js';
import { animationsOn } from './settings';

// 並びが変わったとき（増減・並べ替え・移動）の見せ方。変化がどこで起きたか目で追えるようにするため。
// - 移動: 前の位置から今の位置へ滑らかに動かす（FLIP）
// - 出現: 真っ白から元の色へ
// - 消滅: 元の色から真っ黒へ沈めてから消す。消え終わるまでは元の場所に残り、周りはその後で詰まる
// 出入りは周りのカードが動くのに紛れないよう、動きではなく明るさで、移動より長く見せる。
// 一覧は数百件になるので、位置を測って動かすのは画面に見えている（近い）要素だけにする
const MOVE_DURATION = 300;
const ENTER_DURATION = 1200;
const EXIT_DURATION = 800;
// コントラストを 0 にすると一面の灰色になり、そこから明るさで真っ白・真っ黒にできる
const NORMAL = 'contrast(1) brightness(1)';
const WHITE = 'contrast(0) brightness(2)';
const BLACK = 'contrast(0) brightness(0)';

// ページを開いて一覧がそろうまでは、出そろう様子を出現として見せない
const [settled, setSettled] = createSignal(false);
export { setSettled };

// 画面に見えている（近い）要素。全一覧で 1 つの監視を共有する
const visible = new WeakSet<Element>();
const visibility = new IntersectionObserver(
  entries => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target);
      else visible.delete(e.target);
    }
  },
  { rootMargin: '200px' },
);

const onScreen = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight;
};

function enter(el: Element) {
  if (!onScreen(el)) return;
  el.animate(
    [
      { filter: WHITE, opacity: 0 },
      { filter: WHITE, opacity: 1, offset: 0.1 },
      { filter: NORMAL, opacity: 1 },
    ],
    { duration: ENTER_DURATION, easing: 'ease-in' },
  );
}

function exit(el: Element, done: () => void) {
  // 消えかけの要素はもう操作させない
  (el as HTMLElement).style.pointerEvents = 'none';
  el.animate(
    [
      { filter: NORMAL, opacity: 1 },
      { filter: BLACK, opacity: 1, offset: 0.6 },
      { filter: BLACK, opacity: 0 },
    ],
    { duration: EXIT_DURATION, fill: 'forwards' },
  );
  // 描画が止まっていてアニメーションが終わらなくても残らないよう、取り除くのはタイマーで決める
  setTimeout(done, EXIT_DURATION);
}

const cancelMove = (el: Element) => {
  for (const a of el.getAnimations()) if (a.id === 'move') a.cancel();
};

// 中の一覧（For など）の並びの変化をアニメーションで見せる。子は要素であること
export function Reorder(p: { children: JSX.Element }) {
  const source = resolveElements(() => p.children).toArray;
  const watched = new Set<Element>();
  const watch = (el: Element) => {
    if (watched.has(el)) return;
    watched.add(el);
    visibility.observe(el);
  };
  const unwatch = (el: Element) => {
    watched.delete(el);
    visible.delete(el);
    visibility.unobserve(el);
  };
  for (const el of untrack(source)) watch(el);
  onCleanup(() => {
    for (const el of watched) visibility.unobserve(el);
  });

  const list = createListTransition(source, {
    // 消える要素は元の並び位置に残す
    exitMethod: 'keep-index',
    onChange({ list, added, removed, finishRemoved }) {
      const on = settled() && animationsOn();
      for (const el of added) watch(el);
      for (const el of removed) {
        const finish = () => {
          unwatch(el);
          finishRemoved([el]);
        };
        if (on && visible.has(el)) exit(el, finish);
        else finish();
      }
      if (!on) return;
      // 変わる前の位置（動いている途中なら今見えている位置）を、見えている要素だけ測っておく
      const moving = list
        .filter(el => visible.has(el) && el.isConnected)
        .map(el => ({ el, before: el.getBoundingClientRect() }));
      // DOM が新しい並びになってから、差の分だけ前の位置から動かす
      queueMicrotask(() => {
        for (const { el } of moving) cancelMove(el);
        for (const { el, before } of moving) {
          const now = el.getBoundingClientRect();
          const dx = before.left - now.left;
          const dy = before.top - now.top;
          if (dx || dy)
            el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
              id: 'move',
              duration: MOVE_DURATION,
              easing: 'ease-out',
            });
        }
        for (const el of added) enter(el);
      });
    },
  });
  return <>{list()}</>;
}
