// AI 単体テスト（Node で実行: `node tests/ai.test.mjs`）
import {
  createGame,
  placeDebris,
  applyMove,
  canPlaceDebris,
  enumerateMoves,
  reachableEndSet,
  key,
  PHASE,
} from '../js/engine.js';
import {
  mulberry32,
  chooseSeekerMove,
  chooseKingDebris,
  buildOpponentBelief,
  SEEKER,
  KING,
} from '../js/ai.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// --- enumerateMoves / reachableEndSet ---------------------------------------
{
  const g = createGame({ START: { orihime: { x: 0, y: 0 }, hikoboshi: { x: 8, y: 8 } } });
  const moves = enumerateMoves(g, 'orihime');
  ok(moves.length > 0, 'enumerate returns moves');
  ok(moves.every((m) => m.path.length === 3), 'all paths length 3');
  // 角 (0,0) からは盤外へ出ない端点のみ
  ok(moves.every((m) => m.end.x >= 0 && m.end.y >= 0 && m.end.x < 9 && m.end.y < 9), 'ends in bounds');
  // ブロック指定が効く
  const withBlock = reachableEndSet(g, 'orihime', { blocked: new Set(['1,0']) });
  const noBlock = reachableEndSet(g, 'orihime');
  ok(noBlock.size >= withBlock.size, 'blocking does not increase reachable set');
}

// --- シーカーAI: 合法手を返す・再現性がある -------------------------------
{
  const g = createGame();
  placeDebris(g, 'orihime', chooseKingDebris(g, 'orihime', mulberry32(1))); // 王様AIで1個置く→MOVE_ORIHIME
  ok(g.phase === PHASE.MOVE_ORIHIME, 'advanced to orihime move');

  const res = chooseSeekerMove(g, 'orihime', mulberry32(42));
  ok(res && Array.isArray(res.path) && res.path.length === 3, 'seeker returns 3-step path');
  ok(Math.abs(res.probs.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'move distribution sums to 1');
  ok(res.probs.every((p) => p >= 0), 'probabilities non-negative');

  // 同じ seed なら同じ手（再現性）
  const a = chooseSeekerMove(g, 'orihime', mulberry32(7)).path.join(',');
  const b = chooseSeekerMove(g, 'orihime', mulberry32(7)).path.join(',');
  ok(a === b, 'same seed -> same move');

  // 返した手は実際に適用できる（合法）
  const g2 = createGame();
  placeDebris(g2, 'orihime', chooseKingDebris(g2, 'orihime', mulberry32(1)));
  const move = chooseSeekerMove(g2, 'orihime', mulberry32(42));
  applyMove(g2, 'orihime', move.path); // throw しなければ合法
  ok(g2.phase === PHASE.KING_DEBRIS_HIKOBOSHI, 'applied AI move advances phase');
}

// --- 信念分布: 到達可能性・パリティ・負の情報 -------------------------------
{
  // 織姫視点。彦星は (8,8) 開始・移動3・まだ0手（round1 織姫の移動前）
  const g = createGame();
  placeDebris(g, 'orihime', { x: 5, y: 0 }); // MOVE_ORIHIME へ
  const b = buildOpponentBelief(g, 'orihime');
  const N = g.size;
  ok(Math.abs([...b].reduce((a, v) => a + v, 0) - 1) < 1e-9, 'belief sums to 1');
  ok(b[8 * N + 8] > 0.99, '0 moves -> opponent exactly at start');
  ok(b[0] === 0, 'far cell excluded by reach constraint');
}
{
  // 1手（3マス）後: 距離3以内かつパリティの合うマスのみ
  const g = createGame();
  placeDebris(g, 'orihime', { x: 5, y: 0 });
  applyMove(g, 'orihime', ['down', 'down', 'down']);
  placeDebris(g, 'hikoboshi', { x: 0, y: 5 });
  applyMove(g, 'hikoboshi', ['up', 'up', 'up']); // 彦星1手済
  placeDebris(g, 'orihime', { x: 5, y: 1 }); // round2 織姫移動前
  const b = buildOpponentBelief(g, 'orihime');
  const N = g.size;
  ok(b[8 * N + 8] === 0, 'parity: cannot be back at start after odd steps (3)');
  ok(b[5 * N + 8] > 0, 'distance-3 cell (8,5) possible');
  ok(b[6 * N + 8] === 0, 'parity-mismatch cell (8,6) excluded');
  ok(b[4 * N + 8] === 0, 'cell beyond reach (8,4) excluded');
  ok(b[0 * N + 0] === 0, 'far corner excluded');
  // 負の情報: 自分の軌跡（ヒント無し）に相手はいない
  for (const k of g.orihime.trail) {
    if (!g.orihime.revealedHints.has(k)) {
      const [x, y] = k.split(',').map(Number);
      ok(b[y * N + x] === 0, `negative info: own non-hint trail cell ${k} excluded`);
    }
  }
}

// --- シーカーAI: ヒント方向へ寄る傾向（低温で貪欲） -------------------------
{
  // 織姫 (0,4)・彦星 (8,4)。ヒントを右側に人工設定 → 焦点は右 → 右へ寄るはず
  const g = createGame({ START: { orihime: { x: 0, y: 4 }, hikoboshi: { x: 8, y: 4 } } });
  placeDebris(g, 'orihime', { x: 0, y: 0 });
  g.orihime.revealedHints = new Set(['6,4', '7,4']);
  const greedy = chooseSeekerMove(g, 'orihime', mulberry32(1), { ...SEEKER, temperature: 0.01 });
  ok(greedy.end.x > 0, 'greedy move heads toward hint (rightward)');
  ok(greedy.focal.x >= 5, 'focal near the hint cluster');
}

// --- ぐるぐる解消: 軌跡のユニークマス数が移動に応じて増える -----------------
{
  const g = createGame();
  const rng = mulberry32(777);
  // 3ラウンド分（各シーカー3手）進める
  for (let r = 0; r < 3; r++) {
    placeDebris(g, 'orihime', chooseKingDebris(g, 'orihime', rng, { ...KING, epsilon: 0 }));
    applyMove(g, 'orihime', chooseSeekerMove(g, 'orihime', rng, { ...SEEKER, epsilon: 0 }).path);
    if (g.phase === PHASE.GAME_OVER) break;
    placeDebris(g, 'hikoboshi', chooseKingDebris(g, 'hikoboshi', rng, { ...KING, epsilon: 0 }));
    applyMove(g, 'hikoboshi', chooseSeekerMove(g, 'hikoboshi', rng, { ...SEEKER, epsilon: 0 }).path);
    if (g.phase === PHASE.GAME_OVER) break;
  }
  if (g.phase !== PHASE.GAME_OVER) {
    // 3手（9マス通過）で開始1マス+9マス中、少なくとも 1+1.5×3 = 5.5 → 6ユニーク以上
    ok(g.orihime.trail.size >= 6, `orihime explores (trail ${g.orihime.trail.size} >= 6)`);
    ok(g.hikoboshi.trail.size >= 6, `hikoboshi explores (trail ${g.hikoboshi.trail.size} >= 6)`);
  } else {
    ok(true, 'game ended early (meeting) — exploration moot');
    ok(true, 'game ended early (meeting) — exploration moot');
  }
}

// --- 王様AI: 即負け脅威の遮断 ------------------------------------------------
{
  // 織姫(0,0)・彦星(0,3): 織姫は up... いや down×3 の一本道で彦星に着地できる脅威。
  // 3マスちょうどで (0,3) に到達する経路は (0,1)(0,2) を通る直進のみ。
  // 王様はどちらかを塞いで脅威を断つはず。
  const g = createGame({
    START: { orihime: { x: 0, y: 0 }, hikoboshi: { x: 0, y: 3 } },
    INITIAL_CENTER_DEBRIS: false,
  });
  const cell = chooseKingDebris(g, 'orihime', mulberry32(5), { ...KING, temperature: 0.01, epsilon: 0 });
  const k = key(cell);
  ok(k === '0,1' || k === '0,2', `king cuts the only landing corridor (got ${k})`);
}

// --- 王様AI: 設置可能マスを返す・再現性 -----------------------------------
{
  const g = createGame();
  const cell = chooseKingDebris(g, 'orihime', mulberry32(3));
  ok(cell && canPlaceDebris(g, 'orihime', cell), 'king returns a placeable cell');
  ok(key(cell) !== '4,4', 'king does not pick the occupied center');

  const c1 = key(chooseKingDebris(g, 'orihime', mulberry32(9)));
  const c2 = key(chooseKingDebris(g, 'orihime', mulberry32(9)));
  ok(c1 === c2, 'same seed -> same debris cell');

  // 相手シーカーの現在位置は絶対に選ばない（致命的手の禁止）
  {
    const g2 = createGame(); // 彦星(8,8)
    let hit = false;
    for (let s = 0; s < 60; s++) {
      const c = chooseKingDebris(g2, 'orihime', mulberry32(1000 + s));
      if (c.x === g2.hikoboshi.pos.x && c.y === g2.hikoboshi.pos.y) hit = true;
    }
    ok(!hit, 'king never places on opponent current position');
  }

  // 実際に置ける
  placeDebris(g, 'orihime', chooseKingDebris(g, 'orihime', mulberry32(3)));
  ok(g.phase === PHASE.MOVE_ORIHIME, 'king debris applied, advanced to move');
}

// --- 通し: 全AIで最後まで進行しクラッシュしない -----------------------------
{
  const g = createGame({ MAX_ROUNDS: 7 });
  const rng = mulberry32(123);
  let guard = 0;
  while (g.phase !== PHASE.GAME_OVER && guard++ < 100) {
    if (g.phase === PHASE.KING_DEBRIS_ORIHIME) placeDebris(g, 'orihime', chooseKingDebris(g, 'orihime', rng));
    else if (g.phase === PHASE.KING_DEBRIS_HIKOBOSHI) placeDebris(g, 'hikoboshi', chooseKingDebris(g, 'hikoboshi', rng));
    else if (g.phase === PHASE.MOVE_ORIHIME) {
      const m = chooseSeekerMove(g, 'orihime', rng);
      applyMove(g, 'orihime', m.path);
    } else if (g.phase === PHASE.MOVE_HIKOBOSHI) {
      const m = chooseSeekerMove(g, 'hikoboshi', rng);
      applyMove(g, 'hikoboshi', m.path);
    }
  }
  ok(g.phase === PHASE.GAME_OVER, 'all-AI game reaches game over');
  ok(g.winner === 'seekers' || g.winner === 'king', 'a winner is decided');
}

// --- 通し: バリアント（7x7・織姫移動2）でも全AIで決着する ------------------
{
  const g = createGame({ BOARD_SIZE: 7, STEPS: { orihime: 2 }, MAX_ROUNDS: 7 });
  const rng = mulberry32(55);
  let guard = 0;
  while (g.phase !== PHASE.GAME_OVER && guard++ < 100) {
    const who = g.phase.includes('ORIHIME') ? 'orihime' : 'hikoboshi';
    if (g.phase.startsWith('KING_DEBRIS')) placeDebris(g, who, chooseKingDebris(g, who, rng));
    else {
      const m = chooseSeekerMove(g, who, rng);
      ok(m.path.length === g[who].steps, `${who} AI path matches its step count`);
      applyMove(g, who, m.path);
    }
  }
  ok(g.phase === PHASE.GAME_OVER, 'variant all-AI game reaches game over');
}

// --- ダイス: 全AIで決着し、AIの経路長が毎手番の出目に一致する ---------------
{
  const g = createGame({ STEPS: { orihime: 'd6', hikoboshi: 'd4' }, MAX_ROUNDS: 7, rng: mulberry32(2024) });
  const rng = mulberry32(999);
  let guard = 0;
  while (g.phase !== PHASE.GAME_OVER && guard++ < 100) {
    const who = g.phase.includes('ORIHIME') ? 'orihime' : 'hikoboshi';
    if (g.phase.startsWith('KING_DEBRIS')) placeDebris(g, who, chooseKingDebris(g, who, rng));
    else {
      const m = chooseSeekerMove(g, who, rng);
      ok(m.path.length === g[who].steps, `dice AI path length == current roll (${g[who].steps})`);
      applyMove(g, who, m.path);
    }
  }
  ok(g.phase === PHASE.GAME_OVER, 'dice all-AI game reaches game over');
}

// --- ダイス相手の belief は traveled 基準の到達＋パリティで絞る ---------------
{
  const g = createGame({ STEPS: { orihime: 'd6', hikoboshi: 'd6' }, rng: mulberry32(5) });
  const rng = mulberry32(5);
  placeDebris(g, 'orihime', chooseKingDebris(g, 'orihime', rng));
  applyMove(g, 'orihime', chooseSeekerMove(g, 'orihime', rng).path);
  placeDebris(g, 'hikoboshi', chooseKingDebris(g, 'hikoboshi', rng));
  applyMove(g, 'hikoboshi', chooseSeekerMove(g, 'hikoboshi', rng).path);
  placeDebris(g, 'orihime', chooseKingDebris(g, 'orihime', rng)); // round2 織姫手番前
  const b = buildOpponentBelief(g, 'orihime');
  const N = g.size;
  const T = g.hikoboshi.traveled;
  const p0 = g.starts.hikoboshi;
  let respects = true;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const d0 = Math.abs(x - p0.x) + Math.abs(y - p0.y);
      if (b[y * N + x] > 0 && (d0 > T || (T - d0) % 2 !== 0)) respects = false;
    }
  ok(T >= 1, 'opponent has traveled at least 1');
  ok(respects, 'dice belief respects traveled reach + parity');
}

// --- 非公開ダイス: belief は k*faces 上界のみ・パリティ制約を外す ------------
{
  // 公開: 相手 traveled 基準で厳密（パリティで約半分除外）
  // 非公開: 上界 k*faces のみ → 許容マスが増える（パリティ除外なし）
  const pub = createGame({ STEPS: { hikoboshi: 'd6' }, rng: mulberry32(3) });
  const prv = createGame({ STEPS: { hikoboshi: 'd6' }, PUBLIC_ROLLS: false, rng: mulberry32(3) });
  // 同じ手順で1ラウンド進める（同seedのgame rngで出目も一致）
  for (const g of [pub, prv]) {
    const rng = mulberry32(11);
    placeDebris(g, 'orihime', chooseKingDebris(g, 'orihime', rng));
    applyMove(g, 'orihime', chooseSeekerMove(g, 'orihime', rng).path);
    placeDebris(g, 'hikoboshi', chooseKingDebris(g, 'hikoboshi', rng));
    applyMove(g, 'hikoboshi', chooseSeekerMove(g, 'hikoboshi', rng).path);
    placeDebris(g, 'orihime', chooseKingDebris(g, 'orihime', rng));
  }
  const bPub = buildOpponentBelief(pub, 'orihime');
  const bPrv = buildOpponentBelief(prv, 'orihime');
  const nz = (b) => [...b].filter((v) => v > 0).length;
  ok(pub.publicRolls === true && prv.publicRolls === false, 'publicRolls flag set');
  ok(nz(bPrv) > nz(bPub), `private belief is fuzzier (nz ${nz(bPrv)} > ${nz(bPub)})`);
}

// --- 非公開ダイスでも全AIで決着する ------------------------------------------
{
  const g = createGame({ STEPS: { orihime: 'd6', hikoboshi: 'd4' }, PUBLIC_ROLLS: false, rng: mulberry32(7) });
  const rng = mulberry32(7);
  let guard = 0;
  while (g.phase !== PHASE.GAME_OVER && guard++ < 100) {
    const who = g.phase.includes('ORIHIME') ? 'orihime' : 'hikoboshi';
    if (g.phase.startsWith('KING_DEBRIS')) placeDebris(g, who, chooseKingDebris(g, who, rng));
    else applyMove(g, who, chooseSeekerMove(g, who, rng).path);
  }
  ok(g.phase === PHASE.GAME_OVER, 'private-rolls all-AI game reaches game over');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
