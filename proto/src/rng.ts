// 決定論的乱数（mulberry32）。世界のseedから一本通す。

export interface Rng {
  next(): number;               // [0,1)
  pick<T>(arr: T[]): T;
  int(maxExclusive: number): number;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick<T>(arr: T[]): T {
      if (arr.length === 0) throw new Error("pick from empty array");
      return arr[Math.floor(next() * arr.length)];
    },
    int(maxExclusive: number): number {
      return Math.floor(next() * maxExclusive);
    },
  };
}
