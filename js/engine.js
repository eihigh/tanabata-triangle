// 七夕トライアングル — ルールエンジン（純粋・DOM非依存の ES モジュール）
//
// 共有座標グリッド上に織姫・彦星の2駒が存在する。各シーカーは自分の軌跡・自分の
// デブリ・交差ヒントだけを見る別ビューを持ち、王様は両盤面を常に見られる。

// ---- 調整可能な定数（既定＝ゲーム開始画面の初期選択に一致）------------------
export const DEFAULTS = {
  BOARD_SIZE: 7, // 7x7（座標 0..6）
  STEPS_PER_MOVE: 3, // STEPS 未指定シーカーのフォールバック移動量（固定）
  // 既定の移動量（織姫=1d4 / 彦星=1d6）。
  // 数値 or 'd4'/'d6'。省略時は STEPS_PER_MOVE にフォールバック。
  STEPS: { orihime: 'd4', hikoboshi: 'd6' },
  // 出目の公開範囲（既定: 全員に公開）。'all' | 'king' | 'none'。
  PUBLIC_ROLLS: 'all',
  MAX_ROUNDS: 7, // 各シーカーが7回移動
  DEBRIS_PER_TURN: 1, // 移動前に王様が置くデブリ数
  // 初日（ラウンド1）のみ各デブリフェーズで置ける個数。未指定なら DEBRIS_PER_TURN と同じ。
  // 2 にすると「初日のみ王様が2個置ける（＝中央1固定＋初期デブリ2を自由配置できる）」ルール。
  FIRST_ROUND_DEBRIS: null,
  // START を省略すると開始位置は盤の対角コーナー。STEPS: { orihime, hikoboshi } で移動量を上書き。
  // 初期状態で両盤の中央付近に置くデブリ。true→1個、数値→その個数を中心に固めて配置、
  // false/0→無し（両盤で同一配置なのでシーカー二人にとって共通知識）。
  INITIAL_CENTER_DEBRIS: true,
};

// 中心から近い順（マンハッタン距離→固定タイブレーク）に count マスのクラスタ座標を返す。
// 1=中心, 3=中心＋左右, 5=十字（中心＋上下左右）…と中心に固まって広がる。
export function centerClusterCells(size, count) {
  const c = { x: Math.floor(size / 2), y: Math.floor(size / 2) };
  const order = [
    { x: 0, y: 0 }, // 中心
    { x: 1, y: 0 }, { x: -1, y: 0 }, // 左右
    { x: 0, y: 1 }, { x: 0, y: -1 }, // 上下（→十字で5個）
    { x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }, // 角
  ];
  const cells = [];
  for (const o of order) {
    if (cells.length >= count) break;
    const p = { x: c.x + o.x, y: c.y + o.y };
    if (p.x >= 0 && p.y >= 0 && p.x < size && p.y < size) cells.push(p);
  }
  return cells;
}

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

// ---- 移動量スペック（固定 or ダイス）---------------------------------------
// 数値 → 固定n。文字列 'd4'/'1d4'/'d6'/'2' → ダイス/固定。{kind,...} はそのまま。
export function parseStepSpec(v, fallback) {
  if (v == null) return parseStepSpec(fallback, 3);
  if (typeof v === 'number') return { kind: 'fixed', n: v };
  if (typeof v === 'object' && v.kind) return v;
  const s = String(v).trim().toLowerCase();
  const dice = /^(\d+)?d(\d+)$/.exec(s);
  if (dice) return { kind: 'dice', faces: parseInt(dice[2], 10) };
  if (/^\d+$/.test(s)) return { kind: 'fixed', n: parseInt(s, 10) };
  throw new Error(`parseStepSpec: bad spec ${v}`);
}
// このスペックで取りうる最大歩数（候補生成の上限などに使用）。
export const maxStep = (spec) => (spec.kind === 'dice' ? spec.faces : spec.n);

// ---- 出目の可視性スペック ---------------------------------------------------
// 'all'  … 王様も相手シーカーも出目を知る（既定）
// 'king' … 王様だけが出目を知る（相手シーカーは知らない）
// 'none' … 出目は本人のみ（王様も相手シーカーも知らない）
// 後方互換: PUBLIC_ROLLS が true→'all' / false→'none' / 未指定→'all'。
export function normalizeRollVisibility(v) {
  if (v == null || v === true) return 'all';
  if (v === false) return 'none';
  const s = String(v).trim().toLowerCase();
  if (s === 'all' || s === 'king' || s === 'none') return s;
  throw new Error(`normalizeRollVisibility: bad value ${v}`);
}
// 1手の歩数を決める。固定は rng 不使用（決定的）、ダイスは 1..faces を一様に。
export function rollStep(spec, rng) {
  return spec.kind === 'dice' ? 1 + Math.floor(rng() * spec.faces) : spec.n;
}
// who の今手番の歩数を振り直す（手番開始時に呼ぶ）。
export function rollFor(state, who) {
  state[who].steps = rollStep(state[who].stepSpec, state.rng);
  return state[who].steps;
}

// ---- 初期化 -----------------------------------------------------------------
export function createGame(config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const size = cfg.BOARD_SIZE;
  const rng = config.rng || Math.random;
  // 開始位置: 指定が無ければ盤の対角コーナー（盤サイズに追従）
  const start = config.START || {
    orihime: { x: 0, y: 0 },
    hikoboshi: { x: size - 1, y: size - 1 },
  };
  // 移動量スペック: 指定が無ければ DEFAULTS.STEPS（既定の d4/d6）、それも無ければ STEPS_PER_MOVE。
  // config.STEPS は「盤全体を丸ごと上書き」なので、片側だけ指定した場合の他方は STEPS_PER_MOVE に戻る。
  const stepsCfg = cfg.STEPS || {};
  const specFor = (who) => parseStepSpec(stepsCfg[who], cfg.STEPS_PER_MOVE);
  // 初期中央デブリ（中心に固めて配置。開始マス上には置けないので、その盤では該当マスを除く）
  const centerCount =
    cfg.INITIAL_CENTER_DEBRIS === true ? 1 : Math.max(0, Number(cfg.INITIAL_CENTER_DEBRIS) || 0);
  const centerCells = centerClusterCells(size, centerCount);
  // 共通知識: 初期中央デブリは両盤に同一配置（配置規則・個数は公開）なので、
  // 「相手はそのマスに停止できない」という事実をシーカー双方が知る。信念分布の除外に使う。
  const commonDebris = new Set();
  for (const cell of centerCells) {
    if (!eq(cell, start.orihime) && !eq(cell, start.hikoboshi)) commonDebris.add(key(cell));
  }
  const mkSeeker = (pos, spec) => {
    const debris = new Set();
    for (const cell of centerCells) if (!eq(pos, cell)) debris.add(key(cell));
    return {
      pos: { ...pos },
      stepSpec: spec, // 移動量スペック（固定/ダイス）
      steps: rollStep(spec, rng), // 今手番の歩数（ダイスは毎手番振り直す）
      traveled: 0, // 累積移動歩数（公開情報。信念分布の到達判定に使う）
      trail: new Set([key(pos)]), // 開始マスも軌跡に含む
      debris,
      revealedHints: new Set(), // 手番開始時に凍結される交差ヒント
    };
  };
  return {
    size,
    rng, // ダイス用の乱数源（既定 Math.random、テスト/シミュは差し替え可）
    // 出目（＝累積歩数）の可視性。既定 'all'（全員に公開）。'all'=王様も相手シーカーも知る、
    // 'king'=王様だけが知る、'none'=本人のみ。AIは知らない側では相手の traveled を
    // 使わず分布で推論する。
    rollVisibility: normalizeRollVisibility(cfg.PUBLIC_ROLLS),
    // 後方互換: 出目が全公開かどうかの真偽値。
    publicRolls: normalizeRollVisibility(cfg.PUBLIC_ROLLS) === 'all',
    stepsPerMove: cfg.STEPS_PER_MOVE, // 既定移動量（表示・参照用）
    // 開始位置は公開のゲーム設定（隠し情報ではない）。シーカーAIが相手の
    // 到達可能範囲を推論するために参照してよい。
    starts: {
      orihime: { ...start.orihime },
      hikoboshi: { ...start.hikoboshi },
    },
    // 共通知識の初期中央デブリ（両盤同一）。シーカーAIは「相手はここに
    // 停止できない」という正当な公開情報として信念分布から除外してよい。
    commonDebris,
    maxRounds: cfg.MAX_ROUNDS,
    debrisPerTurn: cfg.DEBRIS_PER_TURN,
    // 初日（ラウンド1）のデブリ許容数（未指定なら通常と同じ）。
    firstRoundDebris: cfg.FIRST_ROUND_DEBRIS ?? cfg.DEBRIS_PER_TURN,
    round: 1,
    debrisPlaced: 0, // 現デブリフェーズで置いた個数
    phase: PHASE.KING_DEBRIS_ORIHIME,
    winner: null, // null | 'seekers' | 'king'
    meetingCell: null, // 出会えたマス（シーカー勝ち時）
    orihime: mkSeeker(start.orihime, specFor('orihime')),
    hikoboshi: mkSeeker(start.hikoboshi, specFor('hikoboshi')),
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
// さらに、相手シーカーの「現在位置」には置けない。ここを塞げると合流点を毎ターン
// 封鎖してシーカーを絶対に勝たせない必勝手になってしまうため（致命的問題の修正）。
export function canPlaceDebris(state, who, cell) {
  if (!inBounds(cell, state.size)) return false;
  const s = state[who];
  const k = key(cell);
  if (s.trail.has(k) || s.debris.has(k)) return false;
  const other = who === 'orihime' ? 'hikoboshi' : 'orihime';
  if (eq(cell, state[other].pos)) return false; // 相手の現在位置は禁じ手
  return true;
}

// 現在の手番で王様が置けるデブリ数（初日=ラウンド1のみ firstRoundDebris、以降は debrisPerTurn）。
export function debrisAllowance(state) {
  return state.round === 1 ? state.firstRoundDebris : state.debrisPerTurn;
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
  if (state.debrisPlaced >= debrisAllowance(state)) {
    state.debrisPlaced = 0;
    state.phase = movePhaseFor(who);
    // ヒントは手番開始（デブリフェーズ入り）で凍結済み。デブリ設置は軌跡を変えないので
    // ここでは更新しない（配置中・移動中・移動後で同じヒントを見せる）。
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
  return dfs(state[who].pos, state[who].steps);
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
  dfs(state[who].pos, state[who].steps);
  return results;
}

// ---- 高速到達判定（AI/シミュレータ用・文字列や経路配列を作らない）----------
// 世代スタンプ式の訪問済みグリッド（層ごとに再利用、再帰・確保を避ける）。
let _vis = null;
let _visN = 0;
let _gen = 0;
function ensureVis(N) {
  if (_visN !== N) {
    _vis = new Int32Array(N * N);
    _visN = N;
    _gen = 0;
  }
}

// blocked: Uint8Array(N*N)（1=進入不可）。startIdx から「ちょうど steps 手」で
// 到達できるマスの index 配列を返す（重複なし、盤外/ブロックは除外、自マス折返し可）。
export function reachEndsGrid(N, steps, startIdx, blocked) {
  ensureVis(N);
  let frontier = [startIdx];
  for (let s = 0; s < steps; s++) {
    _gen++;
    const next = [];
    for (let i = 0; i < frontier.length; i++) {
      const c = frontier[i];
      const cx = c % N;
      const cy = (c - cx) / N;
      let n;
      if (cy > 0 && !blocked[(n = c - N)] && _vis[n] !== _gen) { _vis[n] = _gen; next.push(n); }
      if (cy < N - 1 && !blocked[(n = c + N)] && _vis[n] !== _gen) { _vis[n] = _gen; next.push(n); }
      if (cx > 0 && !blocked[(n = c - 1)] && _vis[n] !== _gen) { _vis[n] = _gen; next.push(n); }
      if (cx < N - 1 && !blocked[(n = c + 1)] && _vis[n] !== _gen) { _vis[n] = _gen; next.push(n); }
    }
    frontier = next;
  }
  return frontier;
}

// who の盤面のデブリから進入不可グリッド(Uint8Array)を作る（軌跡は進入可なので含めない）。
export function buildBlockedGrid(state, who) {
  const N = state.size;
  const g = new Uint8Array(N * N);
  for (const k of state[who].debris) {
    const c = parseKey(k);
    g[c.y * N + c.x] = 1;
  }
  return g;
}

// 到達可能な着地マスの集合（"x,y" の Set）。opts.blocked は追加ブロックの Set。
export function reachableEndSet(state, who, opts = {}) {
  const N = state.size;
  const g = buildBlockedGrid(state, who);
  if (opts.blocked) for (const k of opts.blocked) {
    const c = parseKey(k);
    g[c.y * N + c.x] = 1;
  }
  const start = state[who].pos.y * N + state[who].pos.x;
  const set = new Set();
  for (const idx of reachEndsGrid(N, state[who].steps, start, g)) {
    set.add(`${idx % N},${(idx - (idx % N)) / N}`);
  }
  return set;
}

// path: 各要素が方向名 or {x,y} の配列。長さは stepsPerMove。
// 検証して trail/pos を更新し、勝敗判定・フェーズ/ラウンドを進める。
export function applyMove(state, who, path) {
  if (state.phase !== movePhaseFor(who)) {
    throw new Error(`applyMove: wrong phase ${state.phase} for ${who}`);
  }
  if (!Array.isArray(path) || path.length !== state[who].steps) {
    throw new Error(`applyMove: path must have length ${state[who].steps}`);
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
  // 軌跡に追記、駒を移動、累積歩数を加算（公開情報）
  for (const c of visited) s.trail.add(key(c));
  s.pos = cur;
  s.traveled += s.steps;

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
// 王様デブリフェーズに入る＝そのシーカーの手番開始なので、ここで出目を振り、
// 交差ヒントを凍結する（王様のデブリ配置中から、その手番に開示されるヒントが見える）。
export function advancePhase(state) {
  switch (state.phase) {
    case PHASE.MOVE_ORIHIME:
      state.phase = PHASE.KING_DEBRIS_HIKOBOSHI;
      rollFor(state, 'hikoboshi');
      state.hikoboshi.revealedHints = hints(state);
      break;
    case PHASE.MOVE_HIKOBOSHI:
      if (state.round >= state.maxRounds) {
        state.winner = 'king';
        state.phase = PHASE.GAME_OVER;
      } else {
        state.round += 1;
        state.phase = PHASE.KING_DEBRIS_ORIHIME;
        rollFor(state, 'orihime');
        state.orihime.revealedHints = hints(state);
      }
      break;
    default:
      throw new Error(`advancePhase: not a move phase (${state.phase})`);
  }
  return state;
}

// who が完了した移動数（公開情報: 手番構造から導出できる）。
// ラウンド r 中、織姫は自分のデブリ/移動フェーズ時点で r-1 手済・以降 r 手済。
// 彦星はラウンド末に動くため、ラウンド r 内のどのフェーズでも r-1 手済。
export function movesSoFar(state, who) {
  const beforeOrihimeMoved =
    state.phase === PHASE.KING_DEBRIS_ORIHIME ||
    state.phase === PHASE.MOVE_ORIHIME;
  if (who === 'orihime') return beforeOrihimeMoved ? state.round - 1 : state.round;
  return state.round - 1;
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
