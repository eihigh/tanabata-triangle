// Canvas 描画。純粋にゲーム状態＋ビュー指定を受け取って1つの盤面を描く。
import { key, parseKey } from './engine.js';

const COLORS = {
  orihime: { piece: '#e84a8a', trail: 'rgba(232,74,138,0.28)', label: '織姫' },
  hikoboshi: { piece: '#3f7ad6', trail: 'rgba(63,122,214,0.28)', label: '彦星' },
  grid: 'rgba(255,255,255,0.12)',
  bg: '#131a2e',
  debris: '#3a4258',
  debrisEdge: '#20263a',
  hint: '#ffd54a',
  preview: 'rgba(255,255,255,0.5)',
};

// canvas: HTMLCanvasElement, state, opts:
//   who: 'orihime' | 'hikoboshi'  … 描画する盤面
//   reveal: boolean … true なら相手駒も表示（王様ビュー）
//   preview: {x,y}[] … 移動プレビュー経路（シーカー入力中）
//   pieceOverride: {x,y} … プレビュー中の駒位置
export function drawBoard(canvas, state, opts = {}) {
  const { who, reveal = false, preview = [], pieceOverride = null } = opts;
  const ctx = canvas.getContext('2d');
  const N = state.size;
  const W = canvas.width;
  const cell = W / N;

  ctx.clearRect(0, 0, W, W);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, W);

  const s = state[who];
  // 交差ヒントは各シーカーの手番開始時（移動前）に凍結したスナップショットを使う。
  // 移動中にライブ再計算しない。
  const hintSet = s.revealedHints;

  // 軌跡（この盤面のシーカーのみ）
  ctx.fillStyle = COLORS[who].trail;
  for (const k of s.trail) fillCell(ctx, parseKey(k), cell);

  // グリッド線
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= N; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell + 0.5, 0);
    ctx.lineTo(i * cell + 0.5, W);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell + 0.5);
    ctx.lineTo(W, i * cell + 0.5);
    ctx.stroke();
  }

  // デブリ（この盤面のもののみ。盤面ごとに独立）
  for (const k of s.debris) drawDebris(ctx, parseKey(k), cell);

  // 交差ヒント（★）— シーカービューでは常に、王様ビューでも表示
  ctx.fillStyle = COLORS.hint;
  for (const k of hintSet) drawStar(ctx, parseKey(k), cell);

  // プレビュー経路（preview[0] は現在位置、以降が各ステップの着地マス）
  if (preview.length > 1) {
    ctx.strokeStyle = COLORS.preview;
    ctx.lineWidth = Math.max(3, cell * 0.12);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(center(preview[0].x, cell), center(preview[0].y, cell));
    for (let i = 1; i < preview.length; i++) {
      ctx.lineTo(center(preview[i].x, cell), center(preview[i].y, cell));
    }
    ctx.stroke();
    // 途中の着地点に小さな点
    ctx.fillStyle = COLORS.preview;
    for (let i = 1; i < preview.length; i++) {
      ctx.beginPath();
      ctx.arc(center(preview[i].x, cell), center(preview[i].y, cell), cell * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 駒。自分の駒は不透明、王様ビューでの相手駒は「ゴースト」表示で区別する。
  const oriPos = who === 'orihime' && pieceOverride ? pieceOverride : state.orihime.pos;
  const hikPos = who === 'hikoboshi' && pieceOverride ? pieceOverride : state.hikoboshi.pos;
  if (who === 'orihime') drawPiece(ctx, oriPos, cell, 'orihime');
  else if (reveal) drawPiece(ctx, oriPos, cell, 'orihime', true);
  if (who === 'hikoboshi') drawPiece(ctx, hikPos, cell, 'hikoboshi');
  else if (reveal) drawPiece(ctx, hikPos, cell, 'hikoboshi', true);

  // 駒がヒント(★)の上に乗っていると駒が★を隠してしまう。動かなくても「ここはヒントでもある」と
  // 分かるよう、駒の上に小さな★バッジを重ねる。対象はこの盤の“実駒”のみ。半透明ゴースト（相手駒）は
  // 下の★が透けて見えるためバッジ不要（付けると素の★と二重に見える）。
  const ownPos = who === 'orihime' ? oriPos : hikPos;
  if (hintSet.has(key(ownPos))) drawHintBadge(ctx, ownPos, cell);
}

function fillCell(ctx, c, cell) {
  ctx.fillRect(c.x * cell, c.y * cell, cell, cell);
}
function center(v, cell) {
  return v * cell + cell / 2;
}

function drawDebris(ctx, c, cell) {
  const pad = cell * 0.14;
  ctx.fillStyle = COLORS.debris;
  ctx.fillRect(c.x * cell + pad, c.y * cell + pad, cell - 2 * pad, cell - 2 * pad);
  ctx.strokeStyle = COLORS.debrisEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(c.x * cell + pad, c.y * cell + pad, cell - 2 * pad, cell - 2 * pad);
  // ひび割れ風の×
  ctx.beginPath();
  ctx.moveTo(c.x * cell + pad, c.y * cell + pad);
  ctx.lineTo(c.x * cell + cell - pad, c.y * cell + cell - pad);
  ctx.moveTo(c.x * cell + cell - pad, c.y * cell + pad);
  ctx.lineTo(c.x * cell + pad, c.y * cell + cell - pad);
  ctx.stroke();
}

function drawStar(ctx, c, cell) {
  starPath(ctx, center(c.x, cell), center(c.y, cell), cell * 0.28);
  ctx.fill();
}

// 星形のパスを組む（塗り/線は呼び出し側で）。
function starPath(ctx, cx, cy, R) {
  const r = R * 0.45;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const ang = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? R : r;
    const x = cx + Math.cos(ang) * rad;
    const y = cy + Math.sin(ang) * rad;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// 駒に重なったヒントの目印。セル右上に小さな★を、駒の上から見えるよう縁取りして描く。
function drawHintBadge(ctx, c, cell) {
  const bx = c.x * cell + cell * 0.76;
  const by = c.y * cell + cell * 0.24;
  ctx.save();
  starPath(ctx, bx, by, cell * 0.17);
  ctx.fillStyle = COLORS.hint;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.stroke();
  ctx.restore();
}

// ghost=true のとき、その盤面には本来存在しない相手駒を半透明＋破線リングで描く
// （王様が二人の位置関係を掴むための補助表示）。
function drawPiece(ctx, pos, cell, who, ghost = false) {
  const cx = center(pos.x, cell);
  const cy = center(pos.y, cell);
  const r = cell * 0.34;
  ctx.save();
  if (ghost) {
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[who].piece;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[who].piece;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.floor(cell * 0.32)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(COLORS[who].label[0], cx, cy + 1);
  }
  ctx.restore();
}

export { COLORS };
