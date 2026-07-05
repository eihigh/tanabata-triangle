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

// --- シーカーAI: ヒント方向へ寄る傾向（温度0で貪欲） -----------------------
{
  // 織姫 (0,4) に対しヒントを (6,4) 付近に置くと、焦点は右側 → 右へ寄るはず
  const g = createGame({ START: { orihime: { x: 0, y: 4 }, hikoboshi: { x: 8, y: 4 } } });
  // 王様デブリを遠くに置いて MOVE へ
  placeDebris(g, 'orihime', { x: 0, y: 0 });
  // 手番開始スナップショットを人工的に設定（右側にヒント）
  g.orihime.revealedHints = new Set(['6,4', '7,4']);
  // 温度を極小にすると分布はほぼ最良手に集中する → 実RNGで最良手が選ばれる
  const greedy = chooseSeekerMove(g, 'orihime', mulberry32(1), { alpha: 1, beta: 6, gammaPath: 0.15, temperature: 0.01 });
  ok(greedy.end.x > 0, 'greedy move heads toward hint (rightward)');
  ok(greedy.focal.x >= 5, 'focal near the hint cluster');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
