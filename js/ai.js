// 確率分布ベースの AI（純粋・DOM非依存の ES モジュール）。
//
// ■ シーカーAI（織姫/彦星）
//   相手の盤面は一切覗かず、正当に知りうる情報だけで「相手の現在位置の信念分布」を
//   ベイズ的に構築して手を選ぶ。使う情報:
//   - 公開のゲーム設定: 相手の開始位置 (state.starts)・移動量 (state[other].steps)・
//     手番構造から導出できる相手の完了移動数 (movesSoFar)
//   - 自分の軌跡・自分の盤のデブリ
//   - 交差ヒントのスナップショット (revealedHints)
//   信念分布の骨子:
//   1. 到達可能性＋パリティ: 相手は開始位置から「完了手数×移動量」以内かつ偶奇の合う
//      マスにしかいられない（硬い制約。盤の約半分が即除外される）
//   2. 負の情報: 相手の現在位置が自分の軌跡上ならヒントに必ず現れる。よって
//      「自分の軌跡のうちヒントに無いマス」に相手はいない（確率0）
//   3. 正の情報: ヒントの周辺に確率の山（相手はそこを通った）
//   4. 前進事前: 相手も共有焦点（ヒント重心 or 盤中央）へ向かうと仮定した期待位置
//   移動の評価は「着地=即合流の確率」「相手への期待距離」「共有焦点への収束」
//   「新規マス探索（情報獲得）」の混合。ソフトマックス分布からサンプリング。
//
// ■ 王様AI
//   両盤面を見られる立場を活かし、実際の両者の位置に基づいて
//   「今の手番で着地合流される脅威の遮断」「着地急所（相手位置の隣接）封鎖」
//   「二人の間の回廊封鎖」「接近妨害」を評価してデブリ先を選ぶ。
//
// epsilon（乱数混入率）: 0=分布通り、1=完全ランダム。両AIに共通の実力ノブ。

import {
  key,
  parseKey,
  enumerateMoves,
  reachEndsGrid,
  buildBlockedGrid,
  canPlaceDebris,
} from './engine.js';

// ---- 乱数（再現性のため差し替え可能。既定は Math.random）--------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 小道具 -----------------------------------------------------------------
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const centerOf = (size) => ({ x: Math.floor(size / 2), y: Math.floor(size / 2) });
const otherOf = (who) => (who === 'orihime' ? 'hikoboshi' : 'orihime');

// スコア配列をソフトマックス確率分布に変換して1つサンプリング。probs も返す。
function softmaxSample(items, scores, temperature, rng) {
  const T = Math.max(1e-6, temperature);
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / T));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const probs = exps.map((e) => e / sum);
  let r = rng();
  for (let i = 0; i < items.length; i++) {
    r -= probs[i];
    if (r <= 0) return { item: items[i], index: i, probs };
  }
  return { item: items[items.length - 1], index: items.length - 1, probs };
}

// 確率 epsilon で候補から一様ランダムに選び、そうでなければソフトマックス標本抽出。
function pickWithEpsilon(cands, scores, temperature, epsilon, rng) {
  const eps = epsilon || 0;
  if (eps > 0 && rng() < eps) {
    const idx = Math.min(cands.length - 1, (rng() * cands.length) | 0);
    return { item: cands[idx], index: idx, probs: cands.map(() => 1 / cands.length) };
  }
  return softmaxSample(cands, scores, temperature, rng);
}

// p0 から F へ L1 距離 budget 分だけ前進した期待位置（近似）。
function advanceToward(p0, F, budget) {
  const dx = F.x - p0.x;
  const dy = F.y - p0.y;
  const total = Math.abs(dx) + Math.abs(dy);
  if (total <= budget) return { x: F.x, y: F.y };
  const mx = Math.round((budget * Math.abs(dx)) / total);
  const my = budget - mx;
  return { x: p0.x + Math.sign(dx) * mx, y: p0.y + Math.sign(dy) * my };
}

// 共有焦点: ヒント重心（両者にとって共通知識＝ランデブーの focal point）。無ければ盤中央。
export function sharedFocal(state, who) {
  const hints = state[who].revealedHints;
  if (hints.size === 0) return centerOf(state.size);
  let sx = 0;
  let sy = 0;
  for (const k of hints) {
    const c = parseKey(k);
    sx += c.x;
    sy += c.y;
  }
  return { x: Math.round(sx / hints.size), y: Math.round(sy / hints.size) };
}

// ---- 相手の現在位置の信念分布 ------------------------------------------------
export const BELIEF = { sigmaAdvance: 2.5, sigmaHint: 1.6, hintWeight: 1.2 };

// who から見た相手の現在位置の確率分布（Float64Array N*N、総和1）。
// 相手の盤面状態（pos/trail/debris）には一切触れない。
export function buildOpponentBelief(state, who, params = BELIEF) {
  const N = state.size;
  const other = otherOf(who);
  const p0 = state.starts[other]; // 公開設定
  const my = state[who];
  // 相手の累積移動歩数（公開）。固定でもダイスでも、純移動L1 ≤ budget かつ
  // (budget - L1) が偶数、という到達＋パリティの硬い制約がそのまま成立する。
  const budget = state[other].traveled;
  const F = sharedFocal(state, who);
  const expPos = advanceToward(p0, F, budget);
  const hintCells = [...my.revealedHints].map(parseKey);

  const b = new Float64Array(N * N);
  const twoSa = 2 * params.sigmaAdvance * params.sigmaAdvance;
  const twoSh = 2 * params.sigmaHint * params.sigmaHint;
  let tot = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d0 = Math.abs(x - p0.x) + Math.abs(y - p0.y);
      // 1. 到達可能性＋パリティ（硬い制約）
      if (d0 > budget || (budget - d0) % 2 !== 0) continue;
      // 2. 負の情報: 自分の軌跡のうちヒントに無いマスに相手は「今」いない
      const kk = `${x},${y}`;
      if (my.trail.has(kk) && !my.revealedHints.has(kk)) continue;
      // 3+4. 前進事前 ＋ ヒントの山
      const de = Math.abs(x - expPos.x) + Math.abs(y - expPos.y);
      let w = Math.exp(-(de * de) / twoSa) + 1e-4;
      for (const h of hintCells) {
        const dh = Math.abs(x - h.x) + Math.abs(y - h.y);
        w += params.hintWeight * Math.exp(-(dh * dh) / twoSh);
      }
      b[y * N + x] = w;
      tot += w;
    }
  }
  if (tot === 0) {
    // 矛盾（近似のせい）時: 制約を捨てて一様
    b.fill(1 / (N * N));
    return b;
  }
  for (let i = 0; i < b.length; i++) b[i] /= tot;
  return b;
}

// ---- シーカーAI -------------------------------------------------------------
// 重み。epsilon は乱数混入率（0=分布通り, 1=完全ランダム）。
export const SEEKER = {
  wWin: 60, // 着地=即合流の確率（支配項）
  wDist: 1.0, // 相手への期待距離
  wFocal: 0.7, // 共有焦点への収束（ランデブー）
  wExplore: 0.9, // 経路中の新規マス数（ぐるぐる解消・情報獲得）
  wSignal: 3.0, // 相手の居そうな帯を横切る＝ヒント生成
  wMulti: 0.1, // 同一着地への経路数
  temperature: 0.35,
  epsilon: 0,
};

// 自分が知る情報だけで1手を返す。動けない場合は null。
// 返り値 { path, end, focal, probs }。
export function chooseSeekerMove(state, who, rng = Math.random, params = SEEKER) {
  const N = state.size;
  const my = state[who];
  const belief = buildOpponentBelief(state, who);
  const F = sharedFocal(state, who);

  // 着地マスで集約。代表経路は「新規マス数が最大」のものを保持（探索性の高い経路を優先）
  const byEnd = new Map(); // endKey -> { end, path, count, newCells, pathBelief }
  for (const m of enumerateMoves(state, who)) {
    let newCells = 0;
    let pathBelief = 0;
    let px = my.pos.x;
    let py = my.pos.y;
    // enumerateMoves の path は方向名列。着地セル列を再構成して評価
    const cells = [];
    for (const dname of m.path) {
      if (dname === 'up') py--;
      else if (dname === 'down') py++;
      else if (dname === 'left') px--;
      else px++;
      cells.push(py * N + px);
    }
    for (const ci of cells) {
      const ck = `${ci % N},${(ci - (ci % N)) / N}`;
      if (!my.trail.has(ck)) newCells++;
      pathBelief += belief[ci];
    }
    const ek = key(m.end);
    const cur = byEnd.get(ek);
    if (cur) {
      cur.count += 1;
      if (newCells > cur.newCells) {
        cur.newCells = newCells;
        cur.path = m.path;
        cur.pathBelief = pathBelief;
      }
    } else {
      byEnd.set(ek, { end: m.end, path: m.path, count: 1, newCells, pathBelief });
    }
  }
  const cands = [...byEnd.values()];
  if (cands.length === 0) return null; // 囲まれて動けない

  // 相手への期待距離 Σ belief[c]·L1(e,c) を各候補で計算
  const scores = cands.map((c) => {
    const e = c.end;
    let expDist = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const p = belief[y * N + x];
        if (p > 0) expDist += p * (Math.abs(e.x - x) + Math.abs(e.y - y));
      }
    }
    return (
      params.wWin * belief[e.y * N + e.x] -
      params.wDist * expDist -
      params.wFocal * manhattan(e, F) +
      params.wExplore * c.newCells +
      params.wSignal * c.pathBelief +
      params.wMulti * Math.log(c.count)
    );
  });

  const { item, probs } = pickWithEpsilon(cands, scores, params.temperature, params.epsilon, rng);
  return { path: item.path, end: item.end, focal: F, probs };
}

// ---- 王様AI -----------------------------------------------------------------
export const KING = {
  radius: 4, // 動くシーカー周辺の候補半径
  threatPenalty: 40, // 「今の手番で着地合流される」脅威を残す候補への減点
  wObstruct: 4.0, // 接近妨害（相手位置への最接近距離の悪化量）
  adjacentBonus: 4.0, // 相手位置の隣接マス（着地急所）
  corridorBonus: 3.0, // 二人の中点付近（回廊封鎖）
  temperature: 0.2,
  epsilon: 0,
};

// who（次に動くシーカー）の盤面に置くデブリ1マスを返す。置ける所が無ければ null。
// 王様は両盤面を見られる（正当な情報優位）。
export function chooseKingDebris(state, who, rng = Math.random, params = KING) {
  const N = state.size;
  const mover = state[who];
  const target = state[otherOf(who)];
  const p = target.pos; // 実際の合流目標
  const pIdx = p.y * N + p.x;
  const steps = mover.steps;
  const startIdx = mover.pos.y * N + mover.pos.x;
  const mid = { x: Math.round((mover.pos.x + p.x) / 2), y: Math.round((mover.pos.y + p.y) / 2) };

  const grid = buildBlockedGrid(state, who); // この盤のデブリのみ進入不可

  // 到達端点集合から「p が到達可能か」「p への最短距離」を同時に得る
  const evalReach = (ends) => {
    let best = Infinity;
    let threat = false;
    for (let i = 0; i < ends.length; i++) {
      const idx = ends[i];
      if (idx === pIdx) threat = true;
      const x = idx % N;
      const d = Math.abs(x - p.x) + Math.abs((idx - x) / N - p.y);
      if (d < best) best = d;
    }
    return { threat, best };
  };
  const base = evalReach(reachEndsGrid(N, steps, startIdx, grid));
  const baseBest = Number.isFinite(base.best) ? base.best : manhattan(mover.pos, p);

  // 候補集合: 動くシーカー周辺 ∪ 相手位置の4近傍 ∪ 中点周辺（canPlaceDebris で濾過）
  const candSet = new Map();
  const addCand = (x, y) => {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const k = `${x},${y}`;
    if (candSet.has(k)) return;
    if (!canPlaceDebris(state, who, { x, y })) return;
    candSet.set(k, { x, y });
  };
  const R = params.radius;
  for (let y = mover.pos.y - R; y <= mover.pos.y + R; y++)
    for (let x = mover.pos.x - R; x <= mover.pos.x + R; x++) addCand(x, y);
  addCand(p.x + 1, p.y);
  addCand(p.x - 1, p.y);
  addCand(p.x, p.y + 1);
  addCand(p.x, p.y - 1);
  for (let y = mid.y - 2; y <= mid.y + 2; y++)
    for (let x = mid.x - 2; x <= mid.x + 2; x++) addCand(x, y);
  // 空きが無ければ盤面全体（終盤の保険）
  if (candSet.size === 0) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) addCand(x, y);
  }
  const cands = [...candSet.values()];
  if (cands.length === 0) return null; // 盤面が埋まっている（実質起こらない）

  const scores = cands.map((d) => {
    const di = d.y * N + d.x;
    grid[di] = 1;
    const r = evalReach(reachEndsGrid(N, steps, startIdx, grid));
    grid[di] = 0;
    const best = Number.isFinite(r.best) ? r.best : baseBest + N; // 完全封鎖は高評価
    let score = params.wObstruct * (best - baseBest);
    if (base.threat && r.threat) score -= params.threatPenalty; // 脅威を放置する候補は大減点
    if (manhattan(d, p) === 1) score += params.adjacentBonus; // 着地急所
    score += params.corridorBonus * Math.exp(-manhattan(d, mid) / 2); // 回廊封鎖
    return score;
  });

  const { item } = pickWithEpsilon(cands, scores, params.temperature, params.epsilon, rng);
  return item;
}
