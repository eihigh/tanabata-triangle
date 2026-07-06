// engine 単体テスト（Node で実行: `node tests/engine.test.mjs`）
import {
  createGame as _createGame,
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
  movesSoFar,
  parseStepSpec,
  rollStep,
  key,
  DIRS,
  PHASE,
} from '../js/engine.js';

// 既定は「確定設定(7x7 / d4・d6 / king)」に変わったため、従来の 9x9・固定3・全公開を
// 前提にしたテストが崩れないよう、明示指定が無い項目はクラシック設定を被せる。
const CLASSIC = { BOARD_SIZE: 9, STEPS: {}, PUBLIC_ROLLS: 'all' };
const createGame = (cfg = {}) => _createGame({ ...CLASSIC, ...cfg });

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

// --- デブリ禁じ手: 相手シーカーの現在位置には置けない ----------------------
{
  const g = createGame(); // 織姫(0,0) / 彦星(8,8)
  ok(!canPlaceDebris(g, 'orihime', { x: 8, y: 8 }), 'orihime盤に彦星の現在位置は置けない');
  ok(!canPlaceDebris(g, 'hikoboshi', { x: 0, y: 0 }), 'hikoboshi盤に織姫の現在位置は置けない');
  ok(canPlaceDebris(g, 'orihime', { x: 8, y: 7 }), '相手の隣接マスは置ける');
  throws(() => placeDebris(g, 'orihime', { x: 8, y: 8 }), 'placeDebrisは相手の現在位置を拒否');
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

// --- movesSoFar: 手番構造からの移動数導出 -----------------------------------
{
  const g = createGame();
  ok(movesSoFar(g, 'orihime') === 0 && movesSoFar(g, 'hikoboshi') === 0, 'round1 KD_O: both 0 moves');
  placeDebris(g, 'orihime', { x: 5, y: 0 });
  ok(movesSoFar(g, 'orihime') === 0, 'MOVE_ORIHIME: orihime not yet moved');
  applyMove(g, 'orihime', ['down', 'down', 'down']);
  ok(movesSoFar(g, 'orihime') === 1 && movesSoFar(g, 'hikoboshi') === 0, 'KD_H: orihime 1, hikoboshi 0');
  placeDebris(g, 'hikoboshi', { x: 0, y: 5 });
  applyMove(g, 'hikoboshi', ['up', 'up', 'up']);
  ok(movesSoFar(g, 'orihime') === 1 && movesSoFar(g, 'hikoboshi') === 1, 'round2 KD_O: both 1 move');
  ok(g.starts.orihime.x === 0 && g.starts.hikoboshi.x === 8, 'public starts recorded');
}

// --- 初日のみ王様が2個置けるルール（FIRST_ROUND_DEBRIS）----------------------
{
  const g = createGame({ FIRST_ROUND_DEBRIS: 2 });
  // ラウンド1: 織姫盤に1個置いてもまだデブリフェーズ、2個目で移動フェーズへ
  ok(g.phase === PHASE.KING_DEBRIS_ORIHIME, 'round1 starts in king-debris');
  placeDebris(g, 'orihime', { x: 5, y: 0 });
  ok(g.phase === PHASE.KING_DEBRIS_ORIHIME, 'round1: still debris after 1st (allowance 2)');
  placeDebris(g, 'orihime', { x: 6, y: 0 });
  ok(g.phase === PHASE.MOVE_ORIHIME, 'round1: move phase after 2nd debris');
  ok(g.orihime.debris.has('5,0') && g.orihime.debris.has('6,0'), 'both round1 debris placed');
  applyMove(g, 'orihime', ['down', 'down', 'down']);
  placeDebris(g, 'hikoboshi', { x: 0, y: 5 });
  ok(g.phase === PHASE.KING_DEBRIS_HIKOBOSHI, 'round1 hikoboshi also gets 2');
  placeDebris(g, 'hikoboshi', { x: 0, y: 6 });
  applyMove(g, 'hikoboshi', ['up', 'up', 'up']);
  // ラウンド2以降は1個で移動フェーズへ
  ok(g.round === 2 && g.phase === PHASE.KING_DEBRIS_ORIHIME, 'advanced to round2');
  placeDebris(g, 'orihime', { x: 4, y: 3 });
  ok(g.phase === PHASE.MOVE_ORIHIME, 'round2: move phase after just 1 debris');
}

// --- ダイス移動: parseStepSpec / rollStep -----------------------------------
{
  ok(parseStepSpec(3).kind === 'fixed' && parseStepSpec(3).n === 3, 'number -> fixed');
  ok(parseStepSpec('d4').kind === 'dice' && parseStepSpec('d4').faces === 4, "'d4' -> dice4");
  ok(parseStepSpec('1d6').faces === 6, "'1d6' -> dice6");
  ok(parseStepSpec(undefined, 2).n === 2, 'undefined -> fallback');
  const d6 = parseStepSpec('d6');
  for (const r of [0, 0.16, 0.5, 0.83, 0.999]) {
    const v = rollStep(d6, () => r);
    ok(v >= 1 && v <= 6, `dice roll within 1..6 (${v})`);
  }
  ok(rollStep(parseStepSpec(3), () => 0.9) === 3, 'fixed roll ignores rng');
}

// --- ダイス移動: createGame / traveled 累積 ---------------------------------
{
  const g = createGame({ STEPS: { orihime: 'd4', hikoboshi: 3 }, rng: () => 0 });
  ok(g.orihime.stepSpec.kind === 'dice' && g.orihime.stepSpec.faces === 4, 'orihime dice spec');
  ok(g.hikoboshi.stepSpec.kind === 'fixed', 'hikoboshi fixed spec');
  ok(g.orihime.steps === 1, 'dice initial roll with rng=0 -> 1 マス');
  ok(g.orihime.traveled === 0 && g.hikoboshi.traveled === 0, 'traveled starts 0');
}
{
  // d4 で出目4を強制（1+floor(0.75*4)=4）→ 4マス動いて traveled=4
  const g = createGame({ STEPS: { orihime: 'd4' }, rng: () => 0.75 });
  ok(g.orihime.steps === 4, 'forced roll 4');
  placeDebris(g, 'orihime', { x: 5, y: 0 });
  applyMove(g, 'orihime', ['down', 'down', 'down', 'down']); // (0,0)->(0,4)
  ok(key(g.orihime.pos) === '0,4' && g.orihime.traveled === 4, 'traveled == Σ steps (4)');
}

// --- バリアントA: 織姫だけ移動量2 ------------------------------------------
{
  const g = createGame({ STEPS: { orihime: 2 } });
  ok(g.orihime.steps === 2 && g.hikoboshi.steps === 3, 'per-seeker step counts');
  placeDebris(g, 'orihime', { x: 8, y: 0 });
  throws(() => applyMove(g, 'orihime', ['down', 'down', 'down']), 'orihime rejects 3-step move');
  applyMove(g, 'orihime', ['down', 'down']); // (0,0)->(0,2)
  ok(key(g.orihime.pos) === '0,2', 'orihime moves exactly 2');
  ok(g.phase === PHASE.KING_DEBRIS_HIKOBOSHI, 'advances after 2-step move');
  placeDebris(g, 'hikoboshi', { x: 0, y: 0 });
  throws(() => applyMove(g, 'hikoboshi', ['up', 'up']), 'hikoboshi still needs 3 steps');
  applyMove(g, 'hikoboshi', ['up', 'up', 'up']); // (8,8)->(8,5)
  ok(key(g.hikoboshi.pos) === '8,5', 'hikoboshi moves exactly 3');
}

// --- バリアントB: 盤サイズ7x7 ----------------------------------------------
{
  const g = createGame({ BOARD_SIZE: 7 });
  ok(g.size === 7, 'board size 7');
  ok(g.orihime.trail.has('0,0') && g.hikoboshi.trail.has('6,6'), 'start corners follow board size');
  ok(g.orihime.debris.has('3,3') && g.hikoboshi.debris.has('3,3'), 'center debris at (3,3) on 7x7');
  ok(!canPlaceDebris(g, 'orihime', { x: 7, y: 0 }), 'off-board on 7x7 rejected');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
