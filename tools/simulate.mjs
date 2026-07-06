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
//                           [public=all|king|none]  # 出目の可視性（全公開/王様のみ/本人のみ）
//   例:
//     node tools/simulate.mjs board=7 oriSteps=2        # 7x7 かつ織姫だけ移動2
//     node tools/simulate.mjs combos=1                  # 4バリアントをまとめて比較

import { createGame, placeDebris, applyMove, resolveStuck, hasAnyLegalMove, PHASE, activeSeeker, isDebrisPhase, DEFAULTS } from '../js/engine.js';
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
// 出目（累積歩数）の可視性。public=0/none で本人のみ、public=king で王様のみ、既定=全公開。
const PUBLIC_ROLLS =
  args.public === 'king'
    ? 'king'
    : args.public === '0' || args.public === 'false' || args.public === 'none'
      ? false
      : true;
const EPS_LIST = (args.eps ?? '0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0')
  .split(',')
  .map(Number);

// 単発設定を引数から組み立てる。
//   board=7  ori=d6  hik=3   （ori/hik は 2|3|d4|d6。oriSteps/hikSteps 数値も後方互換）
function configFromArgs() {
  const c = {};
  if (args.board) c.BOARD_SIZE = parseInt(args.board, 10);
  if (args.centerDebris != null) c.INITIAL_CENTER_DEBRIS = parseInt(args.centerDebris, 10);
  if (args.firstRoundDebris != null) c.FIRST_ROUND_DEBRIS = parseInt(args.firstRoundDebris, 10);
  const steps = {};
  const ori = args.ori ?? args.oriSteps;
  const hik = args.hik ?? args.hikSteps;
  if (ori != null) steps.orihime = ori; // engine 側 parseStepSpec が 'd6'/'3' を解釈
  if (hik != null) steps.hikoboshi = hik;
  if (Object.keys(steps).length) c.STEPS = steps;
  return c;
}

// combos モードで比較するバリアント（固定＋ダイス）。
// engine の DEFAULTS が既定(7x7/d4・d6)に変わったため、各バリアントは盤サイズ・移動量を明示する。
const COMBOS = [
  ['baseline (9x9, 織姫3/彦星3)', { BOARD_SIZE: 9, STEPS: { orihime: 3, hikoboshi: 3 } }],
  ['A       (9x9, 織姫2/彦星3)', { BOARD_SIZE: 9, STEPS: { orihime: 2 } }],
  ['B       (7x7, 織姫3/彦星3)', { BOARD_SIZE: 7, STEPS: { orihime: 3, hikoboshi: 3 } }],
  ['A+B     (7x7, 織姫2/彦星3)', { BOARD_SIZE: 7, STEPS: { orihime: 2 } }],
  ['D1      (9x9, 織姫1d6/彦星3)', { BOARD_SIZE: 9, STEPS: { orihime: 'd6' } }],
  ['D2      (9x9, 両者1d6)', { BOARD_SIZE: 9, STEPS: { orihime: 'd6', hikoboshi: 'd6' } }],
  ['D3      (9x9, 両者1d4)', { BOARD_SIZE: 9, STEPS: { orihime: 'd4', hikoboshi: 'd4' } }],
];

// ---- 1ゲームのシミュレーション ---------------------------------------------
// シーカー/王様の epsilon を独立に指定できる。
// 返り値: { winner, clearedRound }  clearedRound は出会えたラウンド（負けなら null）
function simulateGame(rng, seekerEps, kingEps, gameConfig) {
  const g = createGame({ PUBLIC_ROLLS, ...gameConfig, rng }); // 共有rngをダイスに供給・出目公開設定
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
// TARGET に応じて epsilon をどの役に混入するか決める（all/seekers/king）。
function runEpsilon(epsilon, rng, gameConfig, maxRounds) {
  const seekerEps = TARGET === 'king' ? 0 : epsilon;
  const kingEps = TARGET === 'seekers' ? 0 : epsilon;
  const clearedByRound = new Array(maxRounds + 1).fill(0);
  let played = 0;
  let seekerWins = 0;
  const t0 = Date.now();
  for (let i = 0; i < GAMES; i++) {
    if (Date.now() - t0 > BUDGET_MS) break; // タイムアウト保証
    const r = simulateGame(rng, seekerEps, kingEps, gameConfig);
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
console.log(`  試行/設定=${GAMES}  タイムアウト/設定=${BUDGET_MS}ms  seed=${SEED}  乱数混入対象=${TARGET}  出目公開=${PUBLIC_ROLLS === 'king' ? '王様のみ(king)' : PUBLIC_ROLLS ? '全公開(all)' : '非公開(none)'}`);
console.log('  乱数混入率 epsilon: 0=AI本来の分布, 1=完全ランダム');

// ---- matrix モード: seekerEps × kingEps の 3×3 クリア率 ---------------------
// 「シーカーの実力だけ落とすと勝率が下がり、王様の実力だけ落とすと勝率が上がる」
// という両役の実力反映を直接示す。
function runMatrix(gameConfig, rng) {
  const levels = (args.matrixEps ?? '0,0.5,1').split(',').map(Number);
  console.log('\n■ 実力マトリクス: 行=シーカーeps, 列=王様eps（値=シーカーのクリア率%）');
  console.log('  ' + 'S\\K'.padStart(6) + ' |' + levels.map((k) => `  king=${k}`.padStart(10)).join(''));
  console.log('  ' + '-'.repeat(8 + levels.length * 10));
  for (const sEps of levels) {
    const cells = [];
    for (const kEps of levels) {
      let played = 0;
      let wins = 0;
      const t0 = Date.now();
      for (let i = 0; i < GAMES; i++) {
        if (Date.now() - t0 > BUDGET_MS) break;
        const r = simulateGame(rng, sEps, kEps, gameConfig);
        played++;
        if (r.winner === 'seekers') wins++;
      }
      cells.push({ sEps, kEps, rate: played ? wins / played : 0, played });
    }
    console.log(
      '  ' + `s=${sEps}`.padStart(6) + ' |' + cells.map((c) => `${pct(c.rate)}%`.padStart(10)).join(''),
    );
  }
}

const csvRows = [];
const tStart = Date.now();
if (args.matrix && args.matrix !== 'false') {
  runMatrix(configFromArgs(), rng);
} else if (args.combos && args.combos !== 'false') {
  for (const [label, cfg] of COMBOS) runSweep(label, cfg, rng, csvRows);
} else {
  const cfg = configFromArgs();
  const size = cfg.BOARD_SIZE ?? DEFAULTS.BOARD_SIZE;
  const ori = cfg.STEPS?.orihime ?? DEFAULTS.STEPS.orihime;
  const hik = cfg.STEPS?.hikoboshi ?? DEFAULTS.STEPS.hikoboshi;
  runSweep(`${size}x${size}, 織姫${ori}/彦星${hik}`, cfg, rng, csvRows);
}
if (csvRows.length) {
  console.log('\n  ※ Day t 列 = t ラウンド目までにシーカーが出会えた累積クリア率(%)');
  const maxDays = 7;
  const header = ['variant', 'epsilon', ...Array.from({ length: maxDays }, (_, i) => `day${i + 1}`), 'clearRate', 'games'].join(',');
  writeFileSync(new URL('./sim-result.csv', import.meta.url), header + '\n' + csvRows.join('\n') + '\n');
  console.log('  CSV: tools/sim-result.csv');
}
console.log(`  総経過: ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
