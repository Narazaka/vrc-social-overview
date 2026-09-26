import { resolveElements } from '@solid-primitives/refs';
import { createListTransition } from '@solid-primitives/transition-group';
import { createEffect, createRoot, createSignal, onCleanup, untrack, type JSX } from 'solid-js';
import { motion } from './settings';
import { state } from './state';

// 並びが変わったとき（増減・並べ替え・移動）の見せ方。変化がどこで起きたか目で追えるようにするため。
// - 移動: 前の位置から今の位置へ滑らかに動かす（FLIP）
// - 出現: 真っ白から元の色へ
// - 消滅: 元の色から真っ黒へ沈めてから消す。消え終わるまでは元の場所に残り、周りはその後で詰まる
// 出入りは周りのカードが動くのに紛れないよう、動きではなく明るさで、移動より長く見せる。
// 一覧は数百件になるので、位置を測って動かすのは画面に見えている（近い）要素だけにする
const MOVE_DURATION = 300;
const ENTER_DURATION = 1200;
const EXIT_DURATION = 800;
// 白・黒は要素の上に重ねた板（CSS の [data-flash]::after）の不透明度で出す。filter で要素そのものの色を変えると
// 毎フレーム描き直しになり重い（GPU を使うゲームと同時だと引っかかる）が、不透明度だけなら描画の最後の合成で済む
function flash(el: Element, kind: 'enter' | 'exit', keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  const target = el as HTMLElement;
  target.dataset.flash = kind;
  target.animate(keyframes, { ...options, pseudoElement: '::after' });
  setTimeout(() => {
    if (target.dataset.flash === kind) delete target.dataset.flash;
  }, Number(options.duration));
}

// ページを開いて一覧がそろうまでは、出そろう様子を出現として見せない
const [settled, setSettled] = createSignal(false);
export { setSettled };

// まとめて取得している間（開いた直後・隠れていたページに戻った直後など）の変化は、取れるたびに動かすと
// 何秒も動き続けるので、1 回の変化としてまとめ、落ち着いてから最初の状態から最後の状態へ一度に動かす。
// フレンド 1 人の移動で起きる程度の取得（数件）ならその場で動かす
const BUSY_REQUESTS = 4;
// 隠れていたページに戻った直後は、溜まっていた変化の反映と取り直しが続くので、少し待ってからまとめて動かす。
// 戻った瞬間の反映（他の visibilitychange の処理）より先に待ちに入っているよう、隠れた時点から待ちにしておく
// （隠れている間は必ず待ちなので、動かしてよいかは待ちかどうかだけで決まる）
const RESUME_QUIET = 2000;
const [quiet, setQuiet] = createSignal(document.hidden);
let quietTimer: ReturnType<typeof setTimeout> | undefined;
document.addEventListener('visibilitychange', () => {
  clearTimeout(quietTimer);
  if (document.hidden) setQuiet(true);
  else quietTimer = setTimeout(() => setQuiet(false), RESUME_QUIET);
});
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
// 変化を見せる設定か（まとめて後で見せる場合も含む）
const wanted = () => settled() && motion() && !reducedMotion.matches;
// 今その場で動かしてよいか
export const canAnimate = () => wanted() && !quiet() && state.progress.total - state.progress.done <= BUSY_REQUESTS;

// まとめている一覧の、落ち着いたら動かす処理
const pendingBatches = new Set<() => void>();
createRoot(() =>
  createEffect(() => {
    if (!canAnimate()) return;
    const batches = [...pendingBatches];
    pendingBatches.clear();
    for (const run of batches) run();
  }),
);

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
  if (!el.isConnected || !onScreen(el)) return;
  el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1 }], ENTER_DURATION);
  flash(el, 'enter', [{ opacity: 1 }, { opacity: 0 }], { duration: ENTER_DURATION, easing: 'ease-in' });
}

function exit(el: Element, done: () => void) {
  // 消えかけの要素はもう操作させない
  (el as HTMLElement).style.pointerEvents = 'none';
  flash(el, 'exit', [{ opacity: 0 }, { opacity: 1, offset: 0.6 }, { opacity: 1 }], {
    duration: EXIT_DURATION,
    fill: 'forwards',
  });
  el.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], {
    duration: EXIT_DURATION,
    fill: 'forwards',
  });
  // 描画が止まっていてアニメーションが終わらなくても残らないよう、取り除くのはタイマーで決める
  setTimeout(done, EXIT_DURATION);
}

// ページ上の位置（スクロールしても変わらない）
type Point = { x: number; y: number };
const pagePos = (el: Element): Point => {
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY };
};

// 前の位置から今の位置へ動かす（動いている途中なら、それを止めてから今の位置を測る）
function moveFrom(el: Element, before: Point) {
  for (const a of el.getAnimations()) if (a.id === 'move') a.cancel();
  const now = pagePos(el);
  const dx = before.x - now.x;
  const dy = before.y - now.y;
  if (dx || dy)
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      id: 'move',
      duration: MOVE_DURATION,
      easing: 'ease-out',
    });
}

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

  // まとめている間の、最初の変化の前の位置と、その後に現れた要素
  let batchStart: Map<Element, Point> | undefined;
  let batchAdded = new Set<Element>();
  const runBatch = () => {
    const start = batchStart;
    const added = batchAdded;
    batchStart = undefined;
    batchAdded = new Set();
    pendingBatches.delete(runBatch);
    if (!start) return;
    for (const [el, before] of start) if (el.isConnected && visible.has(el)) moveFrom(el, before);
    for (const el of added) enter(el);
  };
  onCleanup(() => {
    pendingBatches.delete(runBatch);
    for (const el of watched) visibility.unobserve(el);
  });

  const list = createListTransition(source, {
    // 消える要素は元の並び位置に残す
    exitMethod: 'keep-index',
    onChange({ list, added, removed, finishRemoved }) {
      for (const el of added) watch(el);
      const finish = (el: Element) => {
        unwatch(el);
        finishRemoved([el]);
      };
      if (!untrack(wanted)) {
        for (const el of removed) finish(el);
        return;
      }
      const now = untrack(canAnimate);
      // 今は動かせないか、まとめている途中なら、まとめに加える（消えた要素はすぐ取り除き、まとめからも外す）
      if (!now || batchStart) {
        batchStart ??= new Map(list.filter(el => visible.has(el) && el.isConnected).map(el => [el, pagePos(el)]));
        for (const el of added) batchAdded.add(el);
        for (const el of removed) {
          batchStart.delete(el);
          batchAdded.delete(el);
          finish(el);
        }
        if (now) queueMicrotask(runBatch);
        else pendingBatches.add(runBatch);
        return;
      }
      for (const el of removed) {
        if (visible.has(el)) exit(el, () => finish(el));
        else finish(el);
      }
      // 変わる前の位置（動いている途中なら今見えている位置）を、見えている要素だけ測っておく
      const moving = list.filter(el => visible.has(el) && el.isConnected).map(el => [el, pagePos(el)] as const);
      // DOM が新しい並びになってから、差の分だけ前の位置から動かす
      queueMicrotask(() => {
        for (const [el, before] of moving) moveFrom(el, before);
        for (const el of added) enter(el);
      });
    },
  });
  return <>{list()}</>;
}
