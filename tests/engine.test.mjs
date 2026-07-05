// engine 単体テスト（Node で実行: `node tests/engine.test.mjs`）
import {
  createGame,
  hints,
  canPlaceDebris,
  placeDebris,
  legalStep,
  legalDirs,
  hasAnyLegalMove,
  applyMove,
  checkMeeting,
  resolveStuck,
  activeSeeker,
  key,
  DIRS,
  PHASE,
} from '../js/engine.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function throws(fn, msg) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, msg);
}

// --- 初期状態 ---------------------------------------------------------------
{
  const g = createGame();
  ok(g.phase === PHASE.KING_DEBRIS_ORIHIME, 'starts at KING_DEBRIS_ORIHIME');
  ok(g.round === 1, 'starts at round 1');
  ok(g.orihime.trail.has('0,0'), 'orihime starts at (0,0)');
  ok(g.hikoboshi.trail.has('8,8'), 'hikoboshi starts at (8,8)');
  ok(g.orihime.debris.has('4,4'), 'orihime board has center debris');
  ok(g.hikoboshi.debris.has('4,4'), 'hikoboshi board has center debris');
  ok(g.orihime.debris.size === 1 && g.hikoboshi.debris.size === 1, 'exactly one initial debris each');
  ok(!canPlaceDebris(g, 'orihime', { x: 4, y: 4 }), 'cannot place on existing center debris');
  ok(hints(g).size === 0, 'no hints at start (distinct starts)');
  ok(g.orihime.revealedHints.size === 0, 'revealed hints empty at start');
  ok(activeSeeker(g) === 'orihime', 'orihime active first');
}

// --- デブリ設置 -------------------------------------------------------------
{
  const g = createGame();
  ok(!canPlaceDebris(g, 'orihime', { x: 0, y: 0 }), 'cannot place on trail (start)');
  ok(!canPlaceDebris(g, 'orihime', { x: -1, y: 0 }), 'cannot place off-board');
  ok(canPlaceDebris(g, 'orihime', { x: 3, y: 2 }), 'can place on empty cell');
  throws(
    () => placeDebris(g, 'hikoboshi', { x: 3, y: 2 }),
    'placeDebris wrong-who/phase throws',
  );
  placeDebris(g, 'orihime', { x: 3, y: 2 });
  ok(g.phase === PHASE.MOVE_ORIHIME, 'debris advances to MOVE_ORIHIME');
  ok(g.orihime.debris.has('3,2'), 'debris recorded');
  ok(!g.hikoboshi.debris.has('3,2'), 'debris board-independent');
}

// --- 移動の合法性 -----------------------------------------------------------
{
  const g = createGame({ START: { orihime: { x: 2, y: 2 }, hikoboshi: { x: 6, y: 6 } } });
  placeDebris(g, 'orihime', { x: 3, y: 2 }); // 右隣をブロック
  ok(legalStep(g, 'orihime', { x: 2, y: 2 }, DIRS.right) === null, 'debris blocks step');
  ok(legalStep(g, 'orihime', { x: 0, y: 0 }, DIRS.up) === null, 'edge blocks step');
  ok(!legalDirs(g, 'orihime', { x: 2, y: 2 }).includes('right'), 'right not legal');

  // ステップ数が違うと拒否
  throws(() => applyMove(g, 'orihime', ['up', 'up']), 'wrong length rejected');
  // デブリへ進入する経路は拒否
  throws(() => applyMove(g, 'orihime', ['right', 'up', 'up']), 'blocked path rejected');
}

// --- 自マス重複・折り返しは許可 ---------------------------------------------
{
  const g = createGame({ START: { orihime: { x: 2, y: 2 }, hikoboshi: { x: 6, y: 6 } } });
  placeDebris(g, 'orihime', { x: 0, y: 0 });
  applyMove(g, 'orihime', ['up', 'down', 'up']); // (2,2)->(2,1)->(2,2)->(2,1)
  ok(key(g.orihime.pos) === '2,1', 'backtrack move lands correctly');
  ok(g.orihime.trail.has('2,1') && g.orihime.trail.has('2,2'), 'trail keeps revisited cells');
  ok(g.phase === PHASE.KING_DEBRIS_HIKOBOSHI, 'advances to hikoboshi debris');
}

// --- 交差ヒント -------------------------------------------------------------
{
  const g = createGame({ START: { orihime: { x: 0, y: 1 }, hikoboshi: { x: 4, y: 1 } } });
  placeDebris(g, 'orihime', { x: 8, y: 8 });
  applyMove(g, 'orihime', ['right', 'right', 'right']); // trail 0,1 1,1 2,1 3,1 (rest 3,1)
  placeDebris(g, 'hikoboshi', { x: 8, y: 8 });
  applyMove(g, 'hikoboshi', ['left', 'left', 'left']); // trail 4,1 3,1 2,1 1,1 (rest 1,1)
  const h = hints(g);
  ok(h.has('2,1') && h.has('3,1') && h.has('1,1'), 'intersection cells detected');
  ok(!h.has('0,1') && !h.has('4,1'), 'non-shared cells excluded');
  ok(g.winner === null, 'no meeting when rest cells differ');
}

// --- 出会い（シーカー勝ち）--------------------------------------------------
{
  const g = createGame({ START: { orihime: { x: 1, y: 1 }, hikoboshi: { x: 4, y: 1 } } });
  placeDebris(g, 'orihime', { x: 8, y: 8 });
  applyMove(g, 'orihime', ['right', 'right', 'right']); // orihime -> (4,1) == hikoboshi pos
  ok(g.winner === 'seekers', 'seekers win on same cell');
  ok(key(g.meetingCell) === '4,1', 'meeting cell recorded');
  ok(g.phase === PHASE.GAME_OVER, 'game over on win');
  ok(checkMeeting(g), 'checkMeeting true');
}

// --- 手番切れ（王様勝ち）----------------------------------------------------
{
  const g = createGame({ MAX_ROUNDS: 1 });
  placeDebris(g, 'orihime', { x: 8, y: 0 });
  applyMove(g, 'orihime', ['down', 'down', 'down']); // (0,0)->(0,3)
  placeDebris(g, 'hikoboshi', { x: 0, y: 0 });
  applyMove(g, 'hikoboshi', ['up', 'up', 'up']); // (8,8)->(8,5), round 1 終了、会えず
  ok(g.winner === 'king', 'king wins when rounds exhausted');
  ok(g.phase === PHASE.GAME_OVER, 'game over');
}

// --- 囲まれ検出 -------------------------------------------------------------
{
  // 角(0,0)に置き、右と下を塞ぐと3マス経路が作れない
  const g = createGame({ START: { orihime: { x: 0, y: 0 }, hikoboshi: { x: 8, y: 8 } } });
  // orihime のデブリを (1,0)(0,1) に置く必要があるが、1手番1個なので直接状態を操作して検証
  g.orihime.debris.add(key({ x: 1, y: 0 }));
  g.orihime.debris.add(key({ x: 0, y: 1 }));
  g.phase = PHASE.MOVE_ORIHIME;
  ok(!hasAnyLegalMove(g, 'orihime'), 'fully boxed corner has no legal move');
  resolveStuck(g);
  ok(g.winner === 'king', 'stuck seeker -> king wins');
}

// --- ヒントは移動前にだけ更新（移動中/後は凍結）-----------------------------
{
  const g = createGame({ START: { orihime: { x: 0, y: 0 }, hikoboshi: { x: 8, y: 0 } } });

  // R1: 交差しない範囲まで前進（両手番開始時のスナップショットは空）
  placeDebris(g, 'orihime', { x: 0, y: 8 });
  ok(g.orihime.revealedHints.size === 0, 'orihime snapshot empty before R1 move');
  applyMove(g, 'orihime', ['right', 'right', 'right']); // orihime: 0,0 1,0 2,0 3,0 (rest 3,0)
  placeDebris(g, 'hikoboshi', { x: 0, y: 8 });
  ok(g.hikoboshi.revealedHints.size === 0, 'hikoboshi snapshot empty before R1 move');
  applyMove(g, 'hikoboshi', ['left', 'left', 'left']); // hikoboshi: 8,0 7,0 6,0 5,0 (rest 5,0)

  // R2 織姫: 手番開始（移動前）スナップショットはまだ空（交差なし）
  placeDebris(g, 'orihime', { x: 0, y: 7 });
  ok(g.orihime.revealedHints.size === 0, 'orihime R2 pre-move snapshot still empty');
  // 織姫が移動して初めて彦星軌跡(5,0)(6,0)に重なる交差を作る
  applyMove(g, 'orihime', ['right', 'right', 'right']); // 3,0 -> 4,0 5,0 6,0 (rest 6,0)
  ok(g.winner === null, 'passing through opponent cell is not a meeting');
  // 移動直後: 自分のスナップショットは凍結されたまま（自分の移動で作った交差は映らない）
  ok(g.orihime.revealedHints.size === 0, 'orihime snapshot frozen through its own move');
  // ライブの真の交差は既に存在する
  const live = hints(g);
  ok(live.has('5,0') && live.has('6,0'), 'live intersection now exists');

  // R2 彦星: 手番開始（移動前）でスナップショットが更新され交差が反映される
  placeDebris(g, 'hikoboshi', { x: 0, y: 7 });
  ok(
    g.hikoboshi.revealedHints.has('5,0') && g.hikoboshi.revealedHints.has('6,0'),
    'hikoboshi snapshot updates at its pre-move turn start',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
