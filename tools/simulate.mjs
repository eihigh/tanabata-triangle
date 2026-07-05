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
//   例: node tools/simulate.mjs games=3000 budgetMs=4000 target=seekers

import { createGame, placeDebris, applyMove, resolveStuck, hasAnyLegalMove, PHASE, activeSeeker, isDebrisPhase } from '../js/engine.js';
import { chooseSeekerMove, chooseKingDebris, mulberry32, SEEKER, KING } from '../js/ai.js';

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
const GAME_CONFIG = {}; // 既定 (9x9, 3マス, 7ラウンド, 中央デブリ)
const MAX_ROUNDS = createGame(GAME_CONFIG).maxRounds;

// ---- 1ゲームのシミュレーション ---------------------------------------------
// 返り値: { winner, clearedRound }  clearedRound は出会えたラウンド（負けなら null）
function simulateGame(rng, epsilon) {
  const g = createGame(GAME_CONFIG);
  const seekerEps = TARGET === 'king' ? 0 : epsilon;
  const kingEps = TARGET === 'seekers' ? 0 : epsilon;
  const sp = { ...SEEKER, epsilon: seekerEps };
  const kp = { ...KING, epsilon: kingEps };

  let guard = 0;
  while (g.phase !== PHASE.GAME_OVER && guard++ < 1000) {
    if (isDebrisPhase(g)) {
      const who = activeSeeker(g);
      const cell = chooseKingDebris(g, who, rng, kp);
      if (!cell) break; // 盤面が埋まって置けない（実質起きない）
      placeDebris(g, who, cell);
    } else {
      const who = activeSeeker(g);
      if (!hasAnyLegalMove(g, who)) {
        resolveStuck(g);
        break;
      }
      const move = chooseSeekerMove(g, who, rng, sp);
      applyMove(g, who, move.path);
    }
  }
  return {
    winner: g.winner,
    clearedRound: g.winner === 'seekers' ? g.round : null,
  };
}

// ---- 1つの epsilon について N ゲーム（タイムアウト付き）--------------------
function runEpsilon(epsilon, rng) {
  const clearedByRound = new Array(MAX_ROUNDS + 1).fill(0); // index=ラウンド
  let played = 0;
  let seekerWins = 0;
  const t0 = Date.now();
  for (let i = 0; i < GAMES; i++) {
    if (Date.now() - t0 > BUDGET_MS) break; // タイムアウト保証
    const r = simulateGame(rng, epsilon);
    played++;
    if (r.winner === 'seekers') {
      seekerWins++;
      clearedByRound[r.clearedRound]++;
    }
  }
  // 累積クリア率（日毎 = ラウンド毎）
  const cum = [];
  let acc = 0;
  for (let t = 1; t <= MAX_ROUNDS; t++) {
    acc += clearedByRound[t];
    cum.push(played ? acc / played : 0);
  }
  return { epsilon, played, seekerWins, clearRate: played ? seekerWins / played : 0, cum, ms: Date.now() - t0 };
}

// ---- 実行＋表示 -------------------------------------------------------------
const rng = mulberry32(SEED);
const pct = (x) => (100 * x).toFixed(1).padStart(5);

console.log('七夕トライアングル シーカー勝率シミュレーション（全AI・モンテカルロ）');
console.log(`  試行/設定=${GAMES}  タイムアウト/設定=${BUDGET_MS}ms  seed=${SEED}  乱数混入対象=${TARGET}  ラウンド=${MAX_ROUNDS}`);
console.log('  乱数混入率 epsilon: 0=AI本来の分布, 1=完全ランダム\n');

const dayHead = Array.from({ length: MAX_ROUNDS }, (_, i) => `Day${i + 1}`.padStart(6)).join(' ');
console.log(`  eps  | ${dayHead} |  Clear%   n     ms`);
console.log('  ' + '-'.repeat(9 + MAX_ROUNDS * 7 + 22));

const rows = [];
const tStart = Date.now();
for (const eps of EPS_LIST) {
  const r = runEpsilon(eps, rng);
  rows.push(r);
  const days = r.cum.map((v) => pct(v)).join(' ');
  console.log(`  ${eps.toFixed(2)} | ${days} | ${pct(r.clearRate)}% ${String(r.played).padStart(5)} ${String(r.ms).padStart(5)}`);
}
console.log('\n  ※ Day t 列 = t ラウンド目までにシーカーが出会えた累積クリア率(%)');
console.log(`  総経過: ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

// CSV も出す（機械処理用）
const csv = [
  ['epsilon', ...Array.from({ length: MAX_ROUNDS }, (_, i) => `day${i + 1}`), 'clearRate', 'games'].join(','),
  ...rows.map((r) => [r.epsilon, ...r.cum.map((v) => v.toFixed(4)), r.clearRate.toFixed(4), r.played].join(',')),
].join('\n');
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./sim-result.csv', import.meta.url), csv + '\n');
console.log('  CSV: tools/sim-result.csv');
