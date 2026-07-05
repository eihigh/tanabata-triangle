// 七夕トライアングル シーカー勝率シミュレーター
//
// 全AI対戦をモンテカルロで多数回まわし、「乱数混入率(epsilon)」ごとに
// シーカーのクリア率を計算する。日毎（＝ラウンド毎）の累積クリア率も出す。
//
// 隠れ情報＋2盤面の軌跡/デブリ集合という状態空間の巨大さから、勝率の厳密DPは
// 非現実的。そこで「各設定に壁時計タイムアウトを設けた」モンテカルロにして、
// 常に有限時間で終了し、実際に完了した試行数に対する率を報告する。
//
// 使い方:
//   node tools/simulate.mjs [games=2000] [budgetMs=5000] [seed=12345]
//                           [eps=0,0.1,...,1] [target=all|seekers|king]
//                           [board=9] [oriSteps=3] [hikSteps=3] [combos=1]
//   例:
//     node tools/simulate.mjs board=7 oriSteps=2        # 7x7 かつ織姫だけ移動2
//     node tools/simulate.mjs combos=1                  # 4バリアントをまとめて比較

import { createGame, placeDebris, applyMove, resolveStuck, hasAnyLegalMove, PHASE, activeSeeker, isDebrisPhase } from '../js/engine.js';
import { chooseSeekerMove, chooseKingDebris, mulberry32, SEEKER, KING } from '../js/ai.js';
import { writeFileSync } from 'node:fs';

// ---- 引数パース -------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.includes('=') ? a.split('=') : [a, 'true'];
    return [k, v];
  }),
);
const GAMES = parseInt(args.games ?? '2000', 10);
const BUDGET_MS = parseInt(args.budgetMs ?? '5000', 10);
const SEED = parseInt(args.seed ?? '12345', 10);
const TARGET = args.target ?? 'all'; // どの役に乱数を混入するか
const EPS_LIST = (args.eps ?? '0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0')
  .split(',')
  .map(Number);

// 単発設定を引数から組み立てる（board / oriSteps / hikSteps）
function configFromArgs() {
  const c = {};
  if (args.board) c.BOARD_SIZE = parseInt(args.board, 10);
  const steps = {};
  if (args.oriSteps) steps.orihime = parseInt(args.oriSteps, 10);
  if (args.hikSteps) steps.hikoboshi = parseInt(args.hikSteps, 10);
  if (Object.keys(steps).length) c.STEPS = steps;
  return c;
}

// combos モードで比較する4バリアント
const COMBOS = [
  ['baseline (9x9, 織姫3/彦星3)', {}],
  ['A       (9x9, 織姫2/彦星3)', { STEPS: { orihime: 2 } }],
  ['B       (7x7, 織姫3/彦星3)', { BOARD_SIZE: 7 }],
  ['A+B     (7x7, 織姫2/彦星3)', { BOARD_SIZE: 7, STEPS: { orihime: 2 } }],
];

// ---- 1ゲームのシミュレーション ---------------------------------------------
// 返り値: { winner, clearedRound }  clearedRound は出会えたラウンド（負けなら null）
function simulateGame(rng, epsilon, gameConfig) {
  const g = createGame(gameConfig);
  const seekerEps = TARGET === 'king' ? 0 : epsilon;
  const kingEps = TARGET === 'seekers' ? 0 : epsilon;
  const sp = { ...SEEKER, epsilon: seekerEps };
  const kp = { ...KING, epsilon: kingEps };

  let guard = 0;
  while (g.phase !== PHASE.GAME_OVER && guard++ < 1000) {
    const who = activeSeeker(g);
    if (isDebrisPhase(g)) {
      const cell = chooseKingDebris(g, who, rng, kp);
      if (!cell) break; // 盤面が埋まって置けない（実質起きない）
      placeDebris(g, who, cell);
    } else {
      if (!hasAnyLegalMove(g, who)) {
        resolveStuck(g);
        break;
      }
      applyMove(g, who, chooseSeekerMove(g, who, rng, sp).path);
    }
  }
  return { winner: g.winner, clearedRound: g.winner === 'seekers' ? g.round : null };
}

// ---- 1つの epsilon について N ゲーム（タイムアウト付き）--------------------
function runEpsilon(epsilon, rng, gameConfig, maxRounds) {
  const clearedByRound = new Array(maxRounds + 1).fill(0);
  let played = 0;
  let seekerWins = 0;
  const t0 = Date.now();
  for (let i = 0; i < GAMES; i++) {
    if (Date.now() - t0 > BUDGET_MS) break; // タイムアウト保証
    const r = simulateGame(rng, epsilon, gameConfig);
    played++;
    if (r.winner === 'seekers') {
      seekerWins++;
      clearedByRound[r.clearedRound]++;
    }
  }
  const cum = [];
  let acc = 0;
  for (let t = 1; t <= maxRounds; t++) {
    acc += clearedByRound[t];
    cum.push(played ? acc / played : 0);
  }
  return { epsilon, played, clearRate: played ? seekerWins / played : 0, cum, ms: Date.now() - t0 };
}

// ---- 1バリアントの epsilon 掃引＋表示 --------------------------------------
const pct = (x) => (100 * x).toFixed(1).padStart(5);

function runSweep(label, gameConfig, rng, csvRows) {
  const maxRounds = createGame(gameConfig).maxRounds;
  console.log(`\n■ ${label}`);
  const dayHead = Array.from({ length: maxRounds }, (_, i) => `Day${i + 1}`.padStart(6)).join(' ');
  console.log(`  eps  | ${dayHead} |  Clear%   n     ms`);
  console.log('  ' + '-'.repeat(9 + maxRounds * 7 + 22));
  for (const eps of EPS_LIST) {
    const r = runEpsilon(eps, rng, gameConfig, maxRounds);
    const days = r.cum.map((v) => pct(v)).join(' ');
    console.log(`  ${eps.toFixed(2)} | ${days} | ${pct(r.clearRate)}% ${String(r.played).padStart(5)} ${String(r.ms).padStart(5)}`);
    csvRows.push([JSON.stringify(label.trim()), eps, ...r.cum.map((v) => v.toFixed(4)), r.clearRate.toFixed(4), r.played].join(','));
  }
}

// ---- 実行 -------------------------------------------------------------------
const rng = mulberry32(SEED);
console.log('七夕トライアングル シーカー勝率シミュレーション（全AI・モンテカルロ）');
console.log(`  試行/設定=${GAMES}  タイムアウト/設定=${BUDGET_MS}ms  seed=${SEED}  乱数混入対象=${TARGET}`);
console.log('  乱数混入率 epsilon: 0=AI本来の分布, 1=完全ランダム');

const csvRows = [];
const tStart = Date.now();
if (args.combos && args.combos !== 'false') {
  for (const [label, cfg] of COMBOS) runSweep(label, cfg, rng, csvRows);
} else {
  const cfg = configFromArgs();
  const size = cfg.BOARD_SIZE ?? 9;
  const ori = cfg.STEPS?.orihime ?? 3;
  const hik = cfg.STEPS?.hikoboshi ?? 3;
  runSweep(`${size}x${size}, 織姫${ori}/彦星${hik}`, cfg, rng, csvRows);
}
console.log('\n  ※ Day t 列 = t ラウンド目までにシーカーが出会えた累積クリア率(%)');
console.log(`  総経過: ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

const maxDays = 7;
const header = ['variant', 'epsilon', ...Array.from({ length: maxDays }, (_, i) => `day${i + 1}`), 'clearRate', 'games'].join(',');
writeFileSync(new URL('./sim-result.csv', import.meta.url), header + '\n' + csvRows.join('\n') + '\n');
console.log('  CSV: tools/sim-result.csv');
