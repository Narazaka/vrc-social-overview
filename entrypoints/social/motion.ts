import { createSignal, onCleanup } from 'solid-js';
import { animationsOn } from './settings';

// 並びが変わったとき（増減・並べ替え・移動）に、各要素を前の位置から今の位置へ滑らかに動かし（FLIP）、
// 新しく現れた要素は真っ白から元の色へ、消えた要素は元の色から真っ黒へ変えてから消す。変化がどこで起きたか目で追えるようにするため。
// 出入りは周りのカードが動くのに紛れないよう、動きではなく明るさで、移動より長く見せる。
// 前の位置は、前回の変化の直後と、入れ物の大きさが変わったとき（折り返し位置の変化など）に測っておく
const REORDER_DURATION = 300;
const ENTER_EXIT_DURATION = 1200;
type Box = { x: number; y: number; w: number; h: number };
// コントラストを 0 にすると一面の灰色になり、そこから明るさで真っ白・真っ黒にできる
const NORMAL = 'contrast(1) brightness(1)';
const WHITE = 'contrast(0) brightness(2)';
const BLACK = 'contrast(0) brightness(0)';

// 消えた要素の複製を、消える前にあった位置へ重ねて黒く沈めてから消す（元の要素はもう DOM から外れている）
function fadeOutGhost(el: Element, at: Box) {
  const ghost = el.cloneNode(true) as HTMLElement;
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${at.x}px`,
    top: `${at.y}px`,
    width: `${at.w}px`,
    height: `${at.h}px`,
    margin: '0',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: '5',
  });
  document.body.append(ghost);
  ghost.animate(
    [
      { filter: NORMAL, opacity: 1 },
      { filter: BLACK, opacity: 1, offset: 0.6 },
      { filter: BLACK, opacity: 0 },
    ],
    ENTER_EXIT_DURATION,
  );
  // 描画が止まっていてアニメーションが終わらなくても残らないよう、終わりはタイマーで決める
  setTimeout(() => ghost.remove(), ENTER_EXIT_DURATION);
}

// ページを開いて一覧がそろうまでは、出そろう様子を出現として見せない
const [settled, setSettled] = createSignal(false);
export { setSettled };

export function animateReorder(container: HTMLElement) {
  let last = new Map<Element, Box>();
  // 入れ物が作られた直後に中身が入るのは出現ではないので、作られた処理が終わってからの変化だけを見せる
  let shown = false;
  setTimeout(() => (shown = true));
  const measure = () => {
    const base = container.getBoundingClientRect();
    last = new Map(
      [...container.children].map(el => {
        const r = el.getBoundingClientRect();
        return [el, { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }];
      }),
    );
  };
  // 画面外の要素は動かさない（数百枚あっても見えている分だけで済ませる）
  const onScreen = (y: number, h: number) => y < innerHeight && y + h > 0;
  const mutations = new MutationObserver(() => {
    const prev = last;
    // 動いている途中の要素は、その変位を含めずに今の位置を測る（出現の明るさの変化はそのまま続ける）
    for (const el of container.children) for (const a of el.getAnimations()) if (a.id === 'move') a.cancel();
    measure();
    if (!shown || !settled() || !animationsOn()) return;
    const base = container.getBoundingClientRect();
    for (const [el, before] of prev)
      if (!last.has(el) && onScreen(base.top + before.y, before.h))
        fadeOutGhost(el, { ...before, x: base.left + before.x, y: base.top + before.y });
    for (const [el, now] of last) {
      if (!onScreen(base.top + now.y, now.h)) continue;
      const before = prev.get(el);
      if (!before)
        el.animate([{ filter: WHITE }, { filter: NORMAL }], { duration: ENTER_EXIT_DURATION, easing: 'ease-in' });
      else if (before.x !== now.x || before.y !== now.y)
        el.animate([{ transform: `translate(${before.x - now.x}px, ${before.y - now.y}px)` }, { transform: 'none' }], {
          id: 'move',
          duration: REORDER_DURATION,
          easing: 'ease-out',
        });
    }
  });
  mutations.observe(container, { childList: true });
  // 最初に表示されたときにも呼ばれるので、最初の位置もここで測る
  const resize = new ResizeObserver(measure);
  resize.observe(container);
  onCleanup(() => {
    mutations.disconnect();
    resize.disconnect();
  });
}
