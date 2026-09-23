import { createSignal } from 'solid-js';

// 表示設定は開き直しても保たれるよう保存する。allowed を渡すと、保存値が今は無い選択肢なら既定値に戻す
export function persisted<T extends string | boolean>(name: string, initial: T, allowed?: readonly T[]) {
  const key = `setting:${name}`;
  let value = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const v = JSON.parse(raw) as T;
      if (typeof v === typeof initial && (!allowed || allowed.includes(v))) value = v;
    }
  } catch {
    // 読めなければ既定値を使う
  }
  const [get, set] = createSignal<T>(value);
  const save = (v: T) => {
    set(() => v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // 保存できなくても切り替え自体はできる
    }
  };
  return [get, save] as const;
}
