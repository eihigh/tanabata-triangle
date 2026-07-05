// 確率分布ベースの AI（純粋・DOM非依存の ES モジュール）。
//
// シーカーAI（織姫/彦星）: 自分が正当に知る情報（自分の軌跡・デブリ・交差ヒントの
//   スナップショット）だけから、相手のいそうな場所／合流点の確率場を作り、移動先候補を
//   ソフトマックス確率分布でサンプリングして1手を選ぶ。相手の盤面は一切覗かない。
// 王様AI: 両盤面を見られる立場を活かし、シーカーが合流点へ近づくのを最も妨げるマスを、
//   これも確率分布（ソフトマックス）でサンプリングしてデブリ設置先に選ぶ。

import {
  key,
  parseKey,
  enumerateMoves,
  reachEndsGrid,
  buildBlockedGrid,
  canPlaceDebris,
  hints as trueHints,
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

// 発生源（bumps）から等方ガウスの確率場を作り、正規化して返す（Float64Array, size*size）。
function buildField(size, bumps, sigma) {
  const field = new Float64Array(size * size);
  const twoS2 = 2 * sigma * sigma;
  let total = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const b of bumps) {
        const dx = x - b.x;
        const dy = y - b.y;
        v += Math.exp(-(dx * dx + dy * dy) / twoS2);
      }
      field[y * size + x] = v;
      total += v;
    }
  }
  if (total > 0) for (let i = 0; i < field.length; i++) field[i] /= total;
  return field;
}

// 確率場の最大セル（同点は中央に近い方）を焦点として返す。
function argmaxCell(field, size) {
  const c = centerOf(size);
  let best = -1;
  let bestCell = c;
  let bestToCenter = Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = field[y * size + x];
      const d = Math.abs(x - c.x) + Math.abs(y - c.y);
      if (v > best + 1e-12 || (Math.abs(v - best) <= 1e-12 && d < bestToCenter)) {
        best = v;
        bestCell = { x, y };
        bestToCenter = d;
      }
    }
  }
  return bestCell;
}

// ヒント集合（"x,y" の Set）から確率場と焦点を作る。空なら盤中央を焦点にする。
function fieldFromHints(size, hintSet, sigma = 2) {
  const bumps = [...hintSet].map(parseKey);
  if (bumps.length === 0) bumps.push(centerOf(size));
  const field = buildField(size, bumps, sigma);
  return { field, focal: argmaxCell(field, size) };
}

// 確率 epsilon で候補から一様ランダムに選び、そうでなければソフトマックス標本抽出。
// epsilon は「乱数混入率」: 0 で AI 本来の分布、1 で完全ランダム。
function pickWithEpsilon(cands, scores, temperature, epsilon, rng) {
  const eps = epsilon || 0;
  if (eps > 0 && rng() < eps) {
    const idx = Math.min(cands.length - 1, (rng() * cands.length) | 0);
    return { item: cands[idx], index: idx, probs: cands.map(() => 1 / cands.length) };
  }
  return softmaxSample(cands, scores, temperature, rng);
}

// ---- シーカーAI -------------------------------------------------------------
// パラメータ（挙動の調整用）。epsilon は乱数混入率（0=分布通り, 1=完全ランダム）。
export const SEEKER = { alpha: 1.0, beta: 6.0, gammaPath: 0.15, temperature: 0.6, epsilon: 0 };

// 自分が知る情報だけで1手（path: 方向名配列）を返す。動けない場合は null。
// 返り値 { path, end, focal, probs } … probs は移動先候補の確率分布（デバッグ/表示用）。
export function chooseSeekerMove(state, who, rng = Math.random, params = SEEKER) {
  const size = state.size;
  const { field, focal } = fieldFromHints(size, state[who].revealedHints);

  // 端点ごとに集約（同一端点への複数経路は数え、到達しやすさの弱い重みにする）
  const byEnd = new Map(); // endKey -> { end, path, count }
  for (const m of enumerateMoves(state, who)) {
    const k = key(m.end);
    const cur = byEnd.get(k);
    if (cur) cur.count += 1;
    else byEnd.set(k, { end: m.end, path: m.path, count: 1 });
  }
  const cands = [...byEnd.values()];
  if (cands.length === 0) return null; // 囲まれて動けない

  const scores = cands.map((c) => {
    const dist = manhattan(c.end, focal);
    const pMeet = field[c.end.y * size + c.end.x]; // 相手がちょうどそこにいる確率の代理
    return (
      -params.alpha * dist +
      params.beta * pMeet +
      params.gammaPath * Math.log(c.count)
    );
  });
  const { item, probs } = pickWithEpsilon(cands, scores, params.temperature, params.epsilon, rng);
  return { path: item.path, end: item.end, focal, probs };
}

// ---- 王様AI -----------------------------------------------------------------
export const KING = { radius: 4, temperature: 0.5, focalBonus: 2.0, epsilon: 0 };

// 王様の焦点: 両盤面の真の交差（＝シーカーが目指す合流点）。無ければ盤中央。
function kingFocal(state) {
  const { focal } = fieldFromHints(state.size, trueHints(state));
  return focal;
}

// who（次に動くシーカー）の盤面に置くデブリ1マスを返す。置ける所が無ければ null。
export function chooseKingDebris(state, who, rng = Math.random, params = KING) {
  const size = state.size;
  const focal = kingFocal(state);
  const seeker = state[who];
  const steps = seeker.steps; // このシーカーの移動量
  const startIdx = seeker.pos.y * size + seeker.pos.x;

  // 到達端点(index配列)から焦点への最短距離を返す高速版
  const grid = buildBlockedGrid(state, who); // デブリのみ進入不可
  const minDistFocal = (ends) => {
    let m = Infinity;
    for (let i = 0; i < ends.length; i++) {
      const idx = ends[i];
      const x = idx % size;
      const d = Math.abs(x - focal.x) + Math.abs((idx - x) / size - focal.y);
      if (d < m) m = d;
    }
    return m;
  };

  // 妨害しない場合にシーカーが焦点へ最接近できる距離（基準値）
  let base = minDistFocal(reachEndsGrid(size, steps, startIdx, grid));
  if (!Number.isFinite(base)) base = manhattan(seeker.pos, focal); // 既に詰み気味

  // 設置可否はエンジンの規則に一本化（軌跡・既存デブリ・盤外・相手の現在位置を除外）
  const placeable = (x, y) => canPlaceDebris(state, who, { x, y });
  // 候補: シーカー付近の設置可能マス（軌跡・既存デブリ・盤外は除外）
  const cands = [];
  const R = params.radius;
  for (let y = seeker.pos.y - R; y <= seeker.pos.y + R; y++) {
    for (let x = seeker.pos.x - R; x <= seeker.pos.x + R; x++) {
      if (placeable(x, y)) cands.push({ x, y });
    }
  }
  // 付近に空きが無ければ盤面全体から探す（終盤の保険）
  if (cands.length === 0) {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (placeable(x, y)) cands.push({ x, y });
  }
  if (cands.length === 0) return null; // 盤面が埋まっている（実質起こらない）

  const distToFocal = (c) => manhattan(c, focal);
  const scores = cands.map((d) => {
    // d をブロックした時にシーカーが焦点へ最接近できる距離（gridを一時的に立てる）
    const di = d.y * size + d.x;
    grid[di] = 1;
    let best = minDistFocal(reachEndsGrid(size, steps, startIdx, grid));
    grid[di] = 0;
    if (!Number.isFinite(best)) best = base + size; // 完全に詰ませられるなら高評価
    const obstruction = best - base; // >0 なら接近を妨げている
    const nearFocal = params.focalBonus / (1 + distToFocal(d)); // 合流点周辺を固める
    return obstruction + nearFocal;
  });

  const { item } = pickWithEpsilon(cands, scores, params.temperature, params.epsilon, rng);
  return item;
}
