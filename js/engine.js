// 七夕トライアングル — ルールエンジン（純粋・DOM非依存の ES モジュール）
//
// 共有座標グリッド上に織姫・彦星の2駒が存在する。各シーカーは自分の軌跡・自分の
// デブリ・交差ヒントだけを見る別ビューを持ち、王様は両盤面を常に見られる。

// ---- 調整可能な定数（プロトタイプの既定値）----------------------------------
export const DEFAULTS = {
  BOARD_SIZE: 9, // 9x9（座標 0..8）
  STEPS_PER_MOVE: 3, // 1手でちょうど3マス
  MAX_ROUNDS: 7, // 各シーカーが7回移動
  DEBRIS_PER_TURN: 1, // 移動前に王様が置くデブリ数
  START: { orihime: { x: 0, y: 0 }, hikoboshi: { x: 8, y: 8 } },
  INITIAL_CENTER_DEBRIS: true, // 初期状態で両盤の中央にデブリを1個置く
};

// フェーズ
export const PHASE = {
  KING_DEBRIS_ORIHIME: 'KING_DEBRIS_ORIHIME',
  MOVE_ORIHIME: 'MOVE_ORIHIME',
  KING_DEBRIS_HIKOBOSHI: 'KING_DEBRIS_HIKOBOSHI',
  MOVE_HIKOBOSHI: 'MOVE_HIKOBOSHI',
  GAME_OVER: 'GAME_OVER',
};

export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// ---- 座標ユーティリティ -----------------------------------------------------
export const key = (c) => `${c.x},${c.y}`;
export const parseKey = (k) => {
  const [x, y] = k.split(',').map(Number);
  return { x, y };
};
export const eq = (a, b) => a.x === b.x && a.y === b.y;
const inBounds = (c, size) => c.x >= 0 && c.y >= 0 && c.x < size && c.y < size;

// ---- 初期化 -----------------------------------------------------------------
export function createGame(config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  // 初期中央デブリ（開始マス上には置けないので、開始マスと重ならない盤にのみ置く）
  const center = { x: Math.floor(cfg.BOARD_SIZE / 2), y: Math.floor(cfg.BOARD_SIZE / 2) };
  const mkSeeker = (start) => {
    const debris = new Set();
    if (cfg.INITIAL_CENTER_DEBRIS && !eq(start, center)) debris.add(key(center));
    return {
      pos: { ...start },
      trail: new Set([key(start)]), // 開始マスも軌跡に含む
      debris,
      revealedHints: new Set(), // 手番開始時に凍結される交差ヒント
    };
  };
  return {
    size: cfg.BOARD_SIZE,
    stepsPerMove: cfg.STEPS_PER_MOVE,
    maxRounds: cfg.MAX_ROUNDS,
    debrisPerTurn: cfg.DEBRIS_PER_TURN,
    round: 1,
    debrisPlaced: 0, // 現デブリフェーズで置いた個数
    phase: PHASE.KING_DEBRIS_ORIHIME,
    winner: null, // null | 'seekers' | 'king'
    meetingCell: null, // 出会えたマス（シーカー勝ち時）
    orihime: mkSeeker(cfg.START.orihime),
    hikoboshi: mkSeeker(cfg.START.hikoboshi),
  };
}

// ---- 交差ヒント -------------------------------------------------------------
// 両シーカーの軌跡に共通するマスの集合を返す。
export function hints(state) {
  const out = new Set();
  const other = state.hikoboshi.trail;
  for (const k of state.orihime.trail) {
    if (other.has(k)) out.add(k);
  }
  return out;
}

// ---- デブリ設置 -------------------------------------------------------------
// その盤面の軌跡が無い（かつ盤内・未デブリの）マスにのみ置ける。
export function canPlaceDebris(state, who, cell) {
  if (!inBounds(cell, state.size)) return false;
  const s = state[who];
  const k = key(cell);
  return !s.trail.has(k) && !s.debris.has(k);
}

export function placeDebris(state, who, cell) {
  if (state.phase !== debrisPhaseFor(who)) {
    throw new Error(`placeDebris: wrong phase ${state.phase} for ${who}`);
  }
  if (!canPlaceDebris(state, who, cell)) {
    throw new Error(`placeDebris: illegal cell ${key(cell)} on ${who}`);
  }
  state[who].debris.add(key(cell));
  state.debrisPlaced += 1;
  if (state.debrisPlaced >= state.debrisPerTurn) {
    state.debrisPlaced = 0;
    state.phase = movePhaseFor(who);
    // 「移動前」の唯一のヒント更新点。ここで凍結し、移動中・移動後は変えない。
    state[who].revealedHints = hints(state);
  }
  return state;
}

function debrisPhaseFor(who) {
  return who === 'orihime'
    ? PHASE.KING_DEBRIS_ORIHIME
    : PHASE.KING_DEBRIS_HIKOBOSHI;
}
function movePhaseFor(who) {
  return who === 'orihime' ? PHASE.MOVE_ORIHIME : PHASE.MOVE_HIKOBOSHI;
}

// ---- 移動 -------------------------------------------------------------------
// 1ステップが盤内かつ非デブリか（自軌跡の重複は許可）。
export function legalStep(state, who, from, dir) {
  const to = { x: from.x + dir.x, y: from.y + dir.y };
  if (!inBounds(to, state.size)) return null;
  if (state[who].debris.has(key(to))) return null;
  return to;
}

// 現在位置から合法な次の1マス候補（方向名の配列）を返す。
export function legalDirs(state, who, from) {
  return Object.entries(DIRS)
    .filter(([, d]) => legalStep(state, who, from, d) !== null)
    .map(([name]) => name);
}

// ちょうど stepsPerMove マスの経路が最後まで合法に組めるか（囲まれ検出用）。
export function hasAnyLegalMove(state, who) {
  const dfs = (from, depth) => {
    if (depth === 0) return true;
    for (const d of Object.values(DIRS)) {
      const to = legalStep(state, who, from, d);
      if (to && dfs(to, depth - 1)) return true;
    }
    return false;
  };
  return dfs(state[who].pos, state.stepsPerMove);
}

// ちょうど stepsPerMove マスの合法な経路を全列挙する（重複端点含む）。
// opts.blocked: 追加でブロック扱いする "x,y" の Set（王様AIの評価用）。
// 返り値: [{ end:{x,y}, path:[dirName,...] }, ...]（最大 4^stepsPerMove 通り）。
export function enumerateMoves(state, who, opts = {}) {
  const extra = opts.blocked || null;
  const blocked = (c) =>
    state[who].debris.has(key(c)) || (extra && extra.has(key(c)));
  const results = [];
  const acc = [];
  const dfs = (from, depth) => {
    if (depth === 0) {
      results.push({ end: from, path: acc.slice() });
      return;
    }
    for (const [name, d] of Object.entries(DIRS)) {
      const to = { x: from.x + d.x, y: from.y + d.y };
      if (!inBounds(to, state.size) || blocked(to)) continue;
      acc.push(name);
      dfs(to, depth - 1);
      acc.pop();
    }
  };
  dfs(state[who].pos, state.stepsPerMove);
  return results;
}

// 到達可能な着地マスの集合（"x,y" の Set）。opts.blocked は enumerateMoves と同じ。
export function reachableEndSet(state, who, opts = {}) {
  const set = new Set();
  for (const m of enumerateMoves(state, who, opts)) set.add(key(m.end));
  return set;
}

// path: 各要素が方向名 or {x,y} の配列。長さは stepsPerMove。
// 検証して trail/pos を更新し、勝敗判定・フェーズ/ラウンドを進める。
export function applyMove(state, who, path) {
  if (state.phase !== movePhaseFor(who)) {
    throw new Error(`applyMove: wrong phase ${state.phase} for ${who}`);
  }
  if (!Array.isArray(path) || path.length !== state.stepsPerMove) {
    throw new Error(`applyMove: path must have length ${state.stepsPerMove}`);
  }
  const s = state[who];
  let cur = s.pos;
  const visited = [];
  for (const step of path) {
    const dir = typeof step === 'string' ? DIRS[step] : dirBetween(cur, step);
    if (!dir) throw new Error(`applyMove: illegal step ${JSON.stringify(step)}`);
    const to = legalStep(state, who, cur, dir);
    if (!to) throw new Error(`applyMove: blocked step from ${key(cur)}`);
    cur = to;
    visited.push(to);
  }
  // 軌跡に追記、駒を移動
  for (const c of visited) s.trail.add(key(c));
  s.pos = cur;

  // 勝敗判定（同座標停止でシーカー勝ち）
  if (checkMeeting(state)) {
    state.winner = 'seekers';
    state.meetingCell = { ...state.orihime.pos };
    state.phase = PHASE.GAME_OVER;
    return state;
  }
  advancePhase(state);
  return state;
}

function dirBetween(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const d of Object.values(DIRS)) {
    if (d.x === dx && d.y === dy) return d;
  }
  return null; // 隣接していない
}

export function checkMeeting(state) {
  return eq(state.orihime.pos, state.hikoboshi.pos);
}

// フェーズ遷移。MAX_ROUNDS 到達で王様勝ち。
export function advancePhase(state) {
  switch (state.phase) {
    case PHASE.MOVE_ORIHIME:
      state.phase = PHASE.KING_DEBRIS_HIKOBOSHI;
      break;
    case PHASE.MOVE_HIKOBOSHI:
      if (state.round >= state.maxRounds) {
        state.winner = 'king';
        state.phase = PHASE.GAME_OVER;
      } else {
        state.round += 1;
        state.phase = PHASE.KING_DEBRIS_ORIHIME;
      }
      break;
    default:
      throw new Error(`advancePhase: not a move phase (${state.phase})`);
  }
  return state;
}

// 現在移動すべきシーカー（デブリ/移動フェーズ問わず）を返す。
export function activeSeeker(state) {
  if (
    state.phase === PHASE.KING_DEBRIS_ORIHIME ||
    state.phase === PHASE.MOVE_ORIHIME
  )
    return 'orihime';
  if (
    state.phase === PHASE.KING_DEBRIS_HIKOBOSHI ||
    state.phase === PHASE.MOVE_HIKOBOSHI
  )
    return 'hikoboshi';
  return null;
}

// 移動フェーズで合法な3マス経路が皆無なら王様勝ちで決着させる。
export function resolveStuck(state) {
  if (!isMovePhase(state)) throw new Error('resolveStuck: not a move phase');
  state.winner = 'king';
  state.phase = PHASE.GAME_OVER;
  return state;
}

export const isDebrisPhase = (state) =>
  state.phase === PHASE.KING_DEBRIS_ORIHIME ||
  state.phase === PHASE.KING_DEBRIS_HIKOBOSHI;
export const isMovePhase = (state) =>
  state.phase === PHASE.MOVE_ORIHIME || state.phase === PHASE.MOVE_HIKOBOSHI;
