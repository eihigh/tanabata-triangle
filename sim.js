#!/usr/bin/env node
'use strict';

/*
 * 七夕トライアングル シミュレータ
 *
 * 2人協力版（織姫・彦星）。互いの位置は不可視。手がかりは
 *  - 軌跡の交差（減衰=直近 decay 手番の相手軌跡との重なりのみ開示）
 *  - オプション: 出目の相互開示（--share）
 * 勝利 = 同マスに立つ。MAX_DAY 日以内に会えなければ敗北。
 *
 * CLI:
 *   node sim.js <試行数> <ダイス> <盤リスト> <日数> <減衰> [--policy=P] [--share] [--opp=M] [--seed=K]
 *   node sim.js --matrix [試行数]
 *
 *   ダイス   : NdF 記法（例 2d6, 1d3）。カンマ区切りで複数可。数字のみなら 1dF。
 *   盤       : カンマ区切り（例 7 / 5,7,9）
 *   減衰     : 0=全軌跡, 1=直近1手番, ...
 *   --policy : random | greedy | infogain | hybrid | focal（省略時 random）
 *              focal=事前に示し合わせた収束点（盤の中心）へ向かうだけの「約束事」戦略
 *   --share  : 出目の相互開示 on
 *   --opp    : belief 更新に使う相手移動モデル random(v1) | greedy(v2)（省略時 random）
 *   --eps    : 確率εで無情報（ランダム）に動く。人間の不完全さのモデル（省略時 0）
 *   --ojama  : おじゃま係 none | random | choke | cage（省略時 none）。
 *              片方が移動するたびに全知のおじゃまがデブリ（通行・停止不可マス）を1個置く。
 *              choke=二人の最短経路DAGの最細断面を優先封鎖（壁を育てる）
 *              cage =予測出会い地点（二人の中間・盤中央寄り）そのものと周囲を毒殺
 *   --jvariant : デブリの効き方 shared | private（省略時 shared）
 *              shared=両者共通の盤・両者に公開 / private=次に動く側だけに効き、相手には見えない
 *   --jfocus : private時、標的を交互でなく常に同じ片方に集中（見えない壁での隔離）
 *   --jcap   : デブリ総数の上限（省略時 実質無制限=毎移動1個）
 *   --jinit  : 開始前におじゃまが布石できるデブリ数（省略時 0）
 *   --matrix : 第5節の実験マトリクス＋ε感度＋focal＋おじゃまを一括実行
 *
 * 例: node sim.js 10000 2d6 7 7 1 --policy=greedy --share
 */

/* ===================== RNG（再現性のため seed 可能） ===================== */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ===================== ダイス ===================== */
function parseDiceSpec(s) {
  const m = String(s).match(/^(\d+)d(\d+)$/i);
  if (m) return { n: +m[1], f: +m[2], label: `${m[1]}d${m[2]}` };
  return { n: 1, f: +s, label: `1d${s}` };
}

// 合計値ごとの確率（index=合計値）
function diceProbs(n, f) {
  let dist = [1];
  for (let d = 0; d < n; d++) {
    const nd = new Array(dist.length + f).fill(0);
    for (let s = 0; s < dist.length; s++) {
      if (!dist[s]) continue;
      for (let v = 1; v <= f; v++) nd[s + v] += dist[s] / f;
    }
    dist = nd;
  }
  return dist;
}

/* ===================== 盤の事前計算 ===================== */
/*
 * 障害物なしの4近傍グリッドでは「ちょうどk歩で到達できるマス」は
 *   マンハッタン距離 d <= k かつ (k-d) が偶数
 * と一致する（隣接マスとの往復でパディングできるため）。
 * ※ おじゃま係のブロック（障害物）を入れる場合はこの前提が崩れるので
 *    層状DP（reachableSet）に差し替えること。
 */
class Board {
  constructor(N, maxK, dice) {
    this.N = N;
    this.size = N * N;
    this.maxK = maxK;

    // マンハッタン距離テーブル
    this.dist = new Int8Array(this.size * this.size);
    for (let a = 0; a < this.size; a++) {
      const ar = (a / N) | 0, ac = a % N;
      for (let b = 0; b < this.size; b++) {
        const br = (b / N) | 0, bc = b % N;
        this.dist[a * this.size + b] = Math.abs(ar - br) + Math.abs(ac - bc);
      }
    }

    // 近傍
    this.nbrs = [];
    for (let a = 0; a < this.size; a++) {
      const r = (a / N) | 0, c = a % N, lst = [];
      if (r > 0) lst.push(a - N);
      if (r < N - 1) lst.push(a + N);
      if (c > 0) lst.push(a - 1);
      if (c < N - 1) lst.push(a + 1);
      this.nbrs.push(lst);
    }

    // 外周マス
    this.perimeter = [];
    for (let a = 0; a < this.size; a++) {
      const r = (a / N) | 0, c = a % N;
      if (r === 0 || c === 0 || r === N - 1 || c === N - 1) this.perimeter.push(a);
    }

    // reach[p][k] = ちょうどk歩で到達できるマスの Int16Array
    this.reach = [];
    for (let p = 0; p < this.size; p++) {
      const perK = [];
      for (let k = 0; k <= maxK; k++) {
        const lst = [];
        for (let q = 0; q < this.size; q++) {
          const d = this.dist[p * this.size + q];
          if (d <= k && ((k - d) & 1) === 0) lst.push(q);
        }
        perK.push(Int16Array.from(lst));
      }
      this.reach.push(perK);
    }

    // belief 伝播用の遷移行列（相手ランダムモデル）
    // Ts[s][p*size+q] = P(着地q | 位置p, 出目s) 、Tmix = 出目分布で混合
    this.diceProbs = diceProbs(dice.n, dice.f);
    this.minRoll = dice.n;
    this.maxRoll = dice.n * dice.f;
    this.Ts = [];
    this.Tmix = new Float64Array(this.size * this.size);
    for (let s = 0; s <= this.maxRoll; s++) this.Ts.push(null);
    for (let s = this.minRoll; s <= this.maxRoll; s++) {
      const M = new Float64Array(this.size * this.size);
      for (let p = 0; p < this.size; p++) {
        const r = this.reach[p][s];
        const w = 1 / r.length;
        for (const q of r) M[p * this.size + q] = w;
      }
      this.Ts[s] = M;
      const ps = this.diceProbs[s];
      for (let i = 0; i < M.length; i++) this.Tmix[i] += ps * M[i];
    }
  }

  d(a, b) { return this.dist[a * this.size + b]; }
}

/*
 * 経路を1本サンプリング：ちょうどk歩で start→target。
 * 各ステップで「残り歩数で target に到達可能な近傍」から一様に選ぶ。
 * （帰納的に必ず候補が存在する）
 */
function samplePath(board, start, target, k, rng) {
  const path = [start];
  let cur = start, rem = k;
  while (rem > 0) {
    const cand = [];
    for (const nb of board.nbrs[cur]) {
      const d = board.d(nb, target);
      if (d <= rem - 1 && (((rem - 1) - d) & 1) === 0) cand.push(nb);
    }
    cur = cand[(rng() * cand.length) | 0];
    path.push(cur);
    rem--;
  }
  return path;
}

/* ===================== 障害物（おじゃま係のデブリ）対応 ===================== */
/*
 * デブリがあると「距離＋偶奇」の高速判定が使えないため層状DPに切り替える。
 * layers[t] = ちょうどt歩で到達できるマス集合（デブリは通行・停止とも不可）。
 */
function computeLayers(board, start, k, blocked) {
  const size = board.size;
  const layers = [new Uint8Array(size)];
  layers[0][start] = 1;
  for (let t = 1; t <= k; t++) {
    const prev = layers[t - 1], cur = new Uint8Array(size);
    for (let p = 0; p < size; p++) {
      if (!prev[p]) continue;
      for (const q of board.nbrs[p]) if (!blocked[q]) cur[q] = 1;
    }
    layers.push(cur);
  }
  return layers;
}

// 層状DPの結果から経路を1本後ろ向きサンプリング
function samplePathBlocked(board, layers, target, k, rng) {
  const rev = [target];
  let cur = target;
  for (let t = k; t > 0; t--) {
    const cand = [];
    for (const nb of board.nbrs[cur]) if (layers[t - 1][nb]) cand.push(nb);
    cur = cand[(rng() * cand.length) | 0];
    rev.push(cur);
  }
  return rev.reverse();
}

// デブリを避けたBFS距離場（おじゃまAI用）
function bfsDist(board, from, blocked) {
  const size = board.size;
  const d = new Int16Array(size).fill(-1);
  const q = new Int16Array(size);
  let head = 0, tail = 0;
  d[from] = 0; q[tail++] = from;
  while (head < tail) {
    const u = q[head++];
    for (const v of board.nbrs[u]) {
      if (d[v] < 0 && !blocked[v]) { d[v] = d[u] + 1; q[tail++] = v; }
    }
  }
  return d;
}

/* ===================== おじゃま係AI ===================== */
/*
 * 全知（二人の位置・盤面をすべて見える）。片方が移動するたびにデブリを1個置く。
 * variant 'shared' : デブリは両者共通の盤に置かれ、両者に見える
 * variant 'private': デブリは「次に動く側」の盤にだけ効き、相手には見えない
 *                    （各プレイヤーは自分のデブリだけ見える）
 * 配置禁止: 両プレイヤーの現在マス（相手の立ちマスを塞げると出会いを恒久封鎖できて
 *           しまうため）と既存デブリ。
 */

// チョークポイント封鎖: from→to の最短経路DAGのうち「断面が最も細いレベル」を優先して塞ぐ。
// 同じ細さなら中間・盤中央寄りを好む（収束点も同時に潰れる）。壁が育つと自然に迂回距離が伸びる。
function chokeCell(board, blocked, from, to, rng) {
  const size = board.size;
  const dF = bfsDist(board, from, blocked);
  const dT = bfsDist(board, to, blocked);
  const D = dF[to];
  if (D >= 0 && D <= 1) {
    // 隣接: 間に置けるマスがない → 相手の周囲を檻状に塞ぐ
    const cand = board.nbrs[to].filter(q => !blocked[q] && q !== from);
    return cand.length ? cand[(rng() * cand.length) | 0] : -1;
  }
  if (D < 0) return -1; // 既に分断済み → フォールバック（呼び出し側でランダム配置）
  const width = new Int16Array(D);
  for (let q = 0; q < size; q++) {
    if (q === from || q === to) continue;
    if (dF[q] > 0 && dT[q] > 0 && dF[q] + dT[q] === D) width[dF[q]]++;
  }
  const c = (board.N - 1) >> 1;
  const center = c * board.N + c;
  let best = -1, bs = -Infinity;
  for (let q = 0; q < size; q++) {
    if (q === from || q === to) continue;
    if (dF[q] <= 0 || dT[q] <= 0 || dF[q] + dT[q] !== D) continue;
    const lvl = dF[q];
    const s = -100 * width[lvl] - 10 * Math.abs(lvl - D / 2) - board.d(q, center) + rng() * 1e-3;
    if (s > bs) { bs = s; best = q; }
  }
  return best;
}

// 出会い地点毒殺: 二人が収束するであろう地点 M（二人の中間・盤中央寄り）を予測し、
// M そのもの → M の周囲、の順で塞ぐ。秘匿型では「相手には見えない毒」になり、
// 片方が M で待っても、もう片方は永遠に M に立てない＝約束事（収束点）を静かに殺す。
function cageCell(board, blocked, posA, posB, rng) {
  const size = board.size;
  const c = (board.N - 1) >> 1;
  const center = c * board.N + c;
  let M = -1, bs = Infinity;
  for (let q = 0; q < size; q++) {
    if (q === posA || q === posB) continue;
    const s = (board.d(q, posA) + board.d(q, posB)) * 10 + board.d(q, center) + rng() * 1e-3;
    if (s < bs) { bs = s; M = q; }
  }
  if (M < 0) return -1;
  if (!blocked[M]) return M; // 予測地点そのものを毒殺
  // 既に毒済みなら周囲を檻に（M に近い空きマスを順に）
  let best = -1, bd = Infinity;
  for (let q = 0; q < size; q++) {
    if (blocked[q] || q === posA || q === posB) continue;
    const d = board.d(q, M) + rng() * 1e-3;
    if (d < bd && d < 3) { bd = d; best = q; }
  }
  return best;
}

// デブリ1個の配置先を決める。戻り値 { cell, target }（cell<0なら配置不能）
function ojamaPlace(board, cfg, blocks, posA, posB, nextMover, rng) {
  const priv = cfg.jvariant === 'private';
  // 秘匿型の標的: 通常は「次に動く側」に交互。--jfocus なら常に同じ片方へ集中し、
  // 片方だけを見えない壁で隔離する（もう片方の盤は綺麗なまま）
  const target = priv ? (cfg.jfocus ? 0 : nextMover) : 0; // shared は blocks[0]===blocks[1]
  const blockedArr = blocks[target];
  const from = priv ? (target === 0 ? posA : posB) : posA;
  const to = priv ? (target === 0 ? posB : posA) : posB;
  let cell = -1;
  if (cfg.ojama === 'cage') cell = cageCell(board, blockedArr, posA, posB, rng);
  if (cfg.ojama === 'choke' || (cfg.ojama === 'cage' && cell < 0)) {
    cell = chokeCell(board, blockedArr, from, to, rng);
  }
  if (cell < 0) {
    // random ポリシー / choke・cage のフォールバック
    const legal = [];
    for (let q = 0; q < board.size; q++) {
      if (!blockedArr[q] && q !== posA && q !== posB) legal.push(q);
    }
    if (legal.length) cell = legal[(rng() * legal.length) | 0];
  }
  return { cell, target };
}

/* ===================== belief（相手位置の確率分布） ===================== */

function makeBelief(board, myStart, minDist) {
  const b = new Float64Array(board.size);
  let n = 0;
  for (const p of board.perimeter) {
    if (board.d(myStart, p) >= minDist) { b[p] = 1; n++; }
  }
  if (n === 0) { for (const p of board.perimeter) b[p] = 1; n = board.perimeter.length; }
  for (let i = 0; i < board.size; i++) b[i] /= n;
  return b;
}

function normalize(b) {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i];
  if (s > 1e-12) { for (let i = 0; i < b.length; i++) b[i] /= s; return true; }
  return false;
}

/*
 * 相手の1手番分の移動で belief を前方伝播。
 * roll が既知（出目開示 on）なら Ts[roll]、未知なら Tmix。
 * oppModel='greedy'（v2）: 相手は自分（myPos）に近づくよう動くと仮定し、
 * 着地候補を距離減衰で重み付けする。
 */
function propagateBelief(board, belief, roll, oppModel, myPos) {
  const size = board.size;
  const out = new Float64Array(size);
  if (oppModel === 'greedy') {
    const rolls = roll != null ? [roll] : null;
    for (let p = 0; p < size; p++) {
      const w0 = belief[p];
      if (w0 < 1e-15) continue;
      const ss = rolls || range(board.minRoll, board.maxRoll);
      for (const s of ss) {
        const ps = roll != null ? 1 : board.diceProbs[s];
        const r = board.reach[p][s];
        let z = 0;
        for (const q of r) z += 1 / (1 + board.d(q, myPos));
        for (const q of r) out[q] += w0 * ps * (1 / (1 + board.d(q, myPos))) / z;
      }
    }
  } else {
    const M = roll != null ? board.Ts[roll] : board.Tmix;
    for (let p = 0; p < size; p++) {
      const w0 = belief[p];
      if (w0 < 1e-15) continue;
      const row = p * size;
      for (let q = 0; q < size; q++) out[q] += w0 * M[row + q];
    }
  }
  return out;
}

function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

/*
 * 交差観測による belief 更新。
 * subjectRoll: 交差の原因となった「対象プレイヤーの移動」の出目（既知なら数値、未知なら null）。
 * crossCells:  開示された交差マス（対象の直近経路に含まれることが確定）。
 * clearCells:  対象の直近経路に含まれないことが確定したマス（負の情報）。
 * subjectMoved: 対象がまだ一度も動いていない場合 false（→交差マス＝現在地）。
 */
function observeBelief(board, belief, crossCells, clearCells, subjectRoll, subjectMoved) {
  const size = board.size;
  if (crossCells.length > 0) {
    if (!subjectMoved) {
      // まだ動いていない相手と交差 ＝ 相手はそのマスに立っている
      const nb = new Float64Array(size);
      for (const c of crossCells) nb[c] = 1;
      for (let i = 0; i < size; i++) belief[i] = nb[i] * (belief[i] > 0 ? 1 : 0.001);
    } else {
      // 経路がcを通った → 現在地は c から残り歩数以内。距離減衰の尤度を掛ける
      for (let q = 0; q < size; q++) {
        if (belief[q] < 1e-15) continue;
        let like = 0;
        for (const c of crossCells) {
          const d = board.d(c, q);
          if (subjectRoll != null) {
            if (d <= subjectRoll) like += subjectRoll + 1 - d;
          } else {
            for (let s = board.minRoll; s <= board.maxRoll; s++) {
              if (d <= s) like += board.diceProbs[s] * (s + 1 - d);
            }
          }
        }
        belief[q] *= like;
      }
    }
  }
  const crossSet = new Set(crossCells);
  for (const x of clearCells) {
    if (!crossSet.has(x)) belief[x] = 0;
  }
  if (!normalize(belief)) {
    // 近似の矛盾で全滅した場合のフォールバック：確定除外だけ守って一様に戻す
    for (let i = 0; i < size; i++) belief[i] = 1;
    for (const x of clearCells) if (!crossSet.has(x)) belief[x] = 0;
    if (crossCells.length > 0 && subjectRoll != null) {
      for (let q = 0; q < size; q++) {
        let ok = false;
        for (const c of crossCells) if (board.d(c, q) <= subjectRoll) ok = true;
        if (!ok) belief[q] = 0;
      }
    }
    if (!normalize(belief)) { for (let i = 0; i < size; i++) belief[i] = 1 / size; }
  }
}

/* ===================== 方策 ===================== */

const WIN_WEIGHT = 200; // 着地マスに相手がいる確率の重み（即勝利）

function expectedDist(board, belief, L) {
  let e = 0;
  for (let q = 0; q < board.size; q++) {
    if (belief[q] > 1e-15) e += belief[q] * board.d(L, q);
  }
  return e;
}

// belief を半径2でならした「交差期待フィールド」
function smoothField(board, belief) {
  const sm = new Float64Array(board.size);
  for (let q = 0; q < board.size; q++) {
    const w = belief[q];
    if (w < 1e-15) continue;
    for (let x = 0; x < board.size; x++) {
      const d = board.d(q, x);
      if (d <= 2) sm[x] += w * (3 - d);
    }
  }
  return sm;
}

/*
 * 着地マスと経路を選ぶ。
 * mode: 'random' | 'greedy' | 'infogain' | 'hybrid' | 'focal'
 * reach: 今回の出目で着地可能なマス（デブリ考慮済み）
 * sampler(landing): 経路を1本サンプリング（デブリ考慮済み）
 * myBlocks: 自分の盤のデブリ（null=なし）。focal の目標マス補正に使う
 * 戻り値 { landing, path }
 */
function chooseMove(board, me, roll, day, maxDay, mode, rng, eps, reach, sampler, myBlocks) {
  // ε-ランダム：人間の不完全さのモデル。確率 eps で無情報に動く
  if (eps > 0 && mode !== 'random' && rng() < eps) mode = 'random';

  if (mode === 'hybrid') {
    // 序盤（約4割）は情報収集、以降は会いにいく
    mode = day <= Math.ceil(maxDay * 0.4) ? 'infogain' : 'greedy';
  }

  if (mode === 'random') {
    const landing = reach[(rng() * reach.length) | 0];
    return { landing, path: sampler(landing) };
  }

  // focal: 事前に示し合わせた収束点（盤の中心）へ向かってホバリングするだけ。
  // belief も交差も出目も一切使わない「約束事」戦略。必勝法の脅威を測るための対照。
  // 中心が自分の盤で塞がれていたら「中心に最も近い空きマス」に目標を替える
  // （決定的な走査順なので、デブリが共有・公開なら二人は同じ代替目標を選べる）。
  if (mode === 'focal') {
    const c = (board.N - 1) >> 1;
    let goal = c * board.N + c;
    if (myBlocks && myBlocks[goal]) {
      let bg = goal, bd = Infinity;
      for (let q = 0; q < board.size; q++) {
        if (myBlocks[q]) continue;
        const d = board.d(q, goal);
        if (d < bd) { bd = d; bg = q; }
      }
      goal = bg;
    }
    let best = null, bd2 = Infinity;
    for (const L of reach) {
      const d = board.d(L, goal) + rng() * 1e-6; // 目標に乗れるなら乗る、無理なら最短接近
      if (d < bd2) { bd2 = d; best = L; }
    }
    return { landing: best, path: sampler(best) };
  }

  const belief = me.belief;
  let best = null, bestScore = -Infinity;

  if (mode === 'greedy') {
    for (const L of reach) {
      const score = WIN_WEIGHT * belief[L] - expectedDist(board, belief, L) + rng() * 1e-6;
      if (score > bestScore) { bestScore = score; best = L; }
    }
    return { landing: best, path: sampler(best) };
  }

  // infogain: 実際に通る経路が belief の濃い領域をどれだけ横断するか
  const sm = smoothField(board, belief);
  let bestPath = null;
  for (const L of reach) {
    const path = sampler(L);
    const seen = new Set();
    let info = 0;
    for (const x of path) {
      if (!seen.has(x)) { seen.add(x); info += sm[x]; }
    }
    const score = WIN_WEIGHT * belief[L] + info - 0.01 * expectedDist(board, belief, L) + rng() * 1e-6;
    if (score > bestScore) { bestScore = score; best = L; bestPath = path; }
  }
  return { landing: best, path: bestPath };
}

/* ===================== 1ゲーム ===================== */

function minStartDist(N) { return Math.max(4, Math.round(N * 1.1)); }

function playGame(board, cfg, rng) {
  const { maxDay, decay, policy, share, oppModel, dice } = cfg;
  const size = board.size;
  const per = board.perimeter;
  const minDist = minStartDist(board.N);

  // スタート位置（外周・最小距離制約）
  let a = per[(rng() * per.length) | 0], b;
  do { b = per[(rng() * per.length) | 0]; } while (board.d(a, b) < minDist);

  const mkPlayer = (pos) => ({
    pos,
    stamp: new Int32Array(size).fill(-1e9), // 各マスに最後に通った手番番号
    lastPathCells: [pos],                    // 直近手番で通ったマス
    lastRoll: null,                          // 直近手番の出目（開示用）
    moved: false,
    belief: policy !== 'random' ? makeBelief(board, pos, minDist) : null,
  });
  const players = [mkPlayer(a), mkPlayer(b)];
  players[0].stamp[a] = 0;
  players[1].stamp[b] = 0;

  // おじゃま係のデブリ盤。shared は同一配列を共有、private は各自の盤
  const jOn = cfg.ojama && cfg.ojama !== 'none';
  let blocks = null;
  if (jOn) {
    if (cfg.jvariant === 'private') blocks = [new Uint8Array(size), new Uint8Array(size)];
    else { const sh = new Uint8Array(size); blocks = [sh, sh]; }
  }
  const jcap = cfg.jcap != null ? cfg.jcap : 999;
  let debrisCount = 0;
  const placeDebris = (nextMover) => {
    if (!jOn || debrisCount >= jcap) return;
    const { cell, target } = ojamaPlace(board, cfg, blocks, players[0].pos, players[1].pos, nextMover, rng);
    if (cell >= 0) { blocks[target][cell] = 1; debrisCount++; }
  };
  // 事前配置: 全知おじゃまは開始位置を見てから、1日目の前にデブリを布石できる
  if (jOn && cfg.jinit) {
    for (let i = 0; i < cfg.jinit; i++) placeDebris(i & 1);
  }

  let turn = 0, crossCellsTotal = 0, anyCross = false, stuck = 0;

  const rollDice = () => {
    let s = 0;
    for (let i = 0; i < dice.n; i++) s += 1 + ((rng() * dice.f) | 0);
    return s;
  };

  for (let day = 1; day <= maxDay; day++) {
    for (let pi = 0; pi < 2; pi++) {
      turn++;
      const me = players[pi], op = players[1 - pi];
      const roll = rollDice();
      const myBlocks = jOn ? blocks[pi] : null;

      // 到達集合と経路サンプラ（デブリがあれば層状DP、なければ高速な事前計算）
      let reach, layers = null;
      if (jOn && debrisCount > 0) {
        layers = computeLayers(board, me.pos, roll, myBlocks);
        reach = [];
        const Lk = layers[roll];
        for (let q = 0; q < size; q++) if (Lk[q]) reach.push(q);
      } else {
        reach = board.reach[me.pos][roll];
      }
      const sampler = (L) => (layers
        ? samplePathBlocked(board, layers, L, roll, rng)
        : samplePath(board, me.pos, L, roll, rng));

      // 詰み: ちょうどの歩数で止まれるマスがない → その場に留まる
      if (reach.length === 0) {
        stuck++;
        me.stamp[me.pos] = turn;
        me.lastPathCells = [me.pos];
        me.lastRoll = roll;
        me.moved = true;
        // belief 更新は簡略化のため省略（詰みは稀なイベント）
        placeDebris(1 - pi);
        continue;
      }

      // 着地選択
      const mv = chooseMove(board, me, roll, day, maxDay, policy, rng, cfg.eps || 0, reach, sampler, myBlocks);
      const landing = mv.landing, path = mv.path;

      // 交差判定（相手の減衰内スタンプとの重なり）。segment=移動で踏んだマス（出発マスは除く）
      const segment = path.slice(1);
      const crosses = [];
      for (const x of segment) {
        const t = op.stamp[x];
        const hit = decay === 0 ? t >= 0 : (turn - t) <= decay;
        if (hit) crosses.push(x);
      }
      const uniqCross = [...new Set(crosses)];
      crossCellsTotal += uniqCross.length;
      if (uniqCross.length > 0) anyCross = true;

      // 自分の軌跡スタンプと移動
      for (const x of path) me.stamp[x] = turn;
      const prevLastPath = me.lastPathCells;
      me.pos = landing;
      me.lastPathCells = [...new Set(path)];
      me.lastRoll = roll;
      me.moved = true;

      // 勝利判定（同マス限定）
      if (me.pos === op.pos) {
        return { met: true, day, crossCellsTotal, anyCross, stuck };
      }

      // ---- belief 更新（交差は「今、相手の直前の道を横切った側」だけが知る） ----
      if (policy !== 'random') {
        // (1) 動いた側（me）：相手の直近経路との交差＝相手の居場所の手がかり。
        //     交差あり → 相手の経路が crosses を通った。
        //     交差なし → 自分が踏んだマスは相手の直近経路に含まれない（負の情報）。
        //     着地マスに相手はいない（勝利していないので）。
        const myClear = [...new Set(segment)]; // 交差マス以外の踏破マスは相手経路に含まれない
        observeBelief(
          board, me.belief, uniqCross, myClear,
          share ? op.lastRoll : null, op.moved
        );
        me.belief[me.pos] = 0;
        normalize(me.belief);

        // (2) 相手側（op）：交差は伝えられない。分かるのは「me が1手番動いた」ことと、
        //     出目開示ありならその出目だけ。前方伝播と「未出会い」除外のみ。
        op.belief = propagateBelief(board, op.belief, share ? roll : null, oppModel, op.pos);
        op.belief[op.pos] = 0; // 出会っていない
        normalize(op.belief);

        // 共有デブリは公開情報：相手はデブリの上には立てない。
        // 秘匿型では相手のデブリを知らないので何も除外できない（それが情報の毒）。
        if (jOn && cfg.jvariant !== 'private') {
          const sh = blocks[0];
          for (let q = 0; q < size; q++) {
            if (sh[q]) { me.belief[q] = 0; op.belief[q] = 0; }
          }
          normalize(me.belief);
          normalize(op.belief);
        }
      }
      void prevLastPath;

      // おじゃま係: 移動が終わるたびにデブリを1個置く
      placeDebris(1 - pi);
    }
  }
  return { met: false, day: null, crossCellsTotal, anyCross, stuck };
}

/* ===================== 実験ランナー ===================== */

function runCondition(cfg) {
  const dice = cfg.dice;
  const board = getBoard(cfg.N, dice);
  const rng = mulberry32(cfg.seed || 12345);
  let met = 0, sumDay = 0, cross = 0, anyCrossGames = 0, stuck = 0;
  for (let i = 0; i < cfg.trials; i++) {
    const r = playGame(board, cfg, rng);
    if (r.met) { met++; sumDay += r.day; }
    cross += r.crossCellsTotal;
    if (r.anyCross) anyCrossGames++;
    stuck += r.stuck;
  }
  return {
    meetRate: (100 * met) / cfg.trials,
    avgDay: met ? sumDay / met : NaN,
    crossPerGame: cross / cfg.trials,
    crossGameRate: (100 * anyCrossGames) / cfg.trials,
    stuckPerGame: stuck / cfg.trials,
  };
}

const boardCache = new Map();
function getBoard(N, dice) {
  const key = `${N}:${dice.n}d${dice.f}`;
  if (!boardCache.has(key)) boardCache.set(key, new Board(N, dice.n * dice.f, dice));
  return boardCache.get(key);
}

function fmt(x, d = 1) { return Number.isFinite(x) ? x.toFixed(d) : '-'; }

function printResult(label, r) {
  console.log(
    `${label.padEnd(42)} 出会い ${fmt(r.meetRate).padStart(5)}%  平均決着日 ${fmt(r.avgDay, 2).padStart(5)}  ` +
    `交差/g ${fmt(r.crossPerGame, 2).padStart(6)}  交差有 ${fmt(r.crossGameRate).padStart(5)}%  詰み/g ${fmt(r.stuckPerGame, 2)}`
  );
}

/* ===================== CLI ===================== */

function main() {
  const args = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (const a of args) {
    if (a === '--matrix') flags.matrix = true;
    else if (a === '--share') flags.share = true;
    else if (a.startsWith('--policy=')) flags.policy = a.slice(9);
    else if (a.startsWith('--opp=')) flags.opp = a.slice(6);
    else if (a.startsWith('--seed=')) flags.seed = +a.slice(7);
    else if (a.startsWith('--eps=')) flags.eps = +a.slice(6);
    else if (a.startsWith('--ojama=')) flags.ojama = a.slice(8);
    else if (a.startsWith('--jvariant=')) flags.jvariant = a.slice(11);
    else if (a.startsWith('--jcap=')) flags.jcap = +a.slice(7);
    else if (a.startsWith('--jinit=')) flags.jinit = +a.slice(8);
    else if (a === '--jfocus') flags.jfocus = true;
    else pos.push(a);
  }

  if (flags.matrix) {
    runMatrix(pos[0] ? +pos[0] : 10000, flags.seed || 12345);
    return;
  }

  if (pos.length < 5) {
    console.log('usage: node sim.js <trials> <dice> <boards> <days> <decay> [--policy=P] [--share] [--opp=M] [--seed=K]');
    console.log('       node sim.js --matrix [trials]');
    process.exit(1);
  }

  const trials = +pos[0];
  const diceSpecs = pos[1].split(',').map(parseDiceSpec);
  const boards = pos[2].split(',').map(Number);
  const maxDay = +pos[3];
  const decay = +pos[4];
  const policy = flags.policy || 'random';

  for (const dice of diceSpecs) {
    for (const N of boards) {
      const cfg = {
        trials, dice, N, maxDay, decay, policy,
        share: !!flags.share, oppModel: flags.opp || 'random', seed: flags.seed || 12345,
        eps: flags.eps || 0,
        ojama: flags.ojama || 'none', jvariant: flags.jvariant || 'shared', jcap: flags.jcap, jinit: flags.jinit || 0,
        jfocus: !!flags.jfocus,
      };
      const jl = cfg.ojama !== 'none' ? ` 邪魔${cfg.ojama}-${cfg.jvariant}${cfg.jfocus ? '(集中)' : ''}${cfg.jcap != null ? `(上限${cfg.jcap})` : ''}${cfg.jinit ? `(布石${cfg.jinit})` : ''}` : '';
      const label = `${N}x${N} ${dice.label} ${maxDay}日 減衰${decay} ${policy}${cfg.eps ? `(ε=${cfg.eps})` : ''}${cfg.share ? '+出目' : ''}${cfg.oppModel === 'greedy' ? ' oppV2' : ''}${jl}`;
      printResult(label, runCondition(cfg));
    }
  }
}

/* 第5節の実験マトリクス */
function runMatrix(trials, seed) {
  const d2 = parseDiceSpec('2d6');
  const base = { trials, dice: d2, N: 7, maxDay: 7, decay: 1, oppModel: 'random', seed };

  console.log(`\n=== 実験1: 方策 × 出目開示 (7x7, 2d6, 7日, 減衰1, ${trials}試行) ===`);
  for (const policy of ['random', 'greedy', 'infogain', 'hybrid']) {
    for (const share of [false, true]) {
      if (policy === 'random' && share) continue; // ランダムは情報を使わないので同一
      printResult(`${policy}${share ? ' +出目開示' : ''}`, runCondition({ ...base, policy, share }));
    }
  }

  console.log(`\n=== 実験2: 盤サイズ感度 (hybrid+出目開示, 2d6, 7日, 減衰1) ===`);
  for (const N of [5, 7, 9]) {
    printResult(`${N}x${N}`, runCondition({ ...base, N, policy: 'hybrid', share: true }));
  }

  console.log(`\n=== 実験3: 日数感度 (7x7, hybrid+出目開示, 2d6, 減衰1) ===`);
  for (const maxDay of [5, 6, 7, 8]) {
    printResult(`${maxDay}日`, runCondition({ ...base, maxDay, policy: 'hybrid', share: true }));
  }

  console.log(`\n=== 実験4: 相手モデル v1(random仮定) vs v2(greedy仮定) (greedy方策) ===`);
  for (const share of [false, true]) {
    for (const oppModel of ['random', 'greedy']) {
      printResult(
        `greedy${share ? '+出目' : ''} 相手モデル=${oppModel === 'random' ? 'v1' : 'v2'}`,
        runCondition({ ...base, policy: 'greedy', share, oppModel })
      );
    }
  }

  console.log(`\n=== 実験5: ε感度＝人間らしい不完全プレイ (7x7, greedy, 2d6, 7日, 減衰1) ===`);
  console.log(`    確率εで無情報（ランダム）に動く。人間プレイの想定帯を推定する`);
  for (const eps of [0.2, 0.4, 0.6, 0.8]) {
    for (const share of [false, true]) {
      printResult(`ε=${eps}${share ? ' +出目開示' : ''}`, runCondition({ ...base, policy: 'greedy', share, eps }));
    }
  }

  console.log(`\n=== 実験6: 収束点コンベンション（focal）の脅威 (2d6, 減衰1) ===`);
  console.log(`    「二人とも盤の中心へ向かうだけ」の約束事。交差も出目も使わない`);
  printResult('focal 7x7 7日 出目なし', runCondition({ ...base, policy: 'focal', share: false }));
  printResult('focal 7x7 7日 出目あり', runCondition({ ...base, policy: 'focal', share: true }));
  console.log('    ↑ 出目開示で差が出ない＝収束点必勝は出目開示のせいではない');
  printResult('focal 9x9 4日（盤拡大＋日数短縮でも）', runCondition({ ...base, N: 9, maxDay: 4, policy: 'focal' }));
  printResult('対照 greedy+出目 7x7 7日（正規の推理プレイ）', runCondition({ ...base, policy: 'greedy', share: true }));

  console.log(`\n=== 実験7: おじゃま係 — デブリ共有型(shared) vs 秘匿型(private) (7x7, 2d6, 7日, 減衰1) ===`);
  console.log(`    片方が移動するたびに全知おじゃまがデブリ+1。shared=両者共通・公開 / private=次に動く側だけ・非公開`);
  printResult('focal        おじゃまなし', runCondition({ ...base, policy: 'focal' }));
  printResult('greedy+出目   おじゃまなし', runCondition({ ...base, policy: 'greedy', share: true }));
  for (const oj of ['random', 'choke', 'cage']) {
    for (const jv of ['shared', 'private']) {
      printResult(`focal        ${oj}-${jv}`, runCondition({ ...base, policy: 'focal', ojama: oj, jvariant: jv }));
      printResult(`greedy+出目   ${oj}-${jv}`, runCondition({ ...base, policy: 'greedy', share: true, ojama: oj, jvariant: jv }));
    }
  }
  console.log(`    --- 秘匿・集中攻撃 (--jfocus: 常に同じ片方の盤だけに置き、見えない壁で隔離) ---`);
  for (const oj of ['choke', 'cage']) {
    printResult(`focal        ${oj}-private(集中)`, runCondition({ ...base, policy: 'focal', ojama: oj, jvariant: 'private', jfocus: true }));
    printResult(`greedy+出目   ${oj}-private(集中)`, runCondition({ ...base, policy: 'greedy', share: true, ojama: oj, jvariant: 'private', jfocus: true }));
  }
  console.log(`    --- デブリ上限感度 (choke, greedy+出目) ---`);
  for (const jv of ['shared', 'private']) {
    for (const cap of [4, 7, 14]) {
      printResult(`choke-${jv} 上限${cap}`, runCondition({ ...base, policy: 'greedy', share: true, ojama: 'choke', jvariant: jv, jcap: cap }));
    }
  }
  console.log(`    --- 人間帯 ε=0.4 (greedy+出目) ---`);
  for (const jv of ['shared', 'private']) {
    printResult(`ε=0.4 choke-${jv}`, runCondition({ ...base, policy: 'greedy', share: true, eps: 0.4, ojama: 'choke', jvariant: jv }));
  }
  printResult(`ε=0.4 cage-private(集中)`, runCondition({ ...base, policy: 'greedy', share: true, eps: 0.4, ojama: 'cage', jvariant: 'private', jfocus: true }));
}

main();
