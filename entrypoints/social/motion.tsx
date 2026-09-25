import { createSignal, type JSX } from 'solid-js';
import { TransitionGroup } from 'solid-transition-group';
import { animationsOn } from './settings';

// 並びが変わったとき（増減・並べ替え・移動）の見せ方。変化がどこで起きたか目で追えるようにするため。
// - 移動: 前の位置から今の位置へ滑らかに動かす（CSS の .reorder-move）
// - 出現: 真っ白から元の色へ
// - 消滅: 元の色から真っ黒へ沈めてから消す。消え終わるまでは元の場所に残り、周りはその後で詰まる
// 出入りは周りのカードが動くのに紛れないよう、動きではなく明るさで、移動より長く見せる
const ENTER_DURATION = 1200;
const EXIT_DURATION = 800;
// コントラストを 0 にすると一面の灰色になり、そこから明るさで真っ白・真っ黒にできる
const NORMAL = 'contrast(1) brightness(1)';
const WHITE = 'contrast(0) brightness(2)';
const BLACK = 'contrast(0) brightness(0)';

// ページを開いて一覧がそろうまでは、出そろう様子を出現として見せない
const [settled, setSettled] = createSignal(false);
export { setSettled };

// 画面外の要素は動かさない（数百枚あっても見えている分だけで済ませる）
const onScreen = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight;
};

function enter(el: Element, done: () => void) {
  if (settled() && animationsOn() && onScreen(el))
    el.animate(
      [
        { filter: WHITE, opacity: 0 },
        { filter: WHITE, opacity: 1, offset: 0.1 },
        { filter: NORMAL, opacity: 1 },
      ],
      { duration: ENTER_DURATION, easing: 'ease-in' },
    );
  done();
}

function exit(el: Element, done: () => void) {
  if (!animationsOn() || !onScreen(el)) return done();
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

// 中の一覧（For など）の並びの変化をアニメーションで見せる。子は要素であること
export const Reorder = (p: { children: JSX.Element }) => (
  <TransitionGroup moveClass="reorder-move" onEnter={enter} onExit={exit}>
    {p.children}
  </TransitionGroup>
);
