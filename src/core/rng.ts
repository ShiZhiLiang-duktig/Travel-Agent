/**
 * 种子化伪随机数生成器 —— 与 CPython 的 random.Random 字节级对齐。
 *
 * 为什么要和 CPython 对齐：韧性压力测试的扰动集由 seed=42 采样生成，
 * 回归门禁要求 TS 版与 Python 版产出完全相同的 target_poi_ids
 * （否则 "rain" 扰动可能命不中行程里的 s10，导致 changed_count=0，门禁挂掉）。
 *
 * 实现的是标准 MT19937（32-bit），genrand_int32 / random() / getrandbits
 * 均与 CPython Modules/_randommodule.c 一致。
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

function mul32(a: number, b: number): number {
  // 32-bit 无符号乘法：用低 16 位拆分避免精度丢失
  const ah = (a >>> 16) & 0xffff;
  const al = a & 0xffff;
  const bh = (b >>> 16) & 0xffff;
  const bl = b & 0xffff;
  return (((ah * bl + al * bh) << 16) >>> 0) + (al * bl);
}

export class PyRandom {
  private mt: Uint32Array;
  private mti: number;

  constructor(seed: number) {
    this.mt = new Uint32Array(N);
    this.mti = N;
    // CPython 对整数 seed 走 init_by_array（把整数拆成 32-bit 字数组）。
    // 小整数就是单元素数组 [seed]。
    this.seedByArray([seed >>> 0]);
  }

  /** 单整数种子初始化（参考实现 init_genrand）。 */
  initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = this.mt[i - 1];
      this.mt[i] = (mul32(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.mti = N;
  }

  /** 数组种子初始化（参考实现 init_by_array）。 */
  seedByArray(initKey: number[]): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    const keyLen = initKey.length;
    let k = Math.max(N, keyLen);
    for (; k > 0; k--) {
      const prev = this.mt[i - 1];
      this.mt[i] =
        ((this.mt[i] ^ mul32(prev ^ (prev >>> 30), 1664525)) + (initKey[j] >>> 0) + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
      if (j >= keyLen) j = 0;
    }
    for (k = N - 1; k > 0; k--) {
      const prev = this.mt[i - 1];
      this.mt[i] =
        ((this.mt[i] ^ mul32(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
    this.mti = N;
  }

  /** 生成一个 32-bit 无符号整数（CPython genrand_int32）。 */
  nextUint32(): number {
    if (this.mti >= N) this.twist();
    let y = this.mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  private twist(): void {
    const mag01 = [0, MATRIX_A];
    let kk = 0;
    for (; kk < N - M; kk++) {
      const y = (this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK);
      this.mt[kk] = this.mt[kk + M] ^ (y >>> 1) ^ mag01[y & 1];
    }
    for (; kk < N - 1; kk++) {
      const y = (this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK);
      this.mt[kk] = this.mt[kk + (M - N)] ^ (y >>> 1) ^ mag01[y & 1];
    }
    const y = (this.mt[N - 1] & UPPER_MASK) | (this.mt[0] & LOWER_MASK);
    this.mt[N - 1] = this.mt[M - 1] ^ (y >>> 1) ^ mag01[y & 1];
    this.mti = 0;
  }

  /** CPython getrandbits(k)：取下一个 32-bit 字的高 k 位（1 <= k <= 32）。 */
  getrandbits(k: number): number {
    if (k <= 0) return 0;
    if (k >= 32) return this.nextUint32();
    return this.nextUint32() >>> (32 - k);
  }

  /** CPython _randbelow(n)：返回 [0, n) 的整数，拒绝采样。 */
  randbelow(n: number): number {
    if (n <= 0) return 0;
    const k = bitLength(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** CPython random()：[0,1) 双精度（genrand_res53）。 */
  random(): number {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** CPython random.sample：k 个不重复采样。与 CPython 3.13 算法一致。 */
  sample<T>(population: T[], k: number): T[] {
    const n = population.length;
    if (k < 0 || k > n) {
      throw new Error("Sample larger than population or is negative");
    }
    if (k === 0) return [];
    const result: T[] = new Array(k);

    // 小集合走 partial Fisher-Yates；大集合走集合拒绝采样
    let setsize = 21;
    if (k > 5) {
      // setsize += 4 ** ceil(log(k*3, 4))；本项目 k<=3，不会触发
      setsize += Math.pow(4, Math.ceil(Math.log(k * 3) / Math.log(4)));
    }

    if (n <= setsize) {
      const pool = population.slice();
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
      return result;
    }

    // 大集合分支：选索引，碰撞拒绝
    const selected = new Set<number>();
    for (let i = 0; i < k; i++) {
      let j = this.randbelow(n);
      while (selected.has(j)) j = this.randbelow(n);
      selected.add(j);
      result[i] = population[j];
    }
    return result;
  }
}

/** 整数的位宽（CPython int.bit_length）。 */
function bitLength(n: number): number {
  if (n <= 0) return 0;
  return Math.floor(Math.log2(n)) + 1;
}
