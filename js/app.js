// フェーズ進行・入力・ハンドオフ・勝敗表示のオーケストレーション
import {
  createGame,
  placeDebris,
  canPlaceDebris,
  applyMove,
  legalStep,
  hasAnyLegalMove,
  resolveStuck,
  activeSeeker,
  isDebrisPhase,
  isMovePhase,
  hints,
  key,
  eq,
  DIRS,
  PHASE,
} from './engine.js?v=7';
import { drawBoard, COLORS } from './render.js?v=7';
import { chooseSeekerMove, chooseKingDebris } from './ai.js';

const SEEKER_LABEL = { orihime: '織姫', hikoboshi: '彦星' };
const THINK_MS = 550; // AI が「考える」演出の間
const RESULT_MS = 550; // AI の結果を見せる間

const el = (id) => document.getElementById(id);

const ui = {
  canvas: el('board'),
  canvas2: el('board2'), // 王様ビューのもう一枚
  boards: el('boards'),
  roleBadge: el('role-badge'),
  status: el('status'),
  roundInfo: el('round-info'),
  dirPad: el('dir-pad'),
  btnUndo: el('btn-undo'),
  btnConfirm: el('btn-confirm'),
  moveControls: el('move-controls'),
  debrisControls: el('debris-controls'),
  btnPlaceDebris: el('btn-place-debris'),
  handoff: el('handoff'),
  handoffText: el('handoff-text'),
  handoffBtn: el('handoff-btn'),
  overlay: el('overlay'),
  overlayTitle: el('overlay-title'),
  overlayText: el('overlay-text'),
  overlayBtn: el('overlay-btn'),
  resultBanner: el('result-banner'),
  rbTitle: el('rb-title'),
  rbText: el('rb-text'),
  rbBtn: el('rb-btn'),
  setup: el('setup'),
  setupNote: el('setup-note'),
  thinking: el('thinking'),
  thinkingText: el('thinking-text'),
};

// 役の担当: 'human' | 'ai'
let roles = { orihime: 'ai', hikoboshi: 'ai', king: 'human' };
// バリアント設定（開始画面で選択）。move は '2'|'3'|'d4'|'d6'。publicRolls は 'all'|'king'|'none'。
// 既定: 7×7 ・ 織姫1d4/彦星1d6 ・ 出目は全員に公開(all)。
let variant = { boardSize: 7, orihime: 'd4', hikoboshi: 'd6', publicRolls: 'all' };

let state;
let path; // 移動入力中の {x,y} 配列（先頭=現在位置）
let debrisPick; // 王様が仮選択中のデブリマス {x,y}

// 現在の手番の担当が AI か
function actorIsAI() {
  return isDebrisPhase(state) ? roles.king === 'ai' : roles[activeSeeker(state)] === 'ai';
}
// 人間シーカーが1人でもいると、AI手番中に盤面を見せると隠し情報が漏れる。
// その場合は AI 手番は盤面を伏せる（人間が王様/不在なら見せてよい）。
const canRevealAI = () => roles.orihime !== 'human' && roles.hikoboshi !== 'human';

function start() {
  state = createGame({
    BOARD_SIZE: variant.boardSize,
    STEPS: { orihime: variant.orihime, hikoboshi: variant.hikoboshi },
    PUBLIC_ROLLS: variant.publicRolls,
    rng: Math.random,
  });
  path = null;
  debrisPick = null;
  ui.overlay.classList.add('hidden');
  ui.resultBanner.classList.add('hidden');
  ui.setup.classList.add('hidden');
  ui.thinking.classList.add('hidden');
  ui.handoff.classList.add('hidden');
  beginPhase();
}

// 各フェーズ開始時: AI 手番なら自動進行、人間手番ならハンドオフ画面を挟む
function beginPhase() {
  if (state.phase === PHASE.GAME_OVER) return showResult();
  if (actorIsAI()) return runAITurn();

  const who = activeSeeker(state);
  const king = isDebrisPhase(state);
  const target = SEEKER_LABEL[who];
  const passTo = king ? '王様' : target;
  const detail = king
    ? `${target}の盤面にデブリを置きます`
    : `${target}が移動します`;
  ui.handoffText.innerHTML = `<strong>${passTo}</strong> に渡してください<br><span class="handoff-detail">${detail}</span>`;
  ui.handoff.classList.remove('hidden');
  ui.handoffBtn.onclick = () => {
    ui.handoff.classList.add('hidden');
    enterPhase();
  };
}

// ---- AI 手番 ---------------------------------------------------------------
function runAITurn() {
  const debris = isDebrisPhase(state);
  const who = activeSeeker(state);
  const actorLabel = debris ? '王様' : SEEKER_LABEL[who];
  const reveal = canRevealAI();
  ui.handoff.classList.add('hidden');
  hideControls();

  if (reveal) {
    // 観戦可（人間シーカー不在）: 盤面を見せて演出
    ui.thinking.classList.add('hidden');
    updateHeader();
    if (debris) renderKingReadonly(who);
    else renderSeekerReadonly(who);
    ui.roleBadge.textContent = `${actorLabel}(AI)`;
    ui.status.textContent = debris
      ? `王様(AI)が ${SEEKER_LABEL[who]}の盤面(今回${state[who].steps}マス${diceTag(who)}) にデブリを検討中…`
      : `${SEEKER_LABEL[who]}(AI)が${state[who].steps}マス${diceTag(who)}の移動先を検討中…`;
  } else {
    // 人間シーカーがいる: 盤面を伏せて思考中カードのみ
    ui.thinkingText.textContent = `${actorLabel}(AI)が${debris ? 'デブリを配置' : '移動'}中…`;
    ui.thinking.classList.remove('hidden');
  }

  setTimeout(() => aiAct(debris, who, reveal), THINK_MS);
}

function aiAct(debris, who, reveal) {
  if (debris) {
    const cell = chooseKingDebris(state, who);
    if (cell) placeDebris(state, who, cell);
    if (reveal) {
      renderKingReadonly(who);
      if (cell) markPick(who === 'orihime' ? ui.canvas : ui.canvas2, cell);
      ui.status.textContent = `王様(AI)が (${cell.x}, ${cell.y}) にデブリを置いた`;
      setTimeout(beginPhase, RESULT_MS);
    } else {
      ui.thinking.classList.add('hidden');
      beginPhase();
    }
    return;
  }

  // 移動
  const move = chooseSeekerMove(state, who);
  if (!move) {
    resolveStuck(state);
    return showResult();
  }
  const rolled = state[who].steps;
  applyMove(state, who, move.path);
  if (reveal) {
    renderSeekerReadonly(who);
    ui.status.textContent = `${SEEKER_LABEL[who]}(AI)が ${rolled}マス動いて (${move.end.x}, ${move.end.y}) へ`;
    setTimeout(() => (state.winner ? showResult() : beginPhase()), RESULT_MS);
  } else {
    ui.thinking.classList.add('hidden');
    if (state.winner) showResult();
    else beginPhase();
  }
}

function hideControls() {
  ui.moveControls.classList.add('hidden');
  ui.debrisControls.classList.add('hidden');
}

// 王様ビュー: デブリ配置対象の盤面(who)の縁だけを光らせる
function setKingTargetGlow(who) {
  ui.canvas.parentElement.classList.toggle('glow-target', who === 'orihime');
  ui.canvas2.parentElement.classList.toggle('glow-target', who === 'hikoboshi');
}
function clearBoardGlow() {
  ui.canvas.parentElement.classList.remove('glow-target');
  ui.canvas2.parentElement.classList.remove('glow-target');
}

// ダイス移動なら現在の出目タグ（例 " 🎲4"）、固定なら空文字
function diceTag(who) {
  return state[who].stepSpec.kind === 'dice' ? ` 🎲${state[who].steps}` : '';
}

// 王様ビューを操作なしで描画（AI観戦用）
function renderKingReadonly(who) {
  ui.canvas.onclick = null;
  ui.canvas2.onclick = null;
  ui.boards.classList.add('king');
  drawBoard(ui.canvas, state, { who: 'orihime', reveal: true });
  drawBoard(ui.canvas2, state, { who: 'hikoboshi', reveal: true });
  labelKingBoards(who);
  setKingTargetGlow(who);
}

// シーカービューを操作なしで描画（AI観戦用）
function renderSeekerReadonly(who) {
  ui.canvas.onclick = null;
  ui.canvas2.onclick = null;
  ui.boards.classList.remove('king');
  clearBoardGlow();
  el('board-label').textContent = `${SEEKER_LABEL[who]}の盤面`;
  el('board2-label').textContent = '';
  drawBoard(ui.canvas, state, { who, reveal: false });
}

function enterPhase() {
  const who = activeSeeker(state);
  updateHeader();

  if (isDebrisPhase(state)) {
    // 王様ビュー：両盤面を表示
    setupKingView(who);
  } else {
    // シーカービュー：自分の盤面のみ
    setupSeekerView(who);
  }
}

function updateHeader() {
  const who = activeSeeker(state);
  const king = isDebrisPhase(state);
  ui.roundInfo.textContent = `ラウンド ${state.round} / ${state.maxRounds}`;
  if (king) {
    ui.roleBadge.textContent = '王様';
    ui.roleBadge.style.background = '#7a5cff';
    const tag = diceTag(who);
    ui.status.textContent =
      `${SEEKER_LABEL[who]}(今回${state[who].steps}マス${tag})の盤面にデブリを1個置いて邪魔しよう` +
      '（軌跡と相手のコマが無いマス）';
  } else {
    ui.roleBadge.textContent = SEEKER_LABEL[who];
    ui.roleBadge.style.background = COLORS[who].piece;
    ui.status.textContent = '相手と同じマスにピッタリ止まれば勝ち。★は軌跡の交差ヒント';
  }
}

// ---- 王様（デブリ設置）-----------------------------------------------------
function setupKingView(who) {
  ui.moveControls.classList.add('hidden');
  ui.debrisControls.classList.remove('hidden');
  ui.dirPad.classList.add('hidden');
  ui.boards.classList.add('king'); // 2枚並べる
  debrisPick = null;
  ui.btnPlaceDebris.disabled = true;

  const other = who === 'orihime' ? 'hikoboshi' : 'orihime';
  const targetCanvas = who === 'orihime' ? ui.canvas : ui.canvas2;
  const render = () => {
    // 左：織姫盤、右：彦星盤（両方フル表示）
    drawBoard(ui.canvas, state, { who: 'orihime', reveal: true });
    drawBoard(ui.canvas2, state, { who: 'hikoboshi', reveal: true });
    // 設置対象盤では相手シーカーの現在位置（禁じ手）を明示する
    markForbidden(targetCanvas, state[other].pos);
  };
  render();
  labelKingBoards(who);
  setKingTargetGlow(who);

  const onClick = ( evt) => {
    const cell = cellFromEvent(targetCanvas, evt);
    if (!cell) return;
    if (!canPlaceDebris(state, who, cell)) {
      flashStatus('そのマスには置けません（軌跡上／盤外／相手の現在位置）');
      return;
    }
    debrisPick = cell;
    ui.btnPlaceDebris.disabled = false;
    render();
    // 仮選択マーカー
    markPick(targetCanvas, cell);
  };
  // 両キャンバスにクリックを付けるが、対象盤以外は無視
  ui.canvas.onclick = who === 'orihime' ? onClick : null;
  ui.canvas2.onclick = who === 'hikoboshi' ? onClick : null;

  ui.btnPlaceDebris.onclick = () => {
    if (!debrisPick) return;
    placeDebris(state, who, debrisPick);
    debrisPick = null;
    beginPhase();
  };
}

function labelKingBoards(activeWho) {
  el('board-label').textContent =
    '織姫の盤面' + (activeWho === 'orihime' ? '（設置対象）' : '');
  el('board2-label').textContent =
    '彦星の盤面' + (activeWho === 'hikoboshi' ? '（設置対象）' : '');
}

function markPick(canvas, cell) {
  const ctx = canvas.getContext('2d');
  const s = canvas.width / state.size;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.strokeRect(cell.x * s + 2, cell.y * s + 2, s - 4, s - 4);
}

// 禁じ手（相手の現在位置）を赤い○/で明示する
function markForbidden(canvas, cell) {
  const ctx = canvas.getContext('2d');
  const s = canvas.width / state.size;
  const cx = cell.x * s + s / 2;
  const cy = cell.y * s + s / 2;
  const r = s * 0.42;
  ctx.save();
  ctx.strokeStyle = '#ff5470';
  ctx.lineWidth = Math.max(2, s * 0.06);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.7, cy + r * 0.7);
  ctx.lineTo(cx + r * 0.7, cy - r * 0.7);
  ctx.stroke();
  ctx.restore();
}

// ---- シーカー（移動）-------------------------------------------------------
function setupSeekerView(who) {
  ui.debrisControls.classList.add('hidden');
  ui.moveControls.classList.remove('hidden');
  ui.dirPad.classList.remove('hidden');
  ui.boards.classList.remove('king');
  clearBoardGlow();
  ui.canvas.onclick = null;
  ui.canvas2.onclick = null;
  el('board-label').textContent = `${SEEKER_LABEL[who]}の盤面`;
  el('board2-label').textContent = '';

  // 囲まれチェック
  if (!hasAnyLegalMove(state, who)) {
    resolveStuck(state);
    flashStatus('動けるマスがありません…王様の勝ち');
    return showResult();
  }

  path = [{ ...state[who].pos }];
  bindDirPad(who);
  renderSeeker(who);
  refreshMoveControls(who);
}

function renderSeeker(who) {
  drawBoard(ui.canvas, state, {
    who,
    reveal: false,
    preview: path,
    pieceOverride: path[path.length - 1],
  });
}

function bindDirPad(who) {
  for (const [name, dir] of Object.entries(DIRS)) {
    const btn = el(`dir-${name}`);
    btn.onclick = () => {
      const from = path[path.length - 1];
      const to = legalStep(state, who, from, dir);
      if (!to) return;
      if (path.length - 1 >= state[who].steps) return; // このシーカーの移動量まで
      path.push(to);
      renderSeeker(who);
      refreshMoveControls(who);
    };
  }
  ui.btnUndo.onclick = () => {
    if (path.length > 1) {
      path.pop();
      renderSeeker(who);
      refreshMoveControls(who);
    }
  };
  ui.btnConfirm.onclick = () => {
    if (path.length - 1 !== state[who].steps) return;
    const steps = path.slice(1); // 現在位置を除いた着地マス列
    applyMove(state, who, steps);
    if (state.winner) return showResult();
    beginPhase();
  };
}

function refreshMoveControls(who) {
  const need = state[who].steps;
  const used = path.length - 1;
  const from = path[path.length - 1];
  // 方向ボタンの有効/無効
  for (const [name, dir] of Object.entries(DIRS)) {
    const legal = used < need && legalStep(state, who, from, dir) !== null;
    el(`dir-${name}`).disabled = !legal;
  }
  ui.btnUndo.disabled = path.length <= 1;
  ui.btnConfirm.disabled = used !== need;
  const dice = state[who].stepSpec.kind === 'dice' ? `🎲${need} ` : '';
  ui.status.textContent = `${dice}移動: ${used} / ${need} マス` +
    (used === need ? '（確定できます）' : `（ちょうど${need}マス動く）`);
}

// ---- 勝敗 ------------------------------------------------------------------
function showResult() {
  ui.handoff.classList.add('hidden');
  ui.thinking.classList.add('hidden');
  hideControls();
  ui.status.textContent = ''; // 移動ステータスを消してリザルトと重ならないように
  const seekersWin = state.winner === 'seekers';
  // 勝敗どちらでも両盤（軌跡・デブリ・両者の最終位置）を公開する。王様ビューを流用。
  revealBothBoards();
  ui.rbTitle.textContent = seekersWin ? '🎋 シーカーの勝ち！' : '👑 王様の勝ち！';
  if (seekersWin) {
    const m = state.meetingCell;
    ui.rbText.innerHTML =
      `織姫と彦星は (${m.x}, ${m.y}) で出会えた！　` +
      '<span class="reveal-note">二人の軌跡は下の盤面のとおり</span>';
  } else {
    const o = state.orihime.pos;
    const h = state.hikoboshi.pos;
    ui.rbText.innerHTML =
      '規定手番までに二人は出会えなかった…　' +
      `<span class="reveal-note">実は織姫 (${o.x}, ${o.y})・彦星 (${h.x}, ${h.y}) にいました（下の盤面）</span>`;
  }
  ui.resultBanner.classList.remove('hidden');
  ui.rbBtn.onclick = showSetup;
}

// 両盤を公開表示（軌跡・デブリ・両者の最終位置）。王様のデブリ配置ビューを流用。
function revealBothBoards() {
  ui.canvas.onclick = null;
  ui.canvas2.onclick = null;
  ui.boards.classList.add('king');
  clearBoardGlow();
  drawBoard(ui.canvas, state, { who: 'orihime', reveal: true });
  drawBoard(ui.canvas2, state, { who: 'hikoboshi', reveal: true });
  const o = state.orihime.pos;
  const h = state.hikoboshi.pos;
  el('board-label').textContent = `織姫の盤面 — 最終位置 (${o.x}, ${o.y})`;
  el('board2-label').textContent = `彦星の盤面 — 最終位置 (${h.x}, ${h.y})`;
}

// ---- 役選択（開始前）-------------------------------------------------------
function showSetup() {
  ui.overlay.classList.add('hidden');
  ui.resultBanner.classList.add('hidden');
  ui.handoff.classList.add('hidden');
  ui.thinking.classList.add('hidden');
  hideControls();
  ui.setup.classList.remove('hidden');
}

function initRolePicker() {
  el('role-picker')
    .querySelectorAll('.role-row')
    .forEach((row) => {
      const role = row.dataset.role;
      const buttons = row.querySelectorAll('.seg button');
      const paint = () =>
        buttons.forEach((b) => b.classList.toggle('active', b.dataset.val === roles[role]));
      buttons.forEach((b) =>
        b.addEventListener('click', () => {
          roles[role] = b.dataset.val;
          paint();
          updateSetupNote();
        }),
      );
      paint();
    });
  updateSetupNote();
}

// バリアント選択（盤面サイズ・織姫/彦星の移動量）。
// board は数値、orihime/hikoboshi は移動スペック文字列（'2'|'3'|'d4'|'d6'）。
function initVariantPicker() {
  el('variant-picker')
    .querySelectorAll('.role-row')
    .forEach((row) => {
      const vkey = row.dataset.variant === 'board' ? 'boardSize' : row.dataset.variant;
      const numeric = vkey === 'boardSize';
      const buttons = row.querySelectorAll('.seg button');
      const paint = () =>
        buttons.forEach((b) => {
          const val = numeric ? Number(b.dataset.val) : b.dataset.val;
          b.classList.toggle('active', val === variant[vkey]);
        });
      buttons.forEach((b) =>
        b.addEventListener('click', () => {
          variant[vkey] = numeric ? Number(b.dataset.val) : b.dataset.val;
          paint();
        }),
      );
      paint();
    });
}

function updateSetupNote() {
  const humanSeeker = roles.orihime === 'human' || roles.hikoboshi === 'human';
  ui.setupNote.textContent = humanSeeker
    ? 'AIの手番中は盤面を伏せます（人間シーカーへの情報漏れ防止）。'
    : '人間シーカーがいないため、AIの手番も盤面を表示します（観戦）。';
}

// ---- ユーティリティ --------------------------------------------------------
function cellFromEvent(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const x = ((evt.clientX - rect.left) / rect.width) * state.size;
  const y = ((evt.clientY - rect.top) / rect.height) * state.size;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= state.size || cy >= state.size) return null;
  return { x: cx, y: cy };
}

let flashTimer = null;
function flashStatus(msg) {
  ui.status.textContent = msg;
  ui.status.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ui.status.classList.remove('flash'), 900);
}

// 起動
window.addEventListener('DOMContentLoaded', () => {
  el('btn-restart').onclick = showSetup;
  el('btn-start').onclick = start;
  initRolePicker();
  initVariantPicker();
});
