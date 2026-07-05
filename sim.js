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
 *              おじゃまが交差マスにデブリを置くと、その交差ヒントは検閲され開示されない。
 *   --share  : 出目の相互開示 on
 *   --opp    : belief 更新に使う相手移動モデル random(v1) | greedy(v2)（省略時 random）
 *   --eps    : 確率εで無情報（ランダム）に動く。シーカーの人間らしい不完全さのモデル（省略時 0）
 *   --jeps   : 確率εでキング（おじゃま）が賢い妨害を放棄し無作為に置く。キングの人間らしい
 *              不完全さのモデル。布石・毎手番の両方に効く（省略時 0）
 *   --aware=dist|block : デブリ認識AIの実験機構（実験8・10。いずれも素朴greedyに勝てず不採用）。
 *              dist =期待距離を自陣BFS距離で測る＋共有型は交差尤度も壁で締める
 *              block=公知の「1移動=1デブリ」＋おじゃま方策から相手のデブリ位置を推定し
 *                    「相手はそこに立てない」を belief に反映（被おじゃまの theory-of-mind）
 *   --ojama  : おじゃま係 none | random | choke | cage | cagecenter | predict | spread |
 *              afocal | censor | acensor | censorpure（省略時 none）。
 *              2日目以降、各シーカーが動く"前"に全知のおじゃまがその盤へデブリ（通行・停止不可
 *              マス）を1個置く（初日はデブリなし＝布石のみ）。デブリを直前経路の交差マスに置くと
 *              その交差ヒントを検閲でき（--precross 時）、当該手番の到達も塞げる。
 *              choke=二人の最短経路DAGの最細断面を優先封鎖（壁を育てる）
 *              cage =予測出会い地点（二人の中間・盤中央寄り）そのものと周囲を毒殺（反応型）
 *              afocal=位置から予測した焦点Fを盤ごとに逆側から潰す（約束事キラー・実験12）
 *              以下は実験15の検閲系（--precross 専用）:
 *              censor=交差ヒントの検閲を最優先、無ければ afocal で焦点封鎖（推理と約束事の両対応）
 *              censormax=検閲する交差マスを belief 崩壊まで実評価して選ぶ（否定的結果=censorと同等）
 *              acensor=afocal の焦点封鎖を基本に、F近傍で交差を兼ねるマスがあれば検閲を上乗せ
 *              censorpure=検閲だけに全振り（焦点封鎖しないので focal に無力＝一辺倒の悪例）
 *              以下は実験19（人間キングの「分断」戦略の定式化）:
 *              sever=★採用・分断キング。検閲（発生済みヒントの抹消）を最優先し、無ければ
 *                    belief操舵（mover の belief で着地選択を正確に再現し、最善応答後の
 *                    対相手期待距離を最大化するマスに置く）。布石は afocal 式（非対称・中心毒殺）。
 *                    censor を全列（対greedy・対focal・全ダイス）で上回る新・本命
 *              bmmx=sever の操舵成分の単体（検閲優先なし。アブレーション用）
 *              adapt=着地履歴で約束事型/推理型を分類しフォールバックを afocal/bmmx で切替
 *                    （sever に全列で支配される＝分類は不要だった）
 *              severm=sever の操舵の前に射程内の堀（moat）を挟む合成。対focalは最強（12〜14%）
 *                    だが対greedyで sever に劣る＝シーカー最善応答に対しては sever が上
 *              以下は素朴な定式化（シーカーの最善応答 greedy に対して censor を上回れないか
 *              （cmoat のみ僅差で超える）、いずれも sever に支配される＝記録と再現用に残置）:
 *              split=相手の直前軌跡（＝交差ヒントの発生源）のうち mover に最も近いマスを
 *                    動く前に塞ぐ＝交差の発生を上流で断つ。布石・フォールバックは choke（分断壁）
 *              splitc=検閲を最優先し、無ければ split の上流遮断
 *              split2=検閲→差し迫った交差の予防（--sgate=距離ゲート、既定3）→afocal の三段
 *              splitwall=mover と相手軌跡の間に min-cut の壁を築く（「向かわせない」の壁版）
 *              herd/cherd=mover の予測最善着地を先回り封鎖（cherd は検閲優先）
 *              mmx/cmmx=1手先読み: 対相手期待距離最大化の操舵の belief なし版（cmmx は検閲優先）
 *              moat/cmoat=相手の隣接マス（最終進入路）を塞ぐ堀でラストワンマイルを直接遮断
 *              以下は実験11の読み合い用: cagecenter=常に中心を毒す / predict=プレイヤーの
 *              集合戦略 pfocal を読んで先回り / spread=メニューを日ごとに巡回してヘッジ
 *   --pfocal : プレイヤーの集合戦略 center | rotate | wander（省略時 center。実験11）。
 *              center=中心固定 / rotate=日ごとにメニュー巡回 / wander=日から決まる公開擬似乱数
 *   --jvariant : デブリの効き方 shared | private（省略時 shared）
 *              shared=両者共通の盤・両者に公開 / private=次に動く側だけに効き、相手には見えない
 *   --jcap   : デブリ総数の上限（省略時 実質無制限=毎移動1個）
 *   --jpass  : 通過可能デブリ（実験21のルール変更案）。デブリは「着地（移動先）には
 *              選べないが、通過（飛び越し）は自由。そのマスの軌跡は読めない＝そこで
 *              起きる交差は恒久的に開示されない」。壁による分断の"完成"（神目線で
 *              どうやっても会えない盤面）が構造的に不可能になる。
 *   --jinit  : 開始前の布石数。各盤の内側（外周を除く）に jinit 個ずつ置く（合計 2×jinit、
 *              省略時 0）。N=0〜3 の難易度レバー。外周は詰み防止で禁止。
 *   --sgate  : split2 の距離ゲート。mover から相手軌跡までの距離がこれ以下のときだけ
 *              軌跡の入口を塞ぐ（省略時 3）。実験19の感度分析用。
 *   --trap   : 閉じ込め診断を表示（実験20）。自盤の空きマス連結成分の最小サイズ、
 *              成分≤8を経験した試合率、負けの相互分断率、負けあたり詰み回数。
 *   --tracetrap : 最初の「相互分断負け」の最終盤面をASCIIでダンプ（目視確認用）
 *   --mob=W  : シーカーの可動性項（実験20）。自盤のデブリ密度が高い着地にペナルティ
 *              W×Σmax(0,3-d)。人間の「囲われる前に壁から離れる」の greedy への移植。
 *   --soft=D : シーカーの揺らぎ（実験20）。最善からスコア差 D 以内の着地から一様に
 *              選ぶ混合戦略。sever の最善応答予測を外す読まれにくさのモデル。
 *   --safe[=N] : シーカーの袋小路回避則（実験20）。自盤の関節点解析で「デブリあと1個で
 *              密封されうるサイズ≤N の小部屋」への着地にペナルティ（省略時 N=8）。
 *              人間の「囲われかけの部屋に入らない」の greedy への移植。出会い率は
 *              変えないが、詰み凍結・相互分断の "事故死" をほぼ根絶する。
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
// 表記例: "1d6" / "2d4" のほか、リロール付きは "1d6r"（出目が1・2ならもう一度）
// や "1d6r3"（出目が3以下なら振り直し）のように r<しきい値> を付ける。
// reroll=k は「出目が k 以下なら k+1 以上が出るまで振り直す」を意味する。
function parseDiceSpec(s) {
  const m = String(s).match(/^(\d+)d(\d+)(r\d*)?$/i);
  if (m) {
    const n = +m[1], f = +m[2];
    let reroll = 0, label = `${n}d${f}`;
    if (m[3]) {
      reroll = m[3].length > 1 ? +m[3].slice(1) : 2; // "r" 単体は 1・2 で振り直し
      label = `${n}d${f}r${reroll}`;
    }
    return { n, f, reroll, label };
  }
  return { n: 1, f: +s, reroll: 0, label: `1d${s}` };
}

// 合計値ごとの確率（index=合計値）。reroll>0 なら reroll 以下の目を除外した
// 条件付き分布（常に振り直す方針なので、実効面が reroll+1..f の一様）になる。
function diceProbs(n, f, reroll = 0) {
  const lo = reroll + 1;      // 採用される最小の目
  const cnt = f - reroll;     // 採用される目の数
  let dist = [1];
  for (let d = 0; d < n; d++) {
    const nd = new Array(dist.length + f).fill(0);
    for (let s = 0; s < dist.length; s++) {
      if (!dist[s]) continue;
      for (let v = lo; v <= f; v++) nd[s + v] += dist[s] / cnt;
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
    this.diceProbs = diceProbs(dice.n, dice.f, dice.reroll || 0);
    this.minRoll = dice.n * ((dice.reroll || 0) + 1);
    this.maxRoll = dice.n * dice.f;
    let er = 0;
    for (let s = 0; s < this.diceProbs.length; s++) er += s * this.diceProbs[s];
    this.expRoll = Math.max(this.minRoll, Math.min(this.maxRoll, Math.round(er)));
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

// from を含む空きマス連結成分のサイズ（閉じ込め診断用）。blocked は通行不可マス。
function compSize(board, from, blocked) {
  const d = bfsDist(board, from, blocked);
  let n = 0;
  for (let q = 0; q < board.size; q++) if (d[q] >= 0) n++;
  return n;
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
// crossHints: target がこの手番の頭に見るはずの交差マス群（censor 系用・省略可）。
// censorInfo: censormax / bmmx 用の評価コンテキスト { belief, lastPath, subjectRoll, trueOpp }（省略可）。
// oppTrail:   target の相手の直前経路（split 系用・省略可）。
// intel:      adapt 用の mover 挙動観測 { moves, centerHits }（省略可）。
function ojamaPlace(board, cfg, blocks, posA, posB, mover, rng, day, crossHints, censorInfo, oppTrail, intel) {
  const priv = cfg.jvariant === 'private';
  // 秘匿型の標的: 「今動いた側」の盤に交互に置く
  const target = priv ? mover : 0; // shared は blocks[0]===blocks[1]
  const blockedArr = blocks[target];
  const from = priv ? (target === 0 ? posA : posB) : posA;
  const to = priv ? (target === 0 ? posB : posA) : posB;
  const opp = priv ? (target === 0 ? posB : posA) : posB; // target の相手の現在位置
  const c = (board.N - 1) >> 1, center = c * board.N + c;
  let cell = -1;
  // 不完全なキング（--jeps）: 確率 jeps で賢い妨害を放棄し、無作為な合法マスに置く。
  // シーカーの --eps と対をなす「人間らしいキングの取りこぼし」のモデル。
  const dumb = cfg.jeps > 0 && rng() < cfg.jeps;
  if (dumb) { /* 賢い配置をスキップし、下の無作為フォールバックに落とす */ }
  else if (cfg.ojama === 'cage') cell = cageCell(board, blockedArr, posA, posB, rng);
  // afocal: 位置から予測した focal 点 F を、盤ごとに逆側から潰す賢いキング（実験11）
  else if (cfg.ojama === 'afocal') cell = afocalCell(board, blockedArr, posA, posB, target, false);
  // censor: 交差ヒント検閲を最優先。無ければ afocal で焦点を毒す（focal 対策は afocal に委ねる）
  else if (cfg.ojama === 'censor') {
    cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0) cell = afocalCell(board, blockedArr, posA, posB, target, false);
  }
  // censormax: belief 崩壊を実際に評価して最も効く交差マスを検閲。無ければ afocal へ
  else if (cfg.ojama === 'censormax') {
    cell = censorInfo
      ? censorSmartCell(board, censorInfo.belief, crossHints, censorInfo.lastPath, censorInfo.subjectRoll, censorInfo.trueOpp, blockedArr)
      : censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0) cell = afocalCell(board, blockedArr, posA, posB, target, false);
  }
  // censorpure: 検閲だけに全振り（無ければ choke へ）。焦点封鎖をしないので focal に無力＝一辺倒の悪例
  else if (cfg.ojama === 'censorpure') cell = censorCell(board, blockedArr, crossHints, opp);
  // split: 素朴な分断（実験19・否定的結果）。相手の直前軌跡＝情報の発生源を上流で塞ぐ。無ければ choke（分断壁）へ
  else if (cfg.ojama === 'split') cell = splitCell(board, blockedArr, from, to, oppTrail);
  // splitc: 検閲（発生済みヒントの抹消）を最優先し、無ければ split の上流遮断
  else if (cfg.ojama === 'splitc') {
    cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0) cell = splitCell(board, blockedArr, from, to, oppTrail);
  }
  // split2: 三段ハイブリッド。①発生済みヒントの検閲 → ②交差が差し迫っていれば
  // （mover から相手軌跡までの距離 ≤ sgate）軌跡の入口を塞いで予防 → ③afocal で焦点毒殺。
  // 情報飢餓（①②）と、盲目greedyの中心収束を罰する③を1本の優先順位に束ねる。
  else if (cfg.ojama === 'split2') {
    cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0) {
      const gate = cfg.sgate != null ? cfg.sgate : 3;
      const sc = splitCell(board, blockedArr, from, to, oppTrail);
      if (sc >= 0 && board.d(sc, from) <= gate) cell = sc;
    }
    if (cell < 0) cell = afocalCell(board, blockedArr, posA, posB, target, false);
  }
  // splitwall: mover と相手軌跡の間に壁を築く（軌跡への min-cut）
  else if (cfg.ojama === 'splitwall') cell = splitWallCell(board, blockedArr, from, to, oppTrail);
  // herd: mover の予測最善着地（期待出目で相手に最も寄れるマス）を先回りして塞ぐ操舵
  else if (cfg.ojama === 'herd') cell = herdCell(board, blockedArr, from, to, board.expRoll, cfg.jpass);
  // cherd: 検閲を最優先し、無ければ herd の操舵
  else if (cfg.ojama === 'cherd') {
    cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0) cell = herdCell(board, blockedArr, from, to, board.expRoll, cfg.jpass);
  }
  // mmx: 1手先読みミニマックス（mover の最善応答後の対相手期待距離を最大化する操舵）
  else if (cfg.ojama === 'mmx') cell = minimaxCell(board, blockedArr, from, to, crossHints, cfg.jpass);
  // bmmx: belief版1手先読み（mover の実際の着地選択を belief で再現して読む）
  else if (cfg.ojama === 'bmmx') {
    cell = censorInfo ? beliefMinimaxCell(board, blockedArr, from, to, censorInfo.belief, crossHints) : -1;
    if (cell < 0) cell = minimaxCell(board, blockedArr, from, to, crossHints, cfg.jpass);
  }
  // sever: ★採用・分断キング（実験19）。検閲を最優先し、無ければ bmmx の belief操舵
  else if (cfg.ojama === 'sever') {
    cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0 && censorInfo) cell = beliefMinimaxCell(board, blockedArr, from, to, censorInfo.belief, crossHints, cfg.jpass);
  }
  // severm: sever の操舵の前に「射程内なら相手の最終進入路（堀）」を挟む合成の実験
  else if (cfg.ojama === 'severm') {
    cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0 && board.d(from, to) <= board.maxRoll) cell = moatCell(board, blockedArr, from, to);
    if (cell < 0 && censorInfo) cell = beliefMinimaxCell(board, blockedArr, from, to, censorInfo.belief, crossHints, cfg.jpass);
  }
  // adapt: 検閲は常に最優先（物理封鎖として約束事にも推理にも最強）。ヒントが無い手番の
  // フォールバックだけを、mover の着地履歴の分類で afocal（約束事型）/ bmmx（推理型）に切り替える
  else if (cfg.ojama === 'adapt') {
    cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0 && !adaptIsFocalish(intel) && censorInfo) {
      cell = beliefMinimaxCell(board, blockedArr, from, to, censorInfo.belief, crossHints, cfg.jpass);
    }
    if (cell < 0) cell = afocalCell(board, blockedArr, posA, posB, target, false);
  }
  // moat: 射程内なら相手の最終進入路（隣接マス）を最優先で塞ぎ、それ以外は censor→afocal
  else if (cfg.ojama === 'moat') {
    if (board.d(from, to) <= board.maxRoll) cell = moatCell(board, blockedArr, from, to);
    if (cell < 0) cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0) cell = afocalCell(board, blockedArr, posA, posB, target, false);
  }
  // cmoat: 検閲を最優先し、無ければ射程内の堀、それも無ければ afocal
  else if (cfg.ojama === 'cmoat') {
    cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0 && board.d(from, to) <= board.maxRoll) cell = moatCell(board, blockedArr, from, to);
    if (cell < 0) cell = afocalCell(board, blockedArr, posA, posB, target, false);
  }
  // cmmx: 検閲を最優先し、無ければ mmx の操舵
  else if (cfg.ojama === 'cmmx') {
    cell = censorCell(board, blockedArr, crossHints, opp);
    if (cell < 0) cell = minimaxCell(board, blockedArr, from, to, crossHints, cfg.jpass);
  }
  // acensor: afocal の焦点封鎖を基本に、F 近傍で交差を兼ねるマスがあれば検閲を上乗せ（併用）
  else if (cfg.ojama === 'acensor') cell = afocalCensorCell(board, blockedArr, posA, posB, target, crossHints);
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
      cfg.ojama === 'censor' || cfg.ojama === 'acensor' || cfg.ojama === 'censorpure' ||
      cfg.ojama === 'censormax' || cfg.ojama === 'split' || cfg.ojama === 'splitc' ||
      cfg.ojama === 'split2' || cfg.ojama === 'bmmx' || cfg.ojama === 'sever' || cfg.ojama === 'severm' ||
      cfg.ojama === 'moat' || cfg.ojama === 'cmoat' || cfg.ojama === 'splitwall' || cfg.ojama === 'adapt' ||
      cfg.ojama === 'herd' || cfg.ojama === 'cherd' || cfg.ojama === 'mmx' || cfg.ojama === 'cmmx') && cell < 0)) {
    if (!dumb) cell = chokeCell(board, blockedArr, from, to, rng);
  }
  if (cell < 0) {
    // random ポリシー / 各cageのフォールバック
    const legal = [];
    for (let q = 0; q < board.size; q++) {
      if (!blockedArr[q] && q !== posA && q !== posB &&
          (!cfg.jinterior || board.interiorMask[q])) legal.push(q);
    }
    if (legal.length) cell = legal[(rng() * legal.length) | 0];
  }
  // --jinterior: 外周は最初から最後まで配置禁止（詰み防止を全期間に拡張）。
  // 方策が外周を選んだら、最寄りの内側の空きマスへ寄せる。
  if (cfg.jinterior && cell >= 0 && !board.interiorMask[cell]) {
    let best = -1, bd = Infinity;
    for (const q of board.interior) {
      if (blockedArr[q] || q === posA || q === posB) continue;
      const d = board.d(q, cell) + rng() * 1e-3;
      if (d < bd) { bd = d; best = q; }
    }
    cell = best;
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

/* ===================== censor: 交差ヒントを検閲する（先交差ルール専用） =====================
 * ルール変更（本差分）で、キングがデブリを「交差マス」の上に置くと、その交差ヒントは
 * シーカーに開示されない（検閲）。precross の greedy は手番冒頭の最新交差で追跡するため、
 * その最新ヒントを潰せば追跡が鈍る。ただし約束事(focal)は belief も交差も見ないので
 * 検閲は完全に無駄打ち＝censor 一辺倒は focal に勝てない。
 */

// crossHints: target がこの手番の頭に見るはずの（まだ検閲していない）交差マス群。
// opp: target の相手の現在位置。相手に最も近い交差マス＝最も強い位置手がかりを優先的に潰す。
function censorCell(board, blockedArr, crossHints, opp) {
  if (!crossHints || crossHints.length === 0) return -1;
  let best = -1, bd = Infinity;
  for (const q of crossHints) {
    if (blockedArr[q] || q === opp) continue;
    const d = board.d(q, opp);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

// censormax: 全知キングが「どの交差マスを消せば belief が最も崩れるか」を実際に評価して選ぶ。
// 各候補マスを検閲した場合のシーカーの belief 更新をシミュレートし、真の相手位置の近傍（半径1）に
// 残る belief 質量が最小になるマス＝シーカーが最も相手を見失うマスを返す。nearest-opp（censorCell）
// の「近さ」ヒューリスティックと違い、負の情報の欠落や他の交差マスとの相互作用まで織り込む。
//   belief:  シーカーの現在の belief（更新前）／ lastPath: シーカーの直前経路（負の情報源）
//   subjectRoll: 相手の直前出目（開示ありなら数値・尤度を鋭くする、なし null）／ trueOpp: 真の相手位置
function censorSmartCell(board, belief, crossHints, lastPath, subjectRoll, trueOpp, blockedArr) {
  if (!belief || !crossHints) return -1;
  const cands = crossHints.filter(q => !blockedArr[q] && q !== trueOpp);
  if (cands.length <= 1) return cands.length ? cands[0] : -1;
  const uniqPath = [...new Set(lastPath)];
  const uniqCross = [...new Set(crossHints)];
  let best = -1, bestMass = Infinity;
  for (const c of cands) {
    // c を検閲 ＝ 実現交差から c を除き、c は負の情報からも外す（検閲マスは未知扱い）
    const realizedCross = uniqCross.filter(x => x !== c);
    const clear = uniqPath.filter(x => !blockedArr[x] && x !== c);
    const trial = Float64Array.from(belief);
    observeBelief(board, trial, realizedCross, clear, subjectRoll, true, null);
    let mass = 0;
    for (let q = 0; q < board.size; q++) if (board.d(q, trueOpp) <= 1) mass += trial[q];
    if (mass < bestMass) { bestMass = mass; best = c; }
  }
  return best;
}

// acensor（併用）: afocal の F 近傍候補（距離≤2）を選ぶが、交差ヒストを兼ねるマスを
// 最優先で置く。同じ1手で「焦点封鎖」と「交差検閲」を両立させる＝約束事にも推理にも効かせる。
// F 近傍に交差マスが無ければ純 afocal と同じ挙動（焦点封鎖）に落ちるので、focal への強さを保つ。
function afocalCensorCell(board, blockedArr, posA, posB, target, crossHints) {
  const F = predictFocal(board, posA, posB);
  if (F < 0) return -1;
  const hintSet = (crossHints && crossHints.length) ? new Set(crossHints) : null;
  let best = -1, bScore = Infinity;
  for (let q = 0; q < board.size; q++) {
    if (blockedArr[q] || q === posA || q === posB) continue;
    const dF = board.d(q, F);
    if (dF > 2) continue;
    const sideKey = target === 0 ? q : (board.size - 1 - q);
    const censorBonus = (hintSet && hintSet.has(q)) ? 0 : 1; // 交差を兼ねるマスを最優先
    const score = censorBonus * 1e8 + dF * 10000 + sideKey;
    if (score < bScore) { bScore = score; best = q; }
  }
  return best;
}

/* ===================== split: 軌跡の分断・素朴版（人間キング発の上流遮断・実験19） =====================
 * 人間キングのプレイテスト所見「相手が直前にたどった軌跡に向かわせないように分断させる」の定式化。
 * censor が「発生した交差ヒントを事後に1マス消す」対症療法なのに対し、split は
 * 「交差＝情報の発生そのものを上流で断つ」。手番冒頭（mover が動く前）に、相手の直前軌跡
 * （＝mover の今手番の経路がそこを踏むと、相手の次ヒント＝相手直前経路∩mover経路 が生まれる
 * 情報源）のうち、mover が最初に踏み込みやすいマス＝mover に最も近い軌跡マスを塞ぐ。
 *  (a) mover はその軌跡マスを通れず交差が生まれにくい（相手の次ヒントの予防）
 *  (b) 塞いだマスが mover の直前経路とも重なっていれば、現行ヒントの検閲（censor）を兼ねる
 *  (c) デブリは永続なので、相手の行動圏の縁に沿って壁＝分断線が育ち、物理的にも二人を隔てる
 * タイブレークは相手に近い側（より強い位置手がかりを優先的に潰し、相手の周りの堀を締める）。
 */
function splitCell(board, blockedArr, moverPos, oppPos, oppTrail) {
  if (!oppTrail || oppTrail.length === 0) return -1;
  let best = -1, bd = Infinity, bo = Infinity;
  for (const c of oppTrail) {
    if (blockedArr[c] || c === moverPos || c === oppPos) continue;
    const dP = board.d(c, moverPos), dO = board.d(c, oppPos);
    if (dP < bd || (dP === bd && dO < bo)) { bd = dP; bo = dO; best = c; }
  }
  return best;
}

// herd（操舵）: mover の「予測最善着地」（期待出目 E で到達できるマスのうち相手に最も近いマス
// ＝greedy の代理モデル）を先回りして塞ぐ。毎手番 mover の狙い筋を1マスずつ潰すので、
// デブリが mover の進行レーンに沿って壁として育つ＝「向かわせない」操舵の素朴な定式化。
function herdCell(board, blockedArr, moverPos, oppPos, expRoll, jpass) {
  let cand;
  if (jpass) {
    cand = board.reach[moverPos][expRoll];
  } else {
    const layers = computeLayers(board, moverPos, expRoll, blockedArr);
    const Lk = layers[expRoll];
    cand = [];
    for (let q = 0; q < board.size; q++) if (Lk[q]) cand.push(q);
  }
  let best = -1, bd = Infinity;
  for (const q of cand) {
    if (blockedArr[q] || q === moverPos || q === oppPos) continue;
    const d = board.d(q, oppPos);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

// mmx（1手先読みミニマックス）: 各候補マス c にデブリを置いた場合の
// 「mover の最善応答後の対相手距離の期待値」 V(c) = Σ_s p(s)・min_{L∈reach(P,s,B∪{c})} d(L,O)
// を実際に計算し、V を最大化する c を選ぶ＝mover を最も相手から遠ざける操舵。
// greedy シーカーの目的関数（相手への接近）を代理モデルとして敵対的に1手読む。
// タイブレークは検閲を兼ねるマス（発生済み交差ヒント）を優先。
function minimaxCell(board, blockedArr, moverPos, oppPos, crossHints, jpass) {
  const size = board.size;
  const D = board.d(moverPos, oppPos);
  const hintSet = (crossHints && crossHints.length) ? new Set(crossHints) : null;
  // 候補: mover の到達圏内かつ二人の回廊近傍（＋発生済みヒントマス）に絞って計算量を抑える
  const cands = [];
  for (let q = 0; q < size; q++) {
    if (blockedArr[q] || q === moverPos || q === oppPos) continue;
    const onCorridor = board.d(q, moverPos) + board.d(q, oppPos) <= D + 2;
    const inReach = board.d(q, moverPos) <= board.maxRoll;
    if ((inReach && onCorridor) || (hintSet && hintSet.has(q))) cands.push(q);
  }
  if (cands.length === 0) return -1;
  const trial = Uint8Array.from(blockedArr);
  let best = -1, bs = -Infinity;
  for (const c of cands) {
    trial[c] = 1;
    const layers = jpass ? null : computeLayers(board, moverPos, board.maxRoll, trial);
    let v = 0;
    for (let s = board.minRoll; s <= board.maxRoll; s++) {
      const ps = board.diceProbs[s];
      if (!ps) continue;
      let md = D; // 動けない出目なら現状距離のまま
      let any = false;
      if (jpass) {
        for (const q of board.reach[moverPos][s]) {
          if (trial[q]) continue;
          const d = board.d(q, oppPos);
          if (!any || d < md) { md = d; any = true; }
        }
      } else {
        const Lk = layers[s];
        for (let q = 0; q < size; q++) {
          if (!Lk[q]) continue;
          const d = board.d(q, oppPos);
          if (!any || d < md) { md = d; any = true; }
        }
      }
      v += ps * md;
    }
    trial[c] = 0;
    const score = v * 100 + (hintSet && hintSet.has(c) ? 1 : 0); // 同値なら検閲を兼ねる方
    if (score > bs) { bs = score; best = c; }
  }
  return best;
}

// splitwall（軌跡への壁）: 「mover を相手の軌跡に向かわせない」の min-cut 版。
// 相手の直前軌跡全体を多源BFSの目標集合とし、mover→軌跡の最短経路DAGの細い断面を
// mover 寄りから塞ぐ＝軌跡と mover の間に壁を築く。軌跡に隣接済みなら入口マスを直接塞ぐ。
function splitWallCell(board, blockedArr, moverPos, oppPos, oppTrail) {
  if (!oppTrail || oppTrail.length === 0) return -1;
  const size = board.size;
  const dF = bfsDist(board, moverPos, blockedArr);
  const dT = new Int16Array(size).fill(-1);
  const q = new Int16Array(size);
  let h = 0, t = 0;
  for (const c of new Set(oppTrail)) if (!blockedArr[c] && dT[c] < 0) { dT[c] = 0; q[t++] = c; }
  while (h < t) {
    const u = q[h++];
    for (const v of board.nbrs[u]) if (dT[v] < 0 && !blockedArr[v]) { dT[v] = dT[u] + 1; q[t++] = v; }
  }
  let D = Infinity;
  for (const c of new Set(oppTrail)) if (dF[c] >= 0 && dF[c] < D) D = dF[c];
  if (!Number.isFinite(D) || D <= 1) return splitCell(board, blockedArr, moverPos, oppPos, oppTrail);
  const width = new Int16Array(D + 1);
  for (let x = 0; x < size; x++) {
    if (x === moverPos || x === oppPos) continue;
    if (dF[x] > 0 && dT[x] > 0 && dF[x] + dT[x] === D) width[dF[x]]++;
  }
  let best = -1, bs = -Infinity;
  for (let x = 0; x < size; x++) {
    if (x === moverPos || x === oppPos || blockedArr[x]) continue;
    if (dF[x] <= 0 || dT[x] <= 0 || dF[x] + dT[x] !== D) continue;
    const s = -100 * width[dF[x]] - dF[x]; // 細い断面優先・mover寄り
    if (s > bs) { bs = s; best = x; }
  }
  return best;
}

// moat（堀）: 同マス着地には「相手の現在マスへ隣接マスから進入する」ことが必要。
// mover が今手番で相手に届きうる（D ≤ maxRoll）とき、相手の空き隣接マスのうち
// mover に最も近い側＝最終進入路を塞ぐ。相手の周りに堀が育つと mover は相手マスに
// 物理的に着地できなくなる（ラストワンマイルの直接遮断）。
function moatCell(board, blockedArr, moverPos, oppPos) {
  let best = -1, bd = Infinity;
  for (const q of board.nbrs[oppPos]) {
    if (blockedArr[q] || q === moverPos) continue;
    const d = board.d(q, moverPos);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

// bmmx（belief版1手先読み）: 全知キングが mover の belief（censormax と同じ正当な全知
// コンテキスト）で greedy の着地選択そのものを再現し、各候補デブリに対する mover の
// 最善応答着地 L* を正確に予測。真の相手位置との事後距離 E_s[d(L*, O)] を最大化する
// マスに置く＝「mover が実際に向かう先」を読んで最も遠回りさせる操舵。
function beliefMinimaxCell(board, blockedArr, moverPos, oppPos, belief, crossHints, jpass) {
  if (!belief) return -1;
  const size = board.size;
  const D = board.d(moverPos, oppPos);
  const hintSet = (crossHints && crossHints.length) ? new Set(crossHints) : null;
  const sc = new Float64Array(size);
  for (let L = 0; L < size; L++) sc[L] = WIN_WEIGHT * belief[L] - expectedDist(board, belief, L);
  const cands = [];
  for (let q = 0; q < size; q++) {
    if (blockedArr[q] || q === moverPos || q === oppPos) continue;
    const onCorridor = board.d(q, moverPos) + board.d(q, oppPos) <= D + 2;
    const inReach = board.d(q, moverPos) <= board.maxRoll;
    if ((inReach && onCorridor) || (hintSet && hintSet.has(q))) cands.push(q);
  }
  if (cands.length === 0) return -1;
  const trial = Uint8Array.from(blockedArr);
  let best = -1, bs = -Infinity;
  for (const c of cands) {
    trial[c] = 1;
    const layers = jpass ? null : computeLayers(board, moverPos, board.maxRoll, trial);
    let v = 0;
    for (let s = board.minRoll; s <= board.maxRoll; s++) {
      const ps = board.diceProbs[s];
      if (!ps) continue;
      let bl = -1, bsc = -Infinity;
      if (jpass) {
        for (const q of board.reach[moverPos][s]) {
          if (!trial[q] && sc[q] > bsc) { bsc = sc[q]; bl = q; }
        }
      } else {
        const Lk = layers[s];
        for (let q = 0; q < size; q++) {
          if (Lk[q] && sc[q] > bsc) { bsc = sc[q]; bl = q; }
        }
      }
      v += ps * (bl >= 0 ? board.d(bl, oppPos) : D);
    }
    trial[c] = 0;
    const score = v * 100 + (hintSet && hintSet.has(c) ? 1 : 0);
    if (score > bs) { bs = score; best = c; }
  }
  return best;
}

// adapt（適応キング）: mover の過去の着地から戦略クラスを推定して妨害を切り替える。
// 「毎回、到達集合の中で最も中心に近いマスに着地する」率が高い＝約束事(focal)型
// → afocal（非対称の焦点毒殺）で刈る。そうでなければ推理(greedy)型
// → censor（検閲）→ bmmx（belief操舵）で情報を断ちつつ遠回りさせる。
// 全知キングの正当な観測（相手の着地履歴）だけを使い、シーカーの内部方策は覗かない。
function adaptIsFocalish(intel) {
  return intel && intel.moves >= 2 && intel.centerHits === intel.moves;
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

// --safe（実験20）: 「デブリあと1個で密封されうる小部屋」に立たない人間の回避則。
// 自盤の空きマスグラフを現在地を根に DFS し（Tarjan の関節点）、関節マス（または根＝
// 立ち去った後の現在地）をキングが1個塞ぐと本体から切り離される部分木のうち
// サイズ ≤ th のマス全部を「危険」とマークする。危険マスへの着地はペナルティ
// （ハード禁止ではないので、相手を掴める着地なら踏み込む余地は残る）。
function unsafePockets(board, myPos, blocked, th) {
  const size = board.size;
  const unsafe = new Uint8Array(size);
  const disc = new Int16Array(size).fill(-1);
  const low = new Int16Array(size);
  const sub = new Int16Array(size).fill(1);
  const parent = new Int16Array(size).fill(-1);
  const children = new Array(size).fill(null);
  const it = new Int8Array(size);
  let timer = 0;
  const stack = [myPos];
  disc[myPos] = low[myPos] = timer++;
  while (stack.length) {
    const u = stack[stack.length - 1];
    const nb = board.nbrs[u];
    if (it[u] < nb.length) {
      const v = nb[it[u]++];
      if (blocked[v] || v === parent[u]) continue;
      if (disc[v] < 0) {
        parent[v] = u;
        (children[u] || (children[u] = [])).push(v);
        disc[v] = low[v] = timer++;
        stack.push(v);
      } else if (disc[v] < low[u]) low[u] = disc[v];
    } else {
      stack.pop();
      const p = parent[u];
      if (p >= 0) {
        if (low[u] < low[p]) low[p] = low[u];
        sub[p] += sub[u];
      }
    }
  }
  for (let u = 0; u < size; u++) {
    if (!children[u]) continue;
    for (const v of children[u]) {
      if (sub[v] <= th && (u === myPos || low[v] >= disc[u])) {
        const st = [v];
        while (st.length) {
          const x = st.pop();
          if (unsafe[x]) continue;
          unsafe[x] = 1;
          if (children[x]) for (const w of children[x]) st.push(w);
        }
      }
    }
  }
  return unsafe;
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

  // --safe: 密封されうる小部屋（あとデブリ1個で切り離される部分木）を避ける人間の回避則
  const safeTh = (cfg && cfg.safe) || 0;
  const unsafeArr = (safeTh > 0 && myBlocks && mode !== 'random')
    ? unsafePockets(board, me.pos, myBlocks, safeTh) : null;
  const SAFE_PEN = 25;

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
    // ---- デブリ認識AIの実験機構（素朴greedyに勝てず不採用。記録用に残す） ----
    // 'dist'（自陣BFS距離計画）: 期待距離を壁の迂回コスト込みで測る…つもりだったが
    //   全条件で悪化。出会いは相互的（自分が行けなくても相手が来れば会える）なので、
    //   自陣の壁を「避ける」計画は壁の向こうの相方から遠ざかる誤最適化になる。
    if (awareInfo && awareInfo.mode === 'dist') {
      for (const L of reach) {
        const score = WIN_WEIGHT * belief[L] - expectedDistBlocked(board, belief, L, awareInfo.blocks)
          - (unsafeArr && unsafeArr[L] ? SAFE_PEN : 0) + rng() * 1e-6;
        if (score > bestScore) { bestScore = score; best = L; }
      }
      return { landing: best, path: sampler(best) };
    }
    // ---- 実験20: sever（belief操舵キング）へのシーカー側対抗オプション ----
    // --mob=W（可動性・人間の「壁の近くに寄らない」）: 自盤のデブリ密度が高い着地に
    //   ペナルティ。press(L)=Σ_デブリq max(0, 3-d(L,q))。閉じ込められる前に囲いを避ける。
    // --soft=D（揺らぎ・読まれにくさ）: 最善からスコア差 D 以内の着地から一様に選ぶ。
    //   キングの「mover の最善応答予測」を意図的に外す混合戦略。
    const mobW = (cfg && cfg.mob) || 0;
    const softD = (cfg && cfg.soft) || 0;
    if (mobW > 0 || softD > 0) {
      const blockedCells = [];
      if (mobW > 0 && myBlocks) {
        for (let q = 0; q < board.size; q++) if (myBlocks[q]) blockedCells.push(q);
      }
      const scored = [];
      for (const L of reach) {
        let s = WIN_WEIGHT * belief[L] - expectedDist(board, belief, L)
          - (unsafeArr && unsafeArr[L] ? SAFE_PEN : 0);
        if (mobW > 0) {
          let press = 0;
          for (const q of blockedCells) {
            const d = board.d(L, q);
            if (d < 3) press += 3 - d;
          }
          s -= mobW * press;
        }
        scored.push([L, s]);
        if (s > bestScore) bestScore = s;
      }
      if (softD > 0) {
        const pool = scored.filter(([, s]) => s >= bestScore - softD);
        best = pool[(rng() * pool.length) | 0][0];
      } else {
        best = null;
        let bs2 = -Infinity;
        for (const [L, s] of scored) {
          const j = s + rng() * 1e-6;
          if (j > bs2) { bs2 = j; best = L; }
        }
      }
      return { landing: best, path: sampler(best) };
    }
    // 採用構成: 素朴greedy（到達集合だけデブリを尊重し、狙いはマンハッタン距離）
    for (const L of reach) {
      const score = WIN_WEIGHT * belief[L] - expectedDist(board, belief, L)
        - (unsafeArr && unsafeArr[L] ? SAFE_PEN : 0) + rng() * 1e-6;
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
    const score = WIN_WEIGHT * belief[L] + info - 0.01 * expectedDist(board, belief, L)
      - (unsafeArr && unsafeArr[L] ? SAFE_PEN : 0) + rng() * 1e-6;
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
    moves: 0, centerHits: 0,                 // adapt キング用の挙動観測（中心最寄り着地の回数）
    prevPos1: pos, prevPos2: null,           // 回遊診断用（2手番前の位置）
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
    // 検閲候補: nextMover が手番の頭に見るはずの交差マス（precross 時のみ意味を持つ）。
    // 全知キングは両者の直前経路を知るので、その交差の上にデブリを置けばヒントを検閲できる。
    let crossHints = null, censorInfo = null, oppTrail = null;
    // split 系: 相手（＝nextMover の対面）の直前軌跡が「情報の発生源」。全知キングは常に見える。
    if (cfg.ojama === 'split' || cfg.ojama === 'splitc' || cfg.ojama === 'split2' || cfg.ojama === 'splitwall') {
      const op = players[1 - nextMover];
      if (op.moved) oppTrail = op.lastPathCells;
    }
    if (cfg.precross && policy !== 'random') {
      const me = players[nextMover], op = players[1 - nextMover];
      if (me.moved && op.moved) {
        const opSet = new Set(op.lastPathCells);
        const arr = blocks[nextMover];
        crossHints = [];
        for (const x of me.lastPathCells) if (opSet.has(x) && !arr[x]) crossHints.push(x);
        // censormax / bmmx / adapt 用: belief を評価するための全知コンテキスト
        if (cfg.ojama === 'censormax' || cfg.ojama === 'bmmx' || cfg.ojama === 'sever' || cfg.ojama === 'adapt' || cfg.ojama === 'severm') {
          censorInfo = {
            belief: me.belief,
            lastPath: me.lastPathCells,
            subjectRoll: cfg.share ? op.lastRoll : null,
            trueOpp: op.pos,
          };
        }
      }
    }
    const intel = cfg.ojama === 'adapt'
      ? { moves: players[nextMover].moves, centerHits: players[nextMover].centerHits }
      : null;
    const { cell, target } = ojamaPlace(board, cfg, blocks, players[0].pos, players[1].pos, nextMover, rng, curDay, crossHints, censorInfo, oppTrail, intel);
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
        // 不完全なキング（--jeps）: 布石も確率 jeps で無作為な内側マスに置く
        if (cfg.jeps > 0 && rng() < cfg.jeps) {
          let cell = -1, bd = Infinity;
          for (const q of board.interior) {
            if (arr[q] || q === players[0].pos || q === players[1].pos) continue;
            const d = rng();
            if (d < bd) { bd = d; cell = q; }
          }
          if (cell >= 0) { arr[cell] = 1; debrisCount++; debrisPer[t]++; }
          continue;
        }
        // 布石は交差ヒントが未発生なので censor 系も afocal と同じ焦点予測配置を使う
        const afocalOpening = cfg.ojama === 'afocal' || cfg.ojama === 'censor' || cfg.ojama === 'acensor' || cfg.ojama === 'censormax' ||
          cfg.ojama === 'adapt' || cfg.ojama === 'bmmx' || cfg.ojama === 'sever' || cfg.ojama === 'moat' || cfg.ojama === 'cmoat' || cfg.ojama === 'severm';
        let cell = afocalOpening
          ? afocalCell(board, arr, players[0].pos, players[1].pos, t, true)
          : cfg.jasym
            ? ojamaAsymOpening(board, arr, t, players[0].pos, players[1].pos)
            : ojamaOpeningPlace(board, cfg, arr, players[0].pos, players[1].pos, t, rng);
        if (cell < 0 && afocalOpening) // F近傍が埋まったら通常の内側配置へ退避
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

  let turn = 0, crossCellsTotal = 0, anyCross = false, stuck = 0, hintShown = false;
  // 閉じ込め診断（実験20）: 各シーカーが自盤で属する空きマス連結成分の最小サイズと、
  // 小部屋（成分サイズ≤8）に居た手番数。デブリ盤があるときだけ意味を持つ。
  // oneSplitTurns=自盤の壁で相手の現在マスに到達できない（＝自分からは会いに行けない）手番数。
  // hoverTurns=2手番前とほぼ同じ場所に戻った（壁の前の回遊＝実質動けない）手番数（3日目以降）。
  const minComp = [size, size];
  let trapTurns = 0, oneSplitTurns = 0, hoverTurns = 0;

  const rollDice = () => {
    let s = 0;
    for (let i = 0; i < dice.n; i++) {
      let v;
      do { v = 1 + ((rng() * dice.f) | 0); } while (dice.reroll && v <= dice.reroll);
      s += v;
    }
    return s;
  };

  for (let day = 1; day <= maxDay; day++) {
    for (let pi = 0; pi < 2; pi++) {
      turn++;
      const me = players[pi], op = players[1 - pi];
      // 2日目以降: このシーカーが動く"前"に、その盤へデブリを1個置く（初日は布石のみ）。
      // 動く前に置くことで、直前の交差ヒント（precross）を検閲でき、当該手番の到達も塞げる。
      if (day >= 2) placeDebris(pi, day);
      const roll = rollDice();
      const myBlocks = jOn ? blocks[pi] : null;

      // 到達集合と経路サンプラ（デブリがあれば層状DP、なければ高速な事前計算）。
      // --jpass: デブリは通過自由・着地のみ不可なので、移動は開盤どおり＝着地候補から
      // デブリマスを除くだけ（経路サンプラも開盤の samplePath を使う）。
      let reach, layers = null;
      if (jOn && debrisCount > 0) {
        if (cfg.jpass) {
          reach = [];
          for (const q of board.reach[me.pos][roll]) if (!myBlocks[q]) reach.push(q);
        } else {
          layers = computeLayers(board, me.pos, roll, myBlocks);
          reach = [];
          const Lk = layers[roll];
          for (let q = 0; q < size; q++) if (Lk[q]) reach.push(q);
        }
      } else {
        reach = board.reach[me.pos][roll];
      }
      const sampler = (L) => (layers
        ? samplePathBlocked(board, layers, L, roll, rng)
        : samplePath(board, me.pos, L, roll, rng));

      // precross: 「自分の直前の移動 ∩ 相手の直前の移動」の交差を、動く前に知る。
      // 手番冒頭で belief を更新してから着地を選ぶ（既定の post-move 交差は下でスキップ）。
      // 検閲: キングがデブリを置いたマス（myBlocks）に重なる交差は開示されず、負の情報も取らない。
      if (cfg.precross && policy !== 'random' && me.moved && op.moved) {
        const opSet = new Set(op.lastPathCells);
        const deb = myBlocks;
        const preCross = [];
        for (const x of me.lastPathCells) if (opSet.has(x) && !(deb && deb[x])) preCross.push(x);
        // 開示された✦交差（検閲で消えた分は含まない）が1つでもあれば「ヒントを見た」
        if (preCross.length > 0) hintShown = true;
        // aware=censor: 検閲リークの推理。自分の直前経路は歩いた時点では全マス空きだったので、
        // いま自分の盤にデブリが乗っているマス＝この手番で新たに置かれた＝検閲された交差、と分かる。
        // 相手の経路を知らずとも「自分の経路∩自分の盤の新デブリ」だけで censored 交差を復元できる。
        if (cfg.aware === 'censor' && deb) {
          for (const x of me.lastPathCells) {
            if (deb[x] && !(me.lastPathDebSet && me.lastPathDebSet.has(x))) preCross.push(x);
          }
        }
        const uniqPre = [...new Set(preCross)];
        // 自分の直前経路で交差しなかったマス＝相手は通っていない（負の情報）。
        // ただし検閲マスは交差だったかもしれず、情報として扱わない。
        const preClear = [...new Set(me.lastPathCells)].filter(x => !(deb && deb[x]));
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
        // 閉じ込め診断: 詰み手番でも成分サイズを記録する（完全密封 comp=1 を見逃さない）
        if (jOn && debrisCount > 0 && !cfg.jpass) {
          const occ = myBlocks[op.pos];
          if (occ) myBlocks[op.pos] = 0;
          const dMe = bfsDist(board, me.pos, myBlocks);
          if (occ) myBlocks[op.pos] = 1;
          let c = 0;
          for (let q = 0; q < size; q++) if (dMe[q] >= 0) c++;
          if (c < minComp[pi]) minComp[pi] = c;
          if (c <= 8) trapTurns++;
          if (dMe[op.pos] < 0) oneSplitTurns++;
        }
        me.stamp[me.pos] = turn;
        me.lastPathCells = [me.pos];
        me.lastPathDebSet = null;
        me.lastRoll = roll;
        me.moved = true;
        // belief 更新は簡略化のため省略（詰みは稀なイベント）
        continue;
      }

      // 着地選択（デブリ認識AIの実験機構: 'dist'=自陣BFS距離計画）
      let awareInfo = null;
      if (cfg.aware === 'dist' && jOn && debrisCount > 0) {
        awareInfo = { mode: 'dist', blocks: myBlocks };
      }
      const mv = chooseMove(board, me, roll, day, maxDay, policy, rng, cfg.eps || 0, reach, sampler, myBlocks, awareInfo, cfg);
      const landing = mv.landing, path = mv.path;

      // adapt キング用の挙動観測（約束事の指紋）: focal の決定的な目標（中心、自盤で塞がれて
      // いれば中心に最も近い空きマス）をキング側で再現し、「その目標に最も寄る着地」だったかを
      // 記録する。focal なら定義上毎回一致（rate=1.0）、greedy は belief 次第でしか一致しない。
      if (cfg.ojama === 'adapt') {
        let goal = center;
        if (myBlocks && myBlocks[goal]) {
          let bg = goal, bd = Infinity;
          for (let q = 0; q < size; q++) {
            if (myBlocks[q]) continue;
            const d = board.d(q, goal);
            if (d < bd) { bd = d; bg = q; }
          }
          goal = bg;
        }
        let bdc = Infinity;
        for (const L of reach) { const d = board.d(L, goal); if (d < bdc) bdc = d; }
        if (board.d(landing, goal) === bdc) me.centerHits++;
        me.moves++;
      }

      // 交差判定（相手の減衰内スタンプとの重なり）。segment=移動で踏んだマス（出発マスは除く）
      const segment = path.slice(1);
      const crosses = [];
      for (const x of segment) {
        const t = op.stamp[x];
        const hit = decay === 0 ? t >= 0 : (turn - t) <= decay;
        if (hit) crosses.push(x);
      }
      const uniqCross = [...new Set(crosses)];
      crossCellsTotal += uniqCross.length;
      if (uniqCross.length > 0) anyCross = true;
      // 先交差以外（post-move開示）のモードでは、この手番の交差がそのままヒントになる
      if (uniqCross.length > 0 && !cfg.precross) hintShown = true;

      // 自分の軌跡スタンプと移動
      for (const x of path) me.stamp[x] = turn;
      const prevLastPath = me.lastPathCells;
      me.pos = landing;
      me.lastPathCells = [...new Set(path)];
      // --jpass: 歩行時点でデブリだったマス（通過しただけ）を記録。検閲リーク推理は
      // 「歩いた時は空きだった経路上の新デブリ」だけを検閲と読むべきで、既存デブリの
      // 通過を誤検知しないための正当な自己記録（自盤のデブリは本人に見えている）。
      me.lastPathDebSet = (cfg.jpass && myBlocks) ? new Set(path.filter(x => myBlocks[x])) : null;
      me.lastRoll = roll;
      me.moved = true;

      // 閉じ込め診断: 着地後の自盤の連結成分サイズ・片側分断・回遊。
      // 相手が「自盤のデブリの上」に立っている一時的な状態を分断と誤認しないよう、
      // 相手の立ちマスは空きとみなして到達可能性を測る（構造的な壁だけを数える）。
      if (jOn && debrisCount > 0 && !cfg.jpass) {
        const occ = myBlocks[op.pos];
        if (occ) myBlocks[op.pos] = 0;
        const dMe = bfsDist(board, me.pos, myBlocks);
        if (occ) myBlocks[op.pos] = 1;
        let c = 0;
        for (let q = 0; q < size; q++) if (dMe[q] >= 0) c++;
        if (c < minComp[pi]) minComp[pi] = c;
        if (c <= 8) trapTurns++;
        if (dMe[op.pos] < 0) oneSplitTurns++;
      }
      if (day >= 3 && me.prevPos2 != null && board.d(me.pos, me.prevPos2) <= 1) hoverTurns++;
      me.prevPos2 = me.prevPos1;
      me.prevPos1 = me.pos;

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

      // 勝利判定（同マス限定）。--noday1: 初日は出会っても成立しない（何も起こらず情報も得ない）
      if (me.pos === op.pos && !(cfg.noday1 && day === 1)) {
        return { met: true, day, crossCellsTotal, anyCross, hintShown, stuck, minReach, firstClose2, firstClose4,
                 minComp: Math.min(minComp[0], minComp[1]), trapTurns, oneSplitTurns, hoverTurns, splitLoss: false };
      }

      // ---- belief 更新（交差は「今、相手の直前の道を横切った側」だけが知る） ----
      if (policy !== 'random') {
        // (1) 動いた側（me）：相手の直近経路との交差＝相手の居場所の手がかり。
        //     交差あり → 相手の経路が crosses を通った。
        //     交差なし → 自分が踏んだマスは相手の直近経路に含まれない（負の情報）。
        //     着地マスに相手はいない（勝利していないので）。
        //     ※ --precross のときは手番冒頭で更新済みなので post-move の更新はスキップする。
        if (!cfg.precross) {
          const myClear = [...new Set(segment)]; // 交差マス以外の踏破マスは相手経路に含まれない
          // 認識AI('dist')＋共有型: 相手も同じ壁を通れないので、交差からの尤度をBFS距離で締める
          const opBlocksKnown = (cfg.aware === 'dist' && jOn && cfg.jvariant !== 'private' && debrisCount > 0)
            ? blocks[1 - pi] : null;
          observeBelief(
            board, me.belief, uniqCross, myClear,
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
    }
  }
  // 敗北（タイムアウト）。相互分断: A は自盤で B の位置に到達できず、B も自盤で A に到達できない
  // ＝どちらも構造的に相手のマスへ着地できない詰み型の負け。
  let splitLoss = false;
  if (jOn && debrisCount > 0 && !cfg.jpass) {
    // 相手の立ちマスは空き扱い（相手が自盤のデブリの上に立つ一時状態を分断と数えない）
    const occB = blocks[0][players[1].pos];
    if (occB) blocks[0][players[1].pos] = 0;
    const dA = bfsDist(board, players[0].pos, blocks[0]);
    if (occB) blocks[0][players[1].pos] = 1;
    const occA = blocks[1][players[0].pos];
    if (occA) blocks[1][players[0].pos] = 0;
    const dB = bfsDist(board, players[1].pos, blocks[1]);
    if (occA) blocks[1][players[0].pos] = 1;
    splitLoss = dA[players[1].pos] < 0 && dB[players[0].pos] < 0;
  }
  // --tracetrap: 最初の相互分断負けの盤面を1回だけダンプ（閉じ込めの目視確認用）
  if (cfg.tracetrap && splitLoss && !cfg._traced) {
    cfg._traced = true;
    const render = (t) => {
      const rows = [];
      for (let r = 0; r < board.N; r++) {
        let line = '';
        for (let c2 = 0; c2 < board.N; c2++) {
          const q = r * board.N + c2;
          if (q === players[0].pos) line += blocks[t][q] ? 'a' : 'A'; // 小文字=この盤ではデブリの上
          else if (q === players[1].pos) line += blocks[t][q] ? 'b' : 'B';
          else line += blocks[t][q] ? '#' : '.';
        }
        rows.push('    ' + line);
      }
      return rows.join('\n');
    };
    const cA = compSize(board, players[0].pos, blocks[0]);
    const cB = compSize(board, players[1].pos, blocks[1]);
    console.log(`  [tracetrap] 相互分断で敗北した最終盤面（#=デブリ, A/B=シーカー）`);
    console.log(`  盤A（Aだけに効く壁, Aの成分サイズ=${cA}, 最小=${minComp[0]}）:\n${render(0)}`);
    console.log(`  盤B（Bだけに効く壁, Bの成分サイズ=${cB}, 最小=${minComp[1]}）:\n${render(1)}`);
    console.log(`  詰み（動けない手番）=${stuck}回 / 閉じ込め手番（成分≤8）=${trapTurns}回`);
  }
  return { met: false, day: null, crossCellsTotal, anyCross, hintShown, stuck, minReach, firstClose2, firstClose4,
           minComp: Math.min(minComp[0], minComp[1]), trapTurns, oneSplitTurns, hoverTurns, splitLoss };
}

/* ===================== 実験ランナー ===================== */

function runCondition(cfg) {
  const dice = cfg.dice;
  const board = getBoard(cfg.N, dice);
  const rng = mulberry32(cfg.seed || 12345);
  let met = 0, sumDay = 0, cross = 0, anyCrossGames = 0, stuck = 0, metNoHint = 0;
  let close2 = 0, metGivenClose2 = 0, sumFirstClose2 = 0, sumLastMile = 0, sumMinDist = 0;
  let sumTrapTurns = 0, trap8 = 0, splitLosses = 0, sumMinComp = 0, stuckInLosses = 0;
  let oneSplitInLosses = 0, hoverInLosses = 0, oneSplitLossGames = 0, sumMinCompLoss = 0;
  const metByDay = new Array(cfg.maxDay + 1).fill(0);       // 日別の全出会い件数
  const noHintByDay = new Array(cfg.maxDay + 1).fill(0);    // 日別のノーヒント出会い件数
  for (let i = 0; i < cfg.trials; i++) {
    const r = playGame(board, cfg, rng);
    if (r.met) { met++; sumDay += r.day; metByDay[r.day]++; if (!r.hintShown) { metNoHint++; noHintByDay[r.day]++; } }
    cross += r.crossCellsTotal;
    if (r.anyCross) anyCrossGames++;
    stuck += r.stuck;
    sumMinDist += r.minReach;
    sumTrapTurns += r.trapTurns || 0;
    if (r.minComp != null && r.minComp <= 8) trap8++;
    if (r.minComp != null) sumMinComp += r.minComp;
    if (!r.met) {
      if (r.splitLoss) splitLosses++;
      stuckInLosses += r.stuck;
      oneSplitInLosses += r.oneSplitTurns || 0;
      hoverInLosses += r.hoverTurns || 0;
      if ((r.oneSplitTurns || 0) > 0) oneSplitLossGames++;
      sumMinCompLoss += r.minComp != null ? r.minComp : 0;
    }
    if (r.firstClose2 !== null) {
      close2++;
      sumFirstClose2 += r.firstClose2;
      if (r.met) { metGivenClose2++; sumLastMile += (r.day - r.firstClose2); }
    }
  }
  return {
    meetRate: (100 * met) / cfg.trials,
    avgDay: met ? sumDay / met : NaN,
    noHintClearRate: (100 * metNoHint) / cfg.trials,          // ヒント（開示✦交差）を一度も見ずに出会えた割合（全試行比）
    noHintOfMet: met ? (100 * metNoHint) / met : NaN,         // 出会えたゲームのうちノーヒントだった割合
    crossPerGame: cross / cfg.trials,
    crossGameRate: (100 * anyCrossGames) / cfg.trials,
    stuckPerGame: stuck / cfg.trials,
    // ラストワンマイル分解
    close2Rate: (100 * close2) / cfg.trials,          // 一度でも距離≤2に接近した割合
    convRate: close2 ? (100 * metGivenClose2) / close2 : NaN, // 接近を勝ちに変換できた割合
    firstClose2: close2 ? sumFirstClose2 / close2 : NaN,      // 初めて距離≤2になった日
    lastMile: metGivenClose2 ? sumLastMile / metGivenClose2 : NaN, // 接近から着地までの日数
    minDist: sumMinDist / cfg.trials,                 // 到達した最小距離の平均
    metByDay, noHintByDay, trials: cfg.trials, maxDay: cfg.maxDay,
    // 閉じ込め診断（実験20）
    trapTurnsPerGame: sumTrapTurns / cfg.trials,          // 小部屋（成分≤8）に居た手番数/試合
    trap8Rate: (100 * trap8) / cfg.trials,                // 一度でも成分≤8に落ちた試合の割合
    avgMinComp: sumMinComp / cfg.trials,                  // 最小連結成分サイズの平均（49=無傷）
    lossCount: cfg.trials - met,
    splitLossRate: met < cfg.trials ? (100 * splitLosses) / (cfg.trials - met) : NaN, // 負けのうち相互分断
    stuckPerLoss: met < cfg.trials ? stuckInLosses / (cfg.trials - met) : NaN,        // 負け試合あたりの詰み回数
    oneSplitPerLoss: met < cfg.trials ? oneSplitInLosses / (cfg.trials - met) : NaN,  // 負けあたり片側分断手番数
    oneSplitLossRate: met < cfg.trials ? (100 * oneSplitLossGames) / (cfg.trials - met) : NaN, // 片側分断を経験した負けの率
    hoverPerLoss: met < cfg.trials ? hoverInLosses / (cfg.trials - met) : NaN,        // 負けあたり回遊手番数
    avgMinCompLoss: met < cfg.trials ? sumMinCompLoss / (cfg.trials - met) : NaN,     // 負け試合の最小成分平均
  };
}

const boardCache = new Map();
function getBoard(N, dice) {
  const key = `${N}:${dice.label}`;
  if (!boardCache.has(key)) boardCache.set(key, new Board(N, dice.n * dice.f, dice));
  return boardCache.get(key);
}

function fmt(x, d = 1) { return Number.isFinite(x) ? x.toFixed(d) : '-'; }

// ノーヒントクリアの日別ヒストグラム（何日目に起きたか）。各セル=全試行に対する割合%。
function printNoHintByDay(r) {
  const cells = [];
  for (let d = 1; d <= r.maxDay; d++) {
    const nh = (100 * r.noHintByDay[d]) / r.trials;
    const all = (100 * r.metByDay[d]) / r.trials;
    cells.push(`${d}日:${fmt(nh).padStart(4)}%/${fmt(all).padStart(4)}%`);
  }
  console.log('  ノーヒント/全出会い（日別・全試行比） ' + cells.join(' '));
}

function printResult(label, r) {
  console.log(
    `${label.padEnd(42)} 出会い ${fmt(r.meetRate).padStart(5)}%  平均決着日 ${fmt(r.avgDay, 2).padStart(5)}  ` +
    `交差/g ${fmt(r.crossPerGame, 2).padStart(6)}  交差有 ${fmt(r.crossGameRate).padStart(5)}%  ` +
    `ノーヒントクリア ${fmt(r.noHintClearRate).padStart(5)}%(出会いの${fmt(r.noHintOfMet).padStart(5)}%)  詰み/g ${fmt(r.stuckPerGame, 2)}`
  );
}

// 閉じ込め診断の表示（--trap。実験20: greedy が壁に閉じ込められる欠陥の計測）
function printTrap(r) {
  console.log(
    `  [閉じ込め] 最小成分平均 ${fmt(r.avgMinComp, 1)}マス（負け ${fmt(r.avgMinCompLoss, 1)}）  成分≤8経験 ${fmt(r.trap8Rate)}%  ` +
    `負けの相互分断率 ${fmt(r.splitLossRate)}%  片側分断経験 ${fmt(r.oneSplitLossRate)}%(手番${fmt(r.oneSplitPerLoss, 2)}/負)  ` +
    `回遊/負 ${fmt(r.hoverPerLoss, 2)}  詰み/負 ${fmt(r.stuckPerLoss, 2)}`
  );
}

// ラストワンマイル分解の表示
function printDiag(label, r) {  console.log(
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
    else if (a.startsWith('--jeps=')) flags.jeps = +a.slice(7);
    else if (a.startsWith('--ojama=')) flags.ojama = a.slice(8);
    else if (a.startsWith('--jvariant=')) flags.jvariant = a.slice(11);
    else if (a.startsWith('--jcap=')) flags.jcap = +a.slice(7);
    else if (a.startsWith('--jinit=')) flags.jinit = +a.slice(8);
    else if (a === '--jpass') flags.jpass = true;
    else if (a.startsWith('--sgate=')) flags.sgate = +a.slice(8);
    else if (a === '--trap') flags.trap = true;
    else if (a === '--tracetrap') flags.tracetrap = true;
    else if (a.startsWith('--mob=')) flags.mob = +a.slice(6);
    else if (a.startsWith('--soft=')) flags.soft = +a.slice(7);
    else if (a.startsWith('--safe=')) flags.safe = +a.slice(7);
    else if (a === '--safe') flags.safe = 8;
    else if (a === '--jasym') flags.jasym = true;
    else if (a === '--jinterior') flags.jinterior = true;
    else if (a === '--jdump') flags.jdump = true;
    else if (a.startsWith('--aware=')) flags.aware = a.slice(8);
    else if (a === '--aware') flags.aware = 'dist';
    else if (a === '--sharedcross') flags.sharedCross = true;
    else if (a === '--precross') flags.precross = true;
    else if (a === '--nhday') flags.nhday = true;
    else if (a === '--noday1') flags.noday1 = true;
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
        eps: flags.eps || 0, jeps: flags.jeps || 0,
        ojama: flags.ojama || 'none', jvariant: flags.jvariant || 'shared', jcap: flags.jcap, jinit: flags.jinit || 0,
        sgate: flags.sgate, tracetrap: !!flags.tracetrap, jpass: !!flags.jpass,
        mob: flags.mob || 0, soft: flags.soft || 0, safe: flags.safe || 0,
        aware: flags.aware || null, sharedCross: !!flags.sharedCross,
        precross: !!flags.precross,
        noday1: !!flags.noday1,
        pfocal: flags.pfocal || 'center', jasym: !!flags.jasym, jdump: !!flags.jdump,
        jinterior: !!flags.jinterior,
      };
      const jl = cfg.ojama !== 'none' ? ` 邪魔${cfg.ojama}-${cfg.jvariant}${cfg.jpass ? '(通過可)' : ''}${cfg.jcap != null ? `(上限${cfg.jcap})` : ''}${cfg.jinit ? `(布石${cfg.jinit}${cfg.jasym ? '非対称' : ''})` : ''}${cfg.jinterior ? '(外周禁止)' : ''}` : '';
      const pl = cfg.pfocal && cfg.pfocal !== 'center' ? `[${cfg.pfocal}]` : '';
      const label = `${N}x${N} ${dice.label} ${maxDay}日 減衰${decay} ${policy}${pl}${cfg.aware ? `(認識${cfg.aware})` : ''}${cfg.mob ? `(可動${cfg.mob})` : ''}${cfg.soft ? `(揺${cfg.soft})` : ''}${cfg.safe ? `(安全${cfg.safe})` : ''}${cfg.eps ? `(ε=${cfg.eps})` : ''}${cfg.jeps ? `(κε=${cfg.jeps})` : ''}${cfg.share ? '+出目' : ''}${cfg.precross ? '+先交差' : ''}${cfg.oppModel === 'greedy' ? ' oppV2' : ''}${jl}`;
      const res = runCondition(cfg);
      printResult(label, res);
      if (flags.nhday) printNoHintByDay(res);
      if (flags.trap) printTrap(res);
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

  console.log(`\n=== 実験8: デブリを認識する協力AI（greedy+出目、不採用の記録） ===`);
  console.log(`    dist=自陣BFS距離で計画`);
  const jconfigs = [
    ['choke-shared', { ojama: 'choke', jvariant: 'shared' }],
    ['choke-private', { ojama: 'choke', jvariant: 'private' }],
  ];
  for (const [jname, jcfg] of jconfigs) {
    for (const aware of [null, 'dist']) {
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
    ['cage-private', { ojama: 'cage', jvariant: 'private' }],
  ];
  for (const [jname, jcfg] of jc10) {
    console.log(`  --- ${jname} ---`);
    printResult('  focal（約束事）', runCondition({ ...base, policy: 'focal', ...jcfg }));
    printResult('  nfocal（素朴・再設定なし）', runCondition({ ...base, policy: 'nfocal', ...jcfg }));
    printResult('  greedy+出目（素朴推理）', runCondition({ ...base, policy: 'greedy', share: true, ...jcfg }));
    printResult('  greedy+出目 認識block', runCondition({ ...base, policy: 'greedy', share: true, aware: 'block', ...jcfg }));
  }
  console.log(`    --- ラストワンマイル分解: 認識block は接近を着地に変換できているか (cage-private) ---`);
  const jf = { ojama: 'cage', jvariant: 'private' };
  printDiag('focal', runCondition({ ...base, policy: 'focal', ...jf }));
  printDiag('greedy+出目', runCondition({ ...base, policy: 'greedy', share: true, ...jf }));
  printDiag('greedy+出目 認識block', runCondition({ ...base, policy: 'greedy', share: true, aware: 'block', ...jf }));

  console.log(`\n=== 実験11: focalを前提とした読み合い — 集合戦略 × おじゃま配置の利得マトリクス ===`);
  console.log(`    focalは悪でなく大前提。二人が"どこに集まるか"を巡る全知おじゃまとの読み合いを測る。`);
  console.log(`    数字=出会い率%（プレイヤー視点の得点）。秘匿(private)、7x7・2d6・7日・1万試行`);
  const jbase = { ...base, jvariant: 'private' };
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
