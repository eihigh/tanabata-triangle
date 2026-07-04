#!/usr/bin/env node
'use strict';

/*
 * 七夕トライアングル シミュレータ
 *
 * 2人協力版（織姫・彦星）。互いの位置は不可視。手がかりは
 *  - 軌跡の交差（減衰=直近 decay 手番の相手軌跡との重なりのみ開示）
 *  - オプション: 出目の相互開示（--share）
 * 勝利 = 同マスに立つ。MAX_DAY 日以内に会えなければ敗北。
 *
 * CLI:
 *   node sim.js <試行数> <ダイス> <盤リスト> <日数> <減衰> [--policy=P] [--share] [--opp=M] [--seed=K]
 *   node sim.js --matrix [試行数]
 *
 *   ダイス   : NdF 記法（例 2d6, 1d3）。カンマ区切りで複数可。数字のみなら 1dF。
 *   盤       : カンマ区切り（例 7 / 5,7,9）
 *   減衰     : 0=全軌跡, 1=直近1手番, ...
 *   --policy : random | greedy | infogain | hybrid | focal | nfocal | focalx | xfocal（省略時 random）
 *              focal =事前に示し合わせた収束点（盤の中心）へ向かうだけの「約束事」戦略
 *              nfocal=focalの素朴版。中心が塞がれても再設定しない（実験10の下限対照）
 *              focalx=focalに「交差で相手を掴む」を足した強化案（実験9。私的情報で逆に悪化）
 *              xfocal=集合点を共有交差マスへ動かす（--sharedcross のときだけ機能。実験9）
 *   --sharedcross : 反実仮想。交差を両者に開示する（既定は横切った側だけ）。実験9の天井測定用
 *   --precross : 交差の開示タイミングを反転する実験。既定は「自分が動く→動いた経路と相手の
 *              直前軌跡の交差を知る」。--precross では「自分の直前の移動 ∩ 相手の直前の移動の
 *              交差を、動く前に知る→それを使って動く」。手番冒頭に belief を更新してから着地を
 *              選ぶので、交差を追いかけて動ける一方、当該手番の移動で新しい交差情報は生めない。
 *   --share  : 出目の相互開示 on
 *   --opp    : belief 更新に使う相手移動モデル random(v1) | greedy(v2)（省略時 random）
 *   --eps    : 確率εで無情報（ランダム）に動く。人間の不完全さのモデル（省略時 0）
 *   --aware=dist|role|block : デブリ認識AIの実験機構（実験8・10。いずれも素朴greedyに勝てず不採用）。
 *              dist =期待距離を自陣BFS距離で測る＋共有型は交差尤度も壁で締める
 *              role =秘匿型でデブリ比率から集中攻撃を検知し、標的側が「錨」になる
 *              block=公知の「1移動=1デブリ」＋おじゃま方策から相手のデブリ位置を推定し
 *                    「相手はそこに立てない」を belief に反映（被おじゃまの theory-of-mind）
 *   --ojama  : おじゃま係 none | random | choke | cage | cagecenter | predict | spread |
 *              afocal | censor（省略時 none）。
 *              censor=検閲キング（実験17・ジャム＋先交差前提）: 標的シーカーが次の手番頭に
 *              見るはずの交差マス（標的の直前経路∩相方の直前経路）が盤上に確定した瞬間、
 *              開示される前にそのマスへデブリを置いて握り潰す。消すべき交差が無い手番は
 *              afocal（約束事キラー）として振る舞う。
 *              片方が移動するたびに全知のおじゃまがデブリ（通行・停止不可マス）を1個置く。
 *              choke=二人の最短経路DAGの最細断面を優先封鎖（壁を育てる）
 *              cage =予測出会い地点（二人の中間・盤中央寄り）そのものと周囲を毒殺（反応型）
 *              以下は実験11の読み合い用: cagecenter=常に中心を毒す / predict=プレイヤーの
 *              集合戦略 pfocal を読んで先回り / spread=メニューを日ごとに巡回してヘッジ
 *   --pfocal : プレイヤーの集合戦略 center | rotate | wander（省略時 center。実験11）。
 *              center=中心固定 / rotate=日ごとにメニュー巡回 / wander=日から決まる公開擬似乱数
 *   --jvariant : デブリの効き方 shared | private（省略時 shared）
 *              shared=両者共通の盤・両者に公開 / private=次に動く側だけに効き、相手には見えない
 *   --jfocus : private時、標的を交互でなく常に同じ片方に集中（見えない壁での隔離）
 *   --jcap   : デブリ総数の上限（省略時 実質無制限=毎移動1個）
 *   --jinit  : 開始前の布石数。各盤の内側（外周を除く）に jinit 個ずつ置く（合計 2×jinit、
 *              省略時 0）。N=0〜3 の難易度レバー。外周は詰み防止で禁止。
 *   --jjam=R : ジャム（妨害電波）ルール実験（実験16・17）。自分の盤のデブリから距離R以内の
 *              マスでは交差ヒントが開示されず、クリア情報（相手は通っていない）も得られない。
 *              自分のデブリは見えるので「情報が出ない場所」は自分で分かる＝推理は健全なまま
 *              情報だけが痩せる。R=0（デブリマスそのもの）は移動中判定の旧ルールでは無効だが、
 *              先交差（--precross）では「歩いた後に置かれたデブリ」が既に歩いた軌跡の上に
 *              乗れるため有効＝キングは開示前の交差ヒントをピンポイントで検閲できる（実験17）。
 *   --jjamx=R: 秘匿ジャム。両盤のデブリの周囲Rが霧になるが、相方の盤ぶんの霧は自分には
 *              見えない。見えない霧で握り潰された交差を、プレイヤーは「交差なし＝相手は
 *              通っていない」と誤読する＝負の情報が汚染される。キングの置き方が直接
 *              「推理を難しくする」攻撃になるルール案。
 *   --jpre   : デブリ前置ルール（実験18）。既定は「各プレイヤーが動いた直後に、動いた側の
 *              盤へ1個」（--jfocus で片方固定）。--jpre は置くタイミングと標的を反転する:
 *              「布石 → 織姫移動 → 彦星移動（初日はここまで）→ 以降、毎手番
 *              〈キングが これからヒントを受け取る側 の盤にデブリ → ヒント照合 → 移動〉」。
 *              キングは両者の確定済み直前経路を見てから置けるので、確定検閲（開示直前の
 *              交差潰し）が両プレイヤーに対して毎ヒント可能になる。デブリ総数は初日ぶん
 *              2個少ない（7日なら12個＋布石）。
 *   --matrix : 第5節の実験マトリクス＋ε感度＋focal＋おじゃまを一括実行
 *
 * 例: node sim.js 10000 2d6 7 7 1 --policy=greedy --share
 */

/* ===================== RNG（再現性のため seed 可能） ===================== */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ===================== ダイス ===================== */
function parseDiceSpec(s) {
  const m = String(s).match(/^(\d+)d(\d+)$/i);
  if (m) return { n: +m[1], f: +m[2], label: `${m[1]}d${m[2]}` };
  return { n: 1, f: +s, label: `1d${s}` };
}

// 合計値ごとの確率（index=合計値）
function diceProbs(n, f) {
  let dist = [1];
  for (let d = 0; d < n; d++) {
    const nd = new Array(dist.length + f).fill(0);
    for (let s = 0; s < dist.length; s++) {
      if (!dist[s]) continue;
      for (let v = 1; v <= f; v++) nd[s + v] += dist[s] / f;
    }
    dist = nd;
  }
  return dist;
}

/* ===================== 盤の事前計算 ===================== */
/*
 * 障害物なしの4近傍グリッドでは「ちょうどk歩で到達できるマス」は
 *   マンハッタン距離 d <= k かつ (k-d) が偶数
 * と一致する（隣接マスとの往復でパディングできるため）。
 * ※ おじゃま係のブロック（障害物）を入れる場合はこの前提が崩れるので
 *    層状DP（reachableSet）に差し替えること。
 */
class Board {
  constructor(N, maxK, dice) {
    this.N = N;
    this.size = N * N;
    this.maxK = maxK;

    // マンハッタン距離テーブル
    this.dist = new Int8Array(this.size * this.size);
    for (let a = 0; a < this.size; a++) {
      const ar = (a / N) | 0, ac = a % N;
      for (let b = 0; b < this.size; b++) {
        const br = (b / N) | 0, bc = b % N;
        this.dist[a * this.size + b] = Math.abs(ar - br) + Math.abs(ac - bc);
      }
    }

    // 近傍
    this.nbrs = [];
    for (let a = 0; a < this.size; a++) {
      const r = (a / N) | 0, c = a % N, lst = [];
      if (r > 0) lst.push(a - N);
      if (r < N - 1) lst.push(a + N);
      if (c > 0) lst.push(a - 1);
      if (c < N - 1) lst.push(a + 1);
      this.nbrs.push(lst);
    }

    // 外周マス
    this.perimeter = [];
    for (let a = 0; a < this.size; a++) {
      const r = (a / N) | 0, c = a % N;
      if (r === 0 || c === 0 || r === N - 1 || c === N - 1) this.perimeter.push(a);
    }

    // 内側マス（外周を除く）。布石は詰み防止のためここにしか置けない
    this.interior = [];
    this.interiorMask = new Uint8Array(this.size);
    for (let a = 0; a < this.size; a++) {
      const r = (a / N) | 0, c = a % N;
      if (r > 0 && c > 0 && r < N - 1 && c < N - 1) { this.interior.push(a); this.interiorMask[a] = 1; }
    }

    // reach[p][k] = ちょうどk歩で到達できるマスの Int16Array
    this.reach = [];
    for (let p = 0; p < this.size; p++) {
      const perK = [];
      for (let k = 0; k <= maxK; k++) {
        const lst = [];
        for (let q = 0; q < this.size; q++) {
          const d = this.dist[p * this.size + q];
          if (d <= k && ((k - d) & 1) === 0) lst.push(q);
        }
        perK.push(Int16Array.from(lst));
      }
      this.reach.push(perK);
    }

    // belief 伝播用の遷移行列（相手ランダムモデル）
    // Ts[s][p*size+q] = P(着地q | 位置p, 出目s) 、Tmix = 出目分布で混合
    this.diceProbs = diceProbs(dice.n, dice.f);
    this.minRoll = dice.n;
    this.maxRoll = dice.n * dice.f;
    this.Ts = [];
    this.Tmix = new Float64Array(this.size * this.size);
    for (let s = 0; s <= this.maxRoll; s++) this.Ts.push(null);
    for (let s = this.minRoll; s <= this.maxRoll; s++) {
      const M = new Float64Array(this.size * this.size);
      for (let p = 0; p < this.size; p++) {
        const r = this.reach[p][s];
        const w = 1 / r.length;
        for (const q of r) M[p * this.size + q] = w;
      }
      this.Ts[s] = M;
      const ps = this.diceProbs[s];
      for (let i = 0; i < M.length; i++) this.Tmix[i] += ps * M[i];
    }
  }

  d(a, b) { return this.dist[a * this.size + b]; }
}

/*
 * 経路を1本サンプリング：ちょうどk歩で start→target。
 * 各ステップで「残り歩数で target に到達可能な近傍」から一様に選ぶ。
 * （帰納的に必ず候補が存在する）
 */
function samplePath(board, start, target, k, rng) {
  const path = [start];
  let cur = start, rem = k;
  while (rem > 0) {
    const cand = [];
    for (const nb of board.nbrs[cur]) {
      const d = board.d(nb, target);
      if (d <= rem - 1 && (((rem - 1) - d) & 1) === 0) cand.push(nb);
    }
    cur = cand[(rng() * cand.length) | 0];
    path.push(cur);
    rem--;
  }
  return path;
}

/* ===================== 障害物（おじゃま係のデブリ）対応 ===================== */
/*
 * デブリがあると「距離＋偶奇」の高速判定が使えないため層状DPに切り替える。
 * layers[t] = ちょうどt歩で到達できるマス集合（デブリは通行・停止とも不可）。
 */
function computeLayers(board, start, k, blocked) {
  const size = board.size;
  const layers = [new Uint8Array(size)];
  layers[0][start] = 1;
  for (let t = 1; t <= k; t++) {
    const prev = layers[t - 1], cur = new Uint8Array(size);
    for (let p = 0; p < size; p++) {
      if (!prev[p]) continue;
      for (const q of board.nbrs[p]) if (!blocked[q]) cur[q] = 1;
    }
    layers.push(cur);
  }
  return layers;
}

// 層状DPの結果から経路を1本後ろ向きサンプリング
function samplePathBlocked(board, layers, target, k, rng) {
  const rev = [target];
  let cur = target;
  for (let t = k; t > 0; t--) {
    const cand = [];
    for (const nb of board.nbrs[cur]) if (layers[t - 1][nb]) cand.push(nb);
    cur = cand[(rng() * cand.length) | 0];
    rev.push(cur);
  }
  return rev.reverse();
}

// デブリを避けたBFS距離場（おじゃまAI用）
function bfsDist(board, from, blocked) {
  const size = board.size;
  const d = new Int16Array(size).fill(-1);
  const q = new Int16Array(size);
  let head = 0, tail = 0;
  d[from] = 0; q[tail++] = from;
  while (head < tail) {
    const u = q[head++];
    for (const v of board.nbrs[u]) {
      if (d[v] < 0 && !blocked[v]) { d[v] = d[u] + 1; q[tail++] = v; }
    }
  }
  return d;
}

// ジャム（--jjam/--jjamx・実験16）: デブリから距離R以内の「霧」マスク。
// 霧のマスでは交差ヒントが開示されず、クリア情報も確定しない。
function fogMask(board, arrs, R) {
  const fog = new Uint8Array(board.size);
  for (const arr of arrs) {
    for (let q = 0; q < board.size; q++) {
      if (!arr[q]) continue;
      for (let x = 0; x < board.size; x++) if (board.d(q, x) <= R) fog[x] = 1;
    }
  }
  return fog;
}

/* ===================== おじゃま係AI ===================== */
/*
 * 全知（二人の位置・盤面をすべて見える）。片方が移動するたびにデブリを1個置く。
 * variant 'shared' : デブリは両者共通の盤に置かれ、両者に見える
 * variant 'private': デブリは「次に動く側」の盤にだけ効き、相手には見えない
 *                    （各プレイヤーは自分のデブリだけ見える）
 * 配置禁止: 両プレイヤーの現在マス（相手の立ちマスを塞げると出会いを恒久封鎖できて
 *           しまうため）と既存デブリ。
 */

// チョークポイント封鎖: from→to の最短経路DAGのうち「断面が最も細いレベル」を優先して塞ぐ。
// 同じ細さなら中間・盤中央寄りを好む（収束点も同時に潰れる）。壁が育つと自然に迂回距離が伸びる。
function chokeCell(board, blocked, from, to, rng) {
  const size = board.size;
  const dF = bfsDist(board, from, blocked);
  const dT = bfsDist(board, to, blocked);
  const D = dF[to];
  if (D >= 0 && D <= 1) {
    // 隣接: 間に置けるマスがない → 相手の周囲を檻状に塞ぐ
    const cand = board.nbrs[to].filter(q => !blocked[q] && q !== from);
    return cand.length ? cand[(rng() * cand.length) | 0] : -1;
  }
  if (D < 0) return -1; // 既に分断済み → フォールバック（呼び出し側でランダム配置）
  const width = new Int16Array(D);
  for (let q = 0; q < size; q++) {
    if (q === from || q === to) continue;
    if (dF[q] > 0 && dT[q] > 0 && dF[q] + dT[q] === D) width[dF[q]]++;
  }
  const c = (board.N - 1) >> 1;
  const center = c * board.N + c;
  let best = -1, bs = -Infinity;
  for (let q = 0; q < size; q++) {
    if (q === from || q === to) continue;
    if (dF[q] <= 0 || dT[q] <= 0 || dF[q] + dT[q] !== D) continue;
    const lvl = dF[q];
    const s = -100 * width[lvl] - 10 * Math.abs(lvl - D / 2) - board.d(q, center) + rng() * 1e-3;
    if (s > bs) { bs = s; best = q; }
  }
  return best;
}

// 出会い地点毒殺: 二人が収束するであろう地点 M（二人の中間・盤中央寄り）を予測し、
// M そのもの → M の周囲、の順で塞ぐ。秘匿型では「相手には見えない毒」になり、
// 片方が M で待っても、もう片方は永遠に M に立てない＝約束事（収束点）を静かに殺す。
function cageCell(board, blocked, posA, posB, rng) {
  const size = board.size;
  const c = (board.N - 1) >> 1;
  const center = c * board.N + c;
  let M = -1, bs = Infinity;
  for (let q = 0; q < size; q++) {
    if (q === posA || q === posB) continue;
    const s = (board.d(q, posA) + board.d(q, posB)) * 10 + board.d(q, center) + rng() * 1e-3;
    if (s < bs) { bs = s; M = q; }
  }
  if (M < 0) return -1;
  if (!blocked[M]) return M; // 予測地点そのものを毒殺
  // 既に毒済みなら周囲を檻に（M に近い空きマスを順に）
  let best = -1, bd = Infinity;
  for (let q = 0; q < size; q++) {
    if (blocked[q] || q === posA || q === posB) continue;
    const d = board.d(q, M) + rng() * 1e-3;
    if (d < bd && d < 3) { bd = d; best = q; }
  }
  return best;
}

// 集合点メニュー: 二人が約束できる複数の候補（中心＋4象限のランドマーク）。
// すべて盤の共通知識から決まるので、二人は通信なしで同じ点を選べる。
function landmarkMenu(board) {
  if (board._menu) return board._menu;
  const N = board.N, c = (N - 1) >> 1, r = Math.max(1, Math.round(N / 4));
  const clamp = (v) => Math.max(0, Math.min(N - 1, v));
  const cell = (rr, cc) => clamp(rr) * N + clamp(cc);
  board._menu = [cell(c - r, c - r), cell(c - r, c + r), cell(c + r, c - r), cell(c + r, c + r)];
  return board._menu;
}

// プレイヤーの集合戦略 pfocal から「その日の集合点」を返す（両者が同じ値を得る）。
//   center=常に中心 / rotate=日ごとにメニューを巡回 / wander=日から決まる公開擬似乱数で選ぶ
function focalGoal(board, cfg, day) {
  const c = (board.N - 1) >> 1, center = c * board.N + c;
  const pf = cfg.pfocal || 'center';
  if (pf === 'center') return center;
  const menu = landmarkMenu(board);
  if (pf === 'rotate') return menu[(day - 1) % menu.length];
  if (pf === 'wander') return menu[(Math.imul(day, 2654435761) >>> 0) % menu.length];
  return center;
}

// 指定マス M（とその周囲）を毒す。M が空けば M、埋まっていれば半径3内の最寄り空きマス。
function cageAround(board, blocked, M, posA, posB, rng) {
  if (M < 0) return -1;
  if (!blocked[M] && M !== posA && M !== posB) return M;
  let best = -1, bd = Infinity;
  for (let q = 0; q < board.size; q++) {
    if (blocked[q] || q === posA || q === posB) continue;
    const d = board.d(q, M) + rng() * 1e-3;
    if (d < bd && d < 3) { bd = d; best = q; }
  }
  return best;
}

// デブリ1個の配置先を決める。戻り値 { cell, target }（cell<0なら配置不能）
// pathA/pathB: 各プレイヤーの直前経路（censor キングが交差ヒントの検閲に使う）
function ojamaPlace(board, cfg, blocks, posA, posB, mover, rng, day, pathA, pathB) {
  const priv = cfg.jvariant === 'private';
  // 秘匿型の標的: 通常は「今動いた側」の盤に交互。--jfocus なら常に同じ片方へ集中し、
  // 片方だけを見えない壁で隔離する（もう片方の盤は綺麗なまま）
  const target = priv ? (cfg.jfocus ? 0 : mover) : 0; // shared は blocks[0]===blocks[1]
  const blockedArr = blocks[target];
  const from = priv ? (target === 0 ? posA : posB) : posA;
  const to = priv ? (target === 0 ? posB : posA) : posB;
  const c = (board.N - 1) >> 1, center = c * board.N + c;
  let cell = -1;
  if (cfg.ojama === 'cage') cell = cageCell(board, blockedArr, posA, posB, rng);
  // afocal: 位置から予測した focal 点 F を、盤ごとに逆側から潰す賢いキング（実験11）
  else if (cfg.ojama === 'afocal') cell = afocalCell(board, blockedArr, posA, posB, target, false);
  // censor: 検閲キング（実験17・ジャム＋先交差前提）。標的シーカーS が次の手番頭に見るはずの
  // 交差（S.直前経路 ∩ 相方O.直前経路）は、O が動いた直後に盤上で確定し、まだ S に開示されて
  // いない。その瞬間に交差マスへデブリを置けば R=0 のジャムで握り潰せる。複数あれば最も雄弁な
  // マス（O の現在地に近い＝S の絞り込みが最も鋭くなるはずだったマス）を優先。
  // 消すべき交差が無い手番（S 自身が動いた直後など）は afocal として振る舞う。
  else if (cfg.ojama === 'censor') {
    const sPath = target === 0 ? pathA : pathB;
    const oPath = target === 0 ? pathB : pathA;
    const oPos = target === 0 ? posB : posA;
    // 「まだ開示されていない確定交差」が存在する条件:
    //   既定タイミング（移動後配置）: 相方Oが動いた直後＝mover !== target
    //   前置（--jpre・手番頭配置）  : 標的S自身の手番頭＝mover === target
    //   （前置＋集中で標的でない側の手番頭に置く場合、交差は開示済みの古情報→afocalへ）
    const freshCross = cfg.jpre ? mover === target : mover !== target;
    if (freshCross && sPath && oPath) {
      const oSet = new Set(oPath);
      let bd = Infinity;
      for (const x of sPath) {
        if (!oSet.has(x) || blockedArr[x] || x === posA || x === posB) continue;
        const d = board.d(x, oPos) + rng() * 1e-3;
        if (d < bd) { bd = d; cell = x; }
      }
    }
    if (cell < 0) cell = afocalCell(board, blockedArr, posA, posB, target, false);
  }
  // 読み合い用のおじゃま:
  //   cagecenter=中心だけを毒す素朴読み（プレイヤーが中心に来ると決めつける）
  //   predict   =プレイヤーの集合戦略 pfocal を読み、その日の集合点を先回りで毒す（強い読み）
  //   spread    =メニュー全ランドマークに分散して毒す（ヘッジ。どこに来ても薄く効く）
  else if (cfg.ojama === 'cagecenter') cell = cageAround(board, blockedArr, center, posA, posB, rng);
  else if (cfg.ojama === 'predict') cell = cageAround(board, blockedArr, focalGoal(board, cfg, day || 1), posA, posB, rng);
  else if (cfg.ojama === 'spread') {
    const menu = landmarkMenu(board);
    cell = cageAround(board, blockedArr, menu[(day || 1) % menu.length], posA, posB, rng);
  }
  if (cfg.ojama === 'choke' || ((cfg.ojama === 'cage' || cfg.ojama === 'predict' ||
      cfg.ojama === 'cagecenter' || cfg.ojama === 'spread' || cfg.ojama === 'afocal' ||
      cfg.ojama === 'censor') && cell < 0)) {
    cell = chokeCell(board, blockedArr, from, to, rng);
  }
  if (cell < 0) {
    // random ポリシー / 各cageのフォールバック
    const legal = [];
    for (let q = 0; q < board.size; q++) {
      if (!blockedArr[q] && q !== posA && q !== posB) legal.push(q);
    }
    if (legal.length) cell = legal[(rng() * legal.length) | 0];
  }
  return { cell, target };
}

// 布石（開始前配置）の1個ぶんの配置先を、指定した盤(target)の「内側マス」から選ぶ。
// 外周には置かない（詰み防止）。おじゃまの方策が選んだマスが外周/不正なら、それに最も近い
// 内側の空きマスへ寄せる。方策が候補を出せなければ内側からランダムに置く。
function ojamaOpeningPlace(board, cfg, blockedArr, posA, posB, target, rng) {
  const from = target === 0 ? posA : posB;
  const to = target === 0 ? posB : posA;
  const c = (board.N - 1) >> 1, center = c * board.N + c;
  let pref = -1;
  if (cfg.ojama === 'cage') pref = cageCell(board, blockedArr, posA, posB, rng);
  else if (cfg.ojama === 'cagecenter') pref = cageAround(board, blockedArr, center, posA, posB, rng);
  else if (cfg.ojama === 'predict') pref = cageAround(board, blockedArr, focalGoal(board, cfg, 1), posA, posB, rng);
  else if (cfg.ojama === 'spread') {
    const menu = landmarkMenu(board);
    pref = cageAround(board, blockedArr, menu[1 % menu.length], posA, posB, rng);
  }
  if (cfg.ojama === 'choke' || pref < 0) pref = chokeCell(board, blockedArr, from, to, rng);
  // 内側に限定。pref が内側の空きならそれを使い、そうでなければ最寄りの内側空きマスへ寄せる。
  const ok = (q) => board.interiorMask[q] && !blockedArr[q] && q !== posA && q !== posB;
  if (pref >= 0 && ok(pref)) return pref;
  let best = -1, bd = Infinity;
  for (const q of board.interior) {
    if (!ok(q)) continue;
    const d = (pref >= 0 ? board.d(q, pref) : 0) + rng() * 1e-3;
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

// 非対称布石（--jasym・実験用）: 盤ごとに「中心に近い順」で内側マスを塞ぐが、
// 距離が同じマスのタイブレークを盤で逆にする（盤0は index 昇順=上・左を先に、
// 盤1は index 降順=下・右を先に）。これで focal の決定的な再設定
// 「中心が塞がれたら中心に最も近い空きマスへ」が二人で食い違い、
// 別々の代替焦点を選んで会えなくなる。ミラー布石の弱さを潰す狙い。
function ojamaAsymOpening(board, blockedArr, target, posA, posB) {
  const N = board.N, c = (N - 1) >> 1, center = c * N + c;
  let best = -1, bd = Infinity, bi = target === 0 ? Infinity : -Infinity;
  for (const q of board.interior) {
    if (blockedArr[q] || q === posA || q === posB) continue;
    const d = board.d(q, center);
    if (d < bd || (d === bd && (target === 0 ? q < bi : q > bi))) {
      bd = d; bi = q; best = q;
    }
  }
  return best;
}

/* ===================== afocal: focal点を"位置から"予測して非対称に潰す賢いキング =====================
 * 設計上の肝（循環回避）: シーカーの focal は「盤中心＝位置に依存しない固定焦点」。
 * キングはその目標関数（focalGoal）を一切呼ばず、"観測できる二人の位置"だけから
 * 合流予測点 F を独立に推定する（全知キングが正当に持つ情報）。両者への距離和が最小の
 * 内側マス、タイブレークは中心寄り。→ 序盤（二人が離れている）は F が中心からずれ、
 * 収束につれ F→中心に一致していく。アルゴリズムが別物なので"当たり外れ"のある本物の予測。
 */
function predictFocal(board, posA, posB) {
  const N = board.N, c = (N - 1) >> 1, center = c * N + c;
  let F = -1, bs = Infinity;
  for (const q of board.interior) {
    const s = (board.d(q, posA) + board.d(q, posB)) * 10 + board.d(q, center);
    if (s < bs) { bs = s; F = q; }
  }
  return F;
}

// 予測点 F の近傍（距離≤2）を、盤ごとに"逆側"から毒す。F 自体を最優先で塞ぎ、
// 同距離のマスは盤0=低index側（上・左）、盤1=高index側（下・右）を先に選ぶ。
// → 二人の「Fに最も近い空きマス」が食い違い、別々の代替焦点へ向かって会えなくなる。
// interiorOnly=true は布石用（外周禁止）。毎手番は外周も可。
function afocalCell(board, blockedArr, posA, posB, target, interiorOnly) {
  const F = predictFocal(board, posA, posB);
  if (F < 0) return -1;
  let best = -1, bScore = Infinity;
  for (let q = 0; q < board.size; q++) {
    if (blockedArr[q] || q === posA || q === posB) continue;
    if (interiorOnly && !board.interiorMask[q]) continue;
    const dF = board.d(q, F);
    if (dF > 2) continue;
    const sideKey = target === 0 ? q : (board.size - 1 - q); // 盤で優先する側を反転
    const score = dF * 10000 + sideKey; // 主: F近傍優先, 副: 盤ごとの側
    if (score < bScore) { bScore = score; best = q; }
  }
  return best;
}

// 相手の盤に置かれたであろう k 個のデブリを、おじゃまの方策から静的に推定する
// （デブリ認識AI 'block' 用。honest: 使うのは公知の方策・自分の位置・自分のbeliefのみ）。
function estimatePartnerBlocked(board, cfg, myPos, partnerEst, k, rng) {
  const est = new Uint8Array(board.size);
  for (let i = 0; i < k; i++) {
    let cell = -1;
    if (cfg.ojama === 'cage') cell = cageCell(board, est, myPos, partnerEst, rng);
    if (cfg.ojama === 'choke' || (cfg.ojama === 'cage' && cell < 0)) {
      cell = chokeCell(board, est, partnerEst, myPos, rng); // from=相手, to=自分
    }
    if (cell >= 0 && cell !== partnerEst && cell !== myPos) est[cell] = 1;
    else break;
  }
  return est;
}

/* ===================== belief（相手位置の確率分布） ===================== */

function makeBelief(board, myStart, minDist) {
  const b = new Float64Array(board.size);
  let n = 0;
  for (const p of board.perimeter) {
    if (board.d(myStart, p) >= minDist) { b[p] = 1; n++; }
  }
  if (n === 0) { for (const p of board.perimeter) b[p] = 1; n = board.perimeter.length; }
  for (let i = 0; i < board.size; i++) b[i] /= n;
  return b;
}

function normalize(b) {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i];
  if (s > 1e-12) { for (let i = 0; i < b.length; i++) b[i] /= s; return true; }
  return false;
}

/*
 * 相手の1手番分の移動で belief を前方伝播。
 * roll が既知（出目開示 on）なら Ts[roll]、未知なら Tmix。
 * oppModel='greedy'（v2）: 相手は自分（myPos）に近づくよう動くと仮定し、
 * 着地候補を距離減衰で重み付けする。
 */
function propagateBelief(board, belief, roll, oppModel, myPos) {
  const size = board.size;
  const out = new Float64Array(size);
  if (oppModel === 'greedy') {
    const rolls = roll != null ? [roll] : null;
    for (let p = 0; p < size; p++) {
      const w0 = belief[p];
      if (w0 < 1e-15) continue;
      const ss = rolls || range(board.minRoll, board.maxRoll);
      for (const s of ss) {
        const ps = roll != null ? 1 : board.diceProbs[s];
        const r = board.reach[p][s];
        let z = 0;
        for (const q of r) z += 1 / (1 + board.d(q, myPos));
        for (const q of r) out[q] += w0 * ps * (1 / (1 + board.d(q, myPos))) / z;
      }
    }
  } else {
    const M = roll != null ? board.Ts[roll] : board.Tmix;
    for (let p = 0; p < size; p++) {
      const w0 = belief[p];
      if (w0 < 1e-15) continue;
      const row = p * size;
      for (let q = 0; q < size; q++) out[q] += w0 * M[row + q];
    }
  }
  return out;
}

function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

/*
 * 交差観測による belief 更新。
 * subjectRoll: 交差の原因となった「対象プレイヤーの移動」の出目（既知なら数値、未知なら null）。
 * crossCells:  開示された交差マス（対象の直近経路に含まれることが確定）。
 * clearCells:  対象の直近経路に含まれないことが確定したマス（負の情報）。
 * subjectMoved: 対象がまだ一度も動いていない場合 false（→交差マス＝現在地）。
 * subjectBlocked: 対象の盤のデブリ（既知＝共有型かつ認識AIのとき）。尤度の距離を
 *                 「壁を通れない」BFS距離に置き換えて絞りを鋭くする。null なら開盤。
 */
function observeBelief(board, belief, crossCells, clearCells, subjectRoll, subjectMoved, subjectBlocked) {
  const size = board.size;
  if (crossCells.length > 0) {
    if (!subjectMoved) {
      // まだ動いていない相手と交差 ＝ 相手はそのマスに立っている
      const nb = new Float64Array(size);
      for (const c of crossCells) nb[c] = 1;
      for (let i = 0; i < size; i++) belief[i] = nb[i] * (belief[i] > 0 ? 1 : 0.001);
    } else {
      // 経路がcを通った → 現在地は c から残り歩数以内。距離減衰の尤度を掛ける
      const dFields = subjectBlocked ? crossCells.map(c => bfsDist(board, c, subjectBlocked)) : null;
      for (let q = 0; q < size; q++) {
        if (belief[q] < 1e-15) continue;
        let like = 0;
        for (let ci = 0; ci < crossCells.length; ci++) {
          const c = crossCells[ci];
          const d = dFields ? (dFields[ci][q] >= 0 ? dFields[ci][q] : 1e9) : board.d(c, q);
          if (subjectRoll != null) {
            if (d <= subjectRoll) like += subjectRoll + 1 - d;
          } else {
            for (let s = board.minRoll; s <= board.maxRoll; s++) {
              if (d <= s) like += board.diceProbs[s] * (s + 1 - d);
            }
          }
        }
        belief[q] *= like;
      }
    }
  }
  const crossSet = new Set(crossCells);
  for (const x of clearCells) {
    if (!crossSet.has(x)) belief[x] = 0;
  }
  if (!normalize(belief)) {
    // 近似の矛盾で全滅した場合のフォールバック：確定除外だけ守って一様に戻す
    for (let i = 0; i < size; i++) belief[i] = 1;
    for (const x of clearCells) if (!crossSet.has(x)) belief[x] = 0;
    if (crossCells.length > 0 && subjectRoll != null) {
      for (let q = 0; q < size; q++) {
        let ok = false;
        for (const c of crossCells) if (board.d(c, q) <= subjectRoll) ok = true;
        if (!ok) belief[q] = 0;
      }
    }
    if (!normalize(belief)) { for (let i = 0; i < size; i++) belief[i] = 1 / size; }
  }
}

/* ===================== 方策 ===================== */

const WIN_WEIGHT = 200; // 着地マスに相手がいる確率の重み（即勝利）

function expectedDist(board, belief, L) {
  let e = 0;
  for (let q = 0; q < board.size; q++) {
    if (belief[q] > 1e-15) e += belief[q] * board.d(L, q);
  }
  return e;
}

// デブリ認識版: 自分の盤の実距離（壁の迂回コスト込み）で期待距離を測る。
// 自陣で到達不能なマスは「相手に来てもらうしかない」ので盤一辺ぶんのペナルティ付き。
function expectedDistBlocked(board, belief, L, blocked) {
  const df = bfsDist(board, L, blocked);
  let e = 0;
  for (let q = 0; q < board.size; q++) {
    const w = belief[q];
    if (w > 1e-15) e += w * (df[q] >= 0 ? df[q] : board.d(L, q) + board.N);
  }
  return e;
}

// belief を半径2でならした「交差期待フィールド」
function smoothField(board, belief) {
  const sm = new Float64Array(board.size);
  for (let q = 0; q < board.size; q++) {
    const w = belief[q];
    if (w < 1e-15) continue;
    for (let x = 0; x < board.size; x++) {
      const d = board.d(q, x);
      if (d <= 2) sm[x] += w * (3 - d);
    }
  }
  return sm;
}

/*
 * 着地マスと経路を選ぶ。
 * mode: 'random' | 'greedy' | 'infogain' | 'hybrid' | 'focal'
 * reach: 今回の出目で着地可能なマス（デブリ考慮済み）
 * sampler(landing): 経路を1本サンプリング（デブリ考慮済み）
 * myBlocks: 自分の盤のデブリ（null=なし）。focal の目標マス補正に使う
 * awareInfo: デブリ認識AI用 { mine, total }（自分の盤のデブリ数／総配置数）。
 *            秘匿型では「1移動=1デブリ」が公知ルールなので総数は手番から推論できる。
 * 戻り値 { landing, path }
 */
function chooseMove(board, me, roll, day, maxDay, mode, rng, eps, reach, sampler, myBlocks, awareInfo, cfg) {
  // ε-ランダム：人間の不完全さのモデル。確率 eps で無情報に動く
  if (eps > 0 && mode !== 'random' && rng() < eps) mode = 'random';

  if (mode === 'hybrid') {
    // 序盤（約4割）は情報収集、以降は会いにいく
    mode = day <= Math.ceil(maxDay * 0.4) ? 'infogain' : 'greedy';
  }

  if (mode === 'random') {
    const landing = reach[(rng() * reach.length) | 0];
    return { landing, path: sampler(landing) };
  }

  // focal: 事前に示し合わせた収束点（盤の中心）へ向かってホバリングするだけ。
  // belief も交差も出目も一切使わない「約束事」戦略。必勝法の脅威を測るための対照。
  // 中心が自分の盤で塞がれていたら「中心に最も近い空きマス」に目標を替える
  // （決定的な走査順なので、デブリが共有・公開なら二人は同じ代替目標を選べる）。
  // nfocal: 素朴な約束事。常に「厳密な中心」を狙うだけ（自分の盤で塞がれていても
  // 再設定しない）。focalの再設定が秘匿おじゃま下で不当に有利になっていないかの対照。
  if (mode === 'focal' || mode === 'nfocal') {
    let goal = focalGoal(board, cfg || {}, day); // pfocal に応じて中心 or メニューの集合点
    if (mode === 'focal' && myBlocks && myBlocks[goal]) {
      let bg = goal, bd = Infinity;
      for (let q = 0; q < board.size; q++) {
        if (myBlocks[q]) continue;
        const d = board.d(q, goal);
        if (d < bd) { bd = d; bg = q; }
      }
      goal = bg;
    }
    let best = null, bd2 = Infinity;
    for (const L of reach) {
      const d = board.d(L, goal) + rng() * 1e-6; // 目標に乗れるなら乗る、無理なら最短接近
      if (d < bd2) { bd2 = d; best = L; }
    }
    return { landing: best, path: sampler(best) };
  }

  // focalx: 中心へ向かうfocalに「交差で相手が特定できたら奪う」を足す。
  // 共有アンカー（中心）は動かさないので二人の同期は壊れず、ホバリングの膠着だけを崩す。
  // xfocal: アンカー自体を共有交差マスへ動かす（cfg.sharedCross のときだけ機能）。
  //   秘匿ルール（交差は横切った側だけが知る）では focalTarget は中心のまま＝focalに退化。
  if (mode === 'focalx' || mode === 'xfocal') {
    const goal = mode === 'xfocal' ? me.focalTarget : ((( board.N - 1) >> 1) * board.N + ((board.N - 1) >> 1));
    let best = null, bs = -Infinity;
    for (const L of reach) {
      // 相手を掴む（着地=勝ち）を最優先、次にアンカーへの接近
      const s = WIN_WEIGHT * me.belief[L] - board.d(L, goal) + rng() * 1e-6;
      if (s > bs) { bs = s; best = L; }
    }
    return { landing: best, path: sampler(best) };
  }

  const belief = me.belief;
  let best = null, bestScore = -Infinity;

  if (mode === 'greedy') {
    // ---- デブリ認識AIの実験機構（両案とも素朴greedyに勝てず不採用。記録用に残す） ----
    // 'role'（錨プロトコル・秘匿型）: 「1移動=1デブリ」は公知なので、自分の盤の
    //   デブリ比率から集中攻撃を無通信で検知できる。標的側はほぼ動かない「錨」になり
    //   相方に見つけさせる…つもりだったが大幅悪化。減衰1では移動そのものが信号
    //   （動けば毎手番、長い新鮮な軌跡＝交差の断面を撒ける）で、錨は足跡が小さすぎて
    //   相方から手がかりを奪う自滅だった。
    if (awareInfo && awareInfo.mode === 'role'
        && awareInfo.total >= 4 && awareInfo.mine / awareInfo.total >= 0.7) {
      for (const L of reach) {
        const score = WIN_WEIGHT * belief[L] - board.d(L, me.pos) + rng() * 1e-6;
        if (score > bestScore) { bestScore = score; best = L; }
      }
      return { landing: best, path: sampler(best) };
    }
    // 'dist'（自陣BFS距離計画）: 期待距離を壁の迂回コスト込みで測る…つもりだったが
    //   全条件で悪化。出会いは相互的（自分が行けなくても相手が来れば会える）なので、
    //   自陣の壁を「避ける」計画は壁の向こうの相方から遠ざかる誤最適化になる。
    if (awareInfo && awareInfo.mode === 'dist') {
      for (const L of reach) {
        const score = WIN_WEIGHT * belief[L] - expectedDistBlocked(board, belief, L, awareInfo.blocks) + rng() * 1e-6;
        if (score > bestScore) { bestScore = score; best = L; }
      }
      return { landing: best, path: sampler(best) };
    }
    // 採用構成: 素朴greedy（到達集合だけデブリを尊重し、狙いはマンハッタン距離）
    for (const L of reach) {
      const score = WIN_WEIGHT * belief[L] - expectedDist(board, belief, L) + rng() * 1e-6;
      if (score > bestScore) { bestScore = score; best = L; }
    }
    return { landing: best, path: sampler(best) };
  }

  // infogain: 実際に通る経路が belief の濃い領域をどれだけ横断するか
  const sm = smoothField(board, belief);
  let bestPath = null;
  for (const L of reach) {
    const path = sampler(L);
    const seen = new Set();
    let info = 0;
    for (const x of path) {
      if (!seen.has(x)) { seen.add(x); info += sm[x]; }
    }
    const score = WIN_WEIGHT * belief[L] + info - 0.01 * expectedDist(board, belief, L) + rng() * 1e-6;
    if (score > bestScore) { bestScore = score; best = L; bestPath = path; }
  }
  return { landing: best, path: bestPath };
}

/* ===================== 1ゲーム ===================== */

function minStartDist(N) { return Math.max(4, Math.round(N * 1.1)); }

function playGame(board, cfg, rng) {
  const { maxDay, decay, policy, share, oppModel, dice } = cfg;
  const size = board.size;
  const per = board.perimeter;
  const minDist = minStartDist(board.N);

  // スタート位置（外周・最小距離制約）
  let a = per[(rng() * per.length) | 0], b;
  do { b = per[(rng() * per.length) | 0]; } while (board.d(a, b) < minDist);

  const cc = (board.N - 1) >> 1;
  const center = cc * board.N + cc;
  const mkPlayer = (pos) => ({
    pos,
    stamp: new Int32Array(size).fill(-1e9), // 各マスに最後に通った手番番号
    lastPathCells: [pos],                    // 直近手番で通ったマス
    lastRoll: null,                          // 直近手番の出目（開示用）
    moved: false,
    belief: policy !== 'random' ? makeBelief(board, pos, minDist) : null,
    focalTarget: center,                     // xfocal: 共有集合点（交差で更新）。focalx: 中心固定
  });
  const players = [mkPlayer(a), mkPlayer(b)];
  players[0].stamp[a] = 0;
  players[1].stamp[b] = 0;

  // ラストワンマイル分解の計測
  let minReach = board.d(a, b), firstClose2 = null, firstClose4 = null;

  // おじゃま係のデブリ盤。shared は同一配列を共有、private は各自の盤
  const jOn = cfg.ojama && cfg.ojama !== 'none';
  let blocks = null;
  if (jOn) {
    if (cfg.jvariant === 'private') blocks = [new Uint8Array(size), new Uint8Array(size)];
    else { const sh = new Uint8Array(size); blocks = [sh, sh]; }
  }
  const jcap = cfg.jcap != null ? cfg.jcap : 999;
  let debrisCount = 0;
  const debrisPer = [0, 0]; // 各プレイヤーの盤に置かれた数（秘匿型の役割推論用）
  const placeDebris = (nextMover, curDay) => {
    if (!jOn || debrisCount >= jcap) return;
    const { cell, target } = ojamaPlace(board, cfg, blocks, players[0].pos, players[1].pos, nextMover, rng, curDay,
      players[0].lastPathCells, players[1].lastPathCells);
    if (cell >= 0) { blocks[target][cell] = 1; debrisCount++; debrisPer[target]++; }
  };
  // 事前配置（布石）: 全知おじゃまは開始位置を見てから、1日目の前にデブリを置ける。
  // ルール: 各盤の「内側（外周を除く）」に jinit 個ずつ（合計 2×jinit）。外周は詰み防止で禁止。
  // 秘匿型は各自の盤に jinit 個。共有型は同一盤なので合計 2×jinit を1枚に置く。
  if (jOn && cfg.jinit) {
    const targets = cfg.jvariant === 'private' ? [0, 1] : [0, 0];
    for (const t of targets) {
      for (let i = 0; i < cfg.jinit; i++) {
        if (debrisCount >= jcap) break;
        const arr = blocks[t];
        let cell = (cfg.ojama === 'afocal' || cfg.ojama === 'censor')
          ? afocalCell(board, arr, players[0].pos, players[1].pos, t, true)
          : cfg.jasym
            ? ojamaAsymOpening(board, arr, t, players[0].pos, players[1].pos)
            : ojamaOpeningPlace(board, cfg, arr, players[0].pos, players[1].pos, t, rng);
        if (cell < 0 && (cfg.ojama === 'afocal' || cfg.ojama === 'censor')) // F近傍が埋まったら通常の内側配置へ退避
          cell = ojamaOpeningPlace(board, cfg, arr, players[0].pos, players[1].pos, t, rng);
        if (cell >= 0) { arr[cell] = 1; debrisCount++; debrisPer[t]++; }
      }
    }
  }

  // 診断（--jdump）: 最初の1ゲームだけ、両盤の布石の位置と非対称性を出力
  if (cfg.jdump && !cfg._dumped && jOn && cfg.jvariant === 'private') {
    cfg._dumped = true;
    const cellsOf = (arr) => { const s = []; for (let q = 0; q < size; q++) if (arr[q]) s.push(`(${(q / board.N) | 0},${q % board.N})`); return s; };
    const set0 = new Set(); for (let q = 0; q < size; q++) if (blocks[0][q]) set0.add(q);
    let overlap = 0; for (let q = 0; q < size; q++) if (blocks[0][q] && blocks[1][q]) overlap++;
    const cc2 = (board.N - 1) >> 1;
    console.log(`  [jdump] 中心=(${cc2},${cc2}) start A=(${(a / board.N) | 0},${a % board.N}) B=(${(b / board.N) | 0},${b % board.N})`);
    console.log(`  [jdump] 盤0の布石: ${cellsOf(blocks[0]).join(' ')}`);
    console.log(`  [jdump] 盤1の布石: ${cellsOf(blocks[1]).join(' ')}`);
    console.log(`  [jdump] 一致マス数=${overlap} / 各盤${cfg.jinit}個  → 非対称なら一致は少ないほど良い`);
  }

  let turn = 0, crossCellsTotal = 0, anyCross = false, stuck = 0;

  const rollDice = () => {
    let s = 0;
    for (let i = 0; i < dice.n; i++) s += 1 + ((rng() * dice.f) | 0);
    return s;
  };

  for (let day = 1; day <= maxDay; day++) {
    for (let pi = 0; pi < 2; pi++) {
      turn++;
      const me = players[pi], op = players[1 - pi];
      const roll = rollDice();
      const myBlocks = jOn ? blocks[pi] : null;

      // デブリ前置（--jpre・実験18）: ヒント照合の直前に「これからヒントを受け取る側」の盤へ
      // 1個置く（初日＝どちらかが未移動の間は置かない）。キングは両者の確定済み直前経路を
      // 見てから置けるので、確定検閲が毎ヒント可能。移動前なので今回の到達集合にも効く。
      if (cfg.jpre && me.moved && op.moved) placeDebris(pi, day);

      // ジャム（実験16）: trueFog=ヒント抑制に使う霧、ownFog=自分に見える霧（自分の盤のみ）。
      // --jjam は trueFog==ownFog（健全な情報遮断）。--jjamx は相方の盤の霧も抑制に効くが
      // 自分には見えない＝握り潰された交差を「クリア」と誤読する（負の情報の汚染）。
      let trueFog = null, ownFog = null;
      const jamR = cfg.jjamx != null ? cfg.jjamx : (cfg.jjam != null ? cfg.jjam : -1);
      if (jOn && jamR >= 0 && debrisCount > 0) {
        ownFog = fogMask(board, [myBlocks], jamR);
        trueFog = cfg.jjamx != null ? fogMask(board, [...new Set(blocks)], jamR) : ownFog;
      }

      // 到達集合と経路サンプラ（デブリがあれば層状DP、なければ高速な事前計算）
      let reach, layers = null;
      if (jOn && debrisCount > 0) {
        layers = computeLayers(board, me.pos, roll, myBlocks);
        reach = [];
        const Lk = layers[roll];
        for (let q = 0; q < size; q++) if (Lk[q]) reach.push(q);
      } else {
        reach = board.reach[me.pos][roll];
      }
      const sampler = (L) => (layers
        ? samplePathBlocked(board, layers, L, roll, rng)
        : samplePath(board, me.pos, L, roll, rng));

      // precross: 「自分の直前の移動 ∩ 相手の直前の移動」の交差を、動く前に知る。
      // 手番冒頭で belief を更新してから着地を選ぶ（既定の post-move 交差は下でスキップ）。
      if (cfg.precross && policy !== 'random' && me.moved && op.moved) {
        const opSet = new Set(op.lastPathCells);
        // ジャムあり: trueFog内の交差は開示されない。ownFog内は情報なし（プレイヤーが承知）。
        // jjamxでは「trueFogで潰れたがownFog外」の交差がpreClearに落ちる＝誤った負の情報。
        const uniqPre = [], preClear = [];
        for (const x of new Set(me.lastPathCells)) {
          const crossed = opSet.has(x);
          if (crossed && !(trueFog && trueFog[x])) uniqPre.push(x);
          else if (!(ownFog && ownFog[x])) preClear.push(x);
        }
        const opBlocksKnown = (cfg.aware === 'dist' && jOn && cfg.jvariant !== 'private' && debrisCount > 0)
          ? blocks[1 - pi] : null;
        observeBelief(
          board, me.belief, uniqPre, preClear,
          share ? op.lastRoll : null, op.moved, opBlocksKnown
        );
        me.belief[me.pos] = 0;
        normalize(me.belief);
      }

      // 詰み: ちょうどの歩数で止まれるマスがない → その場に留まる
      if (reach.length === 0) {
        stuck++;
        me.stamp[me.pos] = turn;
        me.lastPathCells = [me.pos];
        me.lastRoll = roll;
        me.moved = true;
        // belief 更新は簡略化のため省略（詰みは稀なイベント）
        if (!cfg.jpre) placeDebris(pi, day);
        continue;
      }

      // 着地選択（デブリ認識AIの実験機構: 'dist'=自陣BFS距離計画 / 'role'=錨プロトコル）
      let awareInfo = null;
      if (cfg.aware === 'dist' && jOn && debrisCount > 0) {
        awareInfo = { mode: 'dist', blocks: myBlocks };
      } else if (cfg.aware === 'role' && jOn && cfg.jvariant === 'private') {
        awareInfo = { mode: 'role', mine: debrisPer[pi], total: debrisCount };
      }
      const mv = chooseMove(board, me, roll, day, maxDay, policy, rng, cfg.eps || 0, reach, sampler, myBlocks, awareInfo, cfg);
      const landing = mv.landing, path = mv.path;

      // 交差判定（相手の減衰内スタンプとの重なり）。segment=移動で踏んだマス（出発マスは除く）
      const segment = path.slice(1);
      const crosses = [];
      for (const x of segment) {
        const t = op.stamp[x];
        const hit = decay === 0 ? t >= 0 : (turn - t) <= decay;
        if (hit) crosses.push(x);
      }
      const uniqCross = [...new Set(crosses)];
      // ジャムあり: 霧内の交差はヒントとして開示されない（統計も開示ベースで数える）
      const discCross = trueFog ? uniqCross.filter((x) => !trueFog[x]) : uniqCross;
      crossCellsTotal += discCross.length;
      if (discCross.length > 0) anyCross = true;

      // 自分の軌跡スタンプと移動
      for (const x of path) me.stamp[x] = turn;
      const prevLastPath = me.lastPathCells;
      me.pos = landing;
      me.lastPathCells = [...new Set(path)];
      me.lastRoll = roll;
      me.moved = true;

      // 近接の計測（ラストワンマイル分解用）
      const dcur = board.d(me.pos, op.pos);
      if (dcur < minReach) minReach = dcur;
      if (firstClose2 === null && dcur <= 2) firstClose2 = day;
      if (firstClose4 === null && dcur <= 4) firstClose4 = day;

      // xfocal: 共有交差があれば集合点を「中心に最も近い交差マス」へ更新（両者共通知識）
      if (cfg.sharedCross && uniqCross.length > 0) {
        let ft = players[0].focalTarget, fb = board.d(ft, center);
        for (const x of uniqCross) { const d = board.d(x, center); if (d < fb) { fb = d; ft = x; } }
        players[0].focalTarget = players[1].focalTarget = ft;
      }

      // 勝利判定（同マス限定）
      if (me.pos === op.pos) {
        return { met: true, day, crossCellsTotal, anyCross, stuck, minReach, firstClose2, firstClose4 };
      }

      // ---- belief 更新（交差は「今、相手の直前の道を横切った側」だけが知る） ----
      if (policy !== 'random') {
        // (1) 動いた側（me）：相手の直近経路との交差＝相手の居場所の手がかり。
        //     交差あり → 相手の経路が crosses を通った。
        //     交差なし → 自分が踏んだマスは相手の直近経路に含まれない（負の情報）。
        //     着地マスに相手はいない（勝利していないので）。
        //     ※ --precross のときは手番冒頭で更新済みなので post-move の更新はスキップする。
        if (!cfg.precross) {
          // 交差マス以外の踏破マスは相手経路に含まれない（ownFog内は情報なしとして除外。
          // jjamxで握り潰された交差はここに残る＝誤った負の情報）
          const myClear = [...new Set(segment)].filter((x) => !(ownFog && ownFog[x]));
          // 認識AI('dist')＋共有型: 相手も同じ壁を通れないので、交差からの尤度をBFS距離で締める
          const opBlocksKnown = (cfg.aware === 'dist' && jOn && cfg.jvariant !== 'private' && debrisCount > 0)
            ? blocks[1 - pi] : null;
          observeBelief(
            board, me.belief, discCross, myClear,
            share ? op.lastRoll : null, op.moved, opBlocksKnown
          );
          me.belief[me.pos] = 0;
          normalize(me.belief);
        }

        // (2) 相手側（op）：交差は伝えられない。分かるのは「me が1手番動いた」ことと、
        //     出目開示ありならその出目だけ。前方伝播と「未出会い」除外のみ。
        op.belief = propagateBelief(board, op.belief, share ? roll : null, oppModel, op.pos);
        op.belief[op.pos] = 0; // 出会っていない
        normalize(op.belief);

        // 反実仮想: 交差を共有すると、相手(op)も「me が uniqCross を通った＝me の現在地は
        // そこから roll 以内」を学べる。既定ルール（秘匿）ではこの経路は無い。
        if (cfg.sharedCross && uniqCross.length > 0) {
          observeBelief(board, op.belief, uniqCross, [], share ? roll : null, true, null);
          op.belief[op.pos] = 0;
          normalize(op.belief);
        }

        // 共有デブリは公開情報：相手はデブリの上には立てない。
        // 秘匿型では相手のデブリを知らないので何も除外できない（それが情報の毒）。
        if (jOn && cfg.jvariant !== 'private') {
          const sh = blocks[0];
          for (let q = 0; q < size; q++) {
            if (sh[q]) { me.belief[q] = 0; op.belief[q] = 0; }
          }
          normalize(me.belief);
          normalize(op.belief);
        }

        // 認識AI 'block'（秘匿型・相手の被おじゃまを推理）:
        // 公知ルール「1移動=1デブリ」から相手の盤のデブリ総数を知り、おじゃまの方策を
        // 使って相手のデブリ位置を推定→「相手はそこに立てない」を belief に反映する。
        // 全知おじゃまへの theory-of-mind。推定は相手位置=自分のbelief最尤という循環近似。
        if (cfg.aware === 'block' && jOn && cfg.jvariant === 'private' && debrisCount > 0) {
          const partnerDebris = debrisCount - debrisPer[pi]; // 相手の盤のデブリ数（公知）
          if (partnerDebris > 0) {
            let est = 0, bw = -1;
            for (let q = 0; q < size; q++) if (me.belief[q] > bw) { bw = me.belief[q]; est = q; }
            const pb = estimatePartnerBlocked(board, cfg, me.pos, est, partnerDebris, rng);
            for (let q = 0; q < size; q++) if (pb[q]) me.belief[q] *= 0.15; // soft（推定は不確実）
            normalize(me.belief);
          }
        }
      }
      void prevLastPath;

      // おじゃま係: シーカーが動いた後、その本人の盤にデブリを1個置く（--jpre 時は手番頭に前置済み）
      if (!cfg.jpre) placeDebris(pi, day);
    }
  }
  return { met: false, day: null, crossCellsTotal, anyCross, stuck, minReach, firstClose2, firstClose4 };
}

/* ===================== 実験ランナー ===================== */

function runCondition(cfg) {
  const dice = cfg.dice;
  const board = getBoard(cfg.N, dice);
  const rng = mulberry32(cfg.seed || 12345);
  let met = 0, sumDay = 0, cross = 0, anyCrossGames = 0, stuck = 0;
  let close2 = 0, metGivenClose2 = 0, sumFirstClose2 = 0, sumLastMile = 0, sumMinDist = 0;
  for (let i = 0; i < cfg.trials; i++) {
    const r = playGame(board, cfg, rng);
    if (r.met) { met++; sumDay += r.day; }
    cross += r.crossCellsTotal;
    if (r.anyCross) anyCrossGames++;
    stuck += r.stuck;
    sumMinDist += r.minReach;
    if (r.firstClose2 !== null) {
      close2++;
      sumFirstClose2 += r.firstClose2;
      if (r.met) { metGivenClose2++; sumLastMile += (r.day - r.firstClose2); }
    }
  }
  return {
    meetRate: (100 * met) / cfg.trials,
    avgDay: met ? sumDay / met : NaN,
    crossPerGame: cross / cfg.trials,
    crossGameRate: (100 * anyCrossGames) / cfg.trials,
    stuckPerGame: stuck / cfg.trials,
    // ラストワンマイル分解
    close2Rate: (100 * close2) / cfg.trials,          // 一度でも距離≤2に接近した割合
    convRate: close2 ? (100 * metGivenClose2) / close2 : NaN, // 接近を勝ちに変換できた割合
    firstClose2: close2 ? sumFirstClose2 / close2 : NaN,      // 初めて距離≤2になった日
    lastMile: metGivenClose2 ? sumLastMile / metGivenClose2 : NaN, // 接近から着地までの日数
    minDist: sumMinDist / cfg.trials,                 // 到達した最小距離の平均
  };
}

const boardCache = new Map();
function getBoard(N, dice) {
  const key = `${N}:${dice.n}d${dice.f}`;
  if (!boardCache.has(key)) boardCache.set(key, new Board(N, dice.n * dice.f, dice));
  return boardCache.get(key);
}

function fmt(x, d = 1) { return Number.isFinite(x) ? x.toFixed(d) : '-'; }

function printResult(label, r) {
  console.log(
    `${label.padEnd(42)} 出会い ${fmt(r.meetRate).padStart(5)}%  平均決着日 ${fmt(r.avgDay, 2).padStart(5)}  ` +
    `交差/g ${fmt(r.crossPerGame, 2).padStart(6)}  交差有 ${fmt(r.crossGameRate).padStart(5)}%  詰み/g ${fmt(r.stuckPerGame, 2)}`
  );
}

// ラストワンマイル分解の表示
function printDiag(label, r) {
  console.log(
    `${label.padEnd(34)} 出会い ${fmt(r.meetRate).padStart(5)}%  ` +
    `接近≤2 ${fmt(r.close2Rate).padStart(5)}%  変換率 ${fmt(r.convRate).padStart(5)}%  ` +
    `初接近日 ${fmt(r.firstClose2, 2).padStart(4)}  接近→着地 ${fmt(r.lastMile, 2).padStart(4)}日  最小距離 ${fmt(r.minDist, 2)}`
  );
}

/* ===================== CLI ===================== */

function main() {
  const args = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (const a of args) {
    if (a === '--matrix') flags.matrix = true;
    else if (a === '--share') flags.share = true;
    else if (a.startsWith('--policy=')) flags.policy = a.slice(9);
    else if (a.startsWith('--opp=')) flags.opp = a.slice(6);
    else if (a.startsWith('--seed=')) flags.seed = +a.slice(7);
    else if (a.startsWith('--eps=')) flags.eps = +a.slice(6);
    else if (a.startsWith('--ojama=')) flags.ojama = a.slice(8);
    else if (a.startsWith('--jvariant=')) flags.jvariant = a.slice(11);
    else if (a.startsWith('--jcap=')) flags.jcap = +a.slice(7);
    else if (a.startsWith('--jinit=')) flags.jinit = +a.slice(8);
    else if (a.startsWith('--jjam=')) flags.jjam = +a.slice(7);
    else if (a.startsWith('--jjamx=')) flags.jjamx = +a.slice(8);
    else if (a === '--jfocus') flags.jfocus = true;
    else if (a === '--jpre') flags.jpre = true;
    else if (a === '--jasym') flags.jasym = true;
    else if (a === '--jdump') flags.jdump = true;
    else if (a.startsWith('--aware=')) flags.aware = a.slice(8);
    else if (a === '--aware') flags.aware = 'dist';
    else if (a === '--sharedcross') flags.sharedCross = true;
    else if (a === '--precross') flags.precross = true;
    else if (a.startsWith('--pfocal=')) flags.pfocal = a.slice(9);
    else pos.push(a);
  }

  if (flags.matrix) {
    runMatrix(pos[0] ? +pos[0] : 10000, flags.seed || 12345);
    return;
  }

  if (pos.length < 5) {
    console.log('usage: node sim.js <trials> <dice> <boards> <days> <decay> [--policy=P] [--share] [--opp=M] [--seed=K]');
    console.log('       node sim.js --matrix [trials]');
    process.exit(1);
  }

  const trials = +pos[0];
  const diceSpecs = pos[1].split(',').map(parseDiceSpec);
  const boards = pos[2].split(',').map(Number);
  const maxDay = +pos[3];
  const decay = +pos[4];
  const policy = flags.policy || 'random';

  for (const dice of diceSpecs) {
    for (const N of boards) {
      const cfg = {
        trials, dice, N, maxDay, decay, policy,
        share: !!flags.share, oppModel: flags.opp || 'random', seed: flags.seed || 12345,
        eps: flags.eps || 0,
        ojama: flags.ojama || 'none', jvariant: flags.jvariant || 'shared', jcap: flags.jcap, jinit: flags.jinit || 0,
        jjam: flags.jjam != null ? flags.jjam : null, jjamx: flags.jjamx != null ? flags.jjamx : null,
        jpre: !!flags.jpre,
        jfocus: !!flags.jfocus, aware: flags.aware || null, sharedCross: !!flags.sharedCross,
        precross: !!flags.precross,
        pfocal: flags.pfocal || 'center', jasym: !!flags.jasym, jdump: !!flags.jdump,
      };
      const jl = cfg.ojama !== 'none' ? ` 邪魔${cfg.ojama}-${cfg.jvariant}${cfg.jfocus ? '(集中)' : ''}${cfg.jcap != null ? `(上限${cfg.jcap})` : ''}${cfg.jinit ? `(布石${cfg.jinit}${cfg.jasym ? '非対称' : ''})` : ''}${cfg.jjam != null ? `(ジャム${cfg.jjam})` : ''}${cfg.jjamx != null ? `(秘匿ジャム${cfg.jjamx})` : ''}${cfg.jpre ? '(前置)' : ''}` : '';
      const pl = cfg.pfocal && cfg.pfocal !== 'center' ? `[${cfg.pfocal}]` : '';
      const label = `${N}x${N} ${dice.label} ${maxDay}日 減衰${decay} ${policy}${pl}${cfg.aware ? `(認識${cfg.aware})` : ''}${cfg.eps ? `(ε=${cfg.eps})` : ''}${cfg.share ? '+出目' : ''}${cfg.precross ? '+先交差' : ''}${cfg.oppModel === 'greedy' ? ' oppV2' : ''}${jl}`;
      printResult(label, runCondition(cfg));
    }
  }
}

/* 第5節の実験マトリクス */
function runMatrix(trials, seed) {
  const d2 = parseDiceSpec('2d6');
  const base = { trials, dice: d2, N: 7, maxDay: 7, decay: 1, oppModel: 'random', seed };

  console.log(`\n=== 実験1: 方策 × 出目開示 (7x7, 2d6, 7日, 減衰1, ${trials}試行) ===`);
  for (const policy of ['random', 'greedy', 'infogain', 'hybrid']) {
    for (const share of [false, true]) {
      if (policy === 'random' && share) continue; // ランダムは情報を使わないので同一
      printResult(`${policy}${share ? ' +出目開示' : ''}`, runCondition({ ...base, policy, share }));
    }
  }

  console.log(`\n=== 実験2: 盤サイズ感度 (hybrid+出目開示, 2d6, 7日, 減衰1) ===`);
  for (const N of [5, 7, 9]) {
    printResult(`${N}x${N}`, runCondition({ ...base, N, policy: 'hybrid', share: true }));
  }

  console.log(`\n=== 実験3: 日数感度 (7x7, hybrid+出目開示, 2d6, 減衰1) ===`);
  for (const maxDay of [5, 6, 7, 8]) {
    printResult(`${maxDay}日`, runCondition({ ...base, maxDay, policy: 'hybrid', share: true }));
  }

  console.log(`\n=== 実験4: 相手モデル v1(random仮定) vs v2(greedy仮定) (greedy方策) ===`);
  for (const share of [false, true]) {
    for (const oppModel of ['random', 'greedy']) {
      printResult(
        `greedy${share ? '+出目' : ''} 相手モデル=${oppModel === 'random' ? 'v1' : 'v2'}`,
        runCondition({ ...base, policy: 'greedy', share, oppModel })
      );
    }
  }

  console.log(`\n=== 実験5: ε感度＝人間らしい不完全プレイ (7x7, greedy, 2d6, 7日, 減衰1) ===`);
  console.log(`    確率εで無情報（ランダム）に動く。人間プレイの想定帯を推定する`);
  for (const eps of [0.2, 0.4, 0.6, 0.8]) {
    for (const share of [false, true]) {
      printResult(`ε=${eps}${share ? ' +出目開示' : ''}`, runCondition({ ...base, policy: 'greedy', share, eps }));
    }
  }

  console.log(`\n=== 実験6: 収束点コンベンション（focal）の脅威 (2d6, 減衰1) ===`);
  console.log(`    「二人とも盤の中心へ向かうだけ」の約束事。交差も出目も使わない`);
  printResult('focal 7x7 7日 出目なし', runCondition({ ...base, policy: 'focal', share: false }));
  printResult('focal 7x7 7日 出目あり', runCondition({ ...base, policy: 'focal', share: true }));
  console.log('    ↑ 出目開示で差が出ない＝収束点必勝は出目開示のせいではない');
  printResult('focal 9x9 4日（盤拡大＋日数短縮でも）', runCondition({ ...base, N: 9, maxDay: 4, policy: 'focal' }));
  printResult('対照 greedy+出目 7x7 7日（正規の推理プレイ）', runCondition({ ...base, policy: 'greedy', share: true }));

  console.log(`\n=== 実験7: おじゃま係 — デブリ共有型(shared) vs 秘匿型(private) (7x7, 2d6, 7日, 減衰1) ===`);
  console.log(`    片方が移動するたびに全知おじゃまがデブリ+1。shared=両者共通・公開 / private=次に動く側だけ・非公開`);
  printResult('focal        おじゃまなし', runCondition({ ...base, policy: 'focal' }));
  printResult('greedy+出目   おじゃまなし', runCondition({ ...base, policy: 'greedy', share: true }));
  for (const oj of ['random', 'choke', 'cage']) {
    for (const jv of ['shared', 'private']) {
      printResult(`focal        ${oj}-${jv}`, runCondition({ ...base, policy: 'focal', ojama: oj, jvariant: jv }));
      printResult(`greedy+出目   ${oj}-${jv}`, runCondition({ ...base, policy: 'greedy', share: true, ojama: oj, jvariant: jv }));
    }
  }
  console.log(`    --- 秘匿・集中攻撃 (--jfocus: 常に同じ片方の盤だけに置き、見えない壁で隔離) ---`);
  for (const oj of ['choke', 'cage']) {
    printResult(`focal        ${oj}-private(集中)`, runCondition({ ...base, policy: 'focal', ojama: oj, jvariant: 'private', jfocus: true }));
    printResult(`greedy+出目   ${oj}-private(集中)`, runCondition({ ...base, policy: 'greedy', share: true, ojama: oj, jvariant: 'private', jfocus: true }));
  }
  console.log(`    --- デブリ上限感度 (choke, greedy+出目) ---`);
  for (const jv of ['shared', 'private']) {
    for (const cap of [4, 7, 14]) {
      printResult(`choke-${jv} 上限${cap}`, runCondition({ ...base, policy: 'greedy', share: true, ojama: 'choke', jvariant: jv, jcap: cap }));
    }
  }
  console.log(`    --- 人間帯 ε=0.4 (greedy+出目) ---`);
  for (const jv of ['shared', 'private']) {
    printResult(`ε=0.4 choke-${jv}`, runCondition({ ...base, policy: 'greedy', share: true, eps: 0.4, ojama: 'choke', jvariant: jv }));
  }
  printResult(`ε=0.4 cage-private(集中)`, runCondition({ ...base, policy: 'greedy', share: true, eps: 0.4, ojama: 'cage', jvariant: 'private', jfocus: true }));

  console.log(`\n=== 実験8: デブリを認識する協力AI（greedy+出目、両案とも不採用の記録） ===`);
  console.log(`    dist=自陣BFS距離で計画 / role=デブリ比率で集中攻撃を検知し標的が錨になる`);
  const jconfigs = [
    ['choke-shared', { ojama: 'choke', jvariant: 'shared' }],
    ['choke-private', { ojama: 'choke', jvariant: 'private' }],
    ['choke-private(集中)', { ojama: 'choke', jvariant: 'private', jfocus: true }],
    ['cage-private(集中)', { ojama: 'cage', jvariant: 'private', jfocus: true }],
  ];
  for (const [jname, jcfg] of jconfigs) {
    for (const aware of [null, 'dist', 'role']) {
      if (aware === 'role' && jcfg.jvariant !== 'private') continue; // roleは秘匿型専用
      printResult(
        `${jname} ${aware ? `認識${aware}` : '素朴greedy'}`,
        runCondition({ ...base, policy: 'greedy', share: true, ...jcfg, aware })
      );
    }
  }

  console.log(`\n=== 実験9: なぜ推理は約束事(focal)に勝てないのか — ラストワンマイル分解 (7x7, 2d6, 7日) ===`);
  console.log(`    接近≤2=一度でも距離2以内に寄った割合 / 変換率=その接近を同マス着地に変えられた割合`);
  printDiag('focal（約束事）', runCondition({ ...base, policy: 'focal' }));
  printDiag('greedy+出目（推理）', runCondition({ ...base, policy: 'greedy', share: true }));
  printDiag('greedy（出目なし）', runCondition({ ...base, policy: 'greedy' }));
  console.log(`    --- focalを情報で強化できるか（focalx=中心アンカー＋交差で相手を掴む） ---`);
  printDiag('focalx +出目', runCondition({ ...base, policy: 'focalx', share: true }));
  console.log(`    --- 情報構造の天井: 動的な共有集合点は交差の共有を要する ---`);
  printDiag('xfocal 交差=秘匿(既定ルール)', runCondition({ ...base, policy: 'xfocal', share: true }));
  printDiag('xfocal 交差=共有(反実仮想)', runCondition({ ...base, policy: 'xfocal', share: true, sharedCross: true }));
  printDiag('greedy 交差=共有(反実仮想)', runCondition({ ...base, policy: 'greedy', share: true, sharedCross: true }));

  console.log(`\n=== 実験10: 秘匿おじゃま下で focal は成立するか / 被おじゃま推理は効くか (7x7, 2d6, 7日) ===`);
  console.log(`    Q1: 中心が相手の盤で塞がれても focal は成立するのか（nfocal=再設定しない素朴版で下限を見る）`);
  console.log(`    Q2: 「相手はおじゃまされていそう」を belief に足す認識block は greedy を押し上げるか`);
  const jc10 = [
    ['choke-private', { ojama: 'choke', jvariant: 'private' }],
    ['choke-private(集中)', { ojama: 'choke', jvariant: 'private', jfocus: true }],
    ['cage-private(集中)', { ojama: 'cage', jvariant: 'private', jfocus: true }],
  ];
  for (const [jname, jcfg] of jc10) {
    console.log(`  --- ${jname} ---`);
    printResult('  focal（約束事）', runCondition({ ...base, policy: 'focal', ...jcfg }));
    printResult('  nfocal（素朴・再設定なし）', runCondition({ ...base, policy: 'nfocal', ...jcfg }));
    printResult('  greedy+出目（素朴推理）', runCondition({ ...base, policy: 'greedy', share: true, ...jcfg }));
    printResult('  greedy+出目 認識block', runCondition({ ...base, policy: 'greedy', share: true, aware: 'block', ...jcfg }));
  }
  console.log(`    --- ラストワンマイル分解: 認識block は接近を着地に変換できているか (cage集中) ---`);
  const jf = { ojama: 'cage', jvariant: 'private', jfocus: true };
  printDiag('focal', runCondition({ ...base, policy: 'focal', ...jf }));
  printDiag('greedy+出目', runCondition({ ...base, policy: 'greedy', share: true, ...jf }));
  printDiag('greedy+出目 認識block', runCondition({ ...base, policy: 'greedy', share: true, aware: 'block', ...jf }));

  console.log(`\n=== 実験11: focalを前提とした読み合い — 集合戦略 × おじゃま配置の利得マトリクス ===`);
  console.log(`    focalは悪でなく大前提。二人が"どこに集まるか"を巡る全知おじゃまとの読み合いを測る。`);
  console.log(`    数字=出会い率%（プレイヤー視点の得点）。秘匿・集中(private/jfocus)、7x7・2d6・7日・1万試行`);
  const jbase = { ...base, jvariant: 'private', jfocus: true };
  // プレイヤーの集合戦略（行）
  const prows = [
    ['center 中心固定', { policy: 'focal', pfocal: 'center' }],
    ['rotate 日巡回  ', { policy: 'focal', pfocal: 'rotate' }],
    ['wander 公開乱数', { policy: 'focal', pfocal: 'wander' }],
    ['greedy 推理    ', { policy: 'greedy', share: true }],
  ];
  // おじゃまの配置戦略（列）
  const ocols = [
    ['なし', { ojama: 'none' }],
    ['中心固定', { ojama: 'cagecenter' }],
    ['予測追尾', { ojama: 'predict' }],
    ['分散', { ojama: 'spread' }],
    ['反応', { ojama: 'cage' }],
  ];
  const grid = [];
  console.log(`\n  ${'プレイヤー＼おじゃま'.padEnd(16)}` + ocols.map(([n]) => n.padStart(8)).join(''));
  for (const [rname, rcfg] of prows) {
    const row = [];
    for (const [, ocfg] of ocols) {
      const r = runCondition({ ...jbase, ...rcfg, ...ocfg });
      row.push(r.meetRate);
    }
    grid.push(row);
    console.log(`  ${rname.padEnd(16)}` + row.map((v) => `${v.toFixed(1)}`.padStart(8)).join(''));
  }
  // 読み合いの要約: 各プレイヤー戦略に対するおじゃまの最善（列内最小＝おじゃまが選ぶ）、
  // その中でプレイヤーが選ぶ最善（maximin）
  console.log(`\n  読み: 各行の「おじゃま最善（＝その行の最小値、なし列は除く）」`);
  let bestRow = -1, bestVal = -1;
  for (let i = 0; i < prows.length; i++) {
    let worst = Infinity, wj = -1;
    for (let j = 1; j < ocols.length; j++) if (grid[i][j] < worst) { worst = grid[i][j]; wj = j; }
    console.log(`    ${prows[i][0]}: 最悪 ${worst.toFixed(1)}% (おじゃま=${ocols[wj][0]})`);
    if (worst > bestVal) { bestVal = worst; bestRow = i; }
  }
  console.log(`  → プレイヤーの maximin 戦略: ${prows[bestRow][0].trim()}（保証 ${bestVal.toFixed(1)}%）`);
}

main();
